# Shopify Standalone Client + Universal User Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Shopify from the generic `widget_clients` system entirely and bill Shopify try-ons through the main app's own `user_credits`, gated behind mandatory shopper login — exactly like the main studio flow.

**Architecture:** `shopify_stores` gains its own `storeKey`/`allowedOrigins` (replacing borrowed `widget_clients` fields) and `jobs` gains `shopifyStoreId`. New `/v1/shopify/customer/*` routes (separate from the generic `/v1/widget/*`) require a signed account token minted via a popup-login handoff, and charge `user_credits` via the same `atomicDeduct`/refund pattern the main app already uses. Dispatcher's Shopify job path switches its refund/SSE plumbing from widget-credit/widget-channel to user-credit/user-channel — reusing the exact machinery the main studio flow already has (`transitionJob` already publishes to `sse:events:${userId}` for free once a real `userId` is passed through).

**Tech Stack:** Fastify 5, Drizzle ORM, `jose` (JWT), Redis (pub/sub + one-time codes), Next.js 15 (popup page), vanilla JS (theme extension).

## Global Constraints

- Never hand-write migration SQL or snapshot JSON — edit `packages/db/src/schema/*.ts`, then run `pnpm db:generate` from `packages/db/` (per this repo's `CLAUDE.md`).
- Credit deduct + job insert must be one Postgres transaction (existing invariant, `apps/api/src/modules/credits/ledger.ts`'s `atomicDeduct` already enforces this — reuse it, don't reimplement).
- `packages/db` must be rebuilt (`pnpm --filter @tryme/db build`) after schema changes before `pnpm typecheck` will pick them up (learned earlier this session — stale `dist/` causes phantom type errors in `apps/api`).
- Only commit when a task's tests pass — this repo's git policy (see `CLAUDE.md`).
- `apps/admin-mobile` mirrors `apps/admin-web` for functional admin changes (Admin Parity Rule) — N/A here, nothing in this plan touches `apps/admin-web`.

---

### Task 1: Schema — `shopify_stores.storeKey`/`allowedOrigins`, `jobs.shopifyStoreId`

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Modify: `packages/db/src/schema/jobs.ts`
- Create: `packages/db/src/migrations/0093_shopify_standalone_columns.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `schema.shopifyStores.storeKey` (`uuid`, unique, default random), `schema.shopifyStores.allowedOrigins` (`text[]`), `schema.jobs.shopifyStoreId` (`uuid`, nullable, FK to `shopify_stores.id`). `schema.shopifyStores.widgetClientId` stays for now — dropped in Task 11 once nothing references it.

- [ ] **Step 1: Add the new columns to `shopify.ts`**

In `packages/db/src/schema/shopify.ts`, find the `shopifyStores` table (starts around line 40) and add two fields after `widgetClientId`:

```ts
export const shopifyStores = pgTable('shopify_stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id')
    .notNull()
    .unique()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  storeKey: uuid('store_key').notNull().unique().defaultRandom(),
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  shopDomain: text('shop_domain').notNull().unique(),
  // ...unchanged below
```

- [ ] **Step 2: Add `shopifyStoreId` to the `jobs` table**

In `packages/db/src/schema/jobs.ts`, the `jobs` table already has `widgetClientId` (line ~31). Add `shopifyStoreId` right after it. Note `jobs.ts` needs to import `shopifyStores` — check the top of the file for existing imports from `./shopify.js` first; if none exists, add one (avoid a duplicate import statement).

```ts
  widgetClientId: uuid('widget_client_id').references(() => widgetClients.id, {
    onDelete: 'set null',
  }),
  shopifyStoreId: uuid('shopify_store_id').references(() => shopifyStores.id, {
    onDelete: 'set null',
  }),
```

Add the import at the top of `jobs.ts`:
```ts
import { shopifyStores } from './shopify.js';
```

- [ ] **Step 3: Generate the migration**

Run: `cd packages/db && pnpm db:generate`
Expected: a new file `packages/db/src/migrations/0093_<generated_name>.sql` containing `ALTER TABLE "shopify_stores" ADD COLUMN "store_key" ...`, `ALTER TABLE "shopify_stores" ADD COLUMN "allowed_origins" ...`, and `ALTER TABLE "jobs" ADD COLUMN "shopify_store_id" uuid REFERENCES "shopify_stores"("id") ...`. Rename the file to `0093_shopify_standalone_columns.sql` for clarity (update the matching entry in `packages/db/src/migrations/meta/_journal.json`'s `tag` field to match).

- [ ] **Step 4: Add the backfill migration**

Create `packages/db/src/migrations/0094_backfill_shopify_store_key.sql` (bump `_journal.json` accordingly — `idx: 94`, matching tag):

```sql
-- Backfill storeKey/allowedOrigins from each store's existing widget_clients
-- row so already-deployed theme extensions keep working (their widget_key
-- value becomes the new store_key value verbatim) without merchants
-- reconfiguring anything.
UPDATE shopify_stores s
SET store_key = wc.widget_key,
    allowed_origins = wc.allowed_origins
FROM widget_clients wc
WHERE s.widget_client_id = wc.id;
```

- [ ] **Step 5: Run migrations, rebuild `@tryme/db`, confirm**

Run: `pnpm db:migrate`
Expected: `Applied 0093_shopify_standalone_columns`, `Applied 0094_backfill_shopify_store_key`.

Run: `pnpm --filter @tryme/db build`
Expected: clean build (no output = success).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(db): add shopify_stores.storeKey/allowedOrigins, jobs.shopifyStoreId"
```

---

### Task 2: Shared types for the new Shopify customer routes

**Files:**
- Modify: `packages/types/src/widget.ts`

**Interfaces:**
- Produces: `ShopifyCustomerPresignRequest`, `ShopifyCustomerJobRequest` (Zod schemas + inferred types) — consumed by Task 5's routes.

- [ ] **Step 1: Add the schemas**

Append to `packages/types/src/widget.ts` (after the existing `WidgetPresignRequest` export):

```ts
export const ShopifyCustomerPresignRequest = z.object({
  contentType: z.string(),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});
export type ShopifyCustomerPresignRequest = z.infer<typeof ShopifyCustomerPresignRequest>;

export const ShopifyCustomerJobRequest = z.object({
  customerPhotoKey: z.string(),
  shopifyProductId: z.number().int().positive(),
});
export type ShopifyCustomerJobRequest = z.infer<typeof ShopifyCustomerJobRequest>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/widget.ts
git commit -m "feat(types): add ShopifyCustomerPresignRequest/ShopifyCustomerJobRequest"
```

---

### Task 3: `requireShopifyStoreKey` auth plugin

**Files:**
- Create: `apps/api/src/plugins/shopify-widget-auth.ts`
- Test: `apps/api/src/plugins/shopify-widget-auth.test.ts`
- Modify: `apps/api/src/server.ts` (register the plugin)

**Interfaces:**
- Consumes: `schema.shopifyStores` (`packages/db`).
- Produces: `app.requireShopifyStoreKey` preHandler — sets `req.shopifyStoreId: string` and `req.shopifyStoreRow: InferSelectModel<typeof schema.shopifyStores>` on success. Consumed by Task 5's routes.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/plugins/shopify-widget-auth.test.ts
import { describe, expect, it, vi } from 'vitest';

describe('requireShopifyStoreKey', () => {
  it('throws UNAUTHORIZED when x-widget-key header is missing', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select: vi.fn() },
    };
    // fastify-plugin wraps the function; call the inner fn directly via .default
    // biome-ignore lint/suspicious/noExplicitAny: test-only unwrap of fastify-plugin wrapper
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const req = { headers: {} } as never;
    await expect(
      (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req),
    ).rejects.toThrow('Missing X-Widget-Key header');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-widget-auth -t "missing"`
Expected: FAIL — `Cannot find module './shopify-widget-auth.js'`

- [ ] **Step 3: Write the plugin**

```ts
// apps/api/src/plugins/shopify-widget-auth.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

export const shopifyWidgetAuthPlugin = fp(async (app) => {
  app.decorate('requireShopifyStoreKey', async (req, _reply) => {
    const key = req.headers['x-widget-key'];
    if (!key || typeof key !== 'string') {
      throw new AppError('UNAUTHORIZED', 401, 'Missing X-Widget-Key header');
    }
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.storeKey, key))
      .limit(1);
    if (!store || store.uninstalledAt) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid or inactive store key');
    }
    if (store.allowedOrigins.length > 0) {
      const origin = req.headers.origin ?? '';
      if (!store.allowedOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN', 403, 'Origin not allowed');
      }
    }
    req.shopifyStoreId = store.id;
    req.shopifyStoreRow = store;
  });
});

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InferSelectModel } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    shopifyStoreId?: string;
    shopifyStoreRow?: InferSelectModel<typeof schema.shopifyStores>;
  }
  interface FastifyInstance {
    requireShopifyStoreKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-widget-auth -t "missing"`
Expected: PASS

- [ ] **Step 5: Register the plugin in `server.ts`**

In `apps/api/src/server.ts`, find `import { shopifyAuthPlugin } from './plugins/shopify-auth.js';` and add a sibling import, then find `await app.register(shopifyAuthPlugin);` and add a sibling registration right after it:

```ts
import { shopifyWidgetAuthPlugin } from './plugins/shopify-widget-auth.js';
```
```ts
  await app.register(shopifyAuthPlugin);
  await app.register(shopifyWidgetAuthPlugin);
```

- [ ] **Step 6: Typecheck + full test suite**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

Run: `pnpm --filter @tryme/api test`
Expected: all pass, including the new test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/plugins/shopify-widget-auth.ts apps/api/src/plugins/shopify-widget-auth.test.ts apps/api/src/server.ts
git commit -m "feat(api): add requireShopifyStoreKey auth plugin"
```

---

### Task 4: Account link/exchange endpoints + signed account token

**Files:**
- Create: `apps/api/src/modules/shopify/customer-auth.ts`
- Test: `apps/api/src/modules/shopify/customer-auth.test.ts`

**Interfaces:**
- Consumes: `signAccess`/`verifyAccess` (`apps/api/src/modules/auth/service.ts`), `app.requireShopifyStoreKey` (Task 3), `app.requireUser` (existing, main-app auth).
- Produces: `mintAccountLinkCode(redis, userId): Promise<string>`, `resolveAccountLinkCode(redis, code): Promise<string | null>`, `signShopifyAccountToken(secret, userId, storeId): Promise<string>`, `verifyShopifyAccountToken(secret, token, expectedStoreId): Promise<string>` (returns `userId`, throws on mismatch/invalid) — all consumed by Task 5's routes.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/shopify/customer-auth.test.ts
import Redis from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import {
  mintAccountLinkCode,
  resolveAccountLinkCode,
  signShopifyAccountToken,
  verifyShopifyAccountToken,
} from './customer-auth.js';

describe('shopify customer account link/exchange', () => {
  it('mints a one-time code that resolves to the userId once, then is gone', async () => {
    const redis = new Redis();
    const userId = 'user-123';
    const code = await mintAccountLinkCode(redis as never, userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBe(userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBeNull();
  });

  it('signs and verifies a token scoped to the correct storeId', async () => {
    const secret = new TextEncoder().encode('a'.repeat(32));
    const token = await signShopifyAccountToken(secret, 'user-123', 'store-abc');
    const userId = await verifyShopifyAccountToken(secret, token, 'store-abc');
    expect(userId).toBe('user-123');
  });

  it('rejects a token presented against the wrong storeId', async () => {
    const secret = new TextEncoder().encode('a'.repeat(32));
    const token = await signShopifyAccountToken(secret, 'user-123', 'store-abc');
    await expect(verifyShopifyAccountToken(secret, token, 'store-other')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- customer-auth`
Expected: FAIL — `Cannot find module './customer-auth.js'`. (If `ioredis-mock` isn't installed, run `pnpm --filter @tryme/api add -D ioredis-mock` first.)

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/customer-auth.ts
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { signAccess, verifyAccess } from '../auth/service.js';

const LINK_CODE_TTL_SECS = 60;
const ACCOUNT_TOKEN_AUDIENCE = 'shopify-widget';
const ACCOUNT_TOKEN_EXPIRY = '30d';

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

export async function signShopifyAccountToken(
  secret: Uint8Array,
  userId: string,
  storeId: string,
): Promise<string> {
  return signAccess(secret, userId, { storeId }, ACCOUNT_TOKEN_EXPIRY, ACCOUNT_TOKEN_AUDIENCE);
}

export async function verifyShopifyAccountToken(
  secret: Uint8Array,
  token: string,
  expectedStoreId: string,
): Promise<string> {
  let payload: Awaited<ReturnType<typeof verifyAccess>>;
  try {
    payload = await verifyAccess(secret, token);
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'Invalid or expired account token');
  }
  const aud = payload.aud;
  const isShopifyWidget = Array.isArray(aud)
    ? aud.includes(ACCOUNT_TOKEN_AUDIENCE)
    : aud === ACCOUNT_TOKEN_AUDIENCE;
  if (!isShopifyWidget || payload.storeId !== expectedStoreId) {
    throw new AppError('UNAUTHORIZED', 401, 'Account token not valid for this store');
  }
  return String(payload.sub);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- customer-auth`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer-auth.ts apps/api/src/modules/shopify/customer-auth.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): shopify account-link code minting + account token sign/verify"
```

---

### Task 5: Shopify customer routes (presign, jobs, events)

**Files:**
- Create: `apps/api/src/modules/shopify/customer.routes.ts`
- Test: `apps/api/test/integration/shopify-customer.test.ts`

**Interfaces:**
- Consumes: `app.requireShopifyStoreKey` (Task 3), `mintAccountLinkCode`/`resolveAccountLinkCode`/`signShopifyAccountToken`/`verifyShopifyAccountToken` (Task 4), `atomicDeduct` (`apps/api/src/modules/credits/ledger.ts`, existing), `getTryonCreditCost` (`apps/api/src/lib/resolution-config.ts`, existing), `ShopifyCustomerPresignRequest`/`ShopifyCustomerJobRequest` (Task 2).
- Produces: `shopifyCustomerRoutes(app)` — registered in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/shopify-customer.test.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
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

  async function seedStore() {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();
    return store;
  }

  it('rejects presign without a store key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/shopify/customer/presign', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('mints an account link code for an authenticated app user, then exchanges it for a store-scoped token', async () => {
    const store = await seedStore();
    const { authorization } = await adminAuthHeader(app, 'SUPER_ADMIN');

    const linkRes = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/account/link',
      headers: { authorization },
    });
    expect(linkRes.statusCode).toBe(200);
    const { code } = linkRes.json() as { code: string };

    const exchangeRes = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/account/exchange',
      headers: { 'x-widget-key': store.storeKey },
      payload: { code },
    });
    expect(exchangeRes.statusCode).toBe(200);
    expect(exchangeRes.json()).toHaveProperty('token');

    // Code is one-time use
    const secondExchange = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/account/exchange',
      headers: { 'x-widget-key': store.storeKey },
      payload: { code },
    });
    expect(secondExchange.statusCode).toBe(401);
  });

  it('rejects job creation without an account token', async () => {
    const store = await seedStore();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: 'widget-inputs/x/photo.jpg', shopifyProductId: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

Note: `adminAuthHeader` returns `{ authorization: 'Bearer <token>' }` for an admin/app user (existing helper, `apps/api/test/helpers/admin.ts`) — used here purely as "some authenticated app user," not for admin privileges.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && node_modules/.bin/vitest run --config vitest.integration.config.ts -t "shopify customer routes"`
Expected: FAIL — route not found (404) since `customer.routes.ts` doesn't exist yet.

- [ ] **Step 3: Write the routes**

```ts
// apps/api/src/modules/shopify/customer.routes.ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { ShopifyCustomerJobRequest, ShopifyCustomerPresignRequest } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { AppError } from '../../lib/errors.js';
import { atomicDeduct } from '../credits/ledger.js';
import {
  mintAccountLinkCode,
  resolveAccountLinkCode,
  signShopifyAccountToken,
  verifyShopifyAccountToken,
} from './customer-auth.js';

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

async function requireAccountUserId(app: FastifyInstance, req: { headers: Record<string, unknown> }, storeId: string): Promise<string> {
  const auth = req.headers.authorization;
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (!token) throw new AppError('UNAUTHORIZED', 401, 'Missing account token');
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  return verifyShopifyAccountToken(secret, token, storeId);
}

export async function shopifyCustomerRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/customer/account/link',
    { preHandler: app.requireUser },
    async (req) => {
      const code = await mintAccountLinkCode(app.redis, req.userId);
      return { code };
    },
  );

  app.post(
    '/v1/shopify/customer/account/exchange',
    { preHandler: app.requireShopifyStoreKey },
    async (req) => {
      const { code } = req.body as { code?: string };
      if (!code) throw new AppError('VALIDATION', 400, 'code is required');
      const userId = await resolveAccountLinkCode(app.redis, code);
      if (!userId) throw new AppError('UNAUTHORIZED', 401, 'Link code invalid or expired');
      const storeId = req.shopifyStoreId as string;
      const secret = new TextEncoder().encode(app.env.JWT_SECRET);
      const token = await signShopifyAccountToken(secret, userId, storeId);
      return { token };
    },
  );

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
      const userId = await requireAccountUserId(app, req, storeId);

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
        const { enqueueSync } = await import('./service.js');
        await enqueueSync(app.redis, { storeId, mode: 'product', shopifyProductId });
        return reply
          .code(202)
          .send({ message: "We're preparing this product for try-on. Check back in a moment." });
      }
      if (!garment.enabled) {
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }

      const jobCost = await getTryonCreditCost(app);
      const jobId = randomUUID();

      await app.db.transaction(async (tx) => {
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers face/bg/pose cols as non-null; shopify jobs legitimately have them null
        await (tx.insert(schema.jobs).values as any)({
          id: jobId,
          userId,
          shopifyStoreId: storeId,
          customerPhotoKey,
          status: 'QUEUED',
          creditsCharged: jobCost,
        });
        // biome-ignore lint/suspicious/noExplicitAny: same — face/bg/pose nullable in SQL, non-null in Drizzle's inferred insert type
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
      const userId = await requireAccountUserId(app, req, storeId);
      const { id } = req.params as { id: string };

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          userId: schema.jobs.userId,
          resultKey: schema.jobOutputs.resultKey,
          errorCode: schema.jobs.errorCode,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobs.id, schema.jobOutputs.jobId))
        .where(eq(schema.jobs.id, id))
        .limit(1);

      if (!job || job.userId !== userId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }
      return {
        ...job,
        resultUrl: job.resultKey ? app.storage.publicUrl(job.resultKey) : null,
      };
    },
  );

  app.get(
    '/v1/shopify/customer/jobs/:id/events',
    { preHandler: app.requireShopifyStoreKey },
    async (req, reply) => {
      const storeId = req.shopifyStoreId as string;
      const userId = await requireAccountUserId(app, req, storeId);
      const { id } = req.params as { id: string };

      const [job] = await app.db
        .select({ id: schema.jobs.id, userId: schema.jobs.userId })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id))
        .limit(1);
      if (!job || job.userId !== userId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }

      writeSseHeaders(reply);
      // biome-ignore lint/suspicious/noExplicitAny: redisSub is decorated on app at runtime; not in Fastify's type map
      const sub: Redis = (app as any).redisSub.duplicate();
      const channel = `sse:events:${userId}`;
      sub.on('error', (err) => req.log.warn({ err, channel }, 'sse redis subscriber error'));
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
      const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);
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

Note: `/v1/shopify/customer/jobs/:id` and `/:id/events` require BOTH the store key (`x-widget-key`) AND the account token (`Authorization: Bearer`) — matches how job creation is scoped, and prevents one shopper polling another shopper's job on the same store.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && node_modules/.bin/vitest run --config vitest.integration.config.ts -t "shopify customer routes"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "feat(api): add /v1/shopify/customer/* routes (presign, jobs, events, account link)"
```

---

### Task 6: Wire the new routes into `server.ts`

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Register the routes**

In `apps/api/src/server.ts`, find the existing import (line 48):
```ts
import { shopifyRoutes } from './modules/shopify/routes.js';
```
and add directly after it:

```ts
import { shopifyCustomerRoutes } from './modules/shopify/customer.routes.js';
```

Find `await app.register(shopifyRoutes);` and add directly after:

```ts
  await app.register(shopifyCustomerRoutes);
```

- [ ] **Step 2: Typecheck + full API test suite**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

Run: `pnpm --filter @tryme/api test`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): register shopifyCustomerRoutes"
```

---

### Task 7: Dispatcher — route Shopify jobs by `shopifyStoreId`, refund via `user_credits`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`
- Modify: `apps/dispatcher/test/integration/shopify.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `schema.jobs.shopifyStoreId`, `schema.jobs.userId` (Task 1), `schema.userCredits`, `schema.creditLedger` (existing).
- Produces: `markShopifyFailed(...)` — internal to `processShopifyJob`, not exported elsewhere.

- [ ] **Step 1: Add `shopifyStoreId`/`userId` to the job select and routing condition**

In `apps/dispatcher/src/job/processor.ts`, the initial job select (around line 64-76) currently selects `widgetClientId` but not `userId`/`shopifyStoreId`. Update it:

```ts
  const [job] = await db
    .select({
      id: schema.jobs.id,
      status: schema.jobs.status,
      userId: schema.jobs.userId,
      widgetClientId: schema.jobs.widgetClientId,
      shopifyStoreId: schema.jobs.shopifyStoreId,
      customerPhotoKey: schema.jobs.customerPhotoKey,
      creditsCharged: schema.jobs.creditsCharged,
      attempts: schema.jobs.attempts,
      createdAt: schema.jobs.createdAt,
      watermark: schema.jobs.watermark,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
```

Then update the routing check (around line 121):

```ts
  // Widget jobs: widgetClientId set (generic widget) OR shopifyStoreId set (standalone
  // Shopify, post-migration) — route to the dedicated processor either way.
  if (job.widgetClientId || job.shopifyStoreId) {
    await processWidgetJob(cfg, job, inputs, stream, messageId, jobLog, startedAt);
    return;
  }
```

- [ ] **Step 2: Widen the `WidgetJob` type**

Find the `WidgetJob` type (around line 921-932) and add the two new fields:

```ts
type WidgetJob = {
  id: string;
  userId: string | null;
  widgetClientId: string | null;
  shopifyStoreId: string | null;
  customerPhotoKey: string | null;
  creditsCharged: number;
  createdAt: Date;
  watermark: boolean;
};
```

- [ ] **Step 3: Replace `processShopifyJob`'s failure calls with `markShopifyFailed`**

In `processShopifyJob` (starts around line 1208), replace every `widgetClientId` reference used for refund purposes. First, change the local binding near the top of the function:

```ts
  const jobId = job.id;
  // biome-ignore lint/style/noNonNullAssertion: userId is guaranteed non-null for linked shopify jobs (login is mandatory at job creation)
  const userId = job.userId!;
  // biome-ignore lint/style/noNonNullAssertion: shopifyStoreId is guaranteed non-null for shopify jobs
  const shopifyStoreId = job.shopifyStoreId!;
  const { creditsCharged } = job;
```

(this replaces the old `const widgetClientId = job.widgetClientId!;` line)

Then replace every `markWidgetFailed(cfg, jobId, widgetClientId, creditsCharged, stream, messageId, '<CODE>', jobLog, startedAt)` call inside `processShopifyJob` (there are 6: `NO_WORKFLOW_CONFIGURED`/`SHOPIFY_INPUTS_MISSING`, `WORKFLOW_NOT_FOUND`, `SHOPIFY_NODES_NOT_CONFIGURED`, `NO_WORKER`, and the final catch-block's dynamic `errMsg`) with the equivalent `markShopifyFailed(cfg, jobId, userId, shopifyStoreId, creditsCharged, stream, messageId, '<CODE>', jobLog, startedAt)` — same arguments, same positions, just `widgetClientId` swapped for `userId, shopifyStoreId` and the function name changed. For example, the first one becomes:

```ts
  if (!workflowTemplateId || !garmentKey || !customerPhotoKey) {
    await markShopifyFailed(
      cfg,
      jobId,
      userId,
      shopifyStoreId,
      creditsCharged,
      stream,
      messageId,
      !workflowTemplateId ? 'NO_WORKFLOW_CONFIGURED' : 'SHOPIFY_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }
```

Apply the same mechanical substitution to the other 5 call sites within `processShopifyJob` (`WORKFLOW_NOT_FOUND`, `SHOPIFY_NODES_NOT_CONFIGURED`, the two `NO_WORKER`/re-enqueue branches — note the re-enqueue branch does NOT call `markWidgetFailed`, only the `MAX_QUEUE_WAIT_MS`-exceeded branch does — and the final `catch` block's `errMsg.slice(0, 1000)` call).

- [ ] **Step 4: Update the success path**

Replace the success-path block (around lines 1415-1449 — the `finalizeOutput` call, the manual `pub.publish('sse:events:widget:...')`, and the `webhooks:outbound` xadd):

```ts
    // Finalize: upload result + thumbnail, write job_outputs, transition COMPLETED.
    // finalizeOutput's own transitionJob call publishes to sse:events:${userId} —
    // the exact channel the main studio flow's own SSE route already subscribes to,
    // so no separate widget-style publish/webhook step is needed here.
    const { resultKey } = await finalizeOutput({
      imageBytes,
      jobId,
      userId,
      jobWatermark: job.watermark,
      db,
      pub,
      s3,
      r2Bucket,
      jobLog,
    });

    await redis.xack(stream, 'dispatcher-cg', messageId);
    await setWorkerStatus(redis, w.id, 'IDLE');
    recordJobOutcome('success', startedAt);
    jobLog.info({ resultKey }, 'shopify job completed successfully');
  } catch (err) {
    jobLog.error({ err }, 'shopify job processing error');
    await setWorkerStatus(redis, w.id, 'IDLE');
    const errMsg = err instanceof Error ? err.message : String(err);
    await markShopifyFailed(
      cfg,
      jobId,
      userId,
      shopifyStoreId,
      creditsCharged,
      stream,
      messageId,
      errMsg.slice(0, 1000),
      jobLog,
      startedAt,
    );
  }
}
```

- [ ] **Step 5: Add `markShopifyFailed`**

Add this function right after `markWidgetFailed` (which stays unchanged, still used by the generic non-Shopify widget path):

```ts
async function markShopifyFailed(
  cfg: ProcessorConfig,
  jobId: string,
  userId: string,
  shopifyStoreId: string,
  creditsCharged: number,
  stream: string,
  messageId: string,
  errorCode: string,
  log: Logger,
  startedAt: number,
): Promise<void> {
  const { db, redis, pub } = cfg;

  // Refund user credits (idempotent — mirrors sweeper.ts's failAndRefund userId branch)
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.jobId, jobId),
          eq(schema.creditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    if (existing.length) return;
    await tx
      .update(schema.userCredits)
      .set({ balance: sql`${schema.userCredits.balance} + ${creditsCharged}` })
      .where(eq(schema.userCredits.userId, userId));
    await tx
      .insert(schema.creditLedger)
      .values({ userId, delta: creditsCharged, reason: 'JOB_FAIL_REFUND', jobId });
  });

  // transitionJob's own publish to sse:events:${userId} covers the client notification.
  await transitionJob(db, pub, jobId, userId, 'FAILED', { errorCode }, log);
  await redis.xack(stream, 'dispatcher-cg', messageId);
  recordJobOutcome('failed', startedAt);
  log.warn({ jobId, shopifyStoreId, errorCode }, 'shopify job FAILED — user credits refunded');
}
```

- [ ] **Step 6: Write the failing tests**

Open `apps/dispatcher/test/integration/shopify.test.ts` (existing file, has a `seedShopifyJobViaFunnel` helper from earlier work). Add a variant that seeds a job with `userId`/`shopifyStoreId` set (no `widgetClientId`) instead of the old `widgetClientId`-based seeding, and asserts on `user_credits`/`credit_ledger` instead of `widget_client_credits`/`widget_credit_ledger`:

```ts
it('refunds user_credits (not widget_client_credits) on terminal failure for a linked shopify job', async () => {
  const { jobId, userId } = await seedLinkedShopifyJob({ withFunnel: false });
  await processJob(cfg, jobId, '', 'jobs:normal', 'msg-1');

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  expect(job?.status).toBe('FAILED');
  expect(job?.errorCode).toBe('NO_WORKFLOW_CONFIGURED');

  const [credits] = await db.select().from(schema.userCredits).where(eq(schema.userCredits.userId, userId));
  expect(credits?.balance).toBe(STARTING_BALANCE); // refunded back to starting balance
});
```

Add the `seedLinkedShopifyJob` helper near the existing `seedShopifyJobViaFunnel`, following the same shape but inserting `userId`/`shopifyStoreId` on the `jobs` row instead of `widgetClientId`, and seeding a `user_credits` row with a known `STARTING_BALANCE` (define as a `const` near the top of the test file, e.g. `100`) minus the job's `creditsCharged` (simulating the deduct having already happened at job-creation time, mirroring what the real `/v1/shopify/customer/jobs` route does).

- [ ] **Step 7: Run tests to verify they fail, then pass**

Run: `cd apps/dispatcher && node_modules/.bin/vitest run --config vitest.integration.config.ts -t "shopify"`
Expected: FAIL first (route/type mismatch since Steps 1-5 aren't applied to a fresh checkout — skip if already applied in-order), then PASS after Steps 1-5 are in place.

- [ ] **Step 8: Full dispatcher test suite + typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: clean.

Run: `pnpm --filter @tryme/dispatcher test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/test/integration/shopify.test.ts
git commit -m "feat(dispatcher): route shopify jobs by shopifyStoreId, refund user_credits on failure"
```

---

### Task 8: Simplify `upsertShopifyStore` — no more `widget_clients` row on install

**Files:**
- Modify: `apps/api/src/modules/shopify/auth.routes.ts`
- Modify: `apps/api/src/modules/shopify/metafields.ts` (rename param for clarity, no behavior change)

**Interfaces:**
- Consumes: `schema.shopifyStores` (Task 1's new columns).
- Produces: `upsertShopifyStore` no longer inserts into `widget_clients`/`widget_client_credits`.

- [ ] **Step 1: Rewrite `upsertShopifyStore`**

Replace the whole function body in `apps/api/src/modules/shopify/auth.routes.ts`:

```ts
export async function upsertShopifyStore(
  app: FastifyInstance,
  shop: ShopDetails,
  accessToken: string,
  scope: string,
) {
  const encKey = app.env.SHOPIFY_TOKEN_ENC_KEY;
  if (!encKey) throw new AppError('CONFIG', 500, 'SHOPIFY_TOKEN_ENC_KEY missing');
  const enc = encryptToken(accessToken, encKey);
  const origins = [
    `https://${shop.myshopifyDomain}`,
    ...(shop.primaryDomain ? [`https://${shop.primaryDomain}`] : []),
  ];

  return app.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopifyShopId, shop.shopifyShopId))
      .limit(1);

    if (existing) {
      const [store] = await tx
        .update(schema.shopifyStores)
        .set({
          accessToken: enc,
          scope,
          allowedOrigins: origins,
          uninstalledAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.shopifyStores.id, existing.id))
        .returning();
      return store;
    }

    const [store] = await tx
      .insert(schema.shopifyStores)
      .values({
        shopDomain: shop.shopDomain,
        shopifyShopId: shop.shopifyShopId,
        accessToken: enc,
        scope,
        allowedOrigins: origins,
      })
      .returning();
    return store;
  });
}
```

Note: `widget_client_id` is left as-is on the table for now (still `NOT NULL` — Task 11 drops it). This function no longer sets it, which will fail the `NOT NULL` constraint on brand-new installs. Task 1 already ran its migration; before this task is deployed, `widget_client_id` must be made nullable as an interim step. Add this to Task 1's Step 1 instead — go back and change `widgetClientId`'s definition from `.notNull()` to plain (nullable) in `packages/db/src/schema/shopify.ts`, then regenerate: run `cd packages/db && pnpm db:generate` again to produce the `ALTER COLUMN "widget_client_id" DROP NOT NULL` statement as part of the same migration batch, and re-run `pnpm db:migrate`.

- [ ] **Step 2: Update the callback's post-install metafield write**

In the `/v1/shopify/auth/callback` handler (same file), replace:

```ts
    const store = await upsertShopifyStore(app, details, access_token, scope);
    const [wc] = await app.db
      .select({ widgetKey: schema.widgetClients.widgetKey })
      .from(schema.widgetClients)
      .where(eq(schema.widgetClients.id, store.widgetClientId))
      .limit(1);
    if (wc) await writeWidgetKeyMetafield(q.shop, access_token, wc.widgetKey, req.log);
```

with:

```ts
    const store = await upsertShopifyStore(app, details, access_token, scope);
    await writeWidgetKeyMetafield(q.shop, access_token, store.storeKey, req.log);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

- [ ] **Step 4: Run existing Shopify auth tests**

Run: `pnpm --filter @tryme/api test -- shopify`
Expected: pass (update any test that asserted on the old `widgetClients` row creation — check `apps/api/test/integration/shopify*.test.ts` for install-flow assertions and adjust them to check `store.storeKey`/`store.allowedOrigins` directly instead of joining `widget_clients`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/auth.routes.ts packages/db/src/schema/shopify.ts packages/db/src/migrations/
git commit -m "feat(api): upsertShopifyStore no longer creates a widget_clients row"
```

---

### Task 9: Update uninstall webhook handler

**Files:**
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts`

- [ ] **Step 1: Repoint the uninstall handler**

Find (around line 64-69):

```ts
                .set({ uninstalledAt: new Date() })
                .where(eq(schema.shopifyStores.id, store.id));
              await app.db
                .update(schema.widgetClients)
                .set({ isActive: false })
                .where(eq(schema.widgetClients.id, store.widgetClientId));
```

Replace with (the `shopify_stores.uninstalledAt` update already fully expresses "inactive" for a standalone store — `requireShopifyStoreKey` already checks `store.uninstalledAt`):

```ts
                .set({ uninstalledAt: new Date() })
                .where(eq(schema.shopifyStores.id, store.id));
```

(the second `widgetClients` update block is deleted entirely, not replaced)

- [ ] **Step 2: Typecheck + test**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api test -- webhook`
Expected: clean, all pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/shopify/webhook.routes.ts
git commit -m "fix(api): uninstall webhook no longer touches widget_clients"
```

---

### Task 10: Remove the now-broken credit-seed from `billing.routes.ts`

**Files:**
- Modify: `apps/api/src/modules/shopify/billing.routes.ts`

**Rationale:** `billing.routes.ts` seeds `widget_client_credits` with `plan.includedTryons * SHOPIFY_JOB_COST` when a merchant activates a Shopify subscription plan — a merchant-level bundled-credits concept. Since try-on credits now belong to individual shoppers' own `user_credits`, not the store, there is no store-level balance left to seed into. This write is deleted; the subscription-plan activation itself (whatever else it does — recording `shopifyPlanId` on the store) is untouched, since that's a separate, still-meaningful concern (which plan tier a merchant is on) from try-on credit funding.

- [ ] **Step 1: Locate and remove the seed block**

Find (around lines 44-62):

```ts
      .returning();
    const seed = plan.includedTryons * app.env.SHOPIFY_JOB_COST;
    await tx
      .update(schema.widgetClientCredits)
      .set({
        balance: sql`${schema.widgetClientCredits.balance} + ${seed}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.widgetClientCredits.widgetClientId, store.widgetClientId));
    await tx.insert(schema.widgetCreditLedger).values({
      widgetClientId: store.widgetClientId,
      delta: seed,
      reason: 'SHOPIFY_PLAN_ACTIVATED',
    });
  });
```

Replace with:

```ts
      .returning();
  });
```

(Read the surrounding function first to confirm `.returning()` and the closing `});` line up correctly with the transaction's actual structure — the exact line numbers may have shifted slightly from other changes in this file.)

- [ ] **Step 2: Remove now-unused imports if any**

Check whether `sql` or `schema.widgetClientCredits`/`schema.widgetCreditLedger` imports in this file become unused after the deletion; remove them if so (biome will flag unused imports).

- [ ] **Step 3: Typecheck + test**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api test -- billing`
Expected: clean, all pass (update any existing test asserting on the old seed behavior).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/billing.routes.ts
git commit -m "fix(api): remove widget_client_credits seed on shopify plan activation"
```

---

### Task 11: Fix `me.routes.ts` + `DashboardPage.tsx`, then drop `shopify_stores.widget_client_id`

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `packages/db/src/schema/shopify.ts` (drop `widgetClientId`)
- Modify: `apps/api/src/env.ts` (drop `SHOPIFY_JOB_COST`)
- Create: `packages/db/src/migrations/0095_drop_shopify_widget_client_id.sql` (generated)

- [ ] **Step 1: Fix `me.routes.ts`**

Replace the `credits` query and `totalTryOns` query:

```ts
    const [{ totalTryOns }] = await app.db
      .select({ totalTryOns: count() })
      .from(schema.jobs)
      .where(eq(schema.jobs.shopifyStoreId, store.id));
```

(delete the `const [credits] = await app.db.select({ balance: schema.widgetClientCredits.balance })...` block entirely)

And the final return:

```ts
    return {
      store: { shopDomain: store.shopDomain, settings: store.settings },
      plan,
      stats: { totalTryOns, syncedProductCount, enabledProductCount, funnelConfigured },
    };
```

(`credits: credits?.balance ?? 0` line removed)

- [ ] **Step 2: Update `apps/shopify/src/types.ts`**

Find the type with `credits: number;` (the `/v1/shopify/me` response type) and delete that field.

- [ ] **Step 3: Update `DashboardPage.tsx`**

Find and delete the line:
```tsx
              <Text as="p">Credit balance: {me?.credits ?? 0}</Text>
```

- [ ] **Step 4: Typecheck both apps**

Run: `pnpm --filter @tryme/api typecheck`
Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: clean.

- [ ] **Step 5: Drop `widgetClientId` from the schema**

In `packages/db/src/schema/shopify.ts`, remove the `widgetClientId` field from `shopifyStores` entirely:

```ts
export const shopifyStores = pgTable('shopify_stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeKey: uuid('store_key').notNull().unique().defaultRandom(),
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  shopDomain: text('shop_domain').notNull().unique(),
  // ...rest unchanged
```

Also remove the now-unused `import { widgetClients } from './widget.js';` at the top of the file if nothing else in it references `widgetClients`.

- [ ] **Step 6: Generate + run the drop migration**

Run: `cd packages/db && pnpm db:generate`
Expected: new file with `ALTER TABLE "shopify_stores" DROP COLUMN "widget_client_id";` — rename to `0095_drop_shopify_widget_client_id.sql`, fix the `_journal.json` tag to match.

Run: `pnpm db:migrate`
Expected: `Applied 0095_drop_shopify_widget_client_id`.

Run: `pnpm --filter @tryme/db build`

- [ ] **Step 7: Remove `SHOPIFY_JOB_COST` from `env.ts`**

In `apps/api/src/env.ts`, delete:
```ts
  SHOPIFY_JOB_COST: z.coerce.number().default(10),
```

Confirm no remaining references: `grep -rn "SHOPIFY_JOB_COST" apps/api/src apps/dispatcher/src` should return nothing after Task 5/10's changes (the old `/v1/widget/jobs` route in `apps/api/src/modules/widget/routes.ts` still uses `jobCost = app.env.SHOPIFY_JOB_COST` for its legacy `shopifyProductId` branch — check whether that branch is now dead code entirely, since Shopify traffic goes through the new `/v1/shopify/customer/jobs` route instead. If confirmed dead, delete that `if (shopifyProductId) { ... }` block from `widget/routes.ts` and the `shopifyProductId` field from `WidgetJobRequest` in `packages/types/src/widget.ts` — this fully retires the old code path.)

- [ ] **Step 8: Full typecheck + test suite across the whole repo**

Run: `pnpm typecheck`
Expected: clean across all workspaces.

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/dispatcher test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/shopify/src/types.ts apps/shopify/src/pages/DashboardPage.tsx packages/db/src/schema/shopify.ts packages/db/src/migrations/ apps/api/src/env.ts apps/api/src/modules/widget/routes.ts packages/types/src/widget.ts
git commit -m "chore: drop shopify_stores.widget_client_id, SHOPIFY_JOB_COST, dead legacy shopify branch in /v1/widget/jobs"
```

---

### Task 12: Theme extension — new routes, login gate

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`

**Interfaces:**
- Consumes: `/v1/shopify/customer/presign`, `/v1/shopify/customer/jobs`, `/v1/shopify/customer/jobs/:id`, `/v1/shopify/customer/jobs/:id/events`, `/v1/shopify/customer/account/exchange` (Task 5).

- [ ] **Step 1: Repoint all API calls and add the login gate**

This is a manual-verification-only file (no automated test harness for the storefront widget, matching this project's established convention). Make these changes to `tryon-widget.js`:

1. Replace every `${apiBase}/v1/widget/...` URL with `${apiBase}/v1/shopify/customer/...` (5 occurrences: presign, jobs, jobs/:id, jobs/:id/events already added in the SSE task).
2. Add an `accountToken` read/write helper backed by `localStorage`:

```js
const ACCOUNT_TOKEN_KEY = 'tryme_shopify_account_token';

function getAccountToken() {
  return localStorage.getItem(ACCOUNT_TOKEN_KEY);
}
function setAccountToken(token) {
  localStorage.setItem(ACCOUNT_TOKEN_KEY, token);
}
function clearAccountToken() {
  localStorage.removeItem(ACCOUNT_TOKEN_KEY);
}
```

3. Add a `linkAccount()` function that opens the popup and waits for the `postMessage`:

```js
function linkAccount(apiBase) {
  return new Promise((resolve, reject) => {
    const nonce = Math.random().toString(36).slice(2);
    const origin = window.location.origin;
    const popup = window.open(
      `https://app.tryme.com/login?next=${encodeURIComponent(`/widget-link-complete?origin=${encodeURIComponent(origin)}&nonce=${nonce}`)}`,
      'tryme-link',
      'width=480,height=640',
    );
    function onMessage(event) {
      if (event.origin !== 'https://app.tryme.com') return;
      if (!event.data || event.data.type !== 'tryme-widget-link' || event.data.nonce !== nonce) return;
      window.removeEventListener('message', onMessage);
      resolve(event.data.code);
    }
    window.addEventListener('message', onMessage);
    const closeCheck = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(closeCheck);
        window.removeEventListener('message', onMessage);
        reject(new Error('popup closed before linking completed'));
      }
    }, 500);
  });
}

async function exchangeCode(apiBase, widgetKey, code) {
  const res = await fetch(`${apiBase}/v1/shopify/customer/account/exchange`, {
    method: 'POST',
    headers: { 'x-widget-key': widgetKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('exchange failed');
  const { token } = await res.json();
  return token;
}
```

4. Wire the account token into every existing `fetch` call in this file by adding an `Authorization: 'Bearer ' + getAccountToken()` header alongside the existing `x-widget-key` header, on `presign`, `jobs` (create), `jobs/:id`, and `jobs/:id/events`.
5. Add a `showStep('signin')` step (new modal step, needs a matching new `<div class="tryme-tryon__step tryme-tryon__step--signin">` block added to `tryon-block.liquid` too — see Step 2 below) that shows a "Sign in to try on" button when `!getAccountToken()`, wired to call `linkAccount()` → `exchangeCode()` → `setAccountToken()` → proceed to the normal upload step.
6. On a 401 from `jobs`/`presign` (expired/invalid token), call `clearAccountToken()` and show the sign-in step again instead of the generic error step.
7. On `INSUFFICIENT_CREDITS` (402) from the `jobs` call, show a distinct message: "Out of credits — top up your account" linking to `https://app.tryme.com/pricing`.

- [ ] **Step 2: Update `tryon-block.liquid`**

Add a new step div (alongside the existing `upload`/`progress`/`pending`/`result`/`error` steps) for the sign-in gate:

```liquid
        <div class="tryme-tryon__step tryme-tryon__step--signin">
          <p>Sign in to try this on with your own credits.</p>
          <button type="button" class="tryme-tryon__signin">Sign in to try on</button>
        </div>
```

No `data-widget-key`/schema changes needed — the attribute name stays `data-widget-key` even though it now maps to `store.storeKey` server-side (agreed in the spec — zero merchant-facing change, since the wire format is unchanged).

- [ ] **Step 3: Manual verification**

Start the local dev stack (`pnpm dev`), reinstall/reload the test store's theme extension, and manually walk through: sign-in gate appears → popup opens → login → popup closes → upload step appears → try-on completes → result shows. Then test the insufficient-credits path by draining a test account's balance.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid
git commit -m "feat(shopify-extension): gate try-on behind account linking, bill user's own credits"
```

---

### Task 13: `/widget-link-complete` page (popup completion)

**Files:**
- Create: `apps/catalogues-web/src/app/widget-link-complete/page.tsx`

**Interfaces:**
- Consumes: `POST /v1/shopify/customer/account/link` (Task 5), `api.post` (`apps/catalogues-web/src/lib/api.ts` — the existing authenticated-fetch wrapper: reads the in-memory token via `getToken()`, attaches `Authorization: Bearer`, retries once through `tryRefresh()` on a 401, `credentials: 'include'` on every call).

- [ ] **Step 1: Write the page**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

export default function WidgetLinkCompletePage(): React.ReactElement {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'linking' | 'done' | 'error'>('linking');

  useEffect(() => {
    const origin = searchParams.get('origin');
    const nonce = searchParams.get('nonce');
    if (!origin || !nonce || !window.opener) {
      setStatus('error');
      return;
    }

    (async () => {
      try {
        const { code } = await api.post<{ code: string }>('/v1/shopify/customer/account/link', {});
        window.opener.postMessage({ type: 'tryme-widget-link', code, nonce }, origin);
        setStatus('done');
        setTimeout(() => window.close(), 800);
      } catch {
        setStatus('error');
      }
    })();
  }, [searchParams]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p>
        {status === 'linking' && 'Linking your account…'}
        {status === 'done' && 'Linked! You can close this window.'}
        {status === 'error' && 'Something went wrong — please close this window and try again.'}
      </p>
    </div>
  );
}
```

Note: `api.post`'s underlying `request()` helper redirects to `/login` on a 401 with no refreshable token (see `apps/catalogues-web/src/lib/api.ts:84`) — harmless here in practice since this page is only ever reached immediately after a successful login (the in-memory token is freshly set), but worth knowing if manual testing ever shows an unexpected redirect instead of the `'error'` state.

- [ ] **Step 2: Verify the route isn't blocked by middleware**

Check `apps/catalogues-web/src/middleware.ts` — this page is not under `(app)` or `(auth)`, so confirm the middleware's route matching doesn't redirect it unexpectedly (it should pass through fine since the user has a valid `access_token` cookie by the time they land here, same as any other protected route).

- [ ] **Step 3: Manual verification**

Run `pnpm --filter @tryme/web dev`, open `http://localhost:3000/widget-link-complete?origin=http://localhost:3000&nonce=test` directly in a browser while logged in, confirm it calls the link endpoint and shows "Linked!".

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/widget-link-complete/page.tsx
git commit -m "feat(web): add widget-link-complete page for shopify popup account linking"
```

---

## Self-Review Notes (for the implementer, not a task)

- Task 8's Step 1 note about making `widgetClientId` nullable must actually be folded back into Task 1 before Task 8 is implemented — sequence Task 1 and Task 8 with that in mind, or do it as an amendment to Task 1's migration before Task 8 runs.
- Tasks 9-11 all touch files that reference `store.widgetClientId` — do them in order (9, 10, 11) since Task 11 is the one that actually removes the column; Tasks 9-10 must stop *reading* it first.
- The existing `docs/progress.md` convention (per `CLAUDE.md`) — add a dated entry after this plan is fully executed, summarizing what's Done/Failed/Open.
