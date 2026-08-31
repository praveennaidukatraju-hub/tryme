# Shopify Storefront Widget: Bill Merchant, Not Shopper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every try-on generation on a merchant's Shopify storefront is billed against the merchant's own tryme credit balance (`shopifyStores.ownerUserId`'s credits) instead of requiring the shopper to log into their own tryme account.

**Architecture:** `POST /v1/shopify/customer/jobs` drops its shopper-JWT requirement and instead resolves credits from `store.ownerUserId`; job ownership checks for status/SSE polling move from shopper `userId` to `shopifyStoreId`; the storefront widget drops its entire signin/token/account-link UI and goes straight from button click to photo upload.

**Tech Stack:** Fastify 5, Drizzle ORM, Vitest (no testcontainers — reuses running `pnpm docker:up` infra), vanilla JS (Shopify theme app extension), Shopify Liquid.

## Global Constraints

- No new DB migration — `shopifyStores.ownerUserId` already exists.
- Tests: Vitest, no testcontainers. `pnpm docker:up` must already be running before any `pnpm test` in this plan.
- Biome pre-commit hook (lefthook) runs on every commit — new/modified `.ts`/`.js` files must pass `pnpm biome check --write` before committing.
- Commit frequently, one commit per task.
- Every task ends with `pnpm --filter @tryme/api typecheck` clean and the relevant test file green before moving to the next task.

---

## Task 1: API — bill the merchant's credits, drop shopper auth

**Files:**
- Modify: `apps/api/src/modules/shopify/customer-auth.ts` (delete `signShopifyAccountToken`, `verifyShopifyAccountToken`)
- Modify: `apps/api/src/modules/shopify/customer-auth.test.ts` (delete the two tests covering the deleted functions)
- Modify: `apps/api/src/modules/shopify/customer.routes.ts` (drop shopper-token requirement; bill `store.ownerUserId`; scope job reads by `shopifyStoreId`; delete the `/account/exchange` route)
- Modify: `apps/api/test/integration/shopify-customer.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `atomicDeduct(db, userId, amount, jobId)` from `apps/api/src/modules/credits/ledger.ts` (unchanged signature) — now called with `store.ownerUserId` instead of a shopper's userId.
- Consumes: `req.shopifyStoreId: string | undefined` and `req.shopifyStoreRow: typeof schema.shopifyStores.$inferSelect | undefined`, decorated by the existing `requireShopifyStoreKey` preHandler (`apps/api/src/plugins/shopify-widget-auth.ts`) — unchanged.
- Produces: a new local helper `requireStoreOwnerWithCredits(app, store, jobCost): Promise<string>` in `customer.routes.ts` that throws `AppError('INSUFFICIENT_CREDITS', 402, ...)` when the store has no linked owner or the owner's balance is below `jobCost`, otherwise returns `store.ownerUserId` as a `string`. Task 2 (the widget) relies on the API returning HTTP 402 for both of these cases, and on the `GET /jobs/:id` response shape being exactly `{ id, status, errorCode, resultUrl }`.

### Step 1: Trim `customer-auth.ts` — remove the shopper-token functions

Read the current file first (`apps/api/src/modules/shopify/customer-auth.ts`) to confirm it still matches this exactly before editing — it should be unchanged since this session's earlier merchant-link work only added `signShopifyAccountToken`/`verifyShopifyAccountToken` were already there, it did not touch them.

Replace the entire file content with:

```ts
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LINK_CODE_TTL_SECS = 60;

export async function mintAccountLinkCode(redis: Redis, userId: string): Promise<string> {
  const code = randomUUID();
  await redis.set(`shopify:link:${code}`, userId, 'EX', LINK_CODE_TTL_SECS);
  return code;
}

export async function resolveAccountLinkCode(redis: Redis, code: string): Promise<string | null> {
  const key = `shopify:link:${code}`;
  const userId = await redis.get(key);
  if (userId) await redis.del(key);
  return userId;
}
```

This drops `signAccess`/`verifyAccess`/`AppError` imports and the `ACCOUNT_TOKEN_AUDIENCE`/`ACCOUNT_TOKEN_EXPIRY` constants along with the two functions — none of them are used by `mintAccountLinkCode`/`resolveAccountLinkCode`.

- [ ] **Step 1a: Make the edit above.**

### Step 2: Trim `customer-auth.test.ts` to match

Replace the entire file content with:

```ts
import Redis from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { mintAccountLinkCode, resolveAccountLinkCode } from './customer-auth.js';

describe('shopify customer account link', () => {
  it('mints a one-time code that resolves to the userId once, then is gone', async () => {
    const redis = new Redis();
    const userId = 'user-123';
    const code = await mintAccountLinkCode(redis as never, userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBe(userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBeNull();
  });
});
```

- [ ] **Step 2a: Make the edit above.**

### Step 3: Run this test file to confirm it still passes

```bash
pnpm --filter @tryme/api test -- customer-auth
```

Expected: 1 test, PASS.

- [ ] **Step 3a: Run and confirm PASS.**

### Step 4: Write the new integration test file (will fail against current `customer.routes.ts`)

Replace the entire content of `apps/api/test/integration/shopify-customer.test.ts` with:

```ts
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('shopify customer routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  async function seedOwner(balance: number) {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `owner-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Store Owner',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance });
    return user;
  }

  async function seedStore(ownerUserId: string | null) {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId,
      })
      .returning();
    return store;
  }

  async function seedGarment(storeId: string, shopifyProductId: number) {
    const [garment] = await app.db
      .insert(schema.shopifyProductGarments)
      .values({
        storeId,
        shopifyProductId,
        r2Key: `shopify-garments/${storeId}/${shopifyProductId}/garment.jpg`,
        title: 'Test Product',
        status: 'active',
        enabled: true,
      })
      .returning();
    return garment;
  }

  async function uploadCustomerPhoto(storeKey: string, bytes: Buffer) {
    const presign = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/presign',
      headers: { 'x-widget-key': storeKey },
      payload: { contentType: 'image/jpeg', contentLength: bytes.length },
    });
    expect(presign.statusCode).toBe(200);
    const { uploadUrl, r2Key } = presign.json() as { uploadUrl: string; r2Key: string };
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);
    return r2Key;
  }

  it('rejects presign without a store key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/presign',
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the account/exchange route no longer exists', async () => {
    const store = await seedStore(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/account/exchange',
      headers: { 'x-widget-key': store.storeKey },
      payload: { code: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects job creation when the store has no linked owner', async () => {
    const store = await seedStore(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: 'shopify-inputs/x/photo.jpg', shopifyProductId: 1 },
    });
    expect(res.statusCode).toBe(402);
  });

  it('rejects job creation when the owner has insufficient credits', async () => {
    const owner = await seedOwner(0);
    const store = await seedStore(owner.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: 'shopify-inputs/x/photo.jpg', shopifyProductId: 1 },
    });
    expect(res.statusCode).toBe(402);
  });

  it('creates a job billed to the store owner and deducts their credits, needing no shopper auth at all', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 7);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 7 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBe(owner.id);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, owner.id));
    expect(credits.balance).toBeLessThan(100);
  });

  it('scopes job status/events by store, not by shopper identity', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const otherStore = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 9);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 9 },
    });
    expect(createRes.statusCode).toBe(201);
    const { jobId } = createRes.json() as { jobId: string };

    const ownRes = await app.inject({
      method: 'GET',
      url: `/v1/shopify/customer/jobs/${jobId}`,
      headers: { 'x-widget-key': store.storeKey },
    });
    expect(ownRes.statusCode).toBe(200);
    const ownBody = ownRes.json();
    expect(ownBody).toHaveProperty('id', jobId);
    expect(ownBody).toHaveProperty('status');
    expect(ownBody).toHaveProperty('resultUrl');
    expect(ownBody).not.toHaveProperty('shopifyStoreId');

    const otherRes = await app.inject({
      method: 'GET',
      url: `/v1/shopify/customer/jobs/${jobId}`,
      headers: { 'x-widget-key': otherStore.storeKey },
    });
    expect(otherRes.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4a: Make the edit above.**

### Step 5: Run the new test file to confirm it fails against the current implementation

```bash
pnpm --filter @tryme/api test -- shopify-customer.test.ts
```

Expected: FAIL. The "account/exchange route no longer exists" test fails (still 200/401, not 404 — route still registered). The "no linked owner"/"insufficient credits" tests fail (still 401, since `requireAccountUserId` runs first). The "billed to owner" test fails (still 401). Confirms the tests correctly exercise unimplemented behavior.

- [ ] **Step 5a: Run and confirm FAIL for the reasons above.**

### Step 6: Rewrite `customer.routes.ts`

Replace the entire content of `apps/api/src/modules/shopify/customer.routes.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { ShopifyCustomerJobRequest, ShopifyCustomerPresignRequest } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicDeduct } from '../credits/ledger.js';
import { mintAccountLinkCode } from './customer-auth.js';

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

function writeSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

/**
 * Resolves which tryme account bills this store's try-on jobs and confirms
 * that account can afford one. Throws INSUFFICIENT_CREDITS (402) for both an
 * unlinked store and a merchant who's actually out of credits — the widget
 * shows the same generic message either way.
 */
async function requireStoreOwnerWithCredits(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  jobCost: number,
): Promise<string> {
  if (!store.ownerUserId) {
    throw new AppError('INSUFFICIENT_CREDITS', 402, 'Store is not linked to a billing account');
  }
  const [credits] = await app.db
    .select({ balance: schema.userCredits.balance })
    .from(schema.userCredits)
    .where(eq(schema.userCredits.userId, store.ownerUserId));
  if (!credits || credits.balance < jobCost) {
    throw new AppError('INSUFFICIENT_CREDITS', 402, 'insufficient credits');
  }
  return store.ownerUserId;
}

export async function shopifyCustomerRoutes(app: FastifyInstance) {
  app.post('/v1/shopify/customer/account/link', { preHandler: app.requireUser }, async (req) => {
    const code = await mintAccountLinkCode(app.redis, req.userId);
    return { code };
  });

  app.post(
    '/v1/shopify/customer/presign',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req, reply) => checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerPresignRequest },
    },
    async (req) => {
      const storeId = req.shopifyStoreId as string;
      const { contentType, contentLength } = req.body as ShopifyCustomerPresignRequest;
      if (!contentType.startsWith('image/')) {
        throw new AppError('VALIDATION', 400, 'Content type must be image/*');
      }
      const ext = contentType.split('/')[1] ?? 'jpg';
      const key = `shopify-inputs/${storeId}/${randomUUID()}/photo.${ext}`;
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`shopify:upload:${key}`, storeId, 'EX', 600);
      return { uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.post(
    '/v1/shopify/customer/jobs',
    {
      preHandler: [
        app.requireShopifyStoreKey,
        async (req, reply) => checkRateLimit(app.redis, req.shopifyStoreId as string, reply),
      ],
      schema: { body: ShopifyCustomerJobRequest },
    },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const store = req.shopifyStoreRow as typeof schema.shopifyStores.$inferSelect;

      const jobCost = await getTryonCreditCost(app);
      const userId = await requireStoreOwnerWithCredits(app, store, jobCost);

      const { customerPhotoKey, shopifyProductId } = req.body as {
        customerPhotoKey: string;
        shopifyProductId: number;
      };

      if (!customerPhotoKey.startsWith(`shopify-inputs/${storeId}/`)) {
        throw new AppError('FORBIDDEN', 403, 'customer photo key does not belong to this store');
      }
      const uploadOwner = await app.redis.get(`shopify:upload:${customerPhotoKey}`);
      if (uploadOwner !== storeId) {
        throw new AppError('FORBIDDEN', 403, 'upload session expired or not owned');
      }

      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      if (photoHead.contentLength > 5 * 1024 * 1024) {
        throw new AppError('BAD_UPLOAD', 413, 'uploaded photo exceeds 5MB limit');
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
      if (!garment.enabled) {
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }

      const jobId = randomUUID();

      await app.db.transaction(async (tx) => {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers non-null for nullable FKs. The plan explicitly notes this is the intended pattern.
        await (tx.insert(schema.jobs).values as any)({
          id: jobId,
          userId,
          shopifyStoreId: storeId,
          customerPhotoKey,
          status: 'QUEUED',
          creditsCharged: jobCost,
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
            workflowTemplateId: store.settings?.workflowTemplateId,
          },
        });
        await atomicDeduct(tx as never, userId, jobCost, jobId);
      });

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

      return reply.code(201).send({ jobId });
    },
  );

  app.get(
    '/v1/shopify/customer/jobs/:id',
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
        resultUrl: job.resultKey ? app.storage.publicUrl(job.resultKey) : null,
      };
    },
  );

  app.get(
    '/v1/shopify/customer/jobs/:id/events',
    { preHandler: app.requireShopifyStoreKey },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const store = req.shopifyStoreRow as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };

      const [job] = await app.db
        .select({ id: schema.jobs.id, shopifyStoreId: schema.jobs.shopifyStoreId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id))
        .limit(1);
      if (!job || job.shopifyStoreId !== storeId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }
      if (!store.ownerUserId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }

      writeSseHeaders(reply);
      const sub: Redis = app.redisSub.duplicate();
      const channel = `sse:events:${store.ownerUserId}`;
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
```

- [ ] **Step 6a: Make the edit above.**

### Step 7: Run the test file again — confirm it passes

```bash
pnpm --filter @tryme/api test -- shopify-customer.test.ts
```

Expected: 6 tests, all PASS.

- [ ] **Step 7a: Run and confirm PASS.**

### Step 8: Typecheck the whole API

```bash
pnpm --filter @tryme/api typecheck
```

Expected: clean, no errors. (This will surface anything referencing the deleted `signShopifyAccountToken`/`verifyShopifyAccountToken`/`requireAccountUserId` outside the files touched above — grep confirmed during design that nothing else references them, but typecheck is the authoritative check.)

- [ ] **Step 8a: Run and confirm clean.**

### Step 9: Run the full API test suite once to catch any other regression

```bash
pnpm --filter @tryme/api test
```

Expected: all suites PASS (no other test file references the deleted routes/functions per this session's earlier grep, but this confirms it).

- [ ] **Step 9a: Run and confirm PASS.**

### Step 10: Biome + commit

```bash
pnpm biome check --write apps/api/src/modules/shopify/customer.routes.ts apps/api/src/modules/shopify/customer-auth.ts apps/api/src/modules/shopify/customer-auth.test.ts apps/api/test/integration/shopify-customer.test.ts
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/src/modules/shopify/customer-auth.ts apps/api/src/modules/shopify/customer-auth.test.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "$(cat <<'EOF'
feat(api): bill shopify try-on to the merchant's own credits, not the shopper's

Drops the shopper account-link/JWT requirement from job creation entirely;
jobs.userId is now store.ownerUserId, and job status/SSE reads are scoped
by shopifyStoreId instead of a shopper identity that no longer exists.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10a: Run the commands above.**

---

## Task 2: Storefront widget — drop the shopper signin gate

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`

**Interfaces:**
- Consumes: `POST /v1/shopify/customer/jobs` now returns 402 (no shopper auth needed) instead of 401 for the "not linked/no credits" case — per Task 1.
- Consumes: `GET /v1/shopify/customer/jobs/:id` response shape `{ id, status, errorCode, resultUrl }` — per Task 1, unchanged field names the widget already reads (`status`, `resultUrl`).
- Produces: no new interface — this is the outermost consumer in the chain.

There is no automated test harness for this vanilla-JS theme extension in this repo (no browser test runner configured for `apps/shopify-extension`). Verification for this task is Biome (syntax/lint) plus a manual checklist, not `pnpm test`.

### Step 1: Rewrite `tryon-widget.js`

Replace the entire content of `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js` with:

```js
(() => {
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const SSE_MAX_WAIT_MS = 6 * 60 * 1000;
  const SSE_RECONNECT_DELAY_MS = 1000;

  function initWidget(root) {
    const widgetKey = root.dataset.widgetKey;
    const productId = Number(root.dataset.productId);
    const apiBase = root.dataset.apiBase.replace(/\/$/, '');

    const button = root.querySelector('.tryme-tryon__button');
    const modal = root.querySelector('.tryme-tryon__modal');
    const closeBtn = root.querySelector('.tryme-tryon__close');
    const fileInput = root.querySelector('.tryme-tryon__file-input');
    const steps = {
      upload: root.querySelector('.tryme-tryon__step--upload'),
      progress: root.querySelector('.tryme-tryon__step--progress'),
      pending: root.querySelector('.tryme-tryon__step--pending'),
      result: root.querySelector('.tryme-tryon__step--result'),
      error: root.querySelector('.tryme-tryon__step--error'),
    };
    const resultImage = root.querySelector('.tryme-tryon__result-image');

    function showStep(name) {
      for (const key in steps) {
        if (steps[key]) steps[key].hidden = key !== name;
      }
    }

    function openModal() {
      modal.hidden = false;
      showStep('upload');
      fileInput.value = '';
    }

    function closeModal() {
      modal.hidden = true;
    }

    async function uploadPhoto(file) {
      const presignRes = await fetch(`${apiBase}/v1/shopify/customer/presign`, {
        method: 'POST',
        headers: { 'x-widget-key': widgetKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
      });
      if (!presignRes.ok) throw new Error('presign failed');
      const body = await presignRes.json();
      const uploadUrl = body.uploadUrl;
      const r2Key = body.r2Key;

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error('upload failed');
      return r2Key;
    }

    async function createJob(customerPhotoKey) {
      const res = await fetch(`${apiBase}/v1/shopify/customer/jobs`, {
        method: 'POST',
        headers: {
          'x-widget-key': widgetKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shopifyProductId: productId, customerPhotoKey: customerPhotoKey }),
      });
      if (res.status === 402) {
        showStep('error');
        const errorStep = steps.error;
        if (errorStep) {
          errorStep.querySelector('p').textContent =
            'Try-on is temporarily unavailable, please check back later.';
        }
        throw new Error('try-on unavailable');
      }
      if (res.status === 202) return { pending: true };
      if (!res.ok) throw new Error(`job create failed: ${res.status}`);
      const body = await res.json();
      return { pending: false, jobId: body.jobId };
    }

    async function fetchJobStatus(jobId) {
      const res = await fetch(`${apiBase}/v1/shopify/customer/jobs/${jobId}`, {
        headers: { 'x-widget-key': widgetKey },
      });
      if (!res.ok) throw new Error(`job fetch failed: ${res.status}`);
      return res.json();
    }

    async function waitForResult(jobId) {
      const deadline = Date.now() + SSE_MAX_WAIT_MS;

      while (Date.now() < deadline) {
        const controller = new AbortController();
        const timer = setTimeout(
          () => {
            controller.abort();
          },
          Math.max(deadline - Date.now(), 0),
        );
        let terminal = null;

        try {
          const res = await fetch(`${apiBase}/v1/shopify/customer/jobs/${jobId}/events`, {
            headers: { 'x-widget-key': widgetKey },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`sse failed: ${res.status}`);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (!terminal) {
            const readResult = await reader.read();
            if (readResult.done) break;
            buf += decoder.decode(readResult.value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop() || '';
            for (let i = 0; i < parts.length; i++) {
              let dataLine = '';
              const lines = parts[i].split('\n');
              for (let j = 0; j < lines.length; j++) {
                if (lines[j].indexOf('data:') === 0) dataLine = lines[j].slice(5).trim();
              }
              if (!dataLine) continue;
              try {
                const evt = JSON.parse(dataLine);
                if (evt.status === 'COMPLETED' || evt.status === 'FAILED') {
                  terminal = evt;
                  break;
                }
              } catch (_e) {
                /* ignore malformed event */
              }
            }
          }
          reader.cancel().catch(() => {});
        } catch (_err) {
          if (controller.signal.aborted) throw new Error('sse timed out');
        } finally {
          clearTimeout(timer);
        }

        if (terminal) {
          if (terminal.status === 'FAILED') throw new Error(terminal.errorCode || 'job failed');
          const terminalBody = await fetchJobStatus(jobId);
          return terminalBody.resultUrl;
        }

        const body = await fetchJobStatus(jobId);
        if (body.status === 'COMPLETED') return body.resultUrl;
        if (body.status === 'FAILED') throw new Error('job failed');

        await new Promise((resolve) => {
          setTimeout(resolve, SSE_RECONNECT_DELAY_MS);
        });
      }
      throw new Error('sse timed out');
    }

    async function handleFile(file) {
      if (!file.type.startsWith('image/')) {
        showStep('error');
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        showStep('error');
        return;
      }

      showStep('progress');
      try {
        const customerPhotoKey = await uploadPhoto(file);
        const jobResult = await createJob(customerPhotoKey);
        if (jobResult.pending) {
          showStep('pending');
          return;
        }
        const resultUrl = await waitForResult(jobResult.jobId);
        resultImage.src = resultUrl;
        showStep('result');
      } catch (_err) {
        showStep('error');
      }
    }

    button.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
    });
    const retryBtns = root.querySelectorAll('.tryme-tryon__retry');
    for (let k = 0; k < retryBtns.length; k++) {
      retryBtns[k].addEventListener('click', () => {
        showStep('upload');
        fileInput.value = '';
      });
    }
  }

  function placeWidget(root) {
    const selector = root.dataset.placementSelector;
    if (!selector) return;
    const target = document.querySelector(selector);
    if (!target) return;
    if (root.dataset.blockAlignment === 'end') {
      target.appendChild(root);
    } else {
      target.insertBefore(root, target.firstChild);
    }
  }

  const widgets = document.querySelectorAll('.tryme-tryon');
  for (let i = 0; i < widgets.length; i++) {
    placeWidget(widgets[i]);
    initWidget(widgets[i]);
  }
})();
```

This drops entirely: `ACCOUNT_TOKEN_KEY`, `getAccountToken`/`setAccountToken`/`clearAccountToken`, `linkAccount()`, `exchangeCode()`, `doAccountLink()`, `signinBtn`/`steps.signin`, the `appBase` variable, and every `Authorization: Bearer` header. `openModal()` now always shows the `upload` step directly. The 402 branch in `createJob()` shows the plain generic message instead of a pricing link.

- [ ] **Step 1a: Make the edit above.**

### Step 2: Update `tryon-block.liquid` — remove `data-app-base` and the `app_base` setting

Read the current file first to confirm line numbers still match (`data-app-base` around line 18, the `app_base` setting object around lines 85-91) before editing, since Task 1 doesn't touch this file and it should be unchanged from what was read earlier this session.

Remove this line (currently line 18):

```
    data-app-base="{{ block.settings.app_base | default: 'https://app.tryme.com' }}"
```

Remove this setting object from the `{% schema %}` block (currently lines 85-91, right after the `api_base` setting and before `promo_text`):

```json
    {
      "type": "text",
      "id": "app_base",
      "label": "App base URL",
      "info": "Where shoppers sign in to link their account (usually the same as the API base URL). Only needs to differ during local development, where the API and web app run on different ports/tunnels.",
      "default": "https://app.tryme.com"
    },
```

The `data-api-base` attribute and the `api_base` schema setting are untouched — the widget still needs those for upload/job-creation/status calls.

- [ ] **Step 2a: Make the edit above.**

### Step 3: Biome check

```bash
pnpm biome check --write apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
```

Expected: clean (or auto-fixed formatting only — no logic changes from Biome).

Note: Biome does not lint `.liquid` files; the Liquid edit in Step 2 has no automated check. Re-read the file after editing to confirm the JSON inside `{% schema %}` is still valid (balanced braces/commas) — an invalid schema block breaks the entire block in the Shopify theme editor.

- [ ] **Step 3a: Run Biome and re-read the Liquid file to confirm valid JSON in `{% schema %}`.**

### Step 4: Manual verification checklist

This extension has no automated test harness, so verify by inspection and (if a dev store + tunnel are available) by hand:

- [ ] Grep confirms no remaining references to the removed identifiers: run `grep -n "appBase\|ACCOUNT_TOKEN_KEY\|linkAccount\|exchangeCode\|doAccountLink\|signin" apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js` — expect no output.
- [ ] Grep confirms `data-app-base`/`app_base` no longer appear in the Liquid file: run `grep -n "app_base\|data-app-base" apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid` — expect no output.
- [ ] If a dev store is available: clicking "Try It On" opens the modal directly to the upload step (no signin screen ever appears), a successful upload+job completes and shows the result image, and a merchant with 0 credits shows "Try-on is temporarily unavailable, please check back later." with no link.

### Step 5: Commit

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid
git commit -m "$(cat <<'EOF'
feat(shopify-extension): drop shopper signin gate, bill store owner's credits

Try It On no longer asks shoppers to sign into an tryme account —
apps/api/src/modules/shopify/customer.routes.ts now bills the merchant's
own credit balance directly. Removes the now-dead signin/token/appBase
plumbing from the widget and the app_base block setting.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5a: Run the commands above.**

---

## Self-Review

**Spec coverage:**
- "Job creation bills the merchant, not the shopper" → Task 1, Step 6 (`requireStoreOwnerWithCredits`, `jobs.userId = store.ownerUserId`, `atomicDeduct(tx, userId, ...)`).
- "Shopper-facing error message" (generic, no link) → Task 2, Step 1 (`createJob`'s 402 branch).
- "Job status/events scoped by store, not shopper" → Task 1, Step 6 (`job.shopifyStoreId !== storeId` in both `GET /jobs/:id` and `GET /jobs/:id/events`; shared SSE channel keyed by `store.ownerUserId`).
- "Removed entirely (dead code)" → Task 1 Steps 1, 2, 6 (functions, route, helper); Task 2 Steps 1, 2 (widget signin code, `app_base`).
- "Kept as-is" (`mintAccountLinkCode`/`resolveAccountLinkCode`, `widget-link-complete/page.tsx`, `POST /account/link`) → untouched by any step in this plan — confirmed no step modifies `apps/catalogues-web/src/app/widget-link-complete/page.tsx`.
- "`api_base` stays" → Task 2 Step 2 explicitly leaves `data-api-base`/`api_base` alone.
- Testing section → Task 1 Steps 4-9 (rewritten integration test + trimmed unit test); Task 2 Step 4 (manual checklist, since no automated harness exists for this extension).
- Out of scope (per-store analytics, merchant-link flow) → not touched by any task.

**Placeholder scan:** No TBD/TODO markers; every step has complete, runnable code or an exact command with expected output.

**Type consistency:** `requireStoreOwnerWithCredits(app, store, jobCost): Promise<string>` (Task 1 Step 6) matches its one call site in the same step. `jobs.userId`/`atomicDeduct` signatures unchanged from `apps/api/src/modules/credits/ledger.ts`. `GET /jobs/:id` response shape (`{ id, status, errorCode, resultUrl }`) matches what Task 2's `fetchJobStatus`/`waitForResult` read (`body.status`, `body.resultUrl`) — no other field is read by the widget.
