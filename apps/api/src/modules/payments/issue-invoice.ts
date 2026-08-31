import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SELLER_CONFIG } from '../../lib/resolution-config.js';
import { financialYearFor, renderInvoicePdf } from './invoice-pdf.js';

const CONFIG_KEY = 'config:system';

async function readSellerConfig(app: FastifyInstance): Promise<typeof DEFAULT_SELLER_CONFIG> {
  const raw = await app.redis.get(CONFIG_KEY);
  const cfg = raw ? JSON.parse(raw) : {};
  return { ...DEFAULT_SELLER_CONFIG, ...cfg.seller };
}

async function allocateInvoiceNumber(app: FastifyInstance, financialYear: string): Promise<string> {
  // Single upsert statement: on first invoice of a financial year, inserts
  // nextNumber=2 and this call receives 2-1=1; on every subsequent call,
  // the ON CONFLICT branch atomically increments and returns the
  // pre-increment value — the row-level lock during the upsert is what
  // keeps this gap-free and race-safe under concurrent purchases.
  const [row] = await app.db
    .insert(schema.invoiceSequences)
    .values({ financialYear, nextNumber: 2 })
    .onConflictDoUpdate({
      target: schema.invoiceSequences.financialYear,
      set: { nextNumber: sql`${schema.invoiceSequences.nextNumber} + 1` },
    })
    .returning({ nextNumber: schema.invoiceSequences.nextNumber });
  const issuedNumber = (row?.nextNumber ?? 2) - 1;
  return `INV-${financialYear}-${String(issuedNumber).padStart(6, '0')}`;
}

/**
 * Non-fatal — never throws. Returns null on any failure (payment not
 * found/not paid, PDF render error, R2 upload error, DB error) so callers
 * can safely fire-and-forget this after a credit grant. Idempotent: a
 * second call for the same paymentId returns the already-issued invoice
 * (re-reads it from R2) instead of allocating a new number.
 */
export async function issueInvoiceIfNeeded(
  app: FastifyInstance,
  paymentId: string,
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer } | null> {
  try {
    const [existing] = await app.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, paymentId));
    if (existing) {
      const pdfBuffer = await app.storage.getObject(existing.r2Key);
      return { invoiceNumber: existing.invoiceNumber, pdfBuffer };
    }

    const [payment] = await app.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId));
    if (payment?.status !== 'paid') return null;

    const [user] = await app.db
      .select({
        email: schema.users.email,
        displayName: schema.users.displayName,
        companyName: schema.users.companyName,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .where(eq(schema.users.id, payment.userId));
    if (!user?.email) return null;

    const [plan] = await app.db
      .select({ name: schema.creditPlans.name })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, payment.planId));

    const issuedAt = payment.paidAt ?? new Date();
    const financialYear = financialYearFor(issuedAt);
    const seller = await readSellerConfig(app);

    const invoiceNumber = await allocateInvoiceNumber(app, financialYear);
    const pdfBuffer = await renderInvoicePdf({
      invoiceNumber,
      issuedAt,
      seller,
      customer: {
        email: user.email,
        gstin: payment.gstin,
        displayName: user.displayName,
        companyName: user.companyName,
        phone: user.phone,
      },
      orderId: payment.razorpayOrderId,
      planName: plan?.name ?? payment.planId,
      credits: payment.credits,
      basePaise: payment.basePaise,
      gstPaise: payment.gstPaise,
      totalPaise: payment.totalPaise,
      paymentStatus: payment.status,
      razorpayPaymentId: payment.razorpayPaymentId,
      paidAt: payment.paidAt,
    });

    const r2Key = keys.invoice(paymentId);
    await app.storage.putObject(r2Key, pdfBuffer, 'application/pdf');

    await app.db
      .insert(schema.invoices)
      .values({ paymentId, invoiceNumber, r2Key, issuedAt })
      .onConflictDoNothing({ target: schema.invoices.paymentId });

    return { invoiceNumber, pdfBuffer };
  } catch (err) {
    app.log.warn({ err, paymentId }, 'issueInvoiceIfNeeded failed — non-fatal');
    return null;
  }
}
