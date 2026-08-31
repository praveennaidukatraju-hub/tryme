# Shopify Embedded Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an embedded Polaris admin app inside the Shopify admin so merchants can pick their subscription plan, enable/disable try-on per product, and choose which Shopify image is used as the garment input — none of which have any UI today.

**Architecture:** Extend `shopify_product_garments` with `enabled` (merchant toggle, default `false`) and `title` (cached at sync time) columns. Add three new backend endpoints (`GET /v1/shopify/products`, `GET /v1/shopify/products/:id/images`, `PATCH /v1/shopify/products/:id`) reusing the existing `requireShopifySession` auth. Extend `POST /v1/widget/jobs`'s Shopify branch to also gate on `enabled`. Build a new `apps/shopify/` Vite + React + Polaris SPA that runs inside the Shopify admin iframe, authenticating via App Bridge's `shopify.idToken()` (loaded via Shopify's CDN script tag, not the `@shopify/app-bridge-react` npm package — the CDN-script + global `shopify` object is Shopify's current recommended integration path and avoids that npm package's React-19 peer-dependency mismatch entirely).

**Tech Stack:** Fastify 5, Drizzle ORM, Zod (`fastify-type-provider-zod`), Vitest (backend tasks); Vite 6 + React 18 (workspace-forced to React 19 via `pnpm-workspace.yaml`'s `overrides`, same as the existing `apps/admin-web`) + `react-router-dom` + `@shopify/polaris` (frontend tasks, no test harness — matches `admin-web`'s own precedent).

## Global Constraints

- **`enabled` defaults to `false`** on every `shopify_product_garments` row (existing and new) — opt-in per product, never opt-out. Existing installs must not suddenly have try-on live everywhere once this ships.
- **Setting `enabled: true` requires `status === 'active'`**; setting `enabled: false` is always allowed regardless of `status`.
- **`GET /v1/shopify/products/:id/images` and the `garmentImageUrl` cross-check in `PATCH`** always fetch live from Shopify — no caching of the full image list (only the single chosen garment image is cached, in R2, as before).
- **`garmentImageUrl` in `PATCH /v1/shopify/products/:id`** must be verified against that product's real, live Shopify image list before being downloaded — reject (400) if it isn't present verbatim in that list.
- **Image downloads reuse the hardened fetch pattern** from `products.sync.ts`: CDN-host allowlist (`assertShopifyCdn`), `redirect: 'error'`, `AbortController` timeout, 10MB cap (content-length + byteLength checks).
- **Write-then-swap for garment image changes** — download into a *new* R2 key, then update `r2Key` to point at it. Never overwrite the existing object path in place.
- **This is merchant-facing admin, not the shopper-facing storefront widget** — real (non-leaking-internals, but not sanitized-to-one-generic-string) error messages are fine here, unlike `tryon-widget.js`.
- **ESM only** (`.js` import specifiers in the backend; ESM throughout), pnpm workspaces, pino via `@tryme/logger`, ASCII quotes, no `console.log` in committed code.
- **Backend tasks are full TDD** (RED/GREEN evidence required). **Frontend tasks have no automated test harness** — matches `apps/admin-web`'s existing precedent (it has none either) — verification is `pnpm --filter @tryme/shopify-admin build` succeeding plus manual smoke-testing against the real dev store.

---

## File Structure

**Create:**
- `apps/api/src/modules/shopify/products.routes.ts` — the 3 new endpoints
- `apps/api/test/shopify-products.test.ts` — tests for all 3
- `packages/db/src/migrations/0089_shopify_product_garments_enabled_title.sql` — generated, not hand-written
- `apps/shopify/` — new workspace app (package.json, tsconfig*.json, vite.config.ts, index.html, `src/main.tsx`, `src/App.tsx`, `src/lib/api.ts`, `src/lib/appBridge.ts`, `src/types.ts`, `src/pages/DashboardPage.tsx`, `src/pages/BillingPage.tsx`, `src/pages/ProductsPage.tsx`, `src/components/ImagePickerModal.tsx`)

**Modify:**
- `packages/db/src/schema/shopify.ts` — add `enabled`, `title` columns
- `apps/api/src/modules/shopify/products.sync.ts` — `ShopifyProduct` interface + `upsertGarment` gain `title`
- `apps/api/test/shopify-sync.test.ts` — assert `title` persisted
- `apps/api/src/modules/shopify/routes.ts` — register the new route file
- `apps/api/src/modules/widget/routes.ts` — `enabled` gate in the Shopify job-creation branch
- `apps/api/test/shopify-jobs.test.ts` — fix existing test's now-required `enabled: true`, add 2 new cases
- `.env`, `.env.production.example` — add `VITE_SHOPIFY_API_KEY`
- `pnpm-workspace.yaml` — none needed (glob `apps/*` already covers the new app)

---

## Task 1: Migration — `enabled` + `title` columns, cached at sync time

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Modify: `apps/api/src/modules/shopify/products.sync.ts`
- Modify: `apps/api/test/shopify-sync.test.ts`
- Create: `packages/db/src/migrations/0089_shopify_product_garments_enabled_title.sql` (generated by `drizzle-kit generate`, do not hand-write)

**Interfaces:**
- Consumes: nothing new.
- Produces: `schema.shopifyProductGarments.enabled: boolean` (default `false`), `schema.shopifyProductGarments.title: string | null` — every later task in this plan reads/writes these two columns by these exact names.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, find the `shopifyProductGarments` table definition and add two fields:

```ts
export const shopifyProductGarments = pgTable(
  'shopify_product_garments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
    shopifyVariantId: bigint('shopify_variant_id', { mode: 'number' }),
    r2Key: text('r2_key').notNull(),
    title: text('title'),
    status: text('status').notNull().default('processing'), // active|processing|failed|deleted
    enabled: boolean('enabled').notNull().default(false),
    failedReason: text('failed_reason'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyProductId, t.shopifyVariantId),
  }),
);
```

(Only the `title` and `enabled` lines are new — everything else in that table is unchanged. `boolean` is already imported at the top of this file per the existing `shopifyPlans`/`shopifyStores` tables in the same file.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0089_shopify_product_garments_enabled_title.sql` (or whatever name drizzle-kit auto-picks — check the actual generated filename with `ls packages/db/src/migrations/ | tail -3` and use that real name in Step 3 below and in every later reference to this file in this plan). Contents should be:

```sql
ALTER TABLE "shopify_product_garments" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "shopify_product_garments" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: succeeds against the local dev database (from `pnpm docker:up`).

- [ ] **Step 4: Cache product title at sync time — write the failing test**

`apps/api/test/shopify-sync.test.ts` has 5 `it` blocks, each calling `syncProduct(app, storeId, { id: N, image: {...} }, fakeFetch)` with a two-field product object literal (`id`, `image`) and each fetching its row into a variable named `row`. Making `title` a required field on `ShopifyProduct` (Step 6 below) means **all 5** call sites need a `title` field added, not just one — update every one of them:

- `{ id: 42, image: { src: 'https://cdn.shopify.com/x.jpg' } }` → `{ id: 42, title: 'Test Product', image: { src: 'https://cdn.shopify.com/x.jpg' } }`
- `{ id: 43, image: null }` → `{ id: 43, title: 'No Image Product', image: null }`
- `{ id: 44, image: { src: 'https://cdn.shopify.com/redirect-check.jpg' } }` → add `title: 'Redirect Check Product'`
- `{ id: 45, image: { src: 'https://cdn.shopify.com/redirects-elsewhere.jpg' } }` → add `title: 'Redirects Elsewhere Product'`
- `{ id: 46, image: { src: 'https://cdn.shopify.com/big.jpg' } }` → add `title: 'Big Product'`
- `{ id: 47, image: { src: 'https://cdn.shopify.com/big-no-header.jpg' } }` → add `title: 'Big No Header Product'`

(That's 6 object literals across the 5 `it` blocks — the redirect test has two `syncProduct` calls, ids 44 and 45.)

Then, in the first `it` block ("uploads first image to R2 and upserts an active garment row"), add one new assertion after the existing `expect(row.status).toBe('active');` line:

```ts
    expect(row.title).toBe('Test Product');
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: FAIL — `row.title` is `undefined`, not `'Test Product'` (the column exists from Step 3 but nothing writes to it yet). The other 4 tests still pass at this point (they don't assert on `title`) but the file won't typecheck yet either, since Step 6 hasn't added `title` to the `ShopifyProduct` interface — run this check after Step 6's interface change instead if TypeScript rejects the test file first; either order surfaces the same gap.

- [ ] **Step 6: Implement — thread `title` through `syncProduct`/`upsertGarment`**

In `apps/api/src/modules/shopify/products.sync.ts`:

```ts
interface ShopifyProduct {
  id: number;
  title: string;
  image?: { src?: string } | null;
}
```

(Adds the required `title: string` field — Shopify's real `products.json` response always includes `title`, so this isn't optional.)

```ts
async function upsertGarment(
  app: FastifyInstance,
  storeId: string,
  productId: number,
  r2Key: string,
  title: string,
  status: string,
  failedReason?: string,
) {
  await app.db
    .insert(schema.shopifyProductGarments)
    .values({
      storeId,
      shopifyProductId: productId,
      shopifyVariantId: NO_VARIANT_SENTINEL,
      r2Key,
      title,
      status,
      failedReason,
    })
    .onConflictDoUpdate({
      target: [
        schema.shopifyProductGarments.storeId,
        schema.shopifyProductGarments.shopifyProductId,
        schema.shopifyProductGarments.shopifyVariantId,
      ],
      set: { r2Key, title, status, failedReason: failedReason ?? null, syncedAt: sql`now()` },
    });
}
```

Update both call sites inside `syncProduct` (the `no product image` early-return branch and the success/failure branches at the end of the function) to pass `product.title` as the new fifth argument, e.g.:

```ts
  if (!src) {
    await upsertGarment(app, storeId, product.id, r2Key, product.title, 'failed', 'no product image');
    return;
  }
  try {
    ...
    await upsertGarment(app, storeId, product.id, r2Key, product.title, 'active');
  } catch (err) {
    app.log.warn({ err, storeId, productId: product.id }, 'product sync failed');
    await upsertGarment(app, storeId, product.id, r2Key, product.title, 'failed', (err as Error).message);
  }
```

Note: `enabled` is intentionally **not** set here — it keeps its schema default (`false`) on every insert, and `onConflictDoUpdate`'s `set` clause intentionally does **not** include `enabled`, so a re-sync of an already-`enabled: true` product never resets the merchant's choice back to `false`.

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: PASS.

- [ ] **Step 8: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS. (`shopify-jobs.test.ts` inserts a `shopifyProductGarments` row directly with an object literal that doesn't set `title` — that's fine, it's nullable; it does not yet need `enabled: true` because Task 5 is what adds the enabled-gate check that would make that test start failing. If it fails at this step, stop and report — that would mean the enabled-gate got implemented earlier than expected.)

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/ apps/api/src/modules/shopify/products.sync.ts apps/api/test/shopify-sync.test.ts
git commit -m "feat(db): add enabled/title columns to shopify_product_garments, cache title at sync"
```

---

## Task 2: `GET /v1/shopify/products` — paginated product list

**Files:**
- Create: `apps/api/src/modules/shopify/products.routes.ts`
- Create: `apps/api/test/shopify-products.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`

**Interfaces:**
- Consumes: `app.requireShopifySession` (existing preHandler, sets `req.shopifyStore`), `schema.shopifyProductGarments` (Task 1's `enabled`/`title` columns), `app.storage.publicUrl(key: string): string` (existing).
- Produces: `shopifyProductsRoutes(app: FastifyInstance): Promise<void>` — exported function, registered in `routes.ts`. `GET /v1/shopify/products` response shape `{ page: number, pageSize: number, total: number, items: { shopifyProductId: number, title: string | null, thumbnailUrl: string, status: string, enabled: boolean }[] }` — Task 8's frontend Products screen consumes exactly this shape.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-products.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { signSessionToken } from './helpers/shopify-session.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 3).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 55,
      shopDomain: 'p.myshopify.com',
      myshopifyDomain: 'p.myshopify.com',
      name: 'P',
      email: 'p@p.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('p.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    {
      storeId,
      shopifyProductId: 1,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/1/garment.jpg`,
      title: 'Red Shirt',
      status: 'active',
      enabled: true,
    },
    {
      storeId,
      shopifyProductId: 2,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/2/garment.jpg`,
      title: 'Blue Shirt',
      status: 'processing',
      enabled: false,
    },
  ]);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/products', () => {
  it('lists this store\'s synced products with status and enabled state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    const red = body.items.find((p: { shopifyProductId: number }) => p.shopifyProductId === 1);
    expect(red.title).toBe('Red Shirt');
    expect(red.status).toBe('active');
    expect(red.enabled).toBe(true);
    expect(red.thumbnailUrl).toBe(app.storage.publicUrl(`shopify-garments/${storeId}/1/garment.jpg`));
    const blue = body.items.find((p: { shopifyProductId: number }) => p.shopifyProductId === 2);
    expect(blue.enabled).toBe(false);
  });

  it('paginates with page/pageSize', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?page=1&pageSize=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
  });
});
```

This test needs a session-token signer. No HTTP-route-level test for `/v1/shopify/me` exists yet (there is no `shopify-me.test.ts`), but `apps/api/test/shopify-service.test.ts` already has a local `signHs256` helper, proven against the real `verifySessionToken` (its "verifies a valid session token" test passes with exactly this claim set: `{ iss, dest, aud, exp, nbf, iat }` — no `sub`/`jti`/`sid` needed, `verifySessionToken` doesn't check those). Extract that proven shape into a new shared helper file rather than inventing a new one:

```ts
// apps/api/test/helpers/shopify-session.ts
import { createHmac } from 'node:crypto';

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** Raw signer — takes an arbitrary claims object, useful for constructing
 *  deliberately-invalid tokens (wrong aud, expired, etc.) in negative tests. */
export function signHs256(payloadObj: Record<string, unknown>, secret: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payloadObj);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Convenience wrapper over signHs256 for the common case: a valid,
 *  currently-live session token for a given shop. */
export function signSessionToken(shopDomain: string, secret: string, apiKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(
    {
      iss: `https://${shopDomain}/admin`,
      dest: `https://${shopDomain}`,
      aud: apiKey,
      exp: now + 60,
      nbf: now - 5,
      iat: now,
    },
    secret,
  );
}
```

Also update `apps/api/test/shopify-service.test.ts` to delete its own local `signHs256` function and instead `import { signHs256 } from './helpers/shopify-session.js';` — its three call sites currently call `signHs256({...claims...})` with the secret closed over from the module-level `SECRET` constant; the shared version takes `secret` as an explicit second argument, so update each call site to `signHs256({...claims...}, SECRET)`. Don't leave two copies of the same JWT-forging logic in the test suite.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: FAIL — `Cannot find module '../src/modules/shopify/products.routes.js'` or a 404, since neither the route nor (possibly) the helper file exists yet.

- [ ] **Step 3: Implement the endpoint**

Create `apps/api/src/modules/shopify/products.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function shopifyProductsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/shopify/products',
    { preHandler: app.requireShopifySession, schema: { querystring: ProductsQuery } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { page, pageSize } = req.query as z.infer<typeof ProductsQuery>;

      const [{ total }] = await app.db
        .select({ total: count() })
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.storeId, store.id));

      const rows = await app.db
        .select({
          shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
          title: schema.shopifyProductGarments.title,
          r2Key: schema.shopifyProductGarments.r2Key,
          status: schema.shopifyProductGarments.status,
          enabled: schema.shopifyProductGarments.enabled,
        })
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.storeId, store.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const items = rows.map((r) => ({
        shopifyProductId: r.shopifyProductId,
        title: r.title,
        thumbnailUrl: app.storage.publicUrl(r.r2Key),
        status: r.status,
        enabled: r.enabled,
      }));

      return { page, pageSize, total, items };
    },
  );
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/shopify/routes.ts`, add the import and registration:

```ts
import { shopifyProductsRoutes } from './products.routes.js';
```

```ts
  await app.register(shopifyBillingRoutes);
  await app.register(shopifyProductsRoutes);
```

(Insert the new `await app.register(shopifyProductsRoutes);` line right after the existing `shopifyBillingRoutes` registration.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/products.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-products.test.ts apps/api/test/helpers/shopify-session.ts
git commit -m "feat(api): GET /v1/shopify/products paginated list"
```

---

## Task 3: `GET /v1/shopify/products/:id/images` — live Shopify image list

**Files:**
- Modify: `apps/api/src/modules/shopify/products.sync.ts` (export `assertShopifyCdn`)
- Modify: `apps/api/src/modules/shopify/products.routes.ts`
- Modify: `apps/api/test/shopify-products.test.ts`

**Interfaces:**
- Consumes: `assertShopifyCdn(url: string): void` (existing in `products.sync.ts`, needs to become exported), `decryptToken` (existing, `apps/api/src/lib/crypto.js`), `SHOPIFY_API_VERSION` (existing, `service.js`).
- Produces: `GET /v1/shopify/products/:id/images` response `{ images: { id: number, src: string }[] }` — Task 4's `PATCH` handler and Task 8's frontend image-picker modal both consume this exact shape.

- [ ] **Step 1: Export `assertShopifyCdn`**

In `apps/api/src/modules/shopify/products.sync.ts`, change:

```ts
function assertShopifyCdn(url: string): void {
```

to:

```ts
export function assertShopifyCdn(url: string): void {
```

(No other change to that function — it's already exactly what both this task and Task 4 need: https-only, host-allowlisted to `myshopify.com`/`shopify.com`/`cdn.shopify.com`.)

- [ ] **Step 2: Write the failing test**

Add to `apps/api/test/shopify-products.test.ts` (same `describe`-adjacent file, new top-level `describe` block — this endpoint needs an injectable fetch, so add a second store/token setup or reuse the existing one from Task 2's `beforeAll` if the store/token variables are already in scope at file level):

```ts
describe('GET /v1/shopify/products/:id/images', () => {
  it('returns the live image list from Shopify for that product', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      expect(url).toContain('/products/1/images.json');
      return {
        ok: true,
        json: async () => ({
          images: [
            { id: 111, src: 'https://cdn.shopify.com/s/files/1/one.jpg' },
            { id: 222, src: 'https://cdn.shopify.com/s/files/1/two.jpg' },
          ],
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/products/1/images',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        images: [
          { id: 111, src: 'https://cdn.shopify.com/s/files/1/one.jpg' },
          { id: 222, src: 'https://cdn.shopify.com/s/files/1/two.jpg' },
        ],
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

(This test globally stubs `fetch` for the duration of one `it`, restoring it in `finally` — the route handler itself calls the real global `fetch`, not an injectable parameter, matching how `apps/api/src/modules/shopify/auth.routes.ts`'s OAuth callback and `billing.routes.ts` both call bare `fetch` directly today rather than accepting a `fetchFn` parameter. This endpoint follows that same existing convention rather than `products.sync.ts`'s injectable-`fetchFn` convention, since it has no test-suite need for concurrent/parallel fetch mocking the way `syncProduct` does.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 4: Implement the endpoint**

In `apps/api/src/modules/shopify/products.routes.ts`, add the import:

```ts
import { decryptToken } from '../../lib/crypto.js';
import { assertShopifyCdn } from './products.sync.js';
import { SHOPIFY_API_VERSION } from './service.js';
```

Add the route inside `shopifyProductsRoutes`, after the existing `GET /v1/shopify/products` handler:

```ts
  app.get(
    '/v1/shopify/products/:id/images',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const token = decryptToken(store.accessToken, app.env.SHOPIFY_TOKEN_ENC_KEY ?? '');

      const res = await fetch(
        `https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products/${id}/images.json`,
        { headers: { 'X-Shopify-Access-Token': token } },
      );
      if (!res.ok) {
        throw new AppError('SHOPIFY', 502, 'failed to fetch product images');
      }
      const { images } = (await res.json()) as { images: { id: number; src: string }[] };
      for (const img of images) assertShopifyCdn(img.src);

      return { images: images.map((img) => ({ id: img.id, src: img.src })) };
    },
  );
```

Add the `AppError` import at the top of the file alongside the others:

```ts
import { AppError } from '../../lib/errors.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: PASS (3 tests total across both `describe` blocks).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/src/modules/shopify/products.routes.ts apps/api/test/shopify-products.test.ts
git commit -m "feat(api): GET /v1/shopify/products/:id/images live Shopify proxy"
```

---

## Task 4: `PATCH /v1/shopify/products/:id` — enable toggle + image swap

**Files:**
- Modify: `apps/api/src/modules/shopify/products.routes.ts`
- Modify: `apps/api/test/shopify-products.test.ts`

**Interfaces:**
- Consumes: `assertShopifyCdn` (Task 3), the live-images-fetch logic (Task 3, extract into a shared local function in this same file so both the `/images` route and this `PATCH` handler call one implementation, not two copies).
- Produces: `PATCH /v1/shopify/products/:id` accepting `{ enabled?: boolean, garmentImageUrl?: string }`, at least one field required. Response: the updated row in the same shape as one `items[]` entry from Task 2's list endpoint (`{ shopifyProductId, title, thumbnailUrl, status, enabled }`) — Task 8's frontend uses this to update its local state after a successful PATCH without needing to re-fetch the whole list.

- [ ] **Step 1: Extract the shared live-image-fetch helper**

In `apps/api/src/modules/shopify/products.routes.ts`, refactor the body of the `/images` route (from Task 3) into a standalone function, and have the route call it:

```ts
async function fetchLiveProductImages(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyProductId: string,
): Promise<{ id: number; src: string }[]> {
  const token = decryptToken(store.accessToken, app.env.SHOPIFY_TOKEN_ENC_KEY ?? '');
  const res = await fetch(
    `https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products/${shopifyProductId}/images.json`,
    { headers: { 'X-Shopify-Access-Token': token } },
  );
  if (!res.ok) {
    throw new AppError('SHOPIFY', 502, 'failed to fetch product images');
  }
  const { images } = (await res.json()) as { images: { id: number; src: string }[] };
  for (const img of images) assertShopifyCdn(img.src);
  return images;
}
```

Replace the `/images` route's body with:

```ts
  app.get(
    '/v1/shopify/products/:id/images',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const images = await fetchLiveProductImages(app, store, id);
      return { images };
    },
  );
```

Run: `pnpm --filter @tryme/api test -- shopify-products` — expect the existing 3 tests still PASS (pure refactor, no behavior change) before continuing.

- [ ] **Step 2: Write the failing tests**

Add to `apps/api/test/shopify-products.test.ts`:

```ts
describe('PATCH /v1/shopify/products/:id', () => {
  it('rejects enabling a product that is not active', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enables an active product', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/1',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it('disables a product regardless of status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it('rejects a garmentImageUrl not in the product\'s real Shopify image list', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({ images: [{ id: 1, src: 'https://cdn.shopify.com/s/files/1/real.jpg' }] }),
      }) as Response) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/s/files/1/fake.jpg' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('swaps the garment image to a real one from the product\'s image list', async () => {
    const originalFetch = global.fetch;
    let downloadedFrom: string | undefined;
    global.fetch = (async (url: string) => {
      if (url.includes('/images.json')) {
        return {
          ok: true,
          json: async () => ({ images: [{ id: 1, src: 'https://cdn.shopify.com/s/files/1/new.jpg' }] }),
        } as Response;
      }
      downloadedFrom = url;
      return {
        ok: true,
        redirected: false,
        arrayBuffer: async () => new ArrayBuffer(4),
        headers: { get: () => 'image/jpeg' },
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/s/files/1/new.jpg' },
      });
      expect(res.statusCode).toBe(200);
      expect(downloadedFrom).toBe('https://cdn.shopify.com/s/files/1/new.jpg');
      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.shopifyProductId, 1));
      expect(row.r2Key).not.toBe(`shopify-garments/${storeId}/1/garment.jpg`);
      expect(row.r2Key).toContain(`shopify-garments/${storeId}/1/garment-`);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

Add `eq` to this test file's existing `drizzle-orm` import if not already imported (check the top of the file — Task 2's version of this file doesn't need `eq` itself, so add it now: `import { eq } from 'drizzle-orm';`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: FAIL — no `PATCH` route exists yet (404s).

- [ ] **Step 4: Implement the endpoint**

Add to `apps/api/src/modules/shopify/products.routes.ts` (imports needed at the top, alongside existing ones):

```ts
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
```

(`and`/`eq` may already be partially imported from Task 2/3 — merge into the existing `drizzle-orm` import line rather than adding a second one.)

```ts
const PatchProductBody = z
  .object({
    enabled: z.boolean().optional(),
    garmentImageUrl: z.string().url().optional(),
  })
  .refine((b) => b.enabled !== undefined || b.garmentImageUrl !== undefined, {
    message: 'at least one of enabled or garmentImageUrl is required',
  });

  app.patch(
    '/v1/shopify/products/:id',
    { preHandler: app.requireShopifySession, schema: { body: PatchProductBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const shopifyProductId = Number(id);
      const { enabled, garmentImageUrl } = req.body as z.infer<typeof PatchProductBody>;

      const [existing] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, store.id),
            eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
          ),
        )
        .limit(1);
      if (!existing) throw new AppError('NOT_FOUND', 404, 'product not synced yet');

      if (enabled === true && existing.status !== 'active') {
        throw new AppError('BAD_REQUEST', 400, 'cannot enable a product that is not active');
      }

      let newR2Key: string | undefined;
      if (garmentImageUrl) {
        const liveImages = await fetchLiveProductImages(app, store, id);
        const matched = liveImages.some((img) => img.src === garmentImageUrl);
        if (!matched) {
          throw new AppError('BAD_REQUEST', 400, 'garmentImageUrl is not one of this product\'s current images');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let res: Response;
        try {
          res = await fetch(garmentImageUrl, { redirect: 'error', signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected image');
        const contentLength = res.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
          throw new AppError('BAD_REQUEST', 400, 'image exceeds 10MB');
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
          throw new AppError('BAD_REQUEST', 400, 'image exceeds 10MB');
        }
        const contentType = res.headers.get('content-type') ?? 'image/jpeg';
        newR2Key = `shopify-garments/${store.id}/${shopifyProductId}/garment-${randomUUID()}.jpg`;
        await app.storage.putObject(newR2Key, Buffer.from(arrayBuffer), contentType);
      }

      const [updated] = await app.db
        .update(schema.shopifyProductGarments)
        .set({
          ...(enabled !== undefined ? { enabled } : {}),
          ...(newR2Key ? { r2Key: newR2Key } : {}),
        })
        .where(eq(schema.shopifyProductGarments.id, existing.id))
        .returning();

      return {
        shopifyProductId: updated.shopifyProductId,
        title: updated.title,
        thumbnailUrl: app.storage.publicUrl(updated.r2Key),
        status: updated.status,
        enabled: updated.enabled,
      };
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: PASS (8 tests total across all three `describe` blocks in this file).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/products.routes.ts apps/api/test/shopify-products.test.ts
git commit -m "feat(api): PATCH /v1/shopify/products/:id enable toggle + image swap"
```

---

## Task 5: Widget job creation — gate on `enabled`

**Files:**
- Modify: `apps/api/src/modules/widget/routes.ts:186-205`
- Modify: `apps/api/test/shopify-jobs.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyProductGarments.enabled` (Task 1).
- Produces: no new exports — behavior change to the existing `POST /v1/widget/jobs` Shopify branch.

- [ ] **Step 1: Fix the existing test's now-implicit assumption**

In `apps/api/test/shopify-jobs.test.ts`'s `beforeAll`, the existing garment insert currently omits `enabled` (relying on whatever the column allowed before Task 1 — now defaults `false`). Update it to be explicit:

```ts
  await app.db.insert(schema.shopifyProductGarments).values({
    storeId,
    shopifyProductId: 88,
    shopifyVariantId: null,
    r2Key: `shopify-garments/${storeId}/88/garment.jpg`,
    status: 'active',
    enabled: true,
  });
```

(Only the added `enabled: true` line is new.)

- [ ] **Step 2: Write the new failing test**

Add to the same `describe('shopify widget job', ...)` block in `apps/api/test/shopify-jobs.test.ts`:

```ts
  it('returns 202 without resyncing when the product is active but not enabled', async () => {
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId,
      shopifyProductId: 99,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/99/garment.jpg`,
      status: 'active',
      enabled: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/widget/jobs',
      headers: {
        'x-widget-key': widgetKey,
        'content-type': 'application/json',
        origin: 'https://j.myshopify.com',
      },
      payload: {
        shopifyProductId: 99,
        customerPhotoKey: `widget-inputs/${widgetClientId}/photo.jpg`,
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().message).not.toMatch(/preparing/i);
  });
```

- [ ] **Step 3: Run tests to verify the new one fails**

Run: `pnpm --filter @tryme/api test -- shopify-jobs`
Expected: the new test FAILS (today, a `status: 'active'` row with no `enabled` check always proceeds to create a real job — 201, not 202). The first test ("creates a shopify job...") should already PASS after Step 1's fix.

- [ ] **Step 4: Implement the enabled gate**

In `apps/api/src/modules/widget/routes.ts`, replace the current single combined query (currently around lines 186-205):

```ts
        const [garment] = await app.db
          .select()
          .from(schema.shopifyProductGarments)
          .where(
            and(
              eq(schema.shopifyProductGarments.storeId, store.id),
              eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
              eq(schema.shopifyProductGarments.status, 'active'),
            ),
          )
          .limit(1);

        if (!garment) {
          // trigger async sync, tell the storefront to retry
          const { enqueueSync } = await import('../shopify/service.js');
          await enqueueSync(app.redis, { storeId: store.id, mode: 'product', shopifyProductId });
          return reply
            .code(202)
            .send({ message: "We're preparing this product for try-on. Check back in a moment." });
        }
```

with:

```ts
        const [garment] = await app.db
          .select()
          .from(schema.shopifyProductGarments)
          .where(
            and(
              eq(schema.shopifyProductGarments.storeId, store.id),
              eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
              eq(schema.shopifyProductGarments.status, 'active'),
            ),
          )
          .limit(1);

        if (!garment) {
          // trigger async sync, tell the storefront to retry
          const { enqueueSync } = await import('../shopify/service.js');
          await enqueueSync(app.redis, { storeId: store.id, mode: 'product', shopifyProductId });
          return reply
            .code(202)
            .send({ message: "We're preparing this product for try-on. Check back in a moment." });
        }

        if (!garment.enabled) {
          // synced and active, but the merchant hasn't turned try-on on for this product —
          // not a freshness problem, so no resync trigger here (would be pointless work).
          return reply
            .code(202)
            .send({ message: 'This product is not available for try-on right now.' });
        }
```

(Everything below this — `resolvedGarmentKey = garment.r2Key;` etc. — is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- shopify-jobs`
Expected: PASS (3 tests: the original creates-a-job test, the original not-synced-yet test, and the new not-enabled test).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/widget/routes.ts apps/api/test/shopify-jobs.test.ts
git commit -m "feat(api): gate widget job creation on shopify_product_garments.enabled"
```

---

## Task 6: `apps/shopify/` — app scaffold, App Bridge auth, Dashboard screen

**Files:**
- Create: `apps/shopify/package.json`, `apps/shopify/tsconfig.json`, `apps/shopify/tsconfig.app.json`, `apps/shopify/tsconfig.node.json`, `apps/shopify/vite.config.ts`, `apps/shopify/index.html`, `apps/shopify/src/main.tsx`, `apps/shopify/src/App.tsx`, `apps/shopify/src/lib/appBridge.ts`, `apps/shopify/src/lib/api.ts`, `apps/shopify/src/types.ts`, `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `.env`, `.env.production.example`

**Interfaces:**
- Consumes: `GET /v1/shopify/me` (existing endpoint).
- Produces: `apiFetch<T>(path: string, init?: RequestInit): Promise<T>` (in `src/lib/api.ts`) — every later frontend task (Billing, Products screens) calls this exact function for all backend requests. `getIdToken(): Promise<string>` (in `src/lib/appBridge.ts`).

**No TDD** — this app has no automated test harness (matches `apps/admin-web`'s existing precedent). Verification is `pnpm --filter @tryme/shopify-admin build` succeeding, plus manual smoke-testing against the real dev store once deployed (last task of this plan covers the full manual verification pass).

- [ ] **Step 1: Add the `VITE_SHOPIFY_API_KEY` env var**

In `.env` (repo root), add near the existing `SHOPIFY_*` block:

```
VITE_SHOPIFY_API_KEY=<same value as SHOPIFY_API_KEY above>
```

(Copy the actual value already present in this session's `.env` for `SHOPIFY_API_KEY` — it's the same Partners app client ID, safe to expose client-side, that's what App Bridge's meta tag needs.)

In `.env.production.example`, add alongside the existing `SHOPIFY_*` block (around line 163-168):

```
VITE_SHOPIFY_API_KEY=                # same value as SHOPIFY_API_KEY, exposed client-side for App Bridge
```

- [ ] **Step 2: Create the package**

Create `apps/shopify/package.json`:

```json
{
  "name": "@tryme/shopify-admin",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b",
    "lint": "biome check src/"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "@shopify/polaris": "^13.9.5"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "~5.6.3",
    "vite": "^6.0.0"
  }
}
```

Before running install, check the actual current published versions with `npm view @shopify/polaris version` and `npm view react-router-dom version` — if either is meaningfully newer than what's above, use the real current version instead (this plan's versions are a real, correct starting point but npm's registry is the authoritative source at implementation time).

Create `apps/shopify/tsconfig.json` (identical to `apps/admin-web/tsconfig.json`):

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}
```

Create `apps/shopify/tsconfig.app.json` (identical to `apps/admin-web/tsconfig.app.json`):

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

Create `apps/shopify/tsconfig.node.json` (identical to `apps/admin-web/tsconfig.node.json`):

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "esnext",
    "types": ["node"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts"]
}
```

Create `apps/shopify/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  envDir: '../../',
  base: process.env.NODE_ENV === 'production' ? '/shopify-admin/' : '/',
  server: {
    port: 5174,
    proxy: {
      '/v1': 'http://127.0.0.1:4000',
    },
  },
});
```

(`envDir: '../../'` points Vite's env loader at the monorepo root so it reads the same root `.env`/`.env.production` this session has used throughout, instead of looking for an `apps/shopify/.env` that doesn't exist. Port `5174` avoids colliding with `admin-web`'s `5173`.)

- [ ] **Step 3: App Bridge + Polaris HTML shell**

Create `apps/shopify/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="shopify-api-key" content="%VITE_SHOPIFY_API_KEY%" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>TryMe Try-On</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

(Per Shopify's current documented requirement, the `shopify-api-key` meta tag must come before the App Bridge script tag, and the App Bridge script tag must be the first `<script>` in the document — both are satisfied here. Vite's built-in HTML env-variable substitution replaces `%VITE_SHOPIFY_API_KEY%` with the real value from `.env` at build/dev time, the same mechanism already used for `VITE_CHATBOT_URL` elsewhere in this repo.)

- [ ] **Step 4: App Bridge session-token helper**

Create `apps/shopify/src/lib/appBridge.ts`:

```ts
declare global {
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
    };
  }
}

export async function getIdToken(): Promise<string> {
  if (!window.shopify) {
    throw new Error('App Bridge not loaded — is this app running inside the Shopify admin iframe?');
  }
  return window.shopify.idToken();
}
```

- [ ] **Step 5: API fetch wrapper**

Create `apps/shopify/src/lib/api.ts`:

```ts
import { getIdToken } from './appBridge';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });

  if (res.status === 401) {
    // Session token may have expired between acquisition and use (~60s lifetime) — retry once with a fresh one.
    const freshToken = await getIdToken();
    const retryRes = await fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${freshToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!retryRes.ok) {
      const body = await retryRes.text();
      throw new ApiError(retryRes.status, body || retryRes.statusText);
    }
    return retryRes.json() as Promise<T>;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 6: Shared types**

Create `apps/shopify/src/types.ts`:

```ts
export interface ShopifyMe {
  shopDomain: string;
  planId: string | null;
  balance: number;
}

export interface ShopifyPlan {
  id: string;
  name: string;
  priceCents: number;
  includedTryons: number;
  overageCents: number;
  trialDays: number;
  isActive: boolean;
}

export interface ShopifyProductListItem {
  shopifyProductId: number;
  title: string | null;
  thumbnailUrl: string;
  status: string;
  enabled: boolean;
}

export interface ShopifyProductImage {
  id: number;
  src: string;
}
```

(Read the actual current response shape of `GET /v1/shopify/me` in `apps/api/src/modules/shopify/me.routes.ts` before finalizing `ShopifyMe` above — this plan's field names are inferred from this session's earlier work on that route; confirm and correct field names to match reality exactly before using them in Step 7 below.)

- [ ] **Step 7: Dashboard screen + app shell**

Create `apps/shopify/src/pages/DashboardPage.tsx`:

```tsx
import { Banner, Card, Layout, Page, SkeletonBodyText, Text } from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { ShopifyMe } from '../types';

export default function DashboardPage() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page title="TryMe Try-On">
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Failed to load account status">
              {error}
            </Banner>
          )}
          <Card>
            {loading ? (
              <SkeletonBodyText lines={3} />
            ) : (
              <>
                <Text as="h2" variant="headingMd">
                  {me?.shopDomain}
                </Text>
                <Text as="p">Credit balance: {me?.balance ?? 0}</Text>
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

Create `apps/shopify/src/App.tsx`:

```tsx
import '@shopify/polaris/build/esm/styles.css';
import { AppProvider } from '@shopify/polaris';
import { Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';

export default function App() {
  return (
    <AppProvider i18n={{}}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
      </Routes>
    </AppProvider>
  );
}
```

Create `apps/shopify/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';

const basename = import.meta.env.PROD ? '/shopify-admin' : '/';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 8: Install + build**

Run: `pnpm install` (from repo root — picks up the new workspace package)
Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors. If `@shopify/polaris`'s peer-dependency range warns about React 19 (the workspace-wide `pnpm-workspace.yaml` override forces React 19 everywhere, same as `admin-web` already runs on today), that is an acceptable warning, not a failure — `admin-web` already demonstrates this exact combination works in this repo. If the build hard-fails (not just warns), stop and report BLOCKED with the exact error.

- [ ] **Step 9: Commit**

```bash
git add apps/shopify/ .env.production.example
git commit -m "feat(shopify-admin): scaffold apps/shopify with App Bridge auth + Dashboard screen"
```

(Do not commit `.env` itself — it's already gitignored, matching every other secret-bearing env var in this repo.)

---

## Task 7: Billing screen

**Files:**
- Create: `apps/shopify/src/pages/BillingPage.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `GET /v1/shopify/billing/plans` (existing, returns `{ plans: ShopifyPlan[], currentPlanId: string | null }`), `POST /v1/shopify/billing/select` (existing, body `{ planId: string }`, returns `{ confirmationUrl: string }`), `apiFetch` (Task 6).
- Produces: nothing consumed by later tasks.

**No TDD** — same as Task 6.

- [ ] **Step 1: Read the real response shape**

Before writing this screen, read `apps/api/src/modules/shopify/billing.routes.ts`'s `GET /v1/shopify/billing/plans` handler (already shown in this plan's context above, but confirm it hasn't drifted) — confirm the exact response field names (`plans`, `currentPlanId`) match what's used below.

- [ ] **Step 2: Billing screen**

Create `apps/shopify/src/pages/BillingPage.tsx`:

```tsx
import { Badge, Banner, BlockStack, Button, Card, Layout, Page, SkeletonBodyText, Text } from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { ShopifyPlan } from '../types';

export default function BillingPage() {
  const [plans, setPlans] = useState<ShopifyPlan[]>([]);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ plans: ShopifyPlan[]; currentPlanId: string | null }>('/v1/shopify/billing/plans')
      .then((data) => {
        setPlans(data.plans);
        setCurrentPlanId(data.currentPlanId);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function selectPlan(planId: string) {
    setSelecting(planId);
    setError(null);
    try {
      const { confirmationUrl } = await apiFetch<{ confirmationUrl: string }>(
        '/v1/shopify/billing/select',
        { method: 'POST', body: JSON.stringify({ planId }) },
      );
      if (window.shopify) {
        // Shopify billing confirmation can't render inside the embedded iframe —
        // navigate the top-level window, not this app's own location.
        window.top!.location.href = confirmationUrl;
      } else {
        window.location.href = confirmationUrl;
      }
    } catch (err) {
      setError((err as Error).message);
      setSelecting(null);
    }
  }

  return (
    <Page title="Billing">
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Failed to update plan">
              {error}
            </Banner>
          )}
          {loading ? (
            <Card>
              <SkeletonBodyText lines={4} />
            </Card>
          ) : (
            <BlockStack gap="400">
              {plans.map((plan) => (
                <Card key={plan.id}>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      {plan.name} {plan.id === currentPlanId && <Badge tone="success">Current</Badge>}
                    </Text>
                    <Text as="p">
                      ${(plan.priceCents / 100).toFixed(2)}/month — {plan.includedTryons} try-ons included
                    </Text>
                    <Button
                      onClick={() => selectPlan(plan.id)}
                      loading={selecting === plan.id}
                      disabled={plan.id === currentPlanId}
                    >
                      {plan.id === currentPlanId ? 'Current plan' : 'Select'}
                    </Button>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 3: Wire the route**

In `apps/shopify/src/App.tsx`, add the import and route:

```tsx
import BillingPage from './pages/BillingPage';
```

```tsx
        <Route path="/" element={<DashboardPage />} />
        <Route path="/billing" element={<BillingPage />} />
```

Add a link from the Dashboard to Billing — in `apps/shopify/src/pages/DashboardPage.tsx`, add near the top of the file:

```tsx
import { Link } from 'react-router-dom';
```

and inside the `<Card>` block, after the balance `<Text>`:

```tsx
                <Link to="/billing">Manage billing</Link>
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/pages/BillingPage.tsx apps/shopify/src/App.tsx apps/shopify/src/pages/DashboardPage.tsx
git commit -m "feat(shopify-admin): billing screen (plan list + select)"
```

---

## Task 8: Products screen — list, enable toggle, image picker

**Files:**
- Create: `apps/shopify/src/pages/ProductsPage.tsx`
- Create: `apps/shopify/src/components/ImagePickerModal.tsx`
- Modify: `apps/shopify/src/App.tsx`, `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `GET /v1/shopify/products` (Task 2), `GET /v1/shopify/products/:id/images` (Task 3), `PATCH /v1/shopify/products/:id` (Task 4), `apiFetch` (Task 6), `ShopifyProductListItem`/`ShopifyProductImage` (Task 6).
- Produces: nothing consumed by later tasks — last task of this plan.

**No TDD** — same as Tasks 6-7.

- [ ] **Step 1: Image picker modal**

Create `apps/shopify/src/components/ImagePickerModal.tsx`:

```tsx
import { Modal, Thumbnail } from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { ShopifyProductImage } from '../types';

interface Props {
  shopifyProductId: number;
  onClose: () => void;
  onSelect: (src: string) => void;
}

export function ImagePickerModal({ shopifyProductId, onClose, onSelect }: Props) {
  const [images, setImages] = useState<ShopifyProductImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ images: ShopifyProductImage[] }>(`/v1/shopify/products/${shopifyProductId}/images`)
      .then((data) => setImages(data.images))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [shopifyProductId]);

  return (
    <Modal open title="Choose garment image" onClose={onClose}>
      <Modal.Section>
        {error && <p>{error}</p>}
        {loading && <p>Loading images...</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              onClick={() => onSelect(img.src)}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
            >
              <Thumbnail source={img.src} alt="" size="large" />
            </button>
          ))}
        </div>
      </Modal.Section>
    </Modal>
  );
}
```

- [ ] **Step 2: Products screen**

Create `apps/shopify/src/pages/ProductsPage.tsx`:

```tsx
import { Badge, Banner, IndexTable, Page, Thumbnail, useIndexResourceState } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { ImagePickerModal } from '../components/ImagePickerModal';
import { apiFetch } from '../lib/api';
import type { ShopifyProductListItem } from '../types';

const STATUS_TONE: Record<string, 'success' | 'attention' | 'critical'> = {
  active: 'success',
  processing: 'attention',
  failed: 'critical',
};

export default function ProductsPage() {
  const [items, setItems] = useState<ShopifyProductListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerProductId, setPickerProductId] = useState<number | null>(null);
  const { selectedResources } = useIndexResourceState(
    items.map((i) => ({ id: String(i.shopifyProductId) })),
  );

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: ShopifyProductListItem[] }>('/v1/shopify/products?pageSize=100')
      .then((data) => setItems(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleEnabled(shopifyProductId: number, enabled: boolean) {
    setError(null);
    try {
      const updated = await apiFetch<ShopifyProductListItem>(`/v1/shopify/products/${shopifyProductId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      setItems((prev) =>
        prev.map((p) => (p.shopifyProductId === shopifyProductId ? updated : p)),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function selectImage(shopifyProductId: number, src: string) {
    setError(null);
    try {
      const updated = await apiFetch<ShopifyProductListItem>(`/v1/shopify/products/${shopifyProductId}`, {
        method: 'PATCH',
        body: JSON.stringify({ garmentImageUrl: src }),
      });
      setItems((prev) =>
        prev.map((p) => (p.shopifyProductId === shopifyProductId ? updated : p)),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPickerProductId(null);
    }
  }

  return (
    <Page title="Products">
      {error && (
        <Banner tone="critical" title="Something went wrong">
          {error}
        </Banner>
      )}
      <IndexTable
        resourceName={{ singular: 'product', plural: 'products' }}
        itemCount={items.length}
        selectedItemsCount={selectedResources.length}
        headings={[
          { title: 'Image' },
          { title: 'Title' },
          { title: 'Status' },
          { title: 'Try-on enabled' },
        ]}
        loading={loading}
      >
        {items.map((item, index) => (
          <IndexTable.Row id={String(item.shopifyProductId)} key={item.shopifyProductId} position={index}>
            <IndexTable.Cell>
              <Thumbnail source={item.thumbnailUrl} alt={item.title ?? ''} size="small" />
              <button
                type="button"
                onClick={() => setPickerProductId(item.shopifyProductId)}
                style={{ display: 'block', marginTop: '4px' }}
              >
                Change image
              </button>
            </IndexTable.Cell>
            <IndexTable.Cell>{item.title}</IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone={STATUS_TONE[item.status] ?? 'attention'}>{item.status}</Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={item.status !== 'active' && !item.enabled}
                title={item.status !== 'active' ? 'Waiting for product sync' : undefined}
                onChange={(e) => toggleEnabled(item.shopifyProductId, e.target.checked)}
              />
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
      {pickerProductId !== null && (
        <ImagePickerModal
          shopifyProductId={pickerProductId}
          onClose={() => setPickerProductId(null)}
          onSelect={(src) => selectImage(pickerProductId, src)}
        />
      )}
    </Page>
  );
}
```

(Using a plain HTML `<input type="checkbox">` rather than Polaris's `Checkbox` component here is a deliberate, minimal choice — swap to Polaris's own `Checkbox` if the implementer finds it renders more consistently inside `IndexTable.Cell`; functionally equivalent either way, and this isn't worth a second review round-trip over.)

- [ ] **Step 3: Wire the route + navigation**

In `apps/shopify/src/App.tsx`:

```tsx
import ProductsPage from './pages/ProductsPage';
```

```tsx
        <Route path="/products" element={<ProductsPage />} />
```

In `apps/shopify/src/pages/DashboardPage.tsx`, add near the existing "Manage billing" link:

```tsx
                <Link to="/products">Manage products</Link>
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/pages/ProductsPage.tsx apps/shopify/src/components/ImagePickerModal.tsx apps/shopify/src/App.tsx apps/shopify/src/pages/DashboardPage.tsx
git commit -m "feat(shopify-admin): products screen (list, enable toggle, image picker)"
```

- [ ] **Step 6: Manual verification against the real dev store**

This step has no automated test — it is the final acceptance check for this entire plan:

1. Update the Partners app's configuration (`apps/shopify-extension/shopify.app.toml`, from the prior plan) or a new `shopify.app.toml` for this app's own App URL if this is served as a separate embedded-app entry — confirm with the human operator how this new app's URL gets registered with Shopify (Partners dashboard → App setup → Embedded app home URL) before this step, since that registration is a manual Partners-dashboard action, not something any task in this plan automates.
2. Run `pnpm --filter @tryme/shopify-admin dev` (or deploy a built version behind the same ngrok tunnel already used this session).
3. Open the app from the Shopify admin (`https://admin.shopify.com/store/<dev-store>/apps/<app-handle>`).
4. Confirm the Dashboard loads real data (shop domain, credit balance) — proves App Bridge session-token auth works end-to-end against a real embedded session, not just a forged test token.
5. Go to Billing, select a plan, confirm it redirects the top-level window (not the iframe) to Shopify's real confirmation screen, approve it, confirm it lands back on the Dashboard with `?billing=active`.
6. Go to Products, confirm the list shows real synced products (trigger a sync first via the Dashboard's "Sync products now" button if the list is empty), toggle one product's enable switch on, confirm the toggle is disabled/greyed for any `processing`/`failed` product, open "Change image" on the enabled product and confirm it shows that product's real Shopify images, pick a different one, confirm it saves.
7. From the storefront (the theme extension from the prior plan), confirm the try-on button now actually creates a real job for the product you just enabled, and confirm a *different*, still-disabled product's button shows the "not available for try-on right now" message instead of creating a job.
