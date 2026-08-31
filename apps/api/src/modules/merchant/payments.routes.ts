import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema } from '@tryme/db';
import {
  MERCHANT_PLAN_BILLING,
  MerchantCheckoutBody,
  MerchantPaymentVerify,
  type MerchantPlanSlug,
} from '@tryme/types';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { resolveMerchantUserId } from './ledger.js';

const GST_RATE = 0.18;

async function createRazorpayOrder(
  keyId: string,
  keySecret: string,
  amountPaise: number,
  receipt: string,
): Promise<{ id: string }> {
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Razorpay order creation failed: ${body}`);
  }
  return res.json() as Promise<{ id: string }>;
}

// Idempotent credit grant to a merchant's (single, unified) credit pool + ledger entry.
async function grantMerchantCredits(
  app: FastifyInstance,
  merchantId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  credits: number,
  signature?: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: DB type narrowing
  const userId = await resolveMerchantUserId(app.db as any, merchantId);

  await app.db.transaction(async (tx) => {
    await tx
      .update(schema.merchantPayments)
      .set({
        status: 'paid',
        razorpayPaymentId,
        ...(signature ? { razorpaySignature: signature } : {}),
        paidAt: new Date(),
      })
      .where(eq(schema.merchantPayments.razorpayOrderId, razorpayOrderId));

    await tx
      .insert(schema.userCredits)
      .values({ userId, balance: credits })
      .onConflictDoUpdate({
        target: schema.userCredits.userId,
        set: {
          balance: sql`${schema.userCredits.balance} + ${credits}`,
          updatedAt: new Date(),
        },
      });

    await tx.insert(schema.creditLedger).values({
      userId,
      delta: credits,
      reason: 'PAYMENT',
      adminId: null,
    });
  });
}

export async function merchantPaymentsRoutes(app: FastifyInstance) {
  // POST /v1/merchant/payments/orders — create a Razorpay order server-side.
  // Amount is computed from authoritative billing data, never from the client.
  app.post(
    '/v1/merchant/payments/orders',
    { preHandler: app.requireMerchant, schema: { body: MerchantCheckoutBody } },
    async (req) => {
      const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = app.env;
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new AppError('NOT_CONFIGURED', 503, 'payments not configured');
      }

      const clientId = (req as FastifyRequest & { merchantClientId: string }).merchantClientId;
      const { planSlug } = req.body as { planSlug: MerchantPlanSlug };
      const plan = MERCHANT_PLAN_BILLING[planSlug];
      if (!plan) throw new AppError('NOT_FOUND', 404, 'plan not found');

      const basePaise = plan.priceInr * 100;
      const gstPaise = Math.round(basePaise * GST_RATE);
      const totalPaise = basePaise + gstPaise;

      const rzpOrder = await createRazorpayOrder(
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET,
        totalPaise,
        `tryme_m_${clientId.slice(0, 8)}`,
      );

      await app.db.insert(schema.merchantPayments).values({
        merchantId: clientId,
        planId: plan.slug,
        razorpayOrderId: rzpOrder.id,
        basePaise,
        gstPaise,
        totalPaise,
        credits: plan.credits,
        status: 'created',
      });

      return {
        orderId: rzpOrder.id,
        amount: totalPaise,
        currency: 'INR',
        keyId: RAZORPAY_KEY_ID,
        credits: plan.credits,
        label: plan.name,
      };
    },
  );

  // POST /v1/merchant/payments/verify — verify Razorpay signature + credit merchant
  app.post(
    '/v1/merchant/payments/verify',
    { preHandler: app.requireMerchant, schema: { body: MerchantPaymentVerify } },
    async (req) => {
      const { RAZORPAY_KEY_SECRET } = app.env;
      if (!RAZORPAY_KEY_SECRET) {
        throw new AppError('NOT_CONFIGURED', 503, 'payments not configured');
      }

      const clientId = (req as FastifyRequest & { merchantClientId: string }).merchantClientId;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
        razorpayOrderId: string;
        razorpayPaymentId: string;
        razorpaySignature: string;
      };

      const expected = createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
      const expectedBuf = Buffer.from(expected);
      const signatureBuf = Buffer.from(razorpaySignature);
      const signatureValid =
        expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);
      if (!signatureValid) {
        throw new AppError('INVALID_SIGNATURE', 400, 'payment signature invalid');
      }

      const [payment] = await app.db
        .select()
        .from(schema.merchantPayments)
        .where(eq(schema.merchantPayments.razorpayOrderId, razorpayOrderId));

      if (!payment) throw new AppError('NOT_FOUND', 404, 'order not found');
      if (payment.merchantId !== clientId) throw new AppError('FORBIDDEN', 403, 'forbidden');
      if (payment.status === 'paid') return { ok: true, alreadyCredited: true };

      await grantMerchantCredits(
        app,
        clientId,
        razorpayOrderId,
        razorpayPaymentId,
        payment.credits,
        razorpaySignature,
      );

      const [bal] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.merchants)
        .innerJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
        .where(eq(schema.merchants.id, clientId));

      return { ok: true, alreadyCredited: false, balance: bal?.balance ?? payment.credits };
    },
  );

  // POST /v1/merchant/payments/webhook — Razorpay server-to-server delivery.
  // Needs the raw body for HMAC verification, so it's scoped in a sub-plugin
  // with a buffer content-type parser.
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    sub.post('/v1/merchant/payments/webhook', async (req, reply) => {
      const { RAZORPAY_WEBHOOK_SECRET } = app.env;
      if (!RAZORPAY_WEBHOOK_SECRET) {
        app.log.warn(
          'RAZORPAY_WEBHOOK_SECRET not set — merchant webhook received but not verified',
        );
        reply.code(200).send({ ok: true });
        return;
      }

      const rawBody = req.body as Buffer;
      const signature = (req.headers['x-razorpay-signature'] as string) ?? '';
      const expected = createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const signatureBuf = Buffer.from(signature, 'hex');
      const valid =
        expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);
      if (!valid) {
        app.log.warn({ signature }, 'merchant razorpay webhook signature mismatch');
        reply.code(200).send({ ok: false, reason: 'invalid signature' });
        return;
      }

      let event: {
        event: string;
        payload: { payment?: { entity?: { id?: string; order_id?: string } } };
      };
      try {
        event = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        reply.code(200).send({ ok: false, reason: 'invalid json' });
        return;
      }

      const eventType = event.event;
      const paymentEntity = event.payload?.payment?.entity;
      const razorpayPaymentId = paymentEntity?.id;
      const razorpayOrderId = paymentEntity?.order_id;

      if (eventType === 'payment.captured' && razorpayOrderId && razorpayPaymentId) {
        const [payment] = await app.db
          .select()
          .from(schema.merchantPayments)
          .where(eq(schema.merchantPayments.razorpayOrderId, razorpayOrderId));

        if (!payment) {
          app.log.error({ razorpayOrderId }, 'merchant webhook: order not found');
          reply.code(200).send({ ok: true });
          return;
        }
        if (payment.status === 'paid') {
          reply.code(200).send({ ok: true });
          return;
        }

        await grantMerchantCredits(
          app,
          payment.merchantId,
          razorpayOrderId,
          razorpayPaymentId,
          payment.credits,
        );
        app.log.info(
          { razorpayOrderId, credits: payment.credits, merchantId: payment.merchantId },
          'merchant webhook: credits granted',
        );
      } else if (eventType === 'payment.failed' && razorpayOrderId) {
        await app.db
          .update(schema.merchantPayments)
          .set({ status: 'failed' })
          .where(
            and(
              eq(schema.merchantPayments.razorpayOrderId, razorpayOrderId),
              eq(schema.merchantPayments.status, 'created'),
            ),
          );
      }

      reply.code(200).send({ ok: true });
    });
  });
}
