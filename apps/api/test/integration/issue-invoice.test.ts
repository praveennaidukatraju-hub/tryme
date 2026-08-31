import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { issueInvoiceIfNeeded } from '../../src/modules/payments/issue-invoice.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('issueInvoiceIfNeeded', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedPaidPayment(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash: 'x', tier: 'free', emailVerified: true })
      .returning();
    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: `order_${email}`,
        razorpayPaymentId: `pay_${email}`,
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        gstin: '27AAPFU0939F1ZV',
        status: 'paid',
        paidAt: new Date(),
      })
      .returning();
    return payment;
  }

  async function seedLoginableUserWithPaidPayment(email: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash, tier: 'free', emailVerified: true })
      .returning();
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '127.0.0.30',
      payload: { email, password: 'password123' },
    });
    const token = loginRes.json().accessToken as string;

    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: `order_${email}`,
        razorpayPaymentId: `pay_${email}`,
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        gstin: '27AAPFU0939F1ZV',
        status: 'paid',
        paidAt: new Date(),
      })
      .returning();
    return { token, userId: user.id, payment };
  }

  it('issues a sequential invoice number and uploads a PDF to R2', async () => {
    const payment = await seedPaidPayment('issue-invoice-1@x.com');

    const result = await issueInvoiceIfNeeded(app, payment.id);
    expect(result).not.toBeNull();
    expect(result?.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
    expect(result?.pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const [row] = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, payment.id));
    expect(row).toBeDefined();
    expect(row.invoiceNumber).toBe(result?.invoiceNumber);

    const stored = await app.storage.getObject(row.r2Key);
    expect(stored.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('allocates sequential numbers across two different payments', async () => {
    const p1 = await seedPaidPayment('issue-invoice-seq-1@x.com');
    const p2 = await seedPaidPayment('issue-invoice-seq-2@x.com');

    const r1 = await issueInvoiceIfNeeded(app, p1.id);
    const r2 = await issueInvoiceIfNeeded(app, p2.id);

    const n1 = Number(r1?.invoiceNumber.split('-').pop());
    const n2 = Number(r2?.invoiceNumber.split('-').pop());
    expect(n2).toBe(n1 + 1);
  });

  it('is idempotent — calling twice for the same payment yields exactly one invoices row', async () => {
    const payment = await seedPaidPayment('issue-invoice-idempotent@x.com');

    const first = await issueInvoiceIfNeeded(app, payment.id);
    const second = await issueInvoiceIfNeeded(app, payment.id);

    expect(second?.invoiceNumber).toBe(first?.invoiceNumber);

    const rows = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, payment.id));
    expect(rows).toHaveLength(1);
  });

  it('returns null (never throws) for a payment that is not paid', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: 'issue-invoice-unpaid@x.com', passwordHash: 'x', tier: 'free' })
      .returning();
    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: user.id,
        planId: 'growth',
        razorpayOrderId: 'order_unpaid',
        basePaise: 100000,
        gstPaise: 18000,
        totalPaise: 118000,
        credits: 5000,
        status: 'created',
      })
      .returning();

    const result = await issueInvoiceIfNeeded(app, payment.id);
    expect(result).toBeNull();
  });

  it('GET /v1/payments/history includes invoiceNumber/invoiceUrl once issued', async () => {
    const { token, payment } = await seedLoginableUserWithPaidPayment('history-invoice@x.com');
    const issued = await issueInvoiceIfNeeded(app, payment.id);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().payments.find((p: { id: string }) => p.id === payment.id);
    expect(row.invoiceNumber).toBe(issued?.invoiceNumber);
    expect(typeof row.invoiceUrl).toBe('string');
  });

  it('GET /v1/payments/:id/invoice redirects to the invoice for its owner, 403s for others', async () => {
    const { token: ownerToken, payment } =
      await seedLoginableUserWithPaidPayment('invoice-owner@x.com');
    await issueInvoiceIfNeeded(app, payment.id);

    const { token: otherToken } = await seedLoginableUserWithPaidPayment('invoice-other@x.com');

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}/invoice`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerRes.statusCode).toBe(302);

    const otherRes = await app.inject({
      method: 'GET',
      url: `/v1/payments/${payment.id}/invoice`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherRes.statusCode).toBe(403);
  });
});
