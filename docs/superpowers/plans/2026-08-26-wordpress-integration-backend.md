# WordPress Integration — Backend & API Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every backend/schema change decided in
`docs/wordpress-plugin-design.md` §5 — the `api_keys.scope`/`integration`
columns, the `requireDevScope` route allowlist, `JOB_SOURCE.WORDPRESS_TRYON`
attribution, the widget-key rate limit, and the merchant-portal "Create
WordPress Widget Key" issuance path — so the not-yet-written WordPress plugin
(separate plan/repo, see `2026-08-26-wordpress-plugin-woocommerce.md`) has a
working, tested API to call on day one.

**Architecture:** This is entirely additive to the existing dev API
(`apps/api/src/modules/dev/`) and merchant API-key management
(`apps/api/src/modules/merchant/api-keys.routes.ts`) — no new services, no new
tables, two new columns on `api_keys`. Every route decision (which scope can
call what) is enforced server-side via a new `requireDevScope` preHandler,
mirroring the existing `requirePermission` factory pattern in
`apps/api/src/modules/admin/guard.ts`.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres, Zod (`@tryme/types`),
Vitest (integration-style tests against docker-compose Postgres/Redis/MinIO —
see `apps/api/test/helpers/`), Next.js/React (`apps/catalogues-web`).

**Prerequisite:** `pnpm docker:up` must be running — every test file in this
plan uses `startContainers()` against the local Postgres/Redis/MinIO from
docker-compose, not testcontainers (none exist in this repo).

---

## Reference: what this plan corrects vs. the design doc

While grounding this plan in the actual code, one claim in
`docs/wordpress-plugin-design.md` §4.2a turned out to be wrong and this plan
fixes it: "**Job-polling ownership is already correct today, unchanged by
this design**" is true for the ownership check (`apiKeyMerchantId`) but
false for a second filter on the same query. `GET /v1/dev/jobs/:id`
(`apps/api/src/modules/dev/routes.ts:402-407`) restricts the job lookup to
`inArray(schema.jobs.source, [JOB_SOURCE.API_TRYON, JOB_SOURCE.API_SAREE_MANNEQUIN,
JOB_SOURCE.API_CATALOG, LEGACY_JOB_SOURCE.API])` — a `wordpress_tryon` job's
`source` is not in that list, so polling would 404 as "job not found" for a
job the merchant legitimately owns. Task 5 below fixes this; without it, the
WordPress widget cannot ever retrieve a completed try-on.

---

## Task 1: `api_keys.scope` and `api_keys.integration` columns

**Files:**
- Modify: `packages/db/src/schema/api-keys.ts`
- Create (generated, not hand-authored): a new file under `packages/db/src/migrations/` produced by `pnpm db:generate`
- Test: Create `apps/api/test/api-keys-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/api-keys-schema.test.ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/modules/dev/keys.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('api_keys scope/integration columns', () => {
  it('defaults to full scope and generic integration', async () => {
    const m = await createTestMerchant(app);
    const { keyHash, keyPrefix } = generateApiKey();
    const [row] = await app.db
      .insert(schema.apiKeys)
      .values({ merchantId: m.merchantId, label: 'test', keyHash, keyPrefix })
      .returning();
    expect(row?.scope).toBe('full');
    expect(row?.integration).toBe('generic');
  });

  it('persists an explicit widget scope and wordpress integration', async () => {
    const m = await createTestMerchant(app);
    const { keyHash, keyPrefix } = generateApiKey();
    const [row] = await app.db
      .insert(schema.apiKeys)
      .values({
        merchantId: m.merchantId,
        label: 'wp widget',
        keyHash,
        keyPrefix,
        scope: 'widget',
        integration: 'wordpress',
      })
      .returning();
    expect(row?.scope).toBe('widget');
    expect(row?.integration).toBe('wordpress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `pnpm --filter @tryme/api test -- api-keys-schema`
Expected: FAIL — TypeScript error `Object literal may only specify known
properties, and 'scope' does not exist in type...` (the `.values()` call
doesn't type-check yet because the schema has no `scope`/`integration`
columns).

- [ ] **Step 3: Add the columns to the schema**

Modify `packages/db/src/schema/api-keys.ts`:

```typescript
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { merchants } from './merchant.js';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  // sha256(full key), hex. Unique so auth is a single index probe — and so a DB
  // dump never yields a usable key. The plaintext key exists only in the create
  // response.
  keyHash: text('key_hash').notNull().unique(),
  // e.g. "sk_live_a1b2" — dashboard display only, never sufficient to authenticate.
  keyPrefix: text('key_prefix').notNull(),
  // 'full' can call every /v1/dev/* route; 'widget' is restricted to the
  // storefront-safe allowlist enforced by requireDevScope() in dev-api-auth.ts.
  // No CHECK constraint — same deliberate choice as jobs.source (see
  // packages/types/src/job-taxonomy.ts).
  scope: text('scope', { enum: ['full', 'widget'] }).notNull().default('full'),
  // Which integration minted this key. Resolved server-side into jobs.source —
  // never trusted from a client-supplied field. See
  // docs/wordpress-plugin-design.md §4.2a.
  integration: text('integration', { enum: ['generic', 'wordpress'] })
    .notNull()
    .default('generic'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: a new file appears at `packages/db/src/migrations/017X_<auto-name>.sql`
(drizzle-kit picks the name — do not rename it). Open it and verify it
contains exactly two `ALTER TABLE` statements equivalent to:

```sql
ALTER TABLE "api_keys" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "integration" text DEFAULT 'generic' NOT NULL;
```

If drizzle-kit emits anything else (e.g. it tries to touch an unrelated
table), stop and investigate before applying — do not force it through.

Run: `pnpm docker:up` (if not already running), then `pnpm db:migrate`
Expected: migration applies cleanly, no errors.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- api-keys-schema`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/api-keys.ts packages/db/src/migrations/ apps/api/test/api-keys-schema.test.ts
git commit -m "feat(db): add scope and integration columns to api_keys"
```

---

## Task 2: `requireDevScope` preHandler + scope/integration decoration

**Files:**
- Modify: `apps/api/src/plugins/dev-api-auth.ts`
- Modify: `apps/api/test/helpers/merchant.ts` (`createTestApiKey` gains `scope`/`integration` options)
- Test: Create `apps/api/test/dev-widget-scope.test.ts`

- [ ] **Step 1: Extend the test helper to create scoped keys**

Modify `apps/api/test/helpers/merchant.ts` — replace the existing
`createTestApiKey` function with:

```typescript
export async function createTestApiKey(
  app: TestApp,
  merchantId: string,
  opts: {
    revoked?: boolean;
    label?: string;
    scope?: 'full' | 'widget';
    integration?: 'generic' | 'wordpress';
  } = {},
) {
  const { key, keyHash, keyPrefix } = generateApiKey();
  const [row] = await app.db
    .insert(schema.apiKeys)
    .values({
      merchantId,
      label: opts.label ?? 'test',
      keyHash,
      keyPrefix,
      revokedAt: opts.revoked ? new Date() : null,
      scope: opts.scope ?? 'full',
      integration: opts.integration ?? 'generic',
    })
    .returning();
  if (!row) throw new Error('failed to create test api key');
  return { id: row.id, key };
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/test/dev-widget-scope.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(
    c,
    {},
    {
      beforeListen: (a) => {
        a.get(
          '/test/full-only',
          { preHandler: [a.requireApiKey, a.requireDevScope('full')] },
          async (req) => ({ ok: true, scope: req.apiKeyScope, integration: req.integration }),
        );
        a.get(
          '/test/either-scope',
          { preHandler: a.requireApiKey },
          async (req) => ({ ok: true, scope: req.apiKeyScope }),
        );
      },
    },
  );
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('requireDevScope', () => {
  it('decorates the request with the key scope and integration', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    const res = await fetch(`${base}/test/either-scope`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('widget');
  });

  it('allows a full-scoped key on a full-only route', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'full' });
    const res = await fetch(`${base}/test/full-only`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a widget-scoped key on a full-only route with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/test/full-only`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope`
Expected: FAIL — `a.requireDevScope is not a function` (TypeError) and/or
`req.apiKeyScope` is `undefined` in the response body.

- [ ] **Step 4: Implement `requireDevScope` and decorate scope/integration**

Replace the full contents of `apps/api/src/plugins/dev-api-auth.ts`:

```typescript
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { API_KEY_RE, extractBearer, hashApiKey } from '../modules/dev/keys.js';

export const devApiAuthPlugin = fp(async (app) => {
  app.decorate('requireApiKey', async (req, _reply) => {
    const key = extractBearer(req.headers.authorization);
    if (!key) throw new AppError('UNAUTHORIZED', 401, 'Missing Authorization: Bearer <api key>');

    // Format guard BEFORE the DB round trip. Same reasoning as the UUID guard in
    // shopify-widget-auth.ts: a malformed value must not reach Postgres, where it
    // would surface as an unhandled error (500) instead of the intended 401. It
    // also keeps junk traffic off the database entirely.
    if (!API_KEY_RE.test(key)) throw new AppError('UNAUTHORIZED', 401, 'Invalid API key');

    // Lookup is by hash on a unique index — an index probe, not a string compare,
    // so there is no timing oracle on the key material.
    const [row] = await app.db
      .select({
        id: schema.apiKeys.id,
        revokedAt: schema.apiKeys.revokedAt,
        scope: schema.apiKeys.scope,
        integration: schema.apiKeys.integration,
        merchantId: schema.merchants.id,
        merchantIsActive: schema.merchants.isActive,
        merchantUserId: schema.merchants.userId,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.merchants, eq(schema.merchants.id, schema.apiKeys.merchantId))
      .where(eq(schema.apiKeys.keyHash, hashApiKey(key)))
      .limit(1);

    // One opaque message for every failure mode — never reveal whether a key
    // exists, is revoked, or belongs to a deactivated merchant.
    if (!row || row.revokedAt || !row.merchantIsActive) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid API key');
    }

    req.apiKeyId = row.id;
    req.apiKeyScope = row.scope;
    req.integration = row.integration;
    req.merchantId = row.merchantId;
    req.merchantUserId = row.merchantUserId;

    // lastUsedAt is dashboard telemetry, not a security control: throttle to ~1
    // write/min/key so a busy key does not add a write to every request, and never
    // let a failure here break the request.
    void (async () => {
      try {
        const ok = await app.redis.set(`apikey:lastused:${row.id}`, '1', 'EX', 60, 'NX');
        if (ok === 'OK') {
          await app.db
            .update(schema.apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(and(eq(schema.apiKeys.id, row.id)));
        }
      } catch (err) {
        app.log.warn({ err, apiKeyId: row.id }, 'failed to record api key lastUsedAt');
      }
    })();
  });

  // Factory mirroring admin/guard.ts's requirePermission(permission) — composed
  // AFTER requireApiKey in a route's preHandler array, reads the scope it already
  // resolved, never re-derives it. No route reads req.apiKeyScope and branches
  // inline; every full-only route composes this instead.
  app.decorate('requireDevScope', (scope: 'full' | 'widget') => {
    return async (req: FastifyRequest, _reply: FastifyReply) => {
      if (req.apiKeyScope !== scope) {
        throw new AppError(
          'FORBIDDEN',
          403,
          `this endpoint requires a '${scope}'-scoped API key`,
        );
      }
    };
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
    apiKeyScope?: 'full' | 'widget';
    integration?: 'generic' | 'wordpress';
    merchantId?: string;
    merchantUserId?: string;
  }
  interface FastifyInstance {
    requireApiKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireDevScope: (
      scope: 'full' | 'widget',
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope dev-api-auth`
Expected: PASS (all tests in both files — `dev-api-auth.test.ts` must still
pass unchanged, confirming this is additive).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plugins/dev-api-auth.ts apps/api/test/helpers/merchant.ts apps/api/test/dev-widget-scope.test.ts
git commit -m "feat(api): add requireDevScope preHandler and key scope/integration resolution"
```

---

## Task 3: Apply the route allowlist

**Files:**
- Modify: `apps/api/src/modules/dev/routes.ts:68-102` (`/v1/dev/me`), `:258-286` (`/v1/dev/saree-mannequin`)
- Modify: `apps/api/src/modules/dev/catalog.routes.ts:59-64`, `:123-128`, `:314-319`
- Test: extend `apps/api/test/dev-widget-scope.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/dev-widget-scope.test.ts` (inside the existing
`describe('requireDevScope', ...)` block, or a new adjacent `describe`):

```typescript
describe('full-only dev routes reject widget-scoped keys', () => {
  it('rejects GET /v1/dev/me for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/me`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(403);
  });

  it('allows GET /v1/dev/me for a full key', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'full' });
    const res = await fetch(`${base}/v1/dev/me`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
  });

  it('rejects POST /v1/dev/saree-mannequin for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/saree-mannequin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ garment: 'aGVsbG8=' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects GET /v1/dev/catalog/options for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/catalog/options`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope`
Expected: FAIL — the 403 assertions get 401/200/other, since no route yet
enforces `requireDevScope('full')`.

- [ ] **Step 3: Add `requireDevScope('full')` to the full-only routes**

In `apps/api/src/modules/dev/routes.ts`, change the `/v1/dev/me` route's
options object (currently `preHandler: app.requireApiKey`) to:

```typescript
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
```

Apply the identical change to the `/v1/dev/saree-mannequin` route's options
object in the same file.

In `apps/api/src/modules/dev/catalog.routes.ts`, apply the identical change
(`preHandler: [app.requireApiKey, app.requireDevScope('full')]`) to all three
routes: `/v1/dev/catalog/options`, `/v1/dev/catalog/generate`, and
`/v1/dev/catalogues/:id`.

Do **not** change `/v1/dev/tryon` or `/v1/dev/jobs/:id` in `routes.ts` — both
scopes are allowed there per the design doc's allowlist table (§4.2).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope dev-tryon-create dev-openapi`
Expected: PASS — including the pre-existing `dev-openapi.test.ts` and
`dev-tryon-create.test.ts`, confirming full-scoped keys (the default in every
other existing test) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/src/modules/dev/catalog.routes.ts apps/api/test/dev-widget-scope.test.ts
git commit -m "feat(api): restrict full-only dev routes to full-scoped API keys"
```

---

## Task 4: `JOB_SOURCE.WORDPRESS_TRYON` and server-resolved attribution

**Files:**
- Modify: `packages/types/src/job-taxonomy.ts`
- Modify: `apps/api/src/modules/dev/create-job.ts` (`createDevTryonJob`)
- Modify: `apps/api/src/modules/dev/routes.ts` (`/v1/dev/tryon` handler)
- Test: extend `apps/api/test/dev-widget-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/dev-widget-scope.test.ts` (needs
`createTestDevTryonCategory`, already imported style used in
`dev-job-rate-limit.test.ts` — add it to the import from `./helpers/merchant.js`,
and add `schema` and `eq` imports from `@tryme/db` / `drizzle-orm`):

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
// ...alongside existing imports:
import { createTestApiKey, createTestDevTryonCategory, createTestMerchant } from './helpers/merchant.js';

const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function tryonForm(categorySlug: string) {
  const fd = new FormData();
  fd.set('category', categorySlug);
  fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
  fd.set('garment', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'g.jpg');
  return fd;
}

describe('job source attribution', () => {
  it('stamps wordpress_tryon for a wordpress-integration key', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `wp-src-${m.merchantId}` });

    const res = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`wp-src-${m.merchantId}`),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.source).toBe('wordpress_tryon');
  });

  it('stamps api_tryon for a generic-integration key (unchanged behavior)', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'full', integration: 'generic' });
    await createTestDevTryonCategory(app, { slug: `api-src-${m.merchantId}` });

    const res = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`api-src-${m.merchantId}`),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.source).toBe('api_tryon');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope`
Expected: FAIL — the first test gets `job.source === 'api_tryon'` (not yet
`'wordpress_tryon'`), since nothing resolves `JOB_SOURCE.WORDPRESS_TRYON` yet.

- [ ] **Step 3: Add `WORDPRESS_TRYON` to the registry**

Modify `packages/types/src/job-taxonomy.ts` — add one line to `JOB_SOURCE`:

```typescript
export const JOB_SOURCE = {
  CATALOG: 'catalog',
  TRYON: 'tryon',
  CATALOG_VIDEO: 'catalog_video',
  SAREE: 'saree',
  SAREE_MANNEQUIN: 'saree_mannequin',
  SHOPIFY: 'shopify',
  MERCHANT_CATALOG: 'merchant_catalog',
  MERCHANT_CATALOG_SAREE_MANNEQUIN: 'merchant_catalog_saree_mannequin',
  MERCHANT_TRYON: 'merchant_tryon',
  API_TRYON: 'api_tryon',
  API_SAREE_MANNEQUIN: 'api_saree_mannequin',
  API_CATALOG: 'api_catalog',
  WORDPRESS_TRYON: 'wordpress_tryon',
} as const;
```

- [ ] **Step 4: Resolve source from `integration` in `createDevTryonJob`**

Modify `apps/api/src/modules/dev/create-job.ts` — change the `createDevTryonJob`
signature and its `createDevJobCore` call:

```typescript
export async function createDevTryonJob(
  app: FastifyInstance,
  params: {
    merchantId: string;
    merchantUserId: string;
    apiKeyId: string;
    integration: 'generic' | 'wordpress';
    categorySlug: string;
    personKey: string;
    garmentKey: string;
  },
): Promise<{ jobId: string }> {
  const cost = await getTryonCreditCost(app);

  const [category] = await app.db
    .select({
      workflowTemplateId: schema.devTryonCategories.workflowTemplateId,
      templateVersion: schema.workflowTemplates.version,
      templateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.devTryonCategories)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.devTryonCategories.workflowTemplateId),
    )
    .where(
      and(
        eq(schema.devTryonCategories.slug, params.categorySlug),
        eq(schema.devTryonCategories.isActive, true),
      ),
    )
    .limit(1);

  if (!category) throw new AppError('BAD_CATEGORY', 400, 'unknown or inactive category');
  if (!category.workflowTemplateId || !category.templateIsActive) {
    throw new AppError('BAD_CATEGORY', 400, 'category has no active workflow configured');
  }

  const [user] = await app.db
    .select({ isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.id, params.merchantUserId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'account suspended');

  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    // Never trust a client-supplied field for this — integration is resolved
    // server-side by dev-api-auth.ts from the authenticated key row, the same
    // place merchantId/merchantUserId are already resolved.
    source: params.integration === 'wordpress' ? JOB_SOURCE.WORDPRESS_TRYON : JOB_SOURCE.API_TRYON,
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      params: {
        personKey: params.personKey,
        workflowTemplateId: category.workflowTemplateId,
        dispatchTemplateVersion: category.templateVersion ?? null,
      },
    }),
  });
}
```

(Only the function signature's added `integration` field and the `source:`
line inside the `createDevJobCore` call actually change — everything else in
the function body is unchanged from today.)

- [ ] **Step 5: Pass `integration` through from the route handler**

In `apps/api/src/modules/dev/routes.ts`, inside the `/v1/dev/tryon` handler,
change the `createDevTryonJob` call from:

```typescript
      const { jobId } = await createDevTryonJob(app, {
        merchantId,
        merchantUserId,
        apiKeyId,
        categorySlug,
        personKey,
        garmentKey,
      });
```

to:

```typescript
      const { jobId } = await createDevTryonJob(app, {
        merchantId,
        merchantUserId,
        apiKeyId,
        integration: (req.integration as 'generic' | 'wordpress') ?? 'generic',
        categorySlug,
        personKey,
        garmentKey,
      });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope dev-tryon-create`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/job-taxonomy.ts apps/api/src/modules/dev/create-job.ts apps/api/src/modules/dev/routes.ts apps/api/test/dev-widget-scope.test.ts
git commit -m "feat(jobs): add WORDPRESS_TRYON job source, resolved from key integration"
```

---

## Task 5: Fix the `JOB_SOURCE` allowlist gap on job polling and usage reporting

**Files:**
- Modify: `apps/api/src/modules/dev/routes.ts:402-407` (`/v1/dev/jobs/:id`)
- Modify: `apps/api/src/modules/merchant/api-keys.routes.ts:130-138` (`/v1/merchant/api-usage`)
- Test: extend `apps/api/test/dev-widget-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/dev-widget-scope.test.ts`:

```typescript
describe('job polling includes wordpress_tryon jobs', () => {
  it('GET /v1/dev/jobs/:id finds a wordpress_tryon job (not a 404)', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `wp-poll-${m.merchantId}` });

    const createRes = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`wp-poll-${m.merchantId}`),
    });
    const { jobId } = await createRes.json();

    const pollRes = await fetch(`${base}/v1/dev/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json();
    expect(body.status).not.toBe(undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope`
Expected: FAIL — `pollRes.status` is 404, because the `inArray` filter on
`jobs.source` excludes `'wordpress_tryon'`.

- [ ] **Step 3: Add `WORDPRESS_TRYON` to both inArray filters**

In `apps/api/src/modules/dev/routes.ts`, inside the `/v1/dev/jobs/:id`
handler, change:

```typescript
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              LEGACY_JOB_SOURCE.API,
            ]),
```

to:

```typescript
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              JOB_SOURCE.WORDPRESS_TRYON,
              LEGACY_JOB_SOURCE.API,
            ]),
```

In `apps/api/src/modules/merchant/api-keys.routes.ts`, inside the
`/v1/merchant/api-usage` handler, apply the identical addition to its
`inArray(schema.jobs.source, [...])` list (same four existing values, same
one new value added) — this surfaces WordPress-originated jobs in the
merchant's usage dashboard alongside other dev-API usage.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-widget-scope`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/src/modules/merchant/api-keys.routes.ts apps/api/test/dev-widget-scope.test.ts
git commit -m "fix(api): include wordpress_tryon jobs in job-polling and usage-report filters"
```

---

## Task 6: Widget-key rate limit

**Files:**
- Modify: `packages/types/src/rate-limits.ts`
- Create: `apps/api/src/lib/widget-key-rate-limit.ts`
- Modify: `apps/api/src/modules/dev/routes.ts` (`/v1/dev/tryon` and `/v1/dev/jobs/:id` handlers)
- Test: Create `apps/api/test/widget-key-rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/widget-key-rate-limit.test.ts
import { DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN } from '@tryme/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { assertWidgetKeyRateLimit } from '../src/lib/widget-key-rate-limit.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestDevTryonCategory, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('assertWidgetKeyRateLimit', () => {
  it('allows up to the configured per-minute limit, then throws RATE_LIMITED', async () => {
    const apiKeyId = 'test-widget-key-rate-limit';
    for (let i = 0; i < DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN; i++) {
      await expect(assertWidgetKeyRateLimit(app, apiKeyId)).resolves.toBeUndefined();
    }
    await expect(assertWidgetKeyRateLimit(app, apiKeyId)).rejects.toThrow(AppError);
    try {
      await assertWidgetKeyRateLimit(app, apiKeyId);
    } catch (err) {
      expect((err as AppError).code).toBe('RATE_LIMITED');
    }
  });

  it('does not throttle a different key sharing the same window', async () => {
    await expect(assertWidgetKeyRateLimit(app, 'other-key-1')).resolves.toBeUndefined();
    await expect(assertWidgetKeyRateLimit(app, 'other-key-2')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- widget-key-rate-limit`
Expected: FAIL — module `../src/lib/widget-key-rate-limit.js` does not exist,
and `DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN` is not exported from `@tryme/types`.

- [ ] **Step 3: Add the rate-limit constant**

Modify `packages/types/src/rate-limits.ts`:

```typescript
/** Fallback per-merchant dev-API job-creation rate when merchants.jobRateLimitPerMin is null. */
export const DEFAULT_JOB_RATE_LIMIT_PER_MIN = 15;

/** Fallback ceiling on QUEUED catalog/saree/saree_mannequin jobs when config:system holds no entry. */
export const DEFAULT_MAX_QUEUE_DEPTH = 50;

/**
 * Tighter per-widget-key request limit than the account-wide 60/min applied to
 * every dev-API key. A widget key sits in public WordPress page source and is
 * expected to be called only by the storefront widget it was issued for, so a
 * lower ceiling bounds the cost of a copied key before the merchant notices and
 * revokes it. Not per-site: the backend only knows which key made a request,
 * not which WordPress site it came from — see docs/wordpress-plugin-design.md §4.2.
 */
export const DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN = 20;
```

- [ ] **Step 4: Implement the limiter**

Create `apps/api/src/lib/widget-key-rate-limit.ts`:

```typescript
import { DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Fixed-window (per-UTC-minute) counter keyed by apiKeyId, mirroring
 * job-rate-limit.ts's assertMerchantJobRateLimit. Applied only to widget-scoped
 * keys (checked by the caller via req.apiKeyScope === 'widget') on the two
 * routes a storefront widget calls: /v1/dev/tryon and /v1/dev/jobs/:id.
 *
 * Fails open on a Redis error, matching server.ts's `skipOnError: true` on the
 * general rate limiter: a Redis blip must not turn into a wall of 500s on a
 * safety-net check.
 */
export async function assertWidgetKeyRateLimit(
  app: FastifyInstance,
  apiKeyId: string,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `widget-key-rate:${apiKeyId}:${bucket}`;

  let count: number;
  try {
    count = await app.redis.incr(key);
    if (count === 1) await app.redis.expire(key, 60);
  } catch (err) {
    app.log.warn({ err, apiKeyId }, 'widget key rate limit check failed open on redis error');
    return;
  }

  if (count > DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN) {
    throw new AppError('RATE_LIMITED', 429, 'widget key request rate limit exceeded', {
      limit: DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- widget-key-rate-limit`
Expected: PASS

- [ ] **Step 6: Wire it into the two widget-callable routes**

In `apps/api/src/modules/dev/routes.ts`, at the top of the `/v1/dev/tryon`
handler (immediately after the existing `const apiKeyId = req.apiKeyId as string;`
line, before any file parsing), add:

```typescript
      if (req.apiKeyScope === 'widget') {
        await assertWidgetKeyRateLimit(app, apiKeyId);
      }
```

The `/v1/dev/jobs/:id` handler has no `apiKeyId` local today — its body
currently starts with:

```typescript
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
```

Change it to:

```typescript
    async (req) => {
      const { id } = req.params as { id: string };
      if (req.apiKeyScope === 'widget') {
        await assertWidgetKeyRateLimit(app, req.apiKeyId as string);
      }
      const [job] = await app.db
```

Add the import at the top of the file: `import { assertWidgetKeyRateLimit } from '../../lib/widget-key-rate-limit.js';`

- [ ] **Step 7: Write and run an end-to-end HTTP-level test**

Add to `apps/api/test/widget-key-rate-limit.test.ts`:

```typescript
describe('widget key rate limit on /v1/dev/tryon', () => {
  it('throttles a widget key that exceeds the per-minute limit', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `rl-wp-${m.merchantId}` });

    const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const form = () => {
      const fd = new FormData();
      fd.set('category', `rl-wp-${m.merchantId}`);
      fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
      fd.set('garment', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'g.jpg');
      return fd;
    };

    const responses: Response[] = [];
    for (let i = 0; i < DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN + 10; i++) {
      responses.push(
        await fetch(`${base}/v1/dev/tryon`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          body: form(),
        }),
      );
    }
    expect(responses.some((r) => r.status === 429)).toBe(true);
    expect(responses.some((r) => r.status === 202)).toBe(true);
  });
});
```

Run: `pnpm --filter @tryme/api test -- widget-key-rate-limit`
Expected: PASS (all tests in the file)

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/rate-limits.ts apps/api/src/lib/widget-key-rate-limit.ts apps/api/src/modules/dev/routes.ts apps/api/test/widget-key-rate-limit.test.ts
git commit -m "feat(api): add per-widget-key rate limit on storefront-callable dev routes"
```

---

## Task 7: "Create WordPress Widget Key" atomic issuance path

**Files:**
- Modify: `packages/types/src/dev.ts`
- Modify: `apps/api/src/modules/merchant/api-keys.routes.ts`
- Test: Modify `apps/api/test/merchant-api-keys.test.ts` (this route already
  has a full test file — extend it, do not create a parallel one)

`requireMerchant` (`apps/api/src/plugins/portal-auth.ts:13`) authenticates via
a plain `Authorization: Bearer <access token>` header — the same JWT the
catalogues-web user session uses, verified with `verifyAccess` — **not** a
cookie. `apps/api/test/merchant-api-keys.test.ts` already has the exact
helper this task needs: a local `tokenFor(userId)` calling `signAccess`
(`apps/api/src/modules/auth/service.js`) and a `call()` wrapper that attaches
`authorization: Bearer ${token}`. Reuse both as-is.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/merchant-api-keys.test.ts`, inside a new
`describe` block appended after the existing `GET /v1/merchant/api-usage`
block (reusing the file's existing `call`, `token`, and `tokenFor`):

```typescript
describe('POST /v1/merchant/api-keys with kind: wordpress_widget', () => {
  it('atomically sets scope=widget and integration=wordpress', async () => {
    const createRes = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'My WooCommerce Store', kind: 'wordpress_widget' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.scope).toBe('widget');
    expect(created.integration).toBe('wordpress');

    const list = await (await call('/v1/merchant/api-keys')).json();
    const row = list.keys.find((k: { id: string }) => k.id === created.id);
    expect(row.scope).toBe('widget');
    expect(row.integration).toBe('wordpress');
  });

  it('defaults to full/generic when kind is omitted (unchanged behavior)', async () => {
    const createRes = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'Regular key' }),
    });
    const created = await createRes.json();
    expect(created.scope).toBe('full');
    expect(created.integration).toBe('generic');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Expected: FAIL — either a compile error (if `kind` isn't a recognized body
field yet) or the created key has `scope: 'full'` regardless of `kind`.

- [ ] **Step 3: Extend the request/response schemas**

Modify `packages/types/src/dev.ts`:

```typescript
export const ApiKeyCreateBody = z.object({
  label: z.string().min(1).max(64),
  // Only WordPress-issued keys set this today. Presence — not any other
  // client-supplied field — is what triggers the atomic
  // scope=widget/integration=wordpress pairing in api-keys.routes.ts; there is
  // deliberately no way to set scope or integration independently through this
  // endpoint. See docs/wordpress-plugin-design.md §4.2/§4.2a.
  kind: z.enum(['wordpress_widget']).optional(),
});

// `key` is present ONLY here — the one and only time the plaintext is returned.
export const ApiKeyCreateResponse = z.object({
  id: z.string().uuid(),
  label: z.string(),
  key: z.string(),
  keyPrefix: z.string(),
  scope: z.enum(['full', 'widget']),
  integration: z.enum(['generic', 'wordpress']),
  createdAt: z.string(),
});
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponse>;

export const ApiKeyListResponse = z.object({
  keys: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      keyPrefix: z.string(),
      scope: z.enum(['full', 'widget']),
      integration: z.enum(['generic', 'wordpress']),
      lastUsedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
```

- [ ] **Step 4: Wire it into the route handler**

Modify `apps/api/src/modules/merchant/api-keys.routes.ts` — the `GET` list
handler's `select` and the `POST` handler:

```typescript
  app.get('/v1/merchant/api-keys', { preHandler: app.requireMerchant }, async (req) => {
    const rows = await app.db
      .select({
        id: schema.apiKeys.id,
        label: schema.apiKeys.label,
        keyPrefix: schema.apiKeys.keyPrefix,
        scope: schema.apiKeys.scope,
        integration: schema.apiKeys.integration,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.merchantId, req.merchantClientId as string),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .orderBy(desc(schema.apiKeys.createdAt));
    return {
      keys: rows.map((r) => ({
        ...r,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    '/v1/merchant/api-keys',
    { preHandler: app.requireMerchant },
    async (req, reply) => {
      const parsed = ApiKeyCreateBody.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION', 400, parsed.error.issues[0]?.message ?? 'invalid body');
      }
      const { label, kind } = parsed.data;
      const { key, keyHash, keyPrefix } = generateApiKey();
      // The ONLY place scope/integration are set together — a merchant-facing
      // "kind" shorthand, not two independently settable fields, so a key can
      // never end up widget-scoped without also being wordpress-attributed
      // (or vice versa). See docs/wordpress-plugin-design.md §4.2a.
      const scopeAndIntegration =
        kind === 'wordpress_widget'
          ? ({ scope: 'widget', integration: 'wordpress' } as const)
          : ({ scope: 'full', integration: 'generic' } as const);
      const [row] = await app.db
        .insert(schema.apiKeys)
        .values({ merchantId: req.merchantClientId as string, label, keyHash, keyPrefix, ...scopeAndIntegration })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create key');

      // The ONLY place the plaintext key is ever returned. It is not stored and
      // cannot be recovered — the dashboard must tell the user so.
      return reply.code(201).send({
        id: row.id,
        label: row.label,
        key,
        keyPrefix: row.keyPrefix,
        scope: row.scope,
        integration: row.integration,
        createdAt: row.createdAt.toISOString(),
      });
    },
  );
```

Also update the import line at the top of the file to include
`ApiKeyCreateBody` unchanged (already imported) — no new import needed since
`kind` is just a new optional field on the existing schema.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Expected: PASS (both new tests, plus every pre-existing test in the file
still passing unchanged)

- [ ] **Step 6: Run the full existing suite to check for regressions**

Run: `pnpm --filter @tryme/api test`
Expected: PASS across the board (the `scope`/`integration` additions to the
list/create responses are additive fields — no existing assertion in this
codebase checks for an exact object shape that would break on an extra key,
but confirm by reading any failure output if one appears).

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/dev.ts apps/api/src/modules/merchant/api-keys.routes.ts apps/api/test/merchant-api-keys.test.ts
git commit -m "feat(api): add wordpress_widget key issuance kind, atomically scoped and attributed"
```

---

## Task 8: Merchant portal UI — "Create WordPress Widget Key"

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/developers/api.ts`
- Modify: `apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx`

No automated test: this repo has no frontend component-test harness for
`apps/catalogues-web` (confirmed — no `*.test.tsx` files or vitest config
exist under it), and introducing one solely for this button is out of scope
for this plan. Verify with the manual QA steps in Step 3 instead.

- [ ] **Step 1: Add the `kind` parameter to the API client**

Modify `apps/catalogues-web/src/app/(app)/developers/api.ts`:

```typescript
import type {
  ApiKey,
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiUsageResponse,
} from '@tryme/types';
import { api } from '@/lib/api';

export type { ApiKey, ApiKeyCreateResponse as CreatedApiKey };

export function listApiKeys(): Promise<ApiKeyListResponse> {
  return api.get<ApiKeyListResponse>('/v1/merchant/api-keys');
}

export function createApiKey(
  label: string,
  kind?: 'wordpress_widget',
): Promise<ApiKeyCreateResponse> {
  return api.post<ApiKeyCreateResponse>('/v1/merchant/api-keys', { label, kind });
}

export function revokeApiKey(id: string): Promise<void> {
  return api.del<void>(`/v1/merchant/api-keys/${id}`);
}

export function getApiUsage(): Promise<ApiUsageResponse> {
  return api.get<ApiUsageResponse>('/v1/merchant/api-usage');
}
```

- [ ] **Step 2: Add the button and a scope/integration badge**

Modify `apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx`:

1. Change the `createMutation` to accept an optional kind:

```typescript
  const createMutation = useMutation({
    mutationFn: ({ l, kind }: { l: string; kind?: 'wordpress_widget' }) => createApiKey(l, kind),
    onSuccess: (created) => {
      setRevealedKey(created);
      setCreateOpen(false);
      setLabel('');
      void qc.invalidateQueries({ queryKey: ['dev-api-keys'] });
    },
  });
```

2. Change the two call sites that currently do `createMutation.mutate(label.trim())`
   — the existing "Create Key" button — to
   `createMutation.mutate({ l: label.trim() })`, and add a second button next
   to it in the same button row:

```tsx
            <GradBtn
              onClick={() => createMutation.mutate({ l: label.trim(), kind: 'wordpress_widget' })}
              disabled={createMutation.isPending || !label.trim()}
              style={{ height: 38, fontSize: 13.5, padding: '0 18px' }}
            >
              {createMutation.isPending ? 'Creating…' : 'Create WordPress Widget Key'}
            </GradBtn>
```

3. In the keys table, add a "Type" column between "Key" and "Created" showing
   a small badge — widget-scoped keys read "WordPress Widget", everything
   else reads "Full access". Add `<span>Type</span>` to the header grid and
   adjust `gridTemplateColumns` from `'1.2fr 1fr 1.1fr 1.1fr 0.6fr'` to
   `'1.2fr 1fr 1fr 1.1fr 1.1fr 0.6fr'` in both the header and row `div`
   styles, and add the corresponding `<span>` in each row:

```tsx
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: k.integration === 'wordpress' ? C.pink : C.mid,
                  }}
                >
                  {k.integration === 'wordpress' ? 'WordPress Widget' : 'Full access'}
                </span>
```

- [ ] **Step 3: Manual QA**

Run `pnpm --filter @tryme/web dev`, log in as a merchant with API access
enabled, go to **Settings → Developers** (or wherever `KeysPanel` is mounted
— confirm via `apps/catalogues-web/src/app/(app)/developers/` routing), and
verify:
1. "Create Key" still creates a full-access key (badge reads "Full access").
2. "Create WordPress Widget Key" creates a key whose badge reads "WordPress
   Widget".
3. The revealed-key dismissal flow (`RevealedKeyBox`) works identically for
   both button types.
4. Revoking either type of key still works.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/(app)/developers/api.ts apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx
git commit -m "feat(web): add Create WordPress Widget Key button and scope badge"
```

---

## Task 9: Per-site CORS allowlist for WordPress widget keys

**Discovered during local end-to-end testing, not in the original design doc.**
`server.ts`'s CORS origin callback only ever allowed `env.CORS_ORIGIN` (a
static list) or an origin present in `shopifyStores.allowedOrigins`. A
WordPress widget key has no equivalent: the storefront `widget.js` calls
`/v1/dev/tryon` / `/v1/dev/jobs/:id` directly from the shopper's browser
(§4.2), and that call is cross-origin from every merchant's own domain
(`https://theirshop.com`), which was never registered anywhere. In production
this blocks the try-on flow on every WooCommerce store, not just a local dev
quirk — first reproduced locally as "Try-on is temporarily unavailable"
(`widget.js`'s `.catch(renderUnavailable)` swallows the CORS-blocked fetch
into that generic message).

**Files:**
- Modify: `packages/db/src/schema/api-keys.ts`
- Create: `packages/db/src/migrations/0177_open_songbird.sql` (via `pnpm db:generate`)
- Modify: `packages/types/src/dev.ts`
- Modify: `apps/api/src/modules/merchant/api-keys.routes.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/helpers/merchant.ts`
- Modify: `apps/api/test/merchant-api-keys.test.ts`
- Create: `apps/api/test/wordpress-cors.test.ts`
- Modify: `apps/catalogues-web/src/app/(app)/developers/api.ts`
- Modify: `apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx`

- [x] **Step 1: Add `api_keys.allowedOrigin`**

Add a nullable `text('allowed_origin')` column to `apiKeys` in
`packages/db/src/schema/api-keys.ts`, set only for
`integration: 'wordpress'` widget keys (one column, not an array like
`shopifyStores.allowedOrigins`, since one widget key is expected per
WordPress site — §4.2). Generate and apply the migration:

```bash
pnpm db:generate
pnpm db:migrate
```

- [x] **Step 2: Require `siteUrl` on `wordpress_widget` key creation**

In `packages/types/src/dev.ts`, add `siteUrl: z.string().url().optional()` to
`ApiKeyCreateBody`, with a `.superRefine` requiring it when
`kind === 'wordpress_widget'`. Add `allowedOrigin: z.string().nullable()` to
`ApiKeyCreateResponse` and to each entry in `ApiKeyListResponse`.

In `apps/api/src/modules/merchant/api-keys.routes.ts`'s POST handler,
normalize `siteUrl` to its origin — `new URL(parsed.data.siteUrl).origin`
(safe without a try/catch: zod's `.url()` already guarantees it parses) —
store it as `allowedOrigin` on insert, and return it in both the create
response and the GET listing's `select`.

- [x] **Step 3: Check it in the CORS origin callback**

In `apps/api/src/server.ts`, after the existing `shopifyStores` lookup, add a
second lookup (only run when the Shopify check missed) against
`apiKeys` where `integration = 'wordpress'`, `revokedAt is null`, and
`allowedOrigin = origin`. Both lookups share the existing 30s TTL
`originCache` — `allowed` is `true` if either query found a row. Import `eq`
from `drizzle-orm` (only `and`/`isNull`/`sql` were imported before).

- [x] **Step 4: Tests**

Add to `apps/api/test/merchant-api-keys.test.ts`: creating a
`wordpress_widget` key normalizes `siteUrl` to `allowedOrigin` (e.g.
`https://my-shop.example.com/wp-admin/` → `https://my-shop.example.com`),
rejects a missing `siteUrl` with 400, rejects a malformed one with 400, and a
plain key still gets `allowedOrigin: null`.

Add `apps/api/test/wordpress-cors.test.ts`, mirroring
`shopify-cors.test.ts`'s pattern: an active widget key's `allowedOrigin` is
reflected in `access-control-allow-origin`; a revoked key's origin is not; an
unregistered origin is not; a `generic`/`full` key's `allowedOrigin` (should
never be set outside the wordpress_widget path, but tested defensively) is
not honored; and the 30s cache/TTL behavior matches the existing Shopify
origin-caching test exactly (allow decision survives revocation until the TTL
expires, then re-queries).

Extend `apps/api/test/helpers/merchant.ts`'s `createTestApiKey` with an
`allowedOrigin?: string` option so tests can seed a widget key's origin
directly.

Run: `pnpm --filter @tryme/api test -- merchant-api-keys wordpress-cors shopify-cors`
Expected: PASS, including the 3 new `merchant-api-keys` cases and all 5 new
`wordpress-cors` cases.

- [x] **Step 5: Merchant portal — collect the site URL**

In `apps/catalogues-web/src/app/(app)/developers/api.ts`, add a `siteUrl?:
string` parameter to `createApiKey` and pass it through in the POST body.

In `KeysPanel.tsx`, add a `siteUrl` input (shown only when
`keyKind === 'wordpress_widget'`, labeled "Store URL", placeholder
`https://mystore.com`), required before "Create Widget Key" is enabled, reset
alongside `label` on cancel/success, and shown as a small subtitle under the
key's label in the listing when `allowedOrigin` is set.

- [x] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/db/src/schema/api-keys.ts packages/db/src/migrations/0177_open_songbird.sql packages/types/src/dev.ts apps/api/src/modules/merchant/api-keys.routes.ts apps/api/src/server.ts apps/api/test/helpers/merchant.ts apps/api/test/merchant-api-keys.test.ts apps/api/test/wordpress-cors.test.ts apps/catalogues-web/src/app/\(app\)/developers/api.ts apps/catalogues-web/src/app/\(app\)/developers/KeysPanel.tsx
git commit -m "feat: per-site CORS allowlist for WordPress widget keys"
```

**Not done here (future hardening, same category as §4.2's "Future hardening
options"):** nothing stops a merchant from later changing the WordPress site
address without updating the widget key's `siteUrl`, at which point the
storefront would 401 with a CORS error instead of a clear message pointing at
the mismatch. Revisit if this shows up in support tickets — an "edit widget
key" UI to update `allowedOrigin` without reissuing the key, or a clearer
plugin-side error surfacing the *reason* is unavailable (CORS vs 401 vs 5xx)
instead of one generic string.

---

## Task 10: Full regression pass

- [ ] **Step 1: Run the complete API unit test suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS, zero regressions.

- [ ] **Step 2: Typecheck and lint everything touched**

Run: `pnpm typecheck` and `pnpm lint`
Expected: PASS. If `pnpm typecheck` surfaces an error in `apps/catalogues-web`
about the `kind` field being possibly `undefined` on the request body sent to
`api.post`, confirm `api.post`'s generic body type accepts an object with an
optional property (it does — `{ label, kind }` where `kind` may be
`undefined` serializes to JSON without the key, which `ApiKeyCreateBody`
already treats as absent via `.optional()`).

- [ ] **Step 3: Update `docs/progress.md`**

Add a dated entry (today's date) under "Done" summarizing: `api_keys.scope`/
`integration` columns added, `requireDevScope` route allowlist enforced,
`JOB_SOURCE.WORDPRESS_TRYON` added and correctly included in the job-polling
and usage-report filters (flag that the design doc's "unchanged by this
design" claim about job polling was corrected), widget-key rate limit added,
and the merchant-portal "Create WordPress Widget Key" flow shipped. Note that
the WordPress plugin itself is tracked in a separate plan/repo and has not
been built yet — this plan only delivers the API surface it will call.

- [ ] **Step 4: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log WordPress backend integration work in progress.md"
```
