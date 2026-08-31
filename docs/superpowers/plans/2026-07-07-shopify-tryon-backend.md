# Shopify Try-On Plugin — Backend Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side path that lets a Shopify store install the app, auto-sync product images to garments, and serve a virtual try-on to a shopper from the storefront — end-to-end, without any Shopify-side UI yet.

**Architecture:** Extend the existing widget/merchant system (Approach A). A Shopify store becomes a `widget_clients` row (`clientType='shopify'`) linked 1:1 to a new `shopify_stores` row. Try-on jobs reuse the widget job pipeline; they are distinguished by `job_inputs.params.kind === 'shopify'` (mirrors saree jobs) — **there is no `jobs.jobType` column**. Product sync runs on a dedicated Redis Stream so webhooks/requests never block.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM (PostgreSQL 16), Redis 7 Streams, R2/MinIO storage, Node `crypto` (AES-256-GCM + HMAC-SHA256), Vitest integration harness.

**Scope note:** This plan covers spec Implementation-Order steps 1–7 + 10 (DB, admin plans, OAuth+auth, webhooks, product sync, widget-job extension, billing, dispatcher). The two frontend subsystems — `apps/shopify/` (Polaris embedded admin) and `apps/shopify-extension/` (Shopify CLI theme extension) — plus the internal-admin-web views are **separate follow-on plans** (different toolchains, independently shippable). This backend slice is testable on its own via the Vitest harness with HMAC/JWT fixtures (no live Shopify needed).

## Global Constraints

- **Credit units:** `shopify_plans.included_tryons` is in try-ons; `widget_client_credits.balance` is in credits. `SHOPIFY_JOB_COST = 10` credits per try-on (mirrors existing `WIDGET_JOB_COST = 10`). Seed balance as `included_tryons * SHOPIFY_JOB_COST`. Cap/overage math is in credits.
- **No `jobs.jobType` column.** Route Shopify jobs via `job_inputs.params.kind === 'shopify'`.
- **OAuth scopes = least privilege:** `read_products` (mandatory) + `write_script_tags` (fallback only). Never request write/orders/customers scopes.
- **Session tokens:** HS256 signed with `SHOPIFY_API_SECRET`. No `kid`/JWKS. Reject any alg other than HS256 (never `none`).
- **Webhook HMAC:** computed over the **raw request body**. Verify → respond `200` immediately → do real work on the `shopify:sync` queue. Shopify retries anything slower than ~5s.
- **Access tokens encrypted at rest:** AES-256-GCM, key from `SHOPIFY_TOKEN_ENC_KEY` (32-byte, base64). Stored as `iv:authTag:ciphertext` (all base64, colon-joined).
- **GDPR webhooks mandatory:** `customers/data_request`, `customers/redact`, `shop/redact` — required for App Store listing.
- **R2 key convention:**
  - `shopify-garments/<storeId>/<productId>/garment.jpg`
  - `shopify-photos/<storeId>/<jobId>/customer.jpg`
  - `outputs/<jobId>/result.png`
- **Job statuses are UPPERCASE** (`QUEUED`, `COMPLETED`, `FAILED`) — schema default is `'QUEUED'`.
- **Conventions:** ESM only (`.js` import specifiers), pnpm workspaces, pino via `@tryme/logger` (no `console.log`), Postgres/Redis bind `127.0.0.1`. `@tryme/db` exports `* as schema` — never add a duplicate re-export.

---

## File Structure

**Create:**
- `packages/db/src/schema/shopify.ts` — `shopifyPlans`, `shopifyStores`, `shopifyProductGarments` tables
- `packages/db/src/migrations/0088_shopify_tables.sql` — generated migration (+ `client_type` on `widget_clients`)
- `apps/api/src/lib/crypto.ts` — `encryptToken` / `decryptToken` (AES-256-GCM)
- `apps/api/src/modules/shopify/service.ts` — Shopify API client, HMAC verify, session-token verify, sync-task enqueue
- `apps/api/src/modules/shopify/auth.routes.ts` — OAuth initiate + callback (store upsert)
- `apps/api/src/modules/shopify/webhook.routes.ts` — webhook handlers (raw-body HMAC)
- `apps/api/src/modules/shopify/products.sync.ts` — sync worker logic (download + upload)
- `apps/api/src/modules/shopify/billing.routes.ts` — plan select + charge callback
- `apps/api/src/modules/shopify/me.routes.ts` — embedded-admin config endpoint (`GET /v1/shopify/me`)
- `apps/api/src/modules/shopify/routes.ts` — registers all shopify sub-routers
- `apps/api/src/modules/admin/shopify-plans.routes.ts` — internal admin plan CRUD
- `apps/api/src/plugins/shopify-auth.ts` — `requireShopifySession` decorator
- `apps/api/test/shopify-crypto.test.ts`, `shopify-service.test.ts`, `shopify-oauth.test.ts`, `shopify-webhooks.test.ts`, `shopify-plans.test.ts`, `shopify-jobs.test.ts`, `shopify-billing.test.ts`

**Modify:**
- `apps/api/src/env.ts` — add `SHOPIFY_*` vars
- `apps/api/src/server.ts` — register shopify routes + `shopifyAuthPlugin`
- `apps/api/src/modules/widget/routes.ts` — accept `shopifyProductId`, resolve garment from R2
- `packages/db/src/schema/index.ts` — `export * from './shopify.js'`
- `packages/db/src/schema/widget.ts` — add `clientType` column + `WidgetSettings` unchanged
- `apps/api/src/modules/widget/ledger.ts` — reuse as-is (no change; documented for implementer)
- `apps/dispatcher/src/job/processor.ts` — add `processShopifyJob` branch inside `processWidgetJob`

---

## Task 1: Database schema + migration

**Files:**
- Create: `packages/db/src/schema/shopify.ts`
- Modify: `packages/db/src/schema/widget.ts` (add `clientType`)
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/0088_shopify_tables.sql` (via `pnpm db:generate`)

**Interfaces:**
- Produces: `schema.shopifyPlans`, `schema.shopifyStores`, `schema.shopifyProductGarments`, and `schema.widgetClients.clientType`. `ShopifyStoreSettings` interface: `{ buttonText?: string; buttonColor?: string; position?: string; customCss?: string; workflowTemplateId?: string }`.

- [ ] **Step 1: Write the schema file**

Create `packages/db/src/schema/shopify.ts`:

```ts
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { widgetClients } from './widget.js';

export interface ShopifyStoreSettings {
  buttonText?: string;
  buttonColor?: string;
  position?: string;
  customCss?: string;
  workflowTemplateId?: string;
}

export const shopifyPlans = pgTable('shopify_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  includedTryons: integer('included_tryons').notNull(),
  overageCents: integer('overage_cents').notNull(),
  trialDays: integer('trial_days').notNull().default(7),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyStores = pgTable('shopify_stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id')
    .notNull()
    .unique()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  shopDomain: text('shop_domain').notNull().unique(),
  shopifyShopId: bigint('shopify_shop_id', { mode: 'number' }).notNull().unique(),
  accessToken: text('access_token').notNull(), // encrypted: iv:authTag:ciphertext
  scope: text('scope').notNull(),
  billingPlanId: bigint('billing_plan_id', { mode: 'number' }),
  shopifyPlanId: uuid('shopify_plan_id').references(() => shopifyPlans.id),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
  settings: jsonb('settings').$type<ShopifyStoreSettings>().notNull().default({}),
  syncCursor: text('sync_cursor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    status: text('status').notNull().default('processing'), // active|processing|failed|deleted
    failedReason: text('failed_reason'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyProductId, t.shopifyVariantId),
  }),
);
```

- [ ] **Step 2: Add `clientType` to `widget_clients`**

In `packages/db/src/schema/widget.ts`, add to the `widgetClients` table definition after `widgetKey`:

```ts
  clientType: text('client_type').notNull().default('merchant'), // 'merchant' | 'shopify'
```

- [ ] **Step 3: Export the new schema**

In `packages/db/src/schema/index.ts` add (keep alphabetical among existing lines):

```ts
export * from './shopify.js';
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/0088_*.sql` is created and `meta/_journal.json` gains entry idx 88. If drizzle-kit names it differently, rename to `0088_shopify_tables.sql` and update the journal `tag` accordingly (server index is canonical; next free idx is 88).

- [ ] **Step 5: Apply + verify migration**

Run: `pnpm db:migrate`
Expected: applies cleanly; `\d shopify_stores` shows the table. Re-running is a no-op.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/db typecheck && pnpm --filter @tryme/db build`
Expected: PASS (CJS build for Metro also succeeds).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/schema/widget.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): shopify_stores, shopify_product_garments, shopify_plans + client_type"
```

---

## Task 2: Token encryption helper (AES-256-GCM)

**Files:**
- Create: `apps/api/src/lib/crypto.ts`
- Create: `apps/api/test/shopify-crypto.test.ts`
- Modify: `apps/api/src/env.ts`

**Interfaces:**
- Produces: `encryptToken(plaintext: string, keyB64: string): string` returning `iv:authTag:ciphertext` (base64 parts). `decryptToken(payload: string, keyB64: string): string`. Env gains `SHOPIFY_TOKEN_ENC_KEY`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SHOPIFY_SCOPES`, `SHOPIFY_JOB_COST`.

- [ ] **Step 1: Add env vars**

In `apps/api/src/env.ts`, add inside the `z.object({...})` before the closing `})`:

```ts
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_APP_URL: z.string().url().optional(),
  SHOPIFY_SCOPES: z.string().default('read_products'),
  // 32-byte key, base64-encoded (44 chars). Required only when Shopify is enabled.
  SHOPIFY_TOKEN_ENC_KEY: z.string().optional(),
  SHOPIFY_JOB_COST: z.coerce.number().default(10),
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/shopify-crypto.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/lib/crypto.js';

const KEY = randomBytes(32).toString('base64');

describe('token crypto', () => {
  it('round-trips a token', () => {
    const enc = encryptToken('shpat_secret_value', KEY);
    expect(enc).not.toContain('shpat_secret_value');
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptToken(enc, KEY)).toBe('shpat_secret_value');
  });

  it('fails to decrypt with a wrong key', () => {
    const enc = encryptToken('x', KEY);
    const wrong = randomBytes(32).toString('base64');
    expect(() => decryptToken(enc, wrong)).toThrow();
  });

  it('produces a different ciphertext each call (random IV)', () => {
    expect(encryptToken('x', KEY)).not.toBe(encryptToken('x', KEY));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-crypto`
Expected: FAIL — cannot find `../src/lib/crypto.js`.

- [ ] **Step 4: Implement crypto helper**

Create `apps/api/src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';

function key(keyB64: string): Buffer {
  const k = Buffer.from(keyB64, 'base64');
  if (k.length !== 32) throw new Error('SHOPIFY_TOKEN_ENC_KEY must be 32 bytes (base64)');
  return k;
}

export function encryptToken(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptToken(payload: string, keyB64: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv(ALG, key(keyB64), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-crypto`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/crypto.ts apps/api/test/shopify-crypto.test.ts apps/api/src/env.ts
git commit -m "feat(api): AES-256-GCM token crypto + shopify env vars"
```

---

## Task 3: Shopify service — HMAC + session token + API client

**Files:**
- Create: `apps/api/src/modules/shopify/service.ts`
- Create: `apps/api/test/shopify-service.test.ts`

**Interfaces:**
- Consumes: env (`SHOPIFY_API_SECRET`, `SHOPIFY_API_KEY`).
- Produces:
  - `verifyWebhookHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean`
  - `verifyQueryHmac(query: Record<string, string>, secret: string): boolean` (OAuth callback + billing callback)
  - `verifySessionToken(token: string, secret: string, apiKey: string): { dest: string; shopDomain: string }` — throws on invalid
  - `shopHostFromDomain(domain: string): string` (strips protocol/path)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-service.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyQueryHmac, verifySessionToken, verifyWebhookHmac } from '../src/modules/shopify/service.js';

const SECRET = 'shpss_test_secret';
const API_KEY = 'shpapikey';

function signHs256(payloadObj: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payloadObj);
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

describe('shopify service', () => {
  it('verifies a valid webhook HMAC', () => {
    const raw = Buffer.from('{"id":1}');
    const hmac = createHmac('sha256', SECRET).update(raw).digest('base64');
    expect(verifyWebhookHmac(raw, hmac, SECRET)).toBe(true);
    expect(verifyWebhookHmac(raw, 'AAAA', SECRET)).toBe(false);
  });

  it('verifies a valid query HMAC and rejects tampering', () => {
    const params: Record<string, string> = { shop: 'a.myshopify.com', code: 'abc', ts: '1' };
    const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const hmac = createHmac('sha256', SECRET).update(msg).digest('hex');
    expect(verifyQueryHmac({ ...params, hmac }, SECRET)).toBe(true);
    expect(verifyQueryHmac({ ...params, hmac, code: 'evil' }, SECRET)).toBe(false);
  });

  it('verifies a valid session token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256({
      iss: 'https://a.myshopify.com/admin', dest: 'https://a.myshopify.com',
      aud: API_KEY, exp: now + 60, nbf: now - 5, iat: now,
    });
    const res = verifySessionToken(token, SECRET, API_KEY);
    expect(res.shopDomain).toBe('a.myshopify.com');
  });

  it('rejects a session token with wrong aud', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256({ iss: 'https://a.myshopify.com/admin', dest: 'https://a.myshopify.com', aud: 'other', exp: now + 60, nbf: now - 5 });
    expect(() => verifySessionToken(token, SECRET, API_KEY)).toThrow();
  });

  it('rejects an expired session token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256({ iss: 'https://a.myshopify.com/admin', dest: 'https://a.myshopify.com', aud: API_KEY, exp: now - 10, nbf: now - 60 });
    expect(() => verifySessionToken(token, SECRET, API_KEY)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/shopify/service.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }
  return safeEq(digest, provided);
}

export function verifyQueryHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  const digest = createHmac('sha256', secret).update(msg).digest('hex');
  return safeEq(Buffer.from(digest, 'utf8'), Buffer.from(hmac, 'utf8'));
}

export function shopHostFromDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

interface SessionClaims {
  iss?: string;
  dest?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
}

export function verifySessionToken(
  token: string,
  secret: string,
  apiKey: string,
): { dest: string; shopDomain: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed session token');
  const [headB64, bodyB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString()) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('unexpected token alg'); // never accept `none`
  const expected = createHmac('sha256', secret).update(`${headB64}.${bodyB64}`).digest('base64url');
  if (!safeEq(Buffer.from(expected), Buffer.from(sigB64))) throw new Error('bad signature');

  const claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString()) as SessionClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 5) throw new Error('token not yet valid');
  if (claims.aud !== apiKey) throw new Error('aud mismatch');
  if (!claims.dest || !claims.iss) throw new Error('missing dest/iss');
  if (shopHostFromDomain(claims.dest) !== shopHostFromDomain(claims.iss)) throw new Error('iss/dest host mismatch');
  const shopDomain = shopHostFromDomain(claims.dest);
  return { dest: claims.dest, shopDomain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-service`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/service.ts apps/api/test/shopify-service.test.ts
git commit -m "feat(api): shopify HMAC + session-token verification"
```

---

## Task 4: Internal admin plan CRUD

**Files:**
- Create: `apps/api/src/modules/admin/shopify-plans.routes.ts`
- Create: `apps/api/test/shopify-plans.test.ts`
- Modify: `apps/api/src/server.ts` (register)

**Interfaces:**
- Consumes: existing `app.requireAdmin(['SUPER_ADMIN','ADMIN'])`, `app.db`, `schema.shopifyPlans`.
- Produces: `GET/POST /admin/shopify-plans`, `PATCH/DELETE /admin/shopify-plans/:id`. `DELETE` is soft (`isActive=false`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-plans.test.ts` (model auth setup on an existing admin test — reuse the harness's admin-login helper if present; otherwise seed an `admin_users` row + mint a token via the auth service):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { adminAuthHeader } from './helpers/admin.js'; // create if missing; see note

let c: Containers; let app: TestApp; let auth: Record<string, string>;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  auth = await adminAuthHeader(app); // returns { authorization: 'Bearer …', cookie? }
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('admin shopify-plans', () => {
  it('creates, lists, updates, soft-deletes a plan', async () => {
    const created = await app.inject({
      method: 'POST', url: '/admin/shopify-plans', headers: auth,
      payload: { name: 'Trend', priceCents: 1999, includedTryons: 100, overageCents: 16 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list = await app.inject({ method: 'GET', url: '/admin/shopify-plans', headers: auth });
    expect(list.json().plans).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH', url: `/admin/shopify-plans/${id}`, headers: auth, payload: { includedTryons: 150 },
    });
    expect(patched.json().plan.includedTryons).toBe(150);

    const del = await app.inject({ method: 'DELETE', url: `/admin/shopify-plans/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    const listAfter = await app.inject({ method: 'GET', url: '/admin/shopify-plans?activeOnly=true', headers: auth });
    expect(listAfter.json().plans).toHaveLength(0);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/shopify-plans' });
    expect(res.statusCode).toBe(401);
  });
});
```

> **Note for implementer:** if `apps/api/test/helpers/admin.ts` does not exist, create a minimal `adminAuthHeader(app)` that inserts an `admin_users` row for a seeded user and returns the auth header the existing admin routes expect. Check any existing `apps/api/test/*admin*.test.ts` for the exact login pattern and copy it — do not invent a new auth scheme.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-plans`
Expected: FAIL — route 404 / module missing.

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/modules/admin/shopify-plans.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const CreatePlan = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  includedTryons: z.number().int().positive(),
  overageCents: z.number().int().nonnegative(),
  trialDays: z.number().int().nonnegative().default(7),
  sortOrder: z.number().int().default(0),
});
const UpdatePlan = CreatePlan.partial().extend({ isActive: z.boolean().optional() });

export async function adminShopifyPlansRoutes(app: FastifyInstance) {
  const admin = { preHandler: app.requireAdmin(['SUPER_ADMIN', 'ADMIN']) };

  app.get('/admin/shopify-plans', admin, async (req) => {
    const activeOnly = (req.query as { activeOnly?: string }).activeOnly === 'true';
    const rows = await app.db.select().from(schema.shopifyPlans).orderBy(desc(schema.shopifyPlans.sortOrder));
    return { plans: activeOnly ? rows.filter((r) => r.isActive) : rows };
  });

  app.post('/admin/shopify-plans', { ...admin, schema: { body: CreatePlan } }, async (req, reply) => {
    const [plan] = await app.db.insert(schema.shopifyPlans).values(req.body as z.infer<typeof CreatePlan>).returning();
    return reply.code(201).send({ id: plan.id, plan });
  });

  app.patch('/admin/shopify-plans/:id', { ...admin, schema: { body: UpdatePlan } }, async (req) => {
    const { id } = req.params as { id: string };
    const [plan] = await app.db.update(schema.shopifyPlans)
      .set(req.body as z.infer<typeof UpdatePlan>)
      .where(eq(schema.shopifyPlans.id, id)).returning();
    return { plan };
  });

  app.delete('/admin/shopify-plans/:id', admin, async (req) => {
    const { id } = req.params as { id: string };
    await app.db.update(schema.shopifyPlans).set({ isActive: false }).where(eq(schema.shopifyPlans.id, id));
    return { ok: true };
  });
}
```

> **Note:** confirm `app.requireAdmin` is a factory returning a preHandler. Check an existing `apps/api/src/modules/admin/*.routes.ts` and match the exact signature (some codebases expose `app.requireAdmin(roles)`, others a static `app.requireAdmin` + per-route role check). Adjust the `admin` const to match.

- [ ] **Step 4: Register the route**

In `apps/api/src/server.ts`, add the import near the other admin imports and register it beside the other `adminXxxRoutes` registrations:

```ts
import { adminShopifyPlansRoutes } from './modules/admin/shopify-plans.routes.js';
// …
await app.register(adminShopifyPlansRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-plans`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/shopify-plans.routes.ts apps/api/test/shopify-plans.test.ts apps/api/src/server.ts
git commit -m "feat(api): internal admin CRUD for shopify plans"
```

---

## Task 5: `requireShopifySession` auth plugin

**Files:**
- Create: `apps/api/src/plugins/shopify-auth.ts`
- Create: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: covered in Task 6's `shopify-oauth.test.ts` via `GET /v1/shopify/me`

**Interfaces:**
- Consumes: `verifySessionToken` (Task 3), env, `schema.shopifyStores`.
- Produces: `app.requireShopifySession` preHandler that sets `req.shopifyStore` (the `shopify_stores` row). `GET /v1/shopify/me` returning `{ store: { shopDomain, settings }, credits: number, plan: {...}|null }`.

- [ ] **Step 1: Implement the plugin**

Create `apps/api/src/plugins/shopify-auth.ts`:

```ts
import { schema } from '@tryme/db';
import { type InferSelectModel, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { verifySessionToken } from '../modules/shopify/service.js';

export const shopifyAuthPlugin = fp(async (app) => {
  app.decorate('requireShopifySession', async (req: any) => {
    const secret = app.env.SHOPIFY_API_SECRET;
    const apiKey = app.env.SHOPIFY_API_KEY;
    if (!secret || !apiKey) throw new AppError('CONFIG', 500, 'Shopify not configured');
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTHORIZED', 401, 'Missing session token');
    let shopDomain: string;
    try {
      ({ shopDomain } = verifySessionToken(token, secret, apiKey));
    } catch {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid session token');
    }
    const [store] = await app.db.select().from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopDomain, shopDomain)).limit(1);
    if (!store || store.uninstalledAt) throw new AppError('FORBIDDEN', 403, 'Store not installed');
    req.shopifyStore = store;
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    shopifyStore?: InferSelectModel<typeof schema.shopifyStores>;
  }
  interface FastifyInstance {
    requireShopifySession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

- [ ] **Step 2: Implement `GET /v1/shopify/me`**

Create `apps/api/src/modules/shopify/me.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifyMeRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/me', { preHandler: app.requireShopifySession }, async (req: any) => {
    const store = req.shopifyStore;
    const [credits] = await app.db.select({ balance: schema.widgetClientCredits.balance })
      .from(schema.widgetClientCredits)
      .where(eq(schema.widgetClientCredits.widgetClientId, store.widgetClientId)).limit(1);
    let plan = null;
    if (store.shopifyPlanId) {
      [plan] = await app.db.select().from(schema.shopifyPlans)
        .where(eq(schema.shopifyPlans.id, store.shopifyPlanId)).limit(1);
    }
    return {
      store: { shopDomain: store.shopDomain, settings: store.settings },
      credits: credits?.balance ?? 0,
      plan: plan ?? null,
    };
  });
}
```

- [ ] **Step 3: Register plugin + route**

In `apps/api/src/server.ts` add near the other plugin registrations (after `widgetAuthPlugin`):

```ts
import { shopifyAuthPlugin } from './plugins/shopify-auth.js';
import { shopifyMeRoutes } from './modules/shopify/me.routes.js';
// … in plugin section:
await app.register(shopifyAuthPlugin);
// … in routes section:
await app.register(shopifyMeRoutes);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plugins/shopify-auth.ts apps/api/src/modules/shopify/me.routes.ts apps/api/src/server.ts
git commit -m "feat(api): requireShopifySession plugin + /v1/shopify/me"
```

---

## Task 6: OAuth install + callback (store upsert)

**Files:**
- Create: `apps/api/src/modules/shopify/auth.routes.ts`
- Create: `apps/api/src/modules/shopify/routes.ts` (aggregator)
- Create: `apps/api/test/shopify-oauth.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `encryptToken` (Task 2), `verifyQueryHmac` (Task 3), env, `app.redis`, `app.db`.
- Produces: `GET /v1/shopify/auth?shop=` (redirect to Shopify authorize) and `GET /v1/shopify/auth/callback`. Exports `upsertShopifyStore(app, shopDetails, token, scope)` used by the callback — this is the function tests exercise directly (the token exchange + shop fetch are mocked at the HTTP boundary).

**Design of the callback (implements spec Install Flow):**
1. `verifyQueryHmac(query)` and verify the Redis nonce (`shopify:nonce:{state}`), else 403.
2. Exchange `code` → access token (`POST https://{shop}/admin/oauth/access_token`).
3. Fetch shop details (`GET https://{shop}/admin/api/2024-01/shop.json`).
4. `upsertShopifyStore`: look up `shopify_stores` by `shopifyShopId`. If found → reactivate (update token/scope, clear `uninstalledAt`, set `widget_clients.isActive=true`, refresh `allowedOrigins`). Else → transactional insert of `widget_clients` (all NOT NULL cols synthesized) + `widget_client_credits(balance=0)` + `shopify_stores`.
5. Register webhooks. Redirect to embedded app URL.

- [ ] **Step 1: Write the failing test** (exercises `upsertShopifyStore` directly — no live Shopify)

Create `apps/api/test/shopify-oauth.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
let c: Containers; let app: TestApp;

const shop = {
  shopifyShopId: 12345, shopDomain: 'demo.myshopify.com', myshopifyDomain: 'demo.myshopify.com',
  primaryDomain: 'demo.example.com', name: 'Demo', shopOwner: 'Jane', email: 'jane@demo.example.com',
  phone: '123', address: 'Somewhere',
};

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY } as any);
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('upsertShopifyStore', () => {
  it('creates widget client + credits + store on first install', async () => {
    const store = await upsertShopifyStore(app, shop, 'shpat_token_1', 'read_products');
    expect(store.shopDomain).toBe('demo.myshopify.com');
    const [wc] = await app.db.select().from(schema.widgetClients).where(eq(schema.widgetClients.id, store.widgetClientId));
    expect(wc.clientType).toBe('shopify');
    expect(wc.isActive).toBe(true);
    expect(wc.allowedOrigins).toContain('https://demo.myshopify.com');
    // token stored encrypted, not plaintext
    expect(store.accessToken).not.toContain('shpat_token_1');
  });

  it('reactivates on reinstall without duplicating rows', async () => {
    await app.db.update(schema.shopifyStores).set({ uninstalledAt: new Date() }).where(eq(schema.shopifyStores.shopifyShopId, 12345));
    const store2 = await upsertShopifyStore(app, shop, 'shpat_token_2', 'read_products');
    expect(store2.uninstalledAt).toBeNull();
    const all = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.shopifyShopId, 12345));
    expect(all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-oauth`
Expected: FAIL — `upsertShopifyStore` not exported.

- [ ] **Step 3: Implement auth.routes.ts**

Create `apps/api/src/modules/shopify/auth.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { encryptToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { verifyQueryHmac } from './service.js';

export interface ShopDetails {
  shopifyShopId: number;
  shopDomain: string;
  myshopifyDomain: string;
  primaryDomain?: string;
  name: string;
  shopOwner?: string;
  email: string;
  phone?: string;
  address?: string;
}

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
    const [existing] = await tx.select().from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopifyShopId, shop.shopifyShopId)).limit(1);

    if (existing) {
      await tx.update(schema.widgetClients)
        .set({ isActive: true, allowedOrigins: origins, updatedAt: new Date() })
        .where(eq(schema.widgetClients.id, existing.widgetClientId));
      const [store] = await tx.update(schema.shopifyStores)
        .set({ accessToken: enc, scope, uninstalledAt: null, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, existing.id)).returning();
      return store;
    }

    // email UNIQUE guard: suffix if a non-shopify client already owns this email
    let email = shop.email;
    const [emailClash] = await tx.select({ id: schema.widgetClients.id })
      .from(schema.widgetClients).where(eq(schema.widgetClients.email, email)).limit(1);
    if (emailClash) email = `owner+shop-${shop.shopifyShopId}@${shop.myshopifyDomain}`;

    const [wc] = await tx.insert(schema.widgetClients).values({
      clientType: 'shopify', isActive: true,
      companyName: shop.name, contactName: shop.shopOwner ?? shop.name,
      email, phone: shop.phone ?? '', websiteUrl: `https://${shop.shopDomain}`,
      companySize: 'unknown', purpose: 'shopify', businessAddress: shop.address ?? '',
      passwordHash: '', allowedOrigins: origins,
    }).returning();

    await tx.insert(schema.widgetClientCredits).values({ widgetClientId: wc.id, balance: 0 });

    const [store] = await tx.insert(schema.shopifyStores).values({
      widgetClientId: wc.id, shopDomain: shop.shopDomain, shopifyShopId: shop.shopifyShopId,
      accessToken: enc, scope,
    }).returning();
    return store;
  });
}

export async function shopifyAuthRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/auth', async (req, reply) => {
    const shop = (req.query as { shop?: string }).shop;
    if (!shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
      throw new AppError('BAD_REQUEST', 400, 'invalid shop');
    }
    const state = randomUUID();
    await app.redis.set(`shopify:nonce:${state}`, shop, 'EX', 600);
    const scopes = app.env.SHOPIFY_SCOPES;
    const redirectUri = `${app.env.SHOPIFY_APP_URL}/v1/shopify/auth/callback`;
    const url = `https://${shop}/admin/oauth/authorize?client_id=${app.env.SHOPIFY_API_KEY}` +
      `&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return reply.redirect(url);
  });

  app.get('/v1/shopify/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifyQueryHmac(q, app.env.SHOPIFY_API_SECRET ?? '')) {
      throw new AppError('FORBIDDEN', 403, 'bad hmac');
    }
    const savedShop = await app.redis.get(`shopify:nonce:${q.state}`);
    if (!savedShop || savedShop !== q.shop) throw new AppError('FORBIDDEN', 403, 'bad state');
    await app.redis.del(`shopify:nonce:${q.state}`);

    // Exchange code → token
    const tokenRes = await fetch(`https://${q.shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: app.env.SHOPIFY_API_KEY, client_secret: app.env.SHOPIFY_API_SECRET, code: q.code }),
    });
    if (!tokenRes.ok) throw new AppError('SHOPIFY', 502, 'token exchange failed');
    const { access_token, scope } = (await tokenRes.json()) as { access_token: string; scope: string };

    // Fetch shop details
    const shopRes = await fetch(`https://${q.shop}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': access_token },
    });
    if (!shopRes.ok) throw new AppError('SHOPIFY', 502, 'shop fetch failed');
    const s = (await shopRes.json() as any).shop;
    const details: ShopDetails = {
      shopifyShopId: s.id, shopDomain: s.myshopify_domain, myshopifyDomain: s.myshopify_domain,
      primaryDomain: s.domain, name: s.name, shopOwner: s.shop_owner, email: s.email,
      phone: s.phone, address: [s.address1, s.city, s.country].filter(Boolean).join(', '),
    };

    const store = await upsertShopifyStore(app, details, access_token, scope);
    // Webhook registration is Task 7; call registerWebhooks(app, q.shop, access_token) here once it exists.
    await app.shopifyRegisterWebhooks?.(q.shop, access_token);

    req.log.info({ storeId: store.id, shop: q.shop }, 'shopify store installed');
    return reply.redirect(`${app.env.SHOPIFY_APP_URL}/embedded?shop=${q.shop}`);
  });
}
```

> **Note:** `app.shopifyRegisterWebhooks` is decorated in Task 7; the optional-chaining call makes Task 6 pass standalone and wires up automatically once Task 7 lands.

- [ ] **Step 4: Create the aggregator + register**

Create `apps/api/src/modules/shopify/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { shopifyAuthRoutes } from './auth.routes.js';
import { shopifyMeRoutes } from './me.routes.js';

export async function shopifyRoutes(app: FastifyInstance) {
  await app.register(shopifyAuthRoutes);
  await app.register(shopifyMeRoutes);
}
```

In `apps/api/src/server.ts`, replace the standalone `shopifyMeRoutes` registration from Task 5 with `await app.register(shopifyRoutes);` (import from `./modules/shopify/routes.js`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-oauth`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/auth.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-oauth.test.ts apps/api/src/server.ts
git commit -m "feat(api): shopify OAuth install/callback + store upsert"
```

---

## Task 7: Webhooks (raw-body HMAC, uninstall, products, GDPR)

**Files:**
- Create: `apps/api/src/modules/shopify/webhook.routes.ts`
- Create: `apps/api/test/shopify-webhooks.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts` (register), `apps/api/src/modules/shopify/service.ts` (add `enqueueSync` + `registerWebhooks`)

**Interfaces:**
- Consumes: `verifyWebhookHmac` (Task 3), `app.redis`, `app.db`.
- Produces: `POST /v1/shopify/webhooks/:topic` handlers. `enqueueSync(redis, task)` → `XADD shopify:sync`. `app.shopifyRegisterWebhooks(shop, token)` decorator. All handlers verify HMAC over raw body, then respond `200` and defer work.

- [ ] **Step 1: Add `enqueueSync` to service.ts**

Append to `apps/api/src/modules/shopify/service.ts`:

```ts
import type { Redis } from 'ioredis';

export interface SyncTask {
  storeId: string;
  mode: 'full' | 'product';
  shopifyProductId?: number;
}

export async function enqueueSync(redis: Redis, task: SyncTask): Promise<void> {
  await redis.xadd('shopify:sync', '*', 'task', JSON.stringify(task));
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/shopify-webhooks.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';

const SECRET = 'shpss_hook_secret';
const ENC_KEY = Buffer.alloc(32, 3).toString('base64');
let c: Containers; let app: TestApp; let storeId: string; let widgetClientId: string;

function sign(raw: string) { return createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('base64'); }

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_API_SECRET: SECRET, SHOPIFY_TOKEN_ENC_KEY: ENC_KEY } as any);
  const store = await upsertShopifyStore(app, {
    shopifyShopId: 999, shopDomain: 'w.myshopify.com', myshopifyDomain: 'w.myshopify.com',
    name: 'W', email: 'w@w.com',
  }, 'tok', 'read_products');
  storeId = store.id; widgetClientId = store.widgetClientId;
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('shopify webhooks', () => {
  it('rejects a bad HMAC', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/shopify/webhooks/app_uninstalled',
      headers: { 'x-shopify-hmac-sha256': 'bad', 'x-shopify-shop-domain': 'w.myshopify.com', 'content-type': 'application/json' },
      payload: '{"id":999}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('processes app/uninstalled: deactivates store + widget client', async () => {
    const raw = '{"id":999}';
    const res = await app.inject({
      method: 'POST', url: '/v1/shopify/webhooks/app_uninstalled',
      headers: { 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-shop-domain': 'w.myshopify.com', 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const [store] = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.id, storeId));
    expect(store.uninstalledAt).not.toBeNull();
    const [wc] = await app.db.select().from(schema.widgetClients).where(eq(schema.widgetClients.id, widgetClientId));
    expect(wc.isActive).toBe(false);
  });

  it('processes products/update: enqueues a sync task', async () => {
    const raw = '{"id":555}';
    const res = await app.inject({
      method: 'POST', url: '/v1/shopify/webhooks/products_update',
      headers: { 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-shop-domain': 'w.myshopify.com', 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const len = await app.redis.xlen('shopify:sync');
    expect(len).toBeGreaterThan(0);
  });

  it('responds 200 to GDPR customers/redact', async () => {
    const raw = '{"shop_id":999,"customer":{"id":1}}';
    const res = await app.inject({
      method: 'POST', url: '/v1/shopify/webhooks/customers_redact',
      headers: { 'x-shopify-hmac-sha256': sign(raw), 'x-shopify-shop-domain': 'w.myshopify.com', 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-webhooks`
Expected: FAIL — routes 404.

- [ ] **Step 4: Implement webhook.routes.ts** (encapsulated raw-body parser)

Create `apps/api/src/modules/shopify/webhook.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { enqueueSync, verifyWebhookHmac } from './service.js';

export async function shopifyWebhookRoutes(app: FastifyInstance) {
  // Capture raw body for HMAC (scoped to this encapsulated plugin instance only).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // hand the raw Buffer to handlers as req.body
  });

  const topics = [
    'app_uninstalled', 'app_subscriptions_update', 'products_update', 'products_delete',
    'customers_data_request', 'customers_redact', 'shop_redact',
  ] as const;

  for (const topic of topics) {
    app.post(`/v1/shopify/webhooks/${topic}`, async (req, reply) => {
      const raw = req.body as Buffer;
      const hmac = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      if (!verifyWebhookHmac(raw, hmac ?? '', app.env.SHOPIFY_API_SECRET ?? '')) {
        throw new AppError('UNAUTHORIZED', 401, 'bad webhook hmac');
      }
      const shopDomain = req.headers['x-shopify-shop-domain'] as string | undefined;
      const payload = JSON.parse(raw.toString() || '{}') as Record<string, any>;

      // Respond fast; real work is deferred to the sync queue / direct row updates.
      reply.code(200).send({ ok: true });

      try {
        const [store] = shopDomain
          ? await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.shopDomain, shopDomain)).limit(1)
          : [undefined];

        switch (topic) {
          case 'app_uninstalled':
            if (store) {
              await app.db.update(schema.shopifyStores).set({ uninstalledAt: new Date() }).where(eq(schema.shopifyStores.id, store.id));
              await app.db.update(schema.widgetClients).set({ isActive: false }).where(eq(schema.widgetClients.id, store.widgetClientId));
            }
            break;
          case 'products_update':
            if (store) await enqueueSync(app.redis, { storeId: store.id, mode: 'product', shopifyProductId: payload.id });
            break;
          case 'products_delete':
            if (store) {
              await app.db.update(schema.shopifyProductGarments)
                .set({ status: 'deleted' })
                .where(eq(schema.shopifyProductGarments.shopifyProductId, payload.id));
            }
            break;
          case 'customers_redact':
          case 'shop_redact':
            // We store no customer PII beyond transient photos; purge store R2 assets on shop_redact.
            req.log.info({ topic, shopDomain }, 'gdpr webhook acknowledged');
            break;
          case 'customers_data_request':
            req.log.info({ topic, shopDomain }, 'gdpr data request — no stored customer data');
            break;
          case 'app_subscriptions_update':
            req.log.info({ topic, shopDomain }, 'subscription updated');
            break;
        }
      } catch (err) {
        req.log.error({ err, topic }, 'webhook post-processing failed');
      }
    });
  }
}

export async function registerWebhooksDecorator(app: FastifyInstance) {
  app.decorate('shopifyRegisterWebhooks', async (shop: string, token: string) => {
    const base = `${app.env.SHOPIFY_APP_URL}/v1/shopify/webhooks`;
    const map: Record<string, string> = {
      'app/uninstalled': `${base}/app_uninstalled`,
      'app_subscriptions/update': `${base}/app_subscriptions_update`,
      'products/update': `${base}/products_update`,
      'products/delete': `${base}/products_delete`,
      'customers/data_request': `${base}/customers_data_request`,
      'customers/redact': `${base}/customers_redact`,
      'shop/redact': `${base}/shop_redact`,
    };
    for (const [topic, address] of Object.entries(map)) {
      await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
      }).catch((err) => app.log.error({ err, topic }, 'webhook registration failed'));
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    shopifyRegisterWebhooks?: (shop: string, token: string) => Promise<void>;
  }
}
```

- [ ] **Step 5: Register in aggregator**

In `apps/api/src/modules/shopify/routes.ts`, register the webhook routes **inside their own encapsulated context** so the raw-body parser does not leak to other routes, and add the decorator:

```ts
import { registerWebhooksDecorator, shopifyWebhookRoutes } from './webhook.routes.js';
// … inside shopifyRoutes():
  await app.register(registerWebhooksDecorator);
  await app.register(shopifyWebhookRoutes); // fastify plugin = encapsulated; parser is local
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-webhooks`
Expected: PASS (4 tests). If other JSON routes break, confirm the content-type parser is scoped to the `shopifyWebhookRoutes` plugin only (it is registered as its own plugin, so encapsulation holds).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/webhook.routes.ts apps/api/src/modules/shopify/service.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-webhooks.test.ts
git commit -m "feat(api): shopify webhooks with raw-body HMAC + GDPR topics"
```

---

## Task 8: Product sync worker

**Files:**
- Create: `apps/api/src/modules/shopify/products.sync.ts`
- Create: `apps/api/test/shopify-sync.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts` (add `POST /v1/shopify/products/sync` trigger via `requireShopifySession`)

**Interfaces:**
- Consumes: `app.storage.putObject`, `schema.shopifyProductGarments`, `app.db`.
- Produces: `syncProduct(app, storeId, product): Promise<void>` (download first image → R2 → upsert row). `syncOneTask(app, task)` dispatches full vs product. The Redis-Stream consumer loop lives in the dispatcher (Task 10 note) or a small api worker; the pure functions are unit-tested here with an injected image fetcher.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-sync.test.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { syncProduct } from '../src/modules/shopify/products.sync.js';

const ENC_KEY = Buffer.alloc(32, 5).toString('base64');
let c: Containers; let app: TestApp; let storeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY } as any);
  const store = await upsertShopifyStore(app, {
    shopifyShopId: 7, shopDomain: 's.myshopify.com', myshopifyDomain: 's.myshopify.com', name: 'S', email: 's@s.com',
  }, 'tok', 'read_products');
  storeId = store.id;
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('syncProduct', () => {
  it('uploads first image to R2 and upserts an active garment row', async () => {
    const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Map([['content-type', 'image/jpeg']]) } as any);
    await syncProduct(app, storeId, { id: 42, image: { src: 'https://cdn.shopify.com/x.jpg' } }, fakeFetch as any);
    const [row] = await app.db.select().from(schema.shopifyProductGarments)
      .where(and(eq(schema.shopifyProductGarments.storeId, storeId), eq(schema.shopifyProductGarments.shopifyProductId, 42)));
    expect(row.status).toBe('active');
    expect(row.r2Key).toBe(`shopify-garments/${storeId}/42/garment.jpg`);
    const head = await app.storage.headObject(row.r2Key);
    expect(head.contentLength).toBe(3);
  });

  it('marks failed when a product has no image', async () => {
    const fakeFetch = async () => { throw new Error('should not be called'); };
    await syncProduct(app, storeId, { id: 43, image: null }, fakeFetch as any);
    const [row] = await app.db.select().from(schema.shopifyProductGarments)
      .where(and(eq(schema.shopifyProductGarments.storeId, storeId), eq(schema.shopifyProductGarments.shopifyProductId, 43)));
    expect(row.status).toBe('failed');
    expect(row.failedReason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement products.sync.ts**

Create `apps/api/src/modules/shopify/products.sync.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

interface ShopifyProduct {
  id: number;
  image?: { src?: string } | null;
}

const ALLOWED_HOSTS = /(^|\.)(myshopify\.com|shopify\.com|cdn\.shopify\.com)$/;

function assertShopifyCdn(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('image url must be https');
  if (!ALLOWED_HOSTS.test(u.hostname)) throw new Error(`image host not allowed: ${u.hostname}`);
}

async function upsertGarment(app: FastifyInstance, storeId: string, productId: number, r2Key: string, status: string, failedReason?: string) {
  await app.db.insert(schema.shopifyProductGarments)
    .values({ storeId, shopifyProductId: productId, shopifyVariantId: null, r2Key, status, failedReason })
    .onConflictDoUpdate({
      target: [schema.shopifyProductGarments.storeId, schema.shopifyProductGarments.shopifyProductId, schema.shopifyProductGarments.shopifyVariantId],
      set: { r2Key, status, failedReason: failedReason ?? null, syncedAt: sql`now()` },
    });
}

export async function syncProduct(
  app: FastifyInstance,
  storeId: string,
  product: ShopifyProduct,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const r2Key = `shopify-garments/${storeId}/${product.id}/garment.jpg`;
  const src = product.image?.src;
  if (!src) {
    await upsertGarment(app, storeId, product.id, r2Key, 'failed', 'no product image');
    return;
  }
  try {
    assertShopifyCdn(src);
    const res = await fetchFn(src);
    if (!res.ok) throw new Error(`download HTTP ${(res as Response).status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers as any).get?.('content-type') ?? 'image/jpeg';
    await app.storage.putObject(r2Key, buf, ct);
    await upsertGarment(app, storeId, product.id, r2Key, 'active');
  } catch (err) {
    app.log.warn({ err, storeId, productId: product.id }, 'product sync failed');
    await upsertGarment(app, storeId, product.id, r2Key, 'failed', (err as Error).message);
  }
}

export async function syncOneTask(app: FastifyInstance, task: { storeId: string; mode: 'full' | 'product'; shopifyProductId?: number }): Promise<void> {
  const [store] = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.id, task.storeId)).limit(1);
  if (!store || store.uninstalledAt) return;
  const { decryptToken } = await import('../../lib/crypto.js');
  const token = decryptToken(store.accessToken, app.env.SHOPIFY_TOKEN_ENC_KEY ?? '');
  const shop = store.shopDomain;

  if (task.mode === 'product' && task.shopifyProductId) {
    const res = await fetch(`https://${shop}/admin/api/2024-01/products/${task.shopifyProductId}.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    });
    if (res.ok) await syncProduct(app, store.id, (await res.json() as any).product);
    return;
  }

  // full sync: paginate (250/page). Respect ~2 req/s.
  let url: string | null = `https://${shop}/admin/api/2024-01/products.json?limit=250`;
  while (url) {
    const res: Response = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) break;
    const products = ((await res.json()) as any).products as ShopifyProduct[];
    for (const p of products) await syncProduct(app, store.id, p);
    const link = res.headers.get('link') ?? '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
    if (url) await new Promise((r) => setTimeout(r, 500)); // throttle
  }
}
```

- [ ] **Step 4: Add the admin sync trigger route**

In `apps/api/src/modules/shopify/routes.ts` (or a small `products.routes.ts` registered by it), add — requires the store session, enqueues a full sync:

```ts
app.post('/v1/shopify/products/sync', { preHandler: app.requireShopifySession }, async (req: any, reply) => {
  const { enqueueSync } = await import('./service.js');
  await enqueueSync(app.redis, { storeId: req.shopifyStore.id, mode: 'full' });
  return reply.code(202).send({ queued: true });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/test/shopify-sync.test.ts apps/api/src/modules/shopify/routes.ts
git commit -m "feat(api): shopify product sync (download + R2 upload, SSRF-guarded)"
```

---

## Task 9: Extend widget jobs to accept `shopifyProductId`

**Files:**
- Modify: `apps/api/src/modules/widget/routes.ts`
- Create: `apps/api/test/shopify-jobs.test.ts`
- Modify: `packages/types/src/widget.ts` (add optional `shopifyProductId` to `WidgetJobRequest`)

**Interfaces:**
- Consumes: `atomicWidgetDeduct` (existing, `apps/api/src/modules/widget/ledger.ts`), `schema.shopifyStores`, `schema.shopifyProductGarments`.
- Produces: `POST /v1/widget/jobs` accepts `{ shopifyProductId?: number, customerPhotoKey }`. When `shopifyProductId` present: resolve garment from `shopify_product_garments` (no external download), write `job_inputs.params = { kind: 'shopify', shopifyProductId, workflowTemplateId }`, deduct `SHOPIFY_JOB_COST`.

- [ ] **Step 1: Add the type field**

In `packages/types/src/widget.ts`, in the `WidgetJobRequest` zod object add:

```ts
  shopifyProductId: z.number().int().positive().optional(),
```

Make `garmentImageUrl` optional there too (Shopify path supplies no URL): change it to `.optional()`. Build the package: `pnpm --filter @tryme/types build`.

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/shopify-jobs.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';

const ENC_KEY = Buffer.alloc(32, 9).toString('base64');
let c: Containers; let app: TestApp; let widgetKey: string; let storeId: string; let widgetClientId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY, SHOPIFY_JOB_COST: 10 } as any);
  const store = await upsertShopifyStore(app, {
    shopifyShopId: 21, shopDomain: 'j.myshopify.com', myshopifyDomain: 'j.myshopify.com', name: 'J', email: 'j@j.com',
  }, 'tok', 'read_products');
  storeId = store.id; widgetClientId = store.widgetClientId;
  // seed credits + a synced garment + a resolvable customer photo
  await app.db.update(schema.widgetClientCredits).set({ balance: 100 }).where(eq(schema.widgetClientCredits.widgetClientId, widgetClientId));
  await app.db.insert(schema.shopifyProductGarments).values({ storeId, shopifyProductId: 88, shopifyVariantId: null, r2Key: `shopify-garments/${storeId}/88/garment.jpg`, status: 'active' });
  const [wc] = await app.db.select().from(schema.widgetClients).where(eq(schema.widgetClients.id, widgetClientId));
  widgetKey = wc.widgetKey;
  // upload a customer photo + register ownership (mirror widget presign flow)
  const photoKey = `widget-inputs/${widgetClientId}/photo.jpg`;
  await app.storage.putObject(photoKey, Buffer.from([1, 2, 3]), 'image/jpeg');
  await app.redis.set(`widget:upload:${photoKey}`, widgetClientId);
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('shopify widget job', () => {
  it('creates a shopify job resolving garment from R2 and tags params.kind', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/jobs',
      headers: { 'x-widget-key': widgetKey, 'content-type': 'application/json' },
      payload: { shopifyProductId: 88, customerPhotoKey: `widget-inputs/${widgetClientId}/photo.jpg` },
    });
    expect(res.statusCode).toBe(200);
    const jobId = res.json().jobId;
    const [inputs] = await app.db.select().from(schema.jobInputs).where(eq(schema.jobInputs.jobId, jobId));
    const params = typeof inputs.params === 'string' ? JSON.parse(inputs.params) : inputs.params;
    expect(params.kind).toBe('shopify');
    expect(params.shopifyProductId).toBe(88);
    expect(inputs.upperGarmentKey).toBe(`shopify-garments/${storeId}/88/garment.jpg`);
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.creditsCharged).toBe(10);
  });

  it('returns 202 when the product is not synced yet', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/widget/jobs',
      headers: { 'x-widget-key': widgetKey, 'content-type': 'application/json' },
      payload: { shopifyProductId: 404404, customerPhotoKey: `widget-inputs/${widgetClientId}/photo.jpg` },
    });
    expect(res.statusCode).toBe(202);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-jobs`
Expected: FAIL — current handler requires `garmentImageUrl` and knows nothing about `shopifyProductId`.

- [ ] **Step 4: Implement the branch in widget/routes.ts**

At the top of the `POST /v1/widget/jobs` handler, after the `customerPhotoKey` ownership + size checks and **before** the `assertSafeExternalUrl(garmentImageUrl)` download block, insert a Shopify branch. Add near the top of the file:

```ts
import { SHOPIFY_JOB_COST_FALLBACK } from '...'; // or read app.env.SHOPIFY_JOB_COST directly
```

Then in the handler:

```ts
const { shopifyProductId } = req.body as { shopifyProductId?: number };
let resolvedGarmentKey: string | null = null;
let jobParams: Record<string, unknown> = {};
let jobCost = WIDGET_JOB_COST;

if (shopifyProductId) {
  const [store] = await app.db.select().from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.widgetClientId, clientId)).limit(1);
  if (!store || store.uninstalledAt) throw new AppError('FORBIDDEN', 403, 'store not active');

  const [garment] = await app.db.select().from(schema.shopifyProductGarments)
    .where(and(
      eq(schema.shopifyProductGarments.storeId, store.id),
      eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
      eq(schema.shopifyProductGarments.status, 'active'),
    )).limit(1);

  if (!garment) {
    // trigger async sync, tell the storefront to retry
    const { enqueueSync } = await import('../shopify/service.js');
    await enqueueSync(app.redis, { storeId: store.id, mode: 'product', shopifyProductId });
    return reply.code(202).send({ message: "We're preparing this product for try-on. Check back in a moment." });
  }

  resolvedGarmentKey = garment.r2Key;
  jobCost = app.env.SHOPIFY_JOB_COST;
  jobParams = { kind: 'shopify', shopifyProductId, workflowTemplateId: store.settings?.workflowTemplateId };
}
```

Then guard the existing external-download path so it only runs for the non-Shopify case:

```ts
let garmentR2Key: string;
if (resolvedGarmentKey) {
  garmentR2Key = resolvedGarmentKey;
} else {
  // ... existing assertSafeExternalUrl + fetch + putObject block, unchanged ...
  garmentR2Key = `widget-garments/${clientId}/${randomUUID()}/garment.${garmentExt}`;
  await app.storage.putObject(garmentR2Key, garmentBuffer, garmentContentType);
}
```

In the `db.transaction`, use `jobCost` for `creditsCharged` and the atomic deduct, and write `params: jobParams` on the `job_inputs` insert (merge with any existing params like `aspectRatio`):

```ts
await (tx.insert(schema.jobs).values as any)({ id: jobId, userId: null, widgetClientId: clientId, customerPhotoKey, status: 'QUEUED', creditsCharged: jobCost });
await (tx.insert(schema.jobInputs).values as any)({ jobId, upperGarmentKey: garmentR2Key, params: jobParams /* + existing fields */ });
await atomicWidgetDeduct(tx as any, clientId, jobCost, jobId);
```

Ensure `and`, `eq` are imported from `drizzle-orm` in this file (add if missing).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-jobs`
Expected: PASS (2 tests). Also run the existing widget flow if a test exists: `pnpm --filter @tryme/api test -- widget` to confirm no regression on the URL path.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/widget/routes.ts packages/types/src/widget.ts apps/api/test/shopify-jobs.test.ts
git commit -m "feat(api): widget jobs accept shopifyProductId, resolve garment from R2"
```

---

## Task 10: Dispatcher `processShopifyJob` branch

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`
- Test: `apps/dispatcher` unit test (mirror an existing processor unit test; assert routing selection, not a live ComfyUI call)

**Interfaces:**
- Consumes: `job_inputs.params.kind === 'shopify'`, `inputs.upperGarmentKey`, `job.customerPhotoKey`, `params.workflowTemplateId`.
- Produces: a `processShopifyJob(...)` path reached from inside `processWidgetJob` (Shopify jobs carry `widgetClientId`, so they already enter `processWidgetJob`). On terminal failure it refunds via the existing widget refund pattern.

- [ ] **Step 1: Locate the routing seam**

In `apps/dispatcher/src/job/processor.ts`, `processWidgetJob` is entered at the `if (job.widgetClientId)` branch (~line 120). Inside `processWidgetJob`, parse `inputs.params` (it may be a JSON string) and branch on `kind`:

```ts
const p = typeof inputs.params === 'string' ? JSON.parse(inputs.params) : (inputs.params ?? {});
if (p.kind === 'shopify') {
  return processShopifyJob(cfg, job, inputs, p, stream, messageId, jobLog, startedAt);
}
// … existing widget handling continues …
```

- [ ] **Step 2: Write the failing unit test**

Add a dispatcher unit test (path mirroring existing `apps/dispatcher/test/**` — check the actual location and copy an existing test's harness) asserting that a job whose `inputs.params.kind === 'shopify'` selects the Shopify workflow template id and uses `inputs.upperGarmentKey` as the garment source. Model it on the nearest existing processor unit test; assert on the patched-workflow inputs, not on network I/O.

Run: `pnpm --filter @tryme/dispatcher test:unit`
Expected: FAIL — `processShopifyJob` undefined.

- [ ] **Step 3: Implement `processShopifyJob`**

Add the function modeled on the existing `processWidgetJob` / `processTryonDirectJob` bodies (same helpers: worker selection, `patchWorkflow`, ComfyUI submit, R2 upload of `outputs/<jobId>/result.png` + thumbnail, status `COMPLETED`, SSE publish). Key differences to encode:
- workflow template = `params.workflowTemplateId` (load from `workflow_templates`)
- garment image = `inputs.upperGarmentKey` (already in R2)
- person image = `job.customerPhotoKey`
- on terminal failure: set status `FAILED`, refund `job.creditsCharged` credits via the existing widget refund path (`widgetRefund` equivalent used by the dispatcher), publish SSE `failed`.

Reuse the exact ComfyUI/patcher/upload helpers already imported at the top of `processor.ts` — do not introduce new ones. Copy the surrounding error-handling/attempt-count structure from `processWidgetJob` verbatim, changing only the three inputs above and the workflow-template source.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/dispatcher test:unit`
Expected: PASS.

- [ ] **Step 5: Add the `shopify:sync` consumer (worker loop)**

In the dispatcher startup (or a dedicated small worker), add a loop that `XREAD`s `shopify:sync` and calls the sync logic. Since `syncOneTask` lives in `apps/api`, either (a) move `products.sync.ts` pure functions into a shared location importable by the dispatcher, or (b) run the sync consumer inside `apps/api` at boot. **Recommended:** run the consumer in `apps/api` (it already has `app.storage`, `app.db`, `app.env`, and the Shopify token key) — add a `startSyncConsumer(app)` called after `app.listen`, reading `shopify:sync` with a blocking `XREAD` and invoking `syncOneTask(app, task)`. Guard with a single-consumer lock so multiple api replicas don't double-process (Redis `SET NX` lease, 30s TTL, renewed each loop).

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/dispatcher typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/api/src/... 
git commit -m "feat(dispatcher): processShopifyJob branch + shopify:sync consumer"
```

---

## Task 11: Billing (plan select + charge callback)

**Files:**
- Create: `apps/api/src/modules/shopify/billing.routes.ts`
- Create: `apps/api/test/shopify-billing.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`

**Interfaces:**
- Consumes: `app.requireShopifySession`, `verifyQueryHmac`, `schema.shopifyPlans`, `schema.shopifyStores`, `widgetClientCredits`.
- Produces: `GET /v1/shopify/billing/plans`, `POST /v1/shopify/billing/select`, `GET /v1/shopify/billing/callback`. On charge activation → set `shopifyStores.billingPlanId` + `shopifyPlanId`, seed balance `includedTryons * SHOPIFY_JOB_COST`.

- [ ] **Step 1: Write the failing test** (activation seeds credits; Shopify charge creation mocked)

Create `apps/api/test/shopify-billing.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { startContainers, stopContainers, type Containers } from './helpers/containers.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { activateCharge } from '../src/modules/shopify/billing.routes.js';

const ENC_KEY = Buffer.alloc(32, 4).toString('base64');
let c: Containers; let app: TestApp; let storeId: string; let widgetClientId: string; let planId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY, SHOPIFY_JOB_COST: 10 } as any);
  const store = await upsertShopifyStore(app, { shopifyShopId: 33, shopDomain: 'b.myshopify.com', myshopifyDomain: 'b.myshopify.com', name: 'B', email: 'b@b.com' }, 'tok', 'read_products');
  storeId = store.id; widgetClientId = store.widgetClientId;
  const [plan] = await app.db.insert(schema.shopifyPlans).values({ name: 'Trend', priceCents: 1999, includedTryons: 100, overageCents: 16 }).returning();
  planId = plan.id;
});
afterAll(async () => { await app?.close(); await stopContainers(c); });

describe('billing activation', () => {
  it('seeds credits = includedTryons * SHOPIFY_JOB_COST', async () => {
    await activateCharge(app, storeId, planId, 55555 /* shopify charge id */);
    const [store] = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.id, storeId));
    expect(store.shopifyPlanId).toBe(planId);
    expect(store.billingPlanId).toBe(55555);
    const [credits] = await app.db.select().from(schema.widgetClientCredits).where(eq(schema.widgetClientCredits.widgetClientId, widgetClientId));
    expect(credits.balance).toBe(1000); // 100 * 10
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-billing`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement billing.routes.ts**

Create `apps/api/src/modules/shopify/billing.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { verifyQueryHmac } from './service.js';

export async function activateCharge(app: FastifyInstance, storeId: string, planId: string, chargeId: number) {
  await app.db.transaction(async (tx) => {
    const [plan] = await tx.select().from(schema.shopifyPlans).where(eq(schema.shopifyPlans.id, planId)).limit(1);
    if (!plan) throw new AppError('NOT_FOUND', 404, 'plan not found');
    const [store] = await tx.update(schema.shopifyStores)
      .set({ shopifyPlanId: planId, billingPlanId: chargeId, updatedAt: new Date() })
      .where(eq(schema.shopifyStores.id, storeId)).returning();
    const seed = plan.includedTryons * app.env.SHOPIFY_JOB_COST;
    await tx.update(schema.widgetClientCredits)
      .set({ balance: seed, updatedAt: new Date() })
      .where(eq(schema.widgetClientCredits.widgetClientId, store.widgetClientId));
    await tx.insert(schema.widgetCreditLedger).values({
      widgetClientId: store.widgetClientId, delta: seed, reason: 'SHOPIFY_PLAN_ACTIVATED',
    });
  });
}

export async function shopifyBillingRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/billing/plans', { preHandler: app.requireShopifySession }, async (req: any) => {
    const plans = await app.db.select().from(schema.shopifyPlans);
    return { plans: plans.filter((p) => p.isActive), currentPlanId: req.shopifyStore.shopifyPlanId ?? null };
  });

  app.post('/v1/shopify/billing/select', { preHandler: app.requireShopifySession }, async (req: any) => {
    const { planId } = req.body as { planId: string };
    const [plan] = await app.db.select().from(schema.shopifyPlans).where(eq(schema.shopifyPlans.id, planId)).limit(1);
    if (!plan || !plan.isActive) throw new AppError('BAD_REQUEST', 400, 'invalid plan');
    // Create Shopify recurring charge; store planId in returnUrl state for the callback.
    const store = req.shopifyStore;
    const { decryptToken } = await import('../../lib/crypto.js');
    const token = decryptToken(store.accessToken, app.env.SHOPIFY_TOKEN_ENC_KEY ?? '');
    const returnUrl = `${app.env.SHOPIFY_APP_URL}/v1/shopify/billing/callback?planId=${planId}&shop=${store.shopDomain}`;
    const res = await fetch(`https://${store.shopDomain}/admin/api/2024-01/recurring_application_charges.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recurring_application_charge: { name: plan.name, price: (plan.priceCents / 100).toFixed(2), trial_days: plan.trialDays, return_url: returnUrl, test: app.env.NODE_ENV !== 'production' } }),
    });
    if (!res.ok) throw new AppError('SHOPIFY', 502, 'charge creation failed');
    const charge = (await res.json() as any).recurring_application_charge;
    return { confirmationUrl: charge.confirmation_url };
  });

  app.get('/v1/shopify/billing/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifyQueryHmac(q, app.env.SHOPIFY_API_SECRET ?? '')) throw new AppError('FORBIDDEN', 403, 'bad hmac');
    const [store] = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.shopDomain, q.shop)).limit(1);
    if (!store) throw new AppError('NOT_FOUND', 404, 'store not found');
    await activateCharge(app, store.id, q.planId, Number(q.charge_id));
    return reply.redirect(`${app.env.SHOPIFY_APP_URL}/embedded?shop=${q.shop}&billing=active`);
  });
}
```

- [ ] **Step 4: Register + run test**

Register `shopifyBillingRoutes` in `apps/api/src/modules/shopify/routes.ts`.
Run: `pnpm --filter @tryme/api test -- shopify-billing`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.routes.ts apps/api/test/shopify-billing.test.ts apps/api/src/modules/shopify/routes.ts
git commit -m "feat(api): shopify billing plan select + charge activation"
```

---

## Task 12: Full suite green + docs

**Files:**
- Modify: `docs/progress.md` (dated entry per CLAUDE.md)
- Modify: `.env.production.example` (add `SHOPIFY_*` vars)

- [ ] **Step 1: Run the full API suite**

Run: `pnpm docker:up && pnpm --filter @tryme/api test`
Expected: all shopify tests + existing suite PASS (fresh DB/bucket per file).

- [ ] **Step 2: Typecheck + lint the workspace**

Run: `pnpm typecheck && pnpm biome check apps/api apps/dispatcher packages/db packages/types --diagnostic-level=error`
Expected: PASS.

- [ ] **Step 3: Add env docs**

Add to `.env.production.example`:

```
# Shopify plugin
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://api.example.com
SHOPIFY_SCOPES=read_products
SHOPIFY_TOKEN_ENC_KEY=            # openssl rand -base64 32
SHOPIFY_JOB_COST=10
```

- [ ] **Step 4: Progress log**

Add a dated entry to the top of `docs/progress.md` under **Done** summarizing the backend slice, and under **Open Questions** note the two follow-on frontend plans (`apps/shopify/`, `apps/shopify-extension/`) + internal-admin views + the "customer photo face-detection 400 path" (deferred to the ComfyUI workflow template task).

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md .env.production.example
git commit -m "docs: shopify backend slice progress + env example"
```

---

## Deferred to follow-on plans (out of scope here)

- **`apps/shopify/`** — Polaris embedded admin (Dashboard, Product Mapping, Appearance, Billing screens) → own plan, consumes `/v1/shopify/me|products|analytics|settings`.
- **`apps/shopify-extension/`** — Shopify CLI theme app extension (`tryon-block.liquid`, `tryon-widget.js`) → own plan.
- **`apps/admin-web/` + `apps/admin-mobile/`** — internal admin views for shopify plans + store data (Admin Parity Rule applies) → own plan.
- **ComfyUI workflow template** for Shopify try-on (`workflow_templates` row) + face-detectability 400 path → own task, needs the real workflow JSON.
- **Overage/top-up usage charges** (`POST /usage_charges`) — spec Billing step 4; add once base billing ships.
- **`GET /v1/shopify/analytics`**, `PATCH /settings`, `DELETE/POST /products/:id` admin endpoints — thin, land with the embedded-admin plan.
```
