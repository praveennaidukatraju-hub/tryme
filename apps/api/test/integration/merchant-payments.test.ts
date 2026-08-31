import { createHmac } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';
import { createTestMerchant } from '../helpers/merchant.js';

const RAZORPAY_KEY_SECRET = 'test-razorpay-key-secret';

// Covers POST /v1/merchant/payments/verify (apps/api/src/modules/merchant/payments.routes.ts),
// which now credits the unified user_credits/credit_ledger pool instead of the retired
// merchant_credits/merchant_credit_ledger tables (Task 4 of the unified-credits plan).
// Previously zero coverage existed for this route.
describe('POST /v1/merchant/payments/verify', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c, { RAZORPAY_KEY_SECRET });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function merchantToken(userId: string) {
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    return signAccess(secret, userId, { kind: 'access' }, '15m');
  }

  async function seedPendingMerchantPayment(opts: {
    merchantId: string;
    razorpayOrderId: string;
    credits: number;
  }) {
    const [payment] = await app.db
      .insert(schema.merchantPayments)
      .values({
        merchantId: opts.merchantId,
        planId: 'test-plan',
        razorpayOrderId: opts.razorpayOrderId,
        basePaise: 250000,
        gstPaise: 45000,
        totalPaise: 295000,
        credits: opts.credits,
        status: 'created',
      })
      .returning();
    return payment;
  }

  function signature(orderId: string, paymentId: string) {
    return createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  }

  it("credits the merchant owner's user_credits balance (additive, not overwritten) and writes a PAYMENT ledger entry", async () => {
    const merchant = await createTestMerchant(app, { balance: 40 });
    const token = await merchantToken(merchant.userId);
    const orderId = 'order_merchant_1';
    const payment = await seedPendingMerchantPayment({
      merchantId: merchant.merchantId,
      razorpayOrderId: orderId,
      credits: 300,
    });
    if (!payment) throw new Error('failed to seed merchant payment');

    const paymentId = 'pay_merchant_1';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; alreadyCredited: boolean; balance: number };
    expect(body.ok).toBe(true);
    expect(body.alreadyCredited).toBe(false);
    // Pre-existing balance (40) is preserved and added to (300), not overwritten.
    expect(body.balance).toBe(340);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(340);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, merchant.userId));
    const paymentEntries = ledger.filter((l) => l.reason === 'PAYMENT');
    expect(paymentEntries).toHaveLength(1);
    expect(paymentEntries[0]?.delta).toBe(300);
  });

  it('is idempotent — calling verify twice only credits once', async () => {
    const merchant = await createTestMerchant(app, { balance: 0 });
    const token = await merchantToken(merchant.userId);
    const orderId = 'order_merchant_idempotent';
    await seedPendingMerchantPayment({
      merchantId: merchant.merchantId,
      razorpayOrderId: orderId,
      credits: 150,
    });

    const paymentId = 'pay_merchant_idempotent';
    const payload = {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature(orderId, paymentId),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/merchant/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().alreadyCredited).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/merchant/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyCredited).toBe(true);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(150);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, merchant.userId));
    expect(ledger.filter((l) => l.reason === 'PAYMENT')).toHaveLength(1);
  });
});
