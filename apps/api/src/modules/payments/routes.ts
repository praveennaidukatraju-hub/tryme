import { createHmac, timingSafeEqual } from 'node:crypto';
import { schema } from '@tryme/db';
import { Gstin } from '@tryme/types';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { sendPaymentReceiptEmail } from '../../lib/mailer.js';
import { issueInvoiceIfNeeded } from './issue-invoice.js';

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

// Shared helper — send receipt email non-fatally after a successful credit grant
async function maybeSendReceipt(
  app: FastifyInstance,
  userId: string,
  payment: {
    id: string;
    planId: string;
    credits: number;
    basePaise: number;
    gstPaise: number;
    totalPaise: number;
    razorpayOrderId: string;
    razorpayPaymentId: string | null;
    paidAt: Date | null;
  },
): Promise<void> {
  try {
    const invoice = await issueInvoiceIfNeeded(app, payment.id);

    const [user] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (!user) return;
    if (!user.email) return;

    const [plan] = await app.db
      .select({ name: schema.creditPlans.name })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, payment.planId));

    const attachments = invoice
      ? [{ filename: `${invoice.invoiceNumber}.pdf`, content: invoice.pdfBuffer }]
      : undefined;

    await sendPaymentReceiptEmail(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      user.email,
      {
        planName: plan?.name ?? payment.planId,
        credits: payment.credits,
        basePaise: payment.basePaise,
        gstPaise: payment.gstPaise,
        totalPaise: payment.totalPaise,
        razorpayOrderId: payment.razorpayOrderId,
        razorpayPaymentId: payment.razorpayPaymentId ?? '',
        paidAt: payment.paidAt ?? new Date(),
      },
      attachments,
    );
  } catch (err) {
    app.log.warn({ err, userId }, 'receipt email failed — non-fatal');
  }
}

type DbOrTx = Parameters<Parameters<FastifyInstance['db']['transaction']>[0]>[0];

// Credits `payment.credits` (the base plan grant) plus, for a campaign-attributed
// user's first successful purchase, a CAMPAIGN_BONUS ledger row on top. Shared by
// /verify and the webhook handler so the two credit-grant paths can't drift.
// Returns the total credited (base + bonus, if any) so callers can report the
// true amount rather than assuming it's always just the plan's base credits.
async function grantPurchaseCredits(
  tx: DbOrTx,
  userId: string,
  payment: { id: string; credits: number },
): Promise<number> {
  await tx
    .insert(schema.userCredits)
    .values({ userId, balance: payment.credits })
    .onConflictDoUpdate({
      target: schema.userCredits.userId,
      set: {
        balance: sql`${schema.userCredits.balance} + ${payment.credits}`,
        updatedAt: new Date(),
      },
    });

  await tx.insert(schema.creditLedger).values({
    userId,
    delta: payment.credits,
    reason: 'PAYMENT',
    adminId: null,
  });

  const [priorPaid] = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.userId, userId),
        eq(schema.payments.status, 'paid'),
        ne(schema.payments.id, payment.id),
      ),
    )
    .limit(1);
  if (priorPaid) return payment.credits; // not their first purchase — no campaign bonus

  const [user] = await tx
    .select({ campaignId: schema.users.signupCampaignId })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user?.campaignId) return payment.credits;

  const [campaign] = await tx
    .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
    .from(schema.signupCampaigns)
    .where(eq(schema.signupCampaigns.id, user.campaignId));
  if (!campaign) return payment.credits;

  const bonus = Math.round(payment.credits * (campaign.bonusPercent / 100));
  if (bonus <= 0) return payment.credits;

  await tx
    .update(schema.userCredits)
    .set({ balance: sql`${schema.userCredits.balance} + ${bonus}`, updatedAt: new Date() })
    .where(eq(schema.userCredits.userId, userId));

  await tx.insert(schema.creditLedger).values({
    userId,
    delta: bonus,
    reason: 'CAMPAIGN_BONUS',
  });

  return payment.credits + bonus;
}

export async function paymentsRoutes(app: FastifyInstance) {
  // GET /v1/payments/plans — public, no auth required
  app.get('/v1/payments/plans', async () => {
    return app.db
      .select()
      .from(schema.creditPlans)
      .where(and(eq(schema.creditPlans.isActive, true), ne(schema.creditPlans.slug, 'free')))
      .orderBy(asc(schema.creditPlans.sortOrder));
  });

  // GET /v1/payments/history — user's own paid payment records
  app.get('/v1/payments/history', { preHandler: app.requireUser }, async (req) => {
    const rows = await app.db
      .select({
        id: schema.payments.id,
        planId: schema.payments.planId,
        planName: schema.creditPlans.name,
        credits: schema.payments.credits,
        basePaise: schema.payments.basePaise,
        gstPaise: schema.payments.gstPaise,
        totalPaise: schema.payments.totalPaise,
        razorpayOrderId: schema.payments.razorpayOrderId,
        razorpayPaymentId: schema.payments.razorpayPaymentId,
        status: schema.payments.status,
        createdAt: schema.payments.createdAt,
        paidAt: schema.payments.paidAt,
        invoiceNumber: schema.invoices.invoiceNumber,
        invoiceR2Key: schema.invoices.r2Key,
      })
      .from(schema.payments)
      .leftJoin(schema.creditPlans, eq(schema.creditPlans.slug, schema.payments.planId))
      .leftJoin(schema.invoices, eq(schema.invoices.paymentId, schema.payments.id))
      .where(eq(schema.payments.userId, req.userId))
      .orderBy(desc(schema.payments.createdAt))
      .limit(100);

    const payments = await Promise.all(
      rows.map(async ({ invoiceR2Key, ...row }) => ({
        ...row,
        invoiceUrl: invoiceR2Key ? (await app.storage.presignGet(invoiceR2Key, 3600)).url : null,
      })),
    );
    return { payments };
  });

  // GET /v1/payments/:id/invoice — redirect to presigned R2 GET URL for payment invoice
  app.get('/v1/payments/:id/invoice', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [payment] = await app.db
      .select({ id: schema.payments.id, userId: schema.payments.userId })
      .from(schema.payments)
      .where(eq(schema.payments.id, id));
    if (!payment) throw new AppError('NOT_FOUND', 404, 'payment not found');
    if (payment.userId !== req.userId) throw new AppError('FORBIDDEN', 403, 'forbidden');

    const [invoice] = await app.db
      .select({ r2Key: schema.invoices.r2Key })
      .from(schema.invoices)
      .where(eq(schema.invoices.paymentId, id));
    if (!invoice) throw new AppError('NOT_FOUND', 404, 'invoice not yet issued');

    const { url } = await app.storage.presignGet(invoice.r2Key, 3600);
    reply.redirect(url);
  });

  // POST /v1/payments/orders — create a Razorpay order server-side
  app.post(
    '/v1/payments/orders',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({ planId: z.string().min(1), gstin: Gstin }),
      },
    },
    async (req) => {
      const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = app.env;
      if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new AppError('NOT_CONFIGURED', 503, 'payments not configured');
      }

      const { planId, gstin } = req.body as { planId: string; gstin?: string };
      const normalizedGstin = gstin?.trim().toUpperCase() || null;
      const [plan] = await app.db
        .select()
        .from(schema.creditPlans)
        .where(and(eq(schema.creditPlans.slug, planId), eq(schema.creditPlans.isActive, true)));
      if (!plan) throw new AppError('NOT_FOUND', 404, 'plan not found or inactive');

      const gstPaise = Math.round(plan.basePaise * GST_RATE);
      const totalPaise = plan.basePaise + gstPaise;

      const rzpOrder = await createRazorpayOrder(
        RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET,
        totalPaise,
        `tryme_${req.userId.slice(0, 8)}`,
      );

      await app.db.insert(schema.payments).values({
        userId: req.userId,
        planId: plan.slug,
        razorpayOrderId: rzpOrder.id,
        basePaise: plan.basePaise,
        gstPaise,
        totalPaise,
        credits: plan.credits,
        gstin: normalizedGstin,
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

  // POST /v1/payments/verify — verify Razorpay signature + credit user
  app.post(
    '/v1/payments/verify',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          razorpayOrderId: z.string().min(1),
          razorpayPaymentId: z.string().min(1),
          razorpaySignature: z.string().min(1),
        }),
      },
    },
    async (req) => {
      const { RAZORPAY_KEY_SECRET } = app.env;
      if (!RAZORPAY_KEY_SECRET) {
        throw new AppError('NOT_CONFIGURED', 503, 'payments not configured');
      }

      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
        razorpayOrderId: string;
        razorpayPaymentId: string;
        razorpaySignature: string;
      };

      // Verify HMAC-SHA256 signature (constant-time to avoid a timing oracle)
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

      // Load the pending payment row — must belong to this user
      const [payment] = await app.db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.razorpayOrderId, razorpayOrderId));

      if (!payment) throw new AppError('NOT_FOUND', 404, 'order not found');
      if (payment.userId !== req.userId) throw new AppError('FORBIDDEN', 403, 'forbidden');
      if (payment.status === 'paid') return { ok: true, alreadyCredited: true };

      // Mark paid + credit user + promote tier atomically.
      // The UPDATE filters on status='created' so only one concurrent caller wins;
      // if updated.length === 0, another call already claimed it.
      let credited = false;
      let creditsGranted = payment.credits;
      await app.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.payments)
          .set({
            status: 'paid',
            razorpayPaymentId,
            razorpaySignature,
            paidAt: new Date(),
          })
          .where(
            and(
              eq(schema.payments.razorpayOrderId, razorpayOrderId),
              eq(schema.payments.status, 'created'),
            ),
          )
          .returning({ id: schema.payments.id });

        if (updated.length === 0) return; // concurrent call already credited — skip

        credited = true;

        creditsGranted = await grantPurchaseCredits(tx, req.userId, payment);

        // Promote the user's tier to this plan's slug so job queue priority kicks in.
        await tx
          .update(schema.users)
          .set({ tier: payment.planId, updatedAt: new Date() })
          .where(eq(schema.users.id, req.userId));
      });

      if (!credited) return { ok: true, alreadyCredited: true };

      const [bal] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, req.userId));

      void maybeSendReceipt(app, req.userId, {
        ...payment,
        razorpayPaymentId,
        paidAt: new Date(),
      });

      return {
        ok: true,
        alreadyCredited: false,
        balance: bal?.balance ?? payment.credits,
        creditsGranted,
      };
    },
  );

  // POST /v1/payments/webhook — Razorpay server-to-server event delivery
  // Must receive the raw request body for HMAC-SHA256 signature verification.
  // Registered in a scoped sub-plugin so the buffer content-type parser doesn't
  // affect any other route.
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    sub.post('/v1/payments/webhook', async (req, reply) => {
      const { RAZORPAY_WEBHOOK_SECRET } = app.env;
      if (!RAZORPAY_WEBHOOK_SECRET) {
        // Webhook secret not configured — acknowledge to avoid Razorpay retries,
        // but log a warning so ops can detect the misconfiguration.
        app.log.warn('RAZORPAY_WEBHOOK_SECRET not set — webhook received but not verified');
        reply.code(200).send({ ok: true });
        return;
      }

      const rawBody = req.body as Buffer;
      const signature = (req.headers['x-razorpay-signature'] as string) ?? '';

      // Verify HMAC-SHA256 over the raw body bytes
      const expected = createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

      const expectedBuf = Buffer.from(expected, 'hex');
      const signatureBuf = Buffer.from(signature, 'hex');
      const valid =
        expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);

      if (!valid) {
        app.log.warn({ signature }, 'razorpay webhook signature mismatch');
        // Return 200 so Razorpay doesn't keep retrying — this is a bad actor request,
        // not a transient failure.
        reply.code(200).send({ ok: false, reason: 'invalid signature' });
        return;
      }

      let event: {
        event: string;
        payload: { payment?: { entity?: { id?: string; order_id?: string; status?: string } } };
      };
      try {
        event = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        app.log.warn('razorpay webhook: failed to parse body as JSON');
        reply.code(200).send({ ok: false, reason: 'invalid json' });
        return;
      }

      const eventType = event.event;
      const paymentEntity = event.payload?.payment?.entity;
      const razorpayPaymentId = paymentEntity?.id;
      const razorpayOrderId = paymentEntity?.order_id;

      app.log.info({ eventType, razorpayOrderId, razorpayPaymentId }, 'razorpay webhook received');

      if (eventType === 'payment.captured' && razorpayOrderId && razorpayPaymentId) {
        const [payment] = await app.db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.razorpayOrderId, razorpayOrderId));

        if (!payment) {
          app.log.error({ razorpayOrderId }, 'razorpay webhook: order not found in DB');
          reply.code(200).send({ ok: true }); // ack regardless to prevent retries
          return;
        }

        if (payment.status === 'paid') {
          app.log.info({ razorpayOrderId }, 'razorpay webhook: already credited — skipping');
          reply.code(200).send({ ok: true });
          return;
        }

        // Idempotent credit grant — conditional UPDATE races safely with /verify.
        let webhookCredited = false;
        await app.db.transaction(async (tx) => {
          const updated = await tx
            .update(schema.payments)
            .set({
              status: 'paid',
              razorpayPaymentId,
              paidAt: new Date(),
            })
            .where(
              and(
                eq(schema.payments.razorpayOrderId, razorpayOrderId),
                eq(schema.payments.status, 'created'),
              ),
            )
            .returning({ id: schema.payments.id });

          if (updated.length === 0) return; // /verify already credited — skip

          webhookCredited = true;

          await grantPurchaseCredits(tx, payment.userId, payment);

          await tx
            .update(schema.users)
            .set({ tier: payment.planId, updatedAt: new Date() })
            .where(eq(schema.users.id, payment.userId));
        });

        if (webhookCredited) {
          app.log.info(
            {
              razorpayOrderId,
              razorpayPaymentId,
              credits: payment.credits,
              userId: payment.userId,
            },
            'razorpay webhook: credits granted',
          );
          void maybeSendReceipt(app, payment.userId, {
            ...payment,
            razorpayPaymentId,
            paidAt: new Date(),
          });
        } else {
          app.log.info(
            { razorpayOrderId },
            'razorpay webhook: already credited by /verify — skipping',
          );
        }
      } else if (eventType === 'payment.failed' && razorpayOrderId) {
        await app.db
          .update(schema.payments)
          .set({ status: 'failed' })
          .where(
            and(
              eq(schema.payments.razorpayOrderId, razorpayOrderId),
              eq(schema.payments.status, 'created'),
            ),
          );
        app.log.info({ razorpayOrderId }, 'razorpay webhook: payment marked failed');
      }

      reply.code(200).send({ ok: true });
    });
  });
}
