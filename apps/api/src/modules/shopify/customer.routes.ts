import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import {
  JOB_SOURCE,
  ShopifyCustomerJobRequest,
  ShopifyCustomerPhotoPreviewRequest,
  ShopifyCustomerPresignRequest,
} from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  RouteShorthandOptions,
} from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { atomicDeductStore, refundStoreAndMarkFailed } from '../credits/shopify-ledger.js';
import { resolveEffectiveEnabled } from './activation.js';
import { runRefill } from './autorefill.js';
import { mintAccountLinkCode } from './customer-auth.js';
import {
  checkShopperLimits,
  type LimitRefusal,
  lockAndRecheckShopperLimits,
  reserveStoreDailySlot,
  ShopperLimitRaceRefusal,
} from './limits.js';
import { resolveShopper } from './shopper.js';

const SLOT_RELEASE_MAX_ATTEMPTS = 3;
const SLOT_RELEASE_RETRY_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Release a reserved store-daily-cap slot with bounded retries.
 *
 * A transient DECR failure must not permanently leak a reserved slot — the
 * 48h key expiry is the only other backstop, and that's a full day-plus of
 * lost capacity for one blip. `slot.release()` is already idempotent (see
 * `reserveStoreDailySlot`), so retrying it after a failure is always safe:
 * we're never at risk of double-releasing, only of giving up too early.
 * Exhausting retries is logged and swallowed rather than thrown — a release
 * failure must never mask the response the caller was already producing
 * (a refusal or a compensated failure).
 */
async function releaseSlotWithRetry(
  slot: { release: () => Promise<void> },
  log: FastifyBaseLogger,
  jobId?: string,
): Promise<void> {
  for (let attempt = 1; attempt <= SLOT_RELEASE_MAX_ATTEMPTS; attempt++) {
    try {
      await slot.release();
      return;
    } catch (err) {
      if (attempt === SLOT_RELEASE_MAX_ATTEMPTS) {
        log.error(
          { err, jobId, attempts: attempt },
          'shopify store daily slot release failed after retries — slot will remain reserved until the 48h key expiry',
        );
        return;
      }
      await sleep(SLOT_RELEASE_RETRY_DELAY_MS * attempt);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: lazy import avoids circular dependency with service.js
let _enqueueSync: ((...args: any[]) => Promise<void>) | null = null;
async function getEnqueueSync() {
  if (!_enqueueSync) {
    const mod = await import('./service.js');
    _enqueueSync = mod.enqueueSync;
  }
  if (!_enqueueSync) throw new AppError('INTERNAL', 500, 'Failed to load sync module');
  return _enqueueSync;
}

async function checkRateLimit(redis: Redis, storeId: string, reply: FastifyReply) {
  const key = `shopify:customer:rl:${storeId}`;
  const [[, count], [, ttl]] = (await redis.pipeline().incr(key).ttl(key).exec()) as [
    [null, number],
    [null, number],
  ];
  if (ttl === -1) await redis.expire(key, 60);
  if (count > 60) {
    reply.header('Retry-After', Math.max(0, ttl === -1 ? 60 : ttl).toString());
    throw new AppError('RATE_LIMITED', 429, 'rate limit exceeded');
  }
}

/**
 * Record a refusal the shopper actually saw.
 *
 * Deliberately NOT inside limits.ts, despite the design doc suggesting it:
 * `checkShopperLimits` runs twice per request — once as a fast path and again
 * inside the job transaction via `lockAndRecheckShopperLimits` — so an insert
 * there would double-count, and the transactional call rolls back on refusal
 * anyway. `reserveStoreDailySlot` has no db handle at all. The three points
 * where a 202 reaches the shopper are unambiguous, and this is called from
 * exactly those.
 *
 * Best-effort: a failed analytics write must never turn a soft refusal into a
 * 500.
 */
const REFUSAL_EVENT_TYPE: Record<LimitRefusal['reason'], string> = {
  email_required: 'refused_email_gate',
  shopper_limit: 'refused_shopper_cap',
  store_limit: 'refused_store_cap',
};

async function recordRefusal(
  app: FastifyInstance,
  storeId: string,
  reason: LimitRefusal['reason'],
  clientId: string | null,
  shopifyProductId: number | null,
): Promise<void> {
  try {
    await app.db.insert(schema.shopifyWidgetEvents).values({
      storeId,
      clientId,
      shopifyProductId,
      type: REFUSAL_EVENT_TYPE[reason],
    });
  } catch (err) {
    app.log.warn({ err, storeId, reason }, 'shopify refusal event not recorded');
  }
}

function writeSseHeaders(reply: FastifyReply): void {
  // reply.raw.writeHead() below bypasses Fastify's own reply pipeline
  // entirely, so anything set via reply.header() — notably @fastify/cors's
  // Access-Control-Allow-Origin, computed in its onRequest hook — never
  // reaches the socket unless copied over here first. Without this, the
  // browser gets a 200 with no CORS header and blocks the shopper's
  // cross-origin widget from reading the stream. setHeader (not writeHead)
  // so these merge with, rather than fight, the headers below.
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(key, value);
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * Confirms this store's own credit balance can afford one try-on job. Throws
 * INSUFFICIENT_CREDITS (402) either way — the widget shows the same generic
 * message for "never granted a balance" and "balance too low".
 */
async function requireStoreHasCredits(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  jobCost: number,
): Promise<void> {
  const [credits] = await app.db
    .select({ balance: schema.shopifyStoreCredits.balance })
    .from(schema.shopifyStoreCredits)
    .where(eq(schema.shopifyStoreCredits.storeId, store.id));
  if (!credits || credits.balance < jobCost) {
    throw new AppError('INSUFFICIENT_CREDITS', 402, 'insufficient credits');
  }
}

/**
 * The workflow every Shopify try-on runs. Resolved here, at creation, and pinned
 * onto job_inputs.params so the dispatcher never has to look it up again — and so
 * an admin promoting a different default mid-flight cannot change the workflow
 * under a job whose credits are already deducted.
 *
 * Returning null means no active default is configured at all, which is a system
 * misconfiguration rather than anything the merchant did. The caller refuses the
 * job before deducting credits: enqueueing would burn a credit and produce a
 * FAILED row with NO_WORKFLOW_CONFIGURED for something no merchant can fix.
 */
async function resolveWorkflowTemplate(
  app: FastifyInstance,
): Promise<{ workflowTemplateId: string; version: number | null } | null> {
  const [row] = await app.db
    .select({
      workflowTemplateId: schema.shopifyFunnelTemplates.workflowTemplateId,
      version: schema.workflowTemplates.version,
    })
    .from(schema.shopifyFunnelTemplates)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.shopifyFunnelTemplates.workflowTemplateId),
    )
    .where(
      and(
        eq(schema.shopifyFunnelTemplates.isDefault, true),
        eq(schema.shopifyFunnelTemplates.isActive, true),
      ),
    )
    .limit(1);
  if (!row?.workflowTemplateId) return null;
  return { workflowTemplateId: row.workflowTemplateId, version: row.version };
}

/**
 * Checks whether an R2 key belongs to this store and is still an active upload.
 * Returns true if both checks pass, false otherwise.
 */
async function isCustomerPhotoOwnedByStore(
  app: FastifyInstance,
  storeId: string,
  r2Key: string,
): Promise<boolean> {
  if (!r2Key.startsWith(`shopify-inputs/${storeId}/`)) return false;
  const owner = await app.redis.get(`shopify:upload:${r2Key}`);
  return owner === storeId;
}

const DIRECT_PREFIX = '/v1/shopify/customer';
// SEC-7.1: routes also registered here (see registerProxied below) are reachable
// through Shopify's App Proxy, which HMAC-signs every forwarded request itself —
// no client-supplied secret to steal, unlike the legacy X-Widget-Key path.
// shopify.app.toml's [app_proxy] maps a storefront-relative path to this prefix.
// Not applied to the SSE events route: App Proxy's behavior for a long-lived
// streaming response isn't documented and hasn't been verified against a live
// Shopify store — that route stays on the legacy path only.
const PROXY_PREFIX = '/v1/shopify/proxy/customer';

/** Registers `handler` at both its direct path and the App Proxy-forwarded
 *  path — same preHandler either way, since requireShopifyStoreKey accepts
 *  both the App Proxy signature and the legacy X-Widget-Key. */
function registerProxied(
  app: FastifyInstance,
  method: 'get' | 'post',
  suffix: string,
  opts: RouteShorthandOptions,
  handler: RouteHandlerMethod,
) {
  app[method](`${DIRECT_PREFIX}${suffix}`, opts, handler);
  app[method](`${PROXY_PREFIX}${suffix}`, opts, handler);
}

export async function shopifyCustomerRoutes(app: FastifyInstance) {
  app.post('/v1/shopify/customer/account/link', { preHandler: app.requireUser }, async (req) => {
    const code = await mintAccountLinkCode(app.redis, req.userId);
    return { code };
  });

  registerProxied(
    app,
    'post',
    '/presign',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req: FastifyRequest, reply: FastifyReply) =>
          checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerPresignRequest },
    },
    async (req) => {
      const storeId = req.shopifyStoreId as string;
      const { contentType, contentLength } = req.body as ShopifyCustomerPresignRequest;
      if (!contentType.startsWith('image/')) {
        throw new AppError('VALIDATION', 400, 'Content type must be image/*');
      }
      // No image extension on the key — Cloudflare's Hotlink Protection pattern-matches
      // image extensions in the path regardless of method and false-positives this
      // presigned PUT/OPTIONS as an image hotlink. Content-Type is passed separately
      // to presignPut and stored as the object's actual Content-Type header.
      const key = `shopify-inputs/${storeId}/${randomUUID()}/photo`;
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`shopify:upload:${key}`, storeId, 'EX', 600);
      return { uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  registerProxied(
    app,
    'post',
    '/photo/preview',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req: FastifyRequest, reply: FastifyReply) =>
          checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerPhotoPreviewRequest },
    },
    async (req) => {
      const storeId = req.shopifyStoreId as string;
      const { r2Key } = req.body as ShopifyCustomerPhotoPreviewRequest;

      if (!(await isCustomerPhotoOwnedByStore(app, storeId, r2Key))) {
        throw new AppError('NOT_FOUND', 404, 'photo not available');
      }

      const { url, expiresIn } = await app.storage.presignGet(r2Key, 300);
      return { previewUrl: url, expiresIn };
    },
  );

  registerProxied(
    app,
    'post',
    '/jobs',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req: FastifyRequest, reply: FastifyReply) =>
          checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerJobRequest },
    },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const store = req.shopifyStoreRow as typeof schema.shopifyStores.$inferSelect;

      const jobCost = await getTryonCreditCost(app);
      await requireStoreHasCredits(app, store, jobCost);

      const {
        customerPhotoKey,
        shopifyProductId,
        clientId,
        shopifyCustomerId,
        email,
        emailConsent,
      } = req.body as {
        customerPhotoKey: string;
        shopifyProductId: number;
        clientId?: string;
        shopifyCustomerId?: number;
        email?: string;
        emailConsent?: boolean;
      };

      if (!(await isCustomerPhotoOwnedByStore(app, storeId, customerPhotoKey))) {
        throw new AppError('FORBIDDEN', 403, 'upload session expired or not owned');
      }

      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      const maxCustomerPhotoBytes = await getUploadLimitBytes(app, 'shopifyCustomerPhotoMaxBytes');
      if (photoHead.contentLength > maxCustomerPhotoBytes) {
        // BAD_UPLOAD at 413 here, 400 above: matches the same code covering
        // both "file missing/corrupt" and "file too large" used identically
        // across upload-ownership.ts, merchant/upload-guard.ts,
        // merchant/upload-sessions.routes.ts, admin/demo-upload-guard.ts —
        // an established convention, not something to diverge from here.
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${maxCustomerPhotoBytes / (1024 * 1024)}MB limit`,
        );
      }

      const [garment] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
            eq(schema.shopifyProductGarments.status, 'active'),
          ),
        )
        .limit(1);

      if (!garment) {
        const enq = await getEnqueueSync();
        await enq(app.redis, { storeId, mode: 'product', shopifyProductId });
        return reply
          .code(202)
          .send({ message: "We're preparing this product for try-on. Check back in a moment." });
      }
      const effectivelyEnabled = await resolveEffectiveEnabled(app, store, garment);
      if (!effectivelyEnabled) {
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }

      const resolvedWorkflow = await resolveWorkflowTemplate(app);
      if (!resolvedWorkflow) {
        // error, not warn: after the funnel removal this can only mean no active
        // default template exists, which is ours to fix, not the merchant's. The
        // shopper still sees the same soft message as a disabled product — no
        // internal state leaks to the storefront.
        app.log.error(
          { storeId, shopifyProductId, garmentId: garment.id },
          'shopify try-on blocked before enqueue: no active default funnel template is configured',
        );
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }
      const workflowTemplateId = resolvedWorkflow.workflowTemplateId;

      // Deployed widget versions did not send clientId. They still receive the
      // store cap, while shopper-specific limits wait until an identity exists.
      let shopper: Awaited<ReturnType<typeof resolveShopper>> | null = null;
      if (clientId) {
        shopper = await resolveShopper(app, storeId, {
          clientId,
          shopifyCustomerId: shopifyCustomerId ?? null,
          email: email ?? null,
        });
        if (email && emailConsent && !shopper.emailConsent) {
          await app.db
            .update(schema.shopifyShoppers)
            .set({ emailConsent: true })
            .where(eq(schema.shopifyShoppers.id, shopper.id));
          shopper = { ...shopper, emailConsent: true };
        }

        // Fast path only — see lockAndRecheckShopperLimits for why this alone
        // does not close the per-shopper race. This just avoids reserving a
        // store slot and opening a transaction for a request that's already
        // over quota with no possibility of a concurrent winner.
        const refusal = await checkShopperLimits(app.db, store, shopper);
        if (refusal) {
          await recordRefusal(app, storeId, refusal.reason, clientId ?? null, shopifyProductId);
          return reply.code(202).send(refusal);
        }
      }

      const slot = await reserveStoreDailySlot(app, store);
      if (!slot.ok) {
        await recordRefusal(app, storeId, 'store_limit', clientId ?? null, shopifyProductId);
        return reply
          .code(202)
          .send({ reason: 'store_limit', message: "Try-on isn't available right now." });
      }

      const jobId = randomUUID();
      let jobCommitted = false;

      try {
        await app.db.transaction(async (tx) => {
          if (shopper) {
            // Serializes this shopper's requests: acquires a transaction-scoped
            // advisory lock on (store, counting identity) and rechecks the
            // limit under it, immediately before the job insert below. Throws
            // ShopperLimitRaceRefusal (caught below, rolling this transaction
            // back) if a concurrent request already consumed the slot between
            // the fast-path check above and this recheck.
            await lockAndRecheckShopperLimits(tx as never, store, shopper);
          }
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers non-null for nullable FKs. The plan explicitly notes this is the intended pattern.
          await (tx.insert(schema.jobs).values as any)({
            id: jobId,
            shopifyStoreId: storeId,
            shopifyShopperId: shopper?.id ?? null,
            customerPhotoKey,
            status: 'QUEUED',
            creditsCharged: jobCost,
            source: JOB_SOURCE.SHOPIFY,
          });
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers non-null for nullable FKs. The plan explicitly notes this is the intended pattern.
          await (tx.insert(schema.jobInputs).values as any)({
            jobId,
            upperGarmentKey: garment.r2Key,
            faceId: null,
            backgroundId: null,
            poseId: null,
            params: {
              kind: 'shopify',
              shopifyProductId,
              // Resolved above and pinned here so the dispatcher trusts it rather
              // than re-resolving — a default promoted mid-flight can't change the
              // workflow under a job whose credits are already deducted.
              workflowTemplateId,
              dispatchTemplateVersion: resolvedWorkflow.version ?? null,
            },
          });
          await atomicDeductStore(tx as never, storeId, jobCost, jobId);
        });
        jobCommitted = true;

        // Fired after the transaction commits and deliberately NOT awaited: a
        // shopper is waiting on this request, and a Shopify round trip has no
        // business being in their critical path. The hourly sweep in
        // alert-scheduler.ts is the safety net if this process dies before the
        // promise settles, so losing it costs at most an hour, never a charge.
        if (store.autorefillStatus === 'ACTIVE') {
          void runRefill(app, store).catch((err) => {
            app.log.error({ err, storeId }, 'auto-refill after job dispatch failed');
          });
        }

        // Extends the presign-time ownership marker (originally EX 600, matching the
        // presigned URL's own expiry) to 24h now that the photo has proven itself real
        // and usable — this is what lets a returning shopper reuse it for a different
        // product without re-uploading. Idempotent: re-extends on every reuse too.
        await app.redis.set(`shopify:upload:${customerPhotoKey}`, storeId, 'EX', 86400);

        await app.redis.xadd(
          'jobs:normal',
          'MAXLEN',
          '~',
          10000,
          '*',
          'jobId',
          jobId,
          'type',
          'WIDGET_TRYON',
        );
      } catch (err) {
        if (err instanceof ShopperLimitRaceRefusal) {
          // Transaction already rolled back — no job, no deducted credit.
          // Only the store slot (reserved before the transaction) needs
          // releasing. The event insert happens after the rollback too, so a
          // failed write can never be undone by it.
          await releaseSlotWithRetry(slot, app.log);
          await recordRefusal(app, storeId, err.refusal.reason, clientId ?? null, shopifyProductId);
          return reply.code(202).send(err.refusal);
        }

        try {
          if (jobCommitted) {
            app.log.error(
              { err, jobId },
              'redis enqueue preparation failed — job will be refunded',
            );
            // Prepaid path: one atomic, idempotent transaction — the refund,
            // its ledger entry, and the FAILED transition either all land or
            // none do — see refundStoreAndMarkFailed for why the old
            // two-step version could leave a partially-compensated job after
            // a crash.
            const { compensated } = await refundStoreAndMarkFailed(
              app.db,
              storeId,
              jobCost,
              jobId,
              'REFUND_ENQUEUE_FAIL',
              'ENQUEUE_FAIL',
            );
            if (!compensated) {
              // The XADD looked like it failed but actually landed: the
              // dispatcher already picked the job up and moved it past QUEUED
              // while we were in here. Not refunding is the right outcome —
              // the generation is running or done — but the shopper's client
              // still got a 503 from us for a job that will complete. Rare and
              // expected; logged so it can be correlated if a shopper reports
              // a "failed" try-on that produced an image anyway.
              app.log.warn(
                { jobId },
                'enqueue looked failed but job already left QUEUED — refund skipped to avoid double-paying a delivered generation',
              );
            }
          }
        } finally {
          await releaseSlotWithRetry(slot, app.log, jobId);
        }

        if (!jobCommitted) throw err;
        throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
      }

      return reply.code(201).send({ jobId });
    },
  );

  registerProxied(
    app,
    'get',
    '/jobs/:id',
    { preHandler: app.requireShopifyStoreKey },
    async (req) => {
      const storeId = req.shopifyStoreId as string;
      const { id } = req.params as { id: string };

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          shopifyStoreId: schema.jobs.shopifyStoreId,
          resultKey: schema.jobOutputs.resultKey,
          errorCode: schema.jobs.errorCode,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobs.id, schema.jobOutputs.jobId))
        .where(eq(schema.jobs.id, id))
        .limit(1);

      if (!job || job.shopifyStoreId !== storeId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }
      return {
        id: job.id,
        status: job.status,
        errorCode: job.errorCode,
        resultUrl: job.resultKey ? (await app.storage.presignGet(job.resultKey, 3600)).url : null,
      };
    },
  );

  app.get(
    '/v1/shopify/customer/jobs/:id/events',
    { preHandler: app.requireShopifyStoreKey },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const { id } = req.params as { id: string };

      const [job] = await app.db
        .select({ id: schema.jobs.id, shopifyStoreId: schema.jobs.shopifyStoreId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id))
        .limit(1);
      if (!job || job.shopifyStoreId !== storeId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }
      writeSseHeaders(reply);
      const sub: Redis = app.redisSub.duplicate();
      const channel = `sse:events:store:${storeId}`;
      sub.on('error', (err) => req.log.warn({ err, channel }, 'sse subscriber error'));
      await sub.subscribe(channel);
      sub.on('message', (_ch, raw) => {
        try {
          const evt = JSON.parse(raw) as Record<string, unknown>;
          if (evt.jobId !== id) return;
          reply.raw.write(`event: ${evt.type ?? 'message'}\ndata: ${raw}\n\n`);
        } catch {
          /* ignore malformed publish */
        }
      });
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
      req.raw.on('close', async () => {
        clearInterval(heartbeat);
        try {
          await sub.unsubscribe(channel);
        } catch {
          /* connection may already be closed */
        }
        sub.disconnect();
      });
    },
  );
}
