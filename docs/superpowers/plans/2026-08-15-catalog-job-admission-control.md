# Catalog Job Admission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the sweeper (`apps/dispatcher/src/stream/sweeper.ts`) from silently killing jobs that were accepted but never reached a worker within its 10-minute `QUEUED_SLA_MS`, by rejecting new submissions *before* they're accepted whenever the system is already over capacity — instead of accepting them and refunding/failing them 10 minutes later.

**Architecture:** Two independent, additive admission-control gates, both admin-tunable, both fail fast with an HTTP error before any credit is charged or DB row is written:

1. **Per-merchant job-creation rate limit** on the public dev API (`/v1/dev/tryon`, `/v1/dev/saree-mannequin`) — a Redis fixed-window counter keyed by merchant, checked once inside the shared `createDevJobCore` helper both routes already funnel through. Limit is admin-editable per merchant (`merchants.jobRateLimitPerMin`), falling back to a system default.
2. **System-wide queue-depth cap** on the four Studio/catalogue-path job-creation functions (`createJob`, `createBatchJobs`, `createSareeJob`, `createSareeMannequinJob`) — counts current `QUEUED` rows across `source IN ('catalog','saree','saree_mannequin')` against an admin-configured ceiling (`config:system.maxQueueDepth`, mirroring the existing `maxBatchJobs` pattern) and rejects with 503 "server is busy" when it would be exceeded.

Neither gate touches the sweeper, the dispatcher, or worker capacity — they only reduce how often a job gets accepted that the current worker pool can't drain inside the SLA.

**Tech Stack:** Fastify 5, Drizzle ORM (Postgres), ioredis, Zod (`@tryme/types`), Vitest (container-backed tests in `apps/api/test/`), React (admin-web).

**Spec:** No separate spec file — this is a bounded change; the design was agreed in conversation (see this plan's Goal/Architecture above, which is the full agreed design).

## Global Constraints

- ESM only, TypeScript 5.6, pnpm workspaces — never introduce npm/yarn lockfiles or new runtime dependencies.
- Never run `pnpm db:generate` / `pnpm db:migrate` against the production VPS or `tryon_prod` — this plan's migration step runs locally only, against the dev Postgres started by `pnpm docker:up`.
- `pnpm --filter @tryme/api test` runs everything under `apps/api/test/**` except `test/integration/**` — this includes container-backed tests like `dev-rate-limit.test.ts`, so `pnpm docker:up` must be running before that command works. Do not confuse this with a true no-Docker unit-only run; the repo's own naming is a little loose here (see CLAUDE.md Testing section), but the existing test files that use `startContainers()` in `apps/api/test/*.test.ts` (not `test/integration/`) are exactly the pattern this plan's new tests follow.
- `packages/db/src/index.ts` exports `* as schema` — never add a duplicate `schema` re-export; import `@tryme/db` as `workspace:*`.
- Match existing comment density/idiom in every file touched — comment the *why*, not the *what*.
- Credit deduct + job insert must stay one Postgres transaction wherever it already is (`atomicDeduct` calls) — this plan's checks are inserted *before* those transactions, never inside or after.
- `AppError`'s `details` field is sent verbatim to the client — keep it small and non-sensitive.

## File Structure

**New files:**
- `packages/types/src/rate-limits.ts` — `DEFAULT_JOB_RATE_LIMIT_PER_MIN`, `DEFAULT_MAX_QUEUE_DEPTH` constants
- `apps/api/src/lib/job-rate-limit.ts` — `assertMerchantJobRateLimit()`
- `apps/api/src/lib/queue-capacity-config.ts` — `getMaxQueueDepth()`, `assertQueueCapacity()`
- `apps/api/test/job-rate-limit.test.ts` — unit tests for the rate-limit helper
- `apps/api/test/dev-job-rate-limit.test.ts` — integration test through `/v1/dev/tryon`
- `apps/api/test/queue-capacity-config.test.ts` — unit tests for the capacity helper
- `apps/api/test/integration/queue-capacity.test.ts` — integration test through `/v1/jobs/tryon` (lives under `test/integration/` because it needs `app.inject` + full Studio fixture seeding, matching `jobs-create-looks.test.ts`'s existing pattern — run via `pnpm --filter @tryme/api test:integration`, not the plain `test` command)
- `packages/db/src/migrations/0154_merchants_job_rate_limit.sql` (name assigned by drizzle-kit; approximate) — adds `merchants.job_rate_limit_per_min`

**Modified files:**
- `packages/db/src/schema/merchant.ts` — add `jobRateLimitPerMin` column
- `packages/types/src/index.ts` — export the new `rate-limits.ts` module
- `packages/types/src/widget.ts` — `AdminMerchantUpdateBody` gains `jobRateLimitPerMin`
- `packages/types/src/admin.ts` — `SystemConfigBody` gains `maxQueueDepth`
- `apps/api/src/modules/admin/merchants.routes.ts` — list/get SELECTs + PATCH handler
- `apps/api/src/modules/admin/users.routes.ts` — merchant-join SELECT (feeds the Users page detail drawer)
- `apps/api/src/modules/admin/config.routes.ts` — `GET /admin/config` default-merge
- `apps/api/src/modules/dev/create-job.ts` — `createDevJobCore` calls `assertMerchantJobRateLimit`
- `apps/api/src/modules/jobs/create.ts` — `createJob` calls `assertQueueCapacity`
- `apps/api/src/modules/jobs/createBatch.ts` — `createBatchJobs` calls `assertQueueCapacity`
- `apps/api/src/modules/jobs/createSaree.ts` — `createSareeJob` calls `assertQueueCapacity`
- `apps/api/src/modules/jobs/createSareeMannequin.ts` — `createSareeMannequinJob` calls `assertQueueCapacity`
- `apps/api/test/helpers/merchant.ts` — `createTestMerchant` gains an optional `jobRateLimitPerMin` opt
- `apps/admin-web/src/types.ts` — `UserMerchant` gains `jobRateLimitPerMin`
- `apps/admin-web/src/pages/UsersPage.tsx` — merchant edit drawer gets a rate-limit field
- `apps/admin-web/src/pages/SettingsPage.tsx` — new `maxQueueDepth` field next to `maxBatchJobs`

---

### Task 1: DB schema — `merchants.jobRateLimitPerMin`

**Files:**
- Modify: `packages/db/src/schema/merchant.ts:16-51` (the `merchants` table)
- Create: migration via `drizzle-kit generate` (do not hand-write the SQL)

**Interfaces:**
- Produces: `schema.merchants.jobRateLimitPerMin` — nullable `integer`, no default (null = "use system default", same convention as leaving `config:system.maxQueueDepth` unset)

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/merchant.ts`, right after `maxKioskDevices` (line 25):

```ts
  maxKioskDevices: integer('max_kiosk_devices').notNull().default(5),
  // Null = use DEFAULT_JOB_RATE_LIMIT_PER_MIN (packages/types/src/rate-limits.ts).
  // Per-merchant override for how many /v1/dev/* job-creation calls this merchant's
  // API keys may make per minute (combined across all their keys) — see
  // assertMerchantJobRateLimit in apps/api/src/lib/job-rate-limit.ts. Distinct from
  // the flat per-key request-volume limiter already on those routes (rateLimitConfig
  // in apps/api/src/modules/dev/routes.ts), which caps raw request count, not job
  // creation specifically.
  jobRateLimitPerMin: integer('job_rate_limit_per_min'),
  webhookUrl: text('webhook_url'),
```

- [ ] **Step 2: Generate the migration**

Run (from repo root, with `pnpm docker:up` already running so drizzle-kit can introspect):

```bash
pnpm db:generate
```

Expected: a new file appears under `packages/db/src/migrations/`, e.g. `0154_<auto-name>.sql`, containing:

```sql
ALTER TABLE "merchants" ADD COLUMN "job_rate_limit_per_min" integer;
```

and `packages/db/src/migrations/meta/_journal.json` gets a new entry. If drizzle-kit picks an unrelated auto-generated name, that's fine — do not rename it.

- [ ] **Step 3: Apply the migration locally**

```bash
pnpm db:migrate
```

Expected: no errors; `psql` (or `pnpm --filter @tryme/db exec drizzle-kit studio` if you prefer a UI) shows `merchants.job_rate_limit_per_min` as a nullable integer column.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/merchant.ts packages/db/src/migrations/
git commit -m "feat(db): add merchants.job_rate_limit_per_min column"
```

---

### Task 2: Types — rate-limit constants + Zod field additions

**Files:**
- Create: `packages/types/src/rate-limits.ts`
- Modify: `packages/types/src/index.ts:1-15`
- Modify: `packages/types/src/widget.ts:408-425` (`AdminMerchantUpdateBody`)
- Modify: `packages/types/src/admin.ts:101-131` (`SystemConfigBody`)

**Interfaces:**
- Produces: `DEFAULT_JOB_RATE_LIMIT_PER_MIN` (number), `DEFAULT_MAX_QUEUE_DEPTH` (number) — both exported from `@tryme/types`
- Produces: `AdminMerchantUpdateBody.jobRateLimitPerMin?: number | null`
- Produces: `SystemConfigBody.maxQueueDepth?: number`

- [ ] **Step 1: Create the constants file**

`packages/types/src/rate-limits.ts`:

```ts
/** Fallback per-merchant dev-API job-creation rate when merchants.jobRateLimitPerMin is null. */
export const DEFAULT_JOB_RATE_LIMIT_PER_MIN = 15;

/** Fallback ceiling on QUEUED catalog/saree/saree_mannequin jobs when config:system holds no entry. */
export const DEFAULT_MAX_QUEUE_DEPTH = 50;
```

- [ ] **Step 2: Export it from the barrel**

In `packages/types/src/index.ts`, add (alphabetically, after `./jobs.js`):

```ts
export * from './job-taxonomy.js';
export * from './jobs.js';
export * from './rate-limits.js';
export * from './saree.js';
```

- [ ] **Step 3: Add the merchant override field**

In `packages/types/src/widget.ts`, inside `AdminMerchantUpdateBody` (line 408-424), add after `maxKioskDevices`:

```ts
    maxKioskDevices: z.number().int().min(1).max(100).optional(),
    // Null clears the override back to DEFAULT_JOB_RATE_LIMIT_PER_MIN.
    jobRateLimitPerMin: z.number().int().min(1).max(500).nullable().optional(),
    logoKey: z.string().max(500).nullable().optional(),
```

- [ ] **Step 4: Add the system-wide config field**

In `packages/types/src/admin.ts`, inside `SystemConfigBody` (line 101-131), add after `maxBatchJobs`:

```ts
  maxBatchJobs: z.number().int().min(1).max(2000).optional(),
  // Ceiling on QUEUED jobs across source IN ('catalog','saree','saree_mannequin') —
  // see assertQueueCapacity in apps/api/src/lib/queue-capacity-config.ts. Exists so
  // a burst of submissions the current worker pool can't drain inside the sweeper's
  // 10-minute QUEUED_SLA_MS is rejected up front instead of accepted and later
  // silently refunded as STUCK_IN_QUEUE.
  maxQueueDepth: z.number().int().min(1).max(5000).optional(),
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/types build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/rate-limits.ts packages/types/src/index.ts packages/types/src/widget.ts packages/types/src/admin.ts
git commit -m "feat(types): add job-rate-limit and queue-depth config fields"
```

---

### Task 3: Admin API — expose and edit `jobRateLimitPerMin`

**Files:**
- Modify: `apps/api/src/modules/admin/merchants.routes.ts:119-151` (list SELECT), `:234-260` (get-by-id SELECT), `:307-351` (PATCH handler)
- Modify: `apps/api/src/modules/admin/users.routes.ts:153-168` (merchant-join SELECT)

**Interfaces:**
- Consumes: `schema.merchants.jobRateLimitPerMin` (Task 1), `AdminMerchantUpdateBody.jobRateLimitPerMin` (Task 2)
- Produces: `GET /admin/merchants`, `GET /admin/merchants/:id`, `GET /admin/users/:id` all return `jobRateLimitPerMin: number | null`; `PATCH /admin/merchants/:id` accepts and persists it

- [ ] **Step 1: Add to the merchants list SELECT**

In `apps/api/src/modules/admin/merchants.routes.ts`, the list query (around line 131):

```ts
          kioskEnabled: schema.merchants.kioskEnabled,
          maxKioskDevices: schema.merchants.maxKioskDevices,
          jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin,
          createdAt: schema.merchants.createdAt,
```

- [ ] **Step 2: Add to the get-by-id SELECT**

Same file, around line 245:

```ts
          kioskEnabled: schema.merchants.kioskEnabled,
          maxKioskDevices: schema.merchants.maxKioskDevices,
          jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin,
          userId: schema.merchants.userId,
```

- [ ] **Step 3: Handle it in the PATCH handler**

Same file, in the `PATCH /admin/merchants/:id` handler, after the `maxKioskDevices` line (around line 325):

```ts
      if (body.maxKioskDevices !== undefined) updates.maxKioskDevices = body.maxKioskDevices;
      if (body.jobRateLimitPerMin !== undefined) {
        updates.jobRateLimitPerMin = body.jobRateLimitPerMin;
      }
```

- [ ] **Step 4: Add to the Users-page merchant join**

In `apps/api/src/modules/admin/users.routes.ts`, the `merchantRow` SELECT (around line 163):

```ts
          kioskEnabled: schema.merchants.kioskEnabled,
          maxKioskDevices: schema.merchants.maxKioskDevices,
          jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin,
          logoKey: schema.merchants.logoKey,
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/merchants.routes.ts apps/api/src/modules/admin/users.routes.ts
git commit -m "feat(admin-api): expose and edit merchant job rate limit"
```

---

### Task 4: `assertMerchantJobRateLimit` helper + unit test

**Files:**
- Create: `apps/api/src/lib/job-rate-limit.ts`
- Create: `apps/api/test/job-rate-limit.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_JOB_RATE_LIMIT_PER_MIN` (Task 2), `AppError` (`apps/api/src/lib/errors.js`)
- Produces: `assertMerchantJobRateLimit(app: FastifyInstance, merchantUserId: string): Promise<void>` — throws `AppError('RATE_LIMITED', 429, ...)` past the limit; resolves otherwise. Reads the merchant's `jobRateLimitPerMin` itself (one extra `SELECT` — merchants are keyed 1:1 with `userId`, see `merchants.userId` `.unique()` in the schema, so `merchantUserId` is a valid lookup key).

This is a pure fixed-window Redis counter, following the same "cheap fail-open on Redis error" posture as the existing `@fastify/rate-limit` registration in `server.ts` (`skipOnError: true`) — a Redis blip must not turn into a wall of 500s.

- [ ] **Step 1: Write the failing unit test**

`apps/api/test/job-rate-limit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { assertMerchantJobRateLimit } from '../src/lib/job-rate-limit.js';

function fakeApp(opts: { jobRateLimitPerMin: number | null; incrValues: number[] }) {
  let call = 0;
  const redis = {
    incr: vi.fn(async () => opts.incrValues[call++] ?? opts.incrValues[opts.incrValues.length - 1]),
    expire: vi.fn(async () => 1),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([{ jobRateLimitPerMin: opts.jobRateLimitPerMin }]),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake FastifyInstance for a unit test
  return { redis, db } as any;
}

describe('assertMerchantJobRateLimit', () => {
  it('allows requests under the limit', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [1] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).resolves.toBeUndefined();
    expect(app.redis.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('rejects the request that crosses the limit', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [16] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('falls back to DEFAULT_JOB_RATE_LIMIT_PER_MIN when the merchant has no override', async () => {
    const app = fakeApp({ jobRateLimitPerMin: null, incrValues: [16] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('does not call expire on the second and later request in the same window', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [2] });
    await assertMerchantJobRateLimit(app, 'user-1');
    expect(app.redis.expire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @tryme/api exec vitest run test/job-rate-limit.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/job-rate-limit.js'`.

- [ ] **Step 3: Implement the helper**

`apps/api/src/lib/job-rate-limit.ts`:

```ts
import { schema } from '@tryme/db';
import { DEFAULT_JOB_RATE_LIMIT_PER_MIN } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Fixed-window (per-UTC-minute) counter, keyed by merchant — merchants.userId is
 * unique (one merchant per user), so merchantUserId is a valid per-merchant key
 * without needing a separate merchantId lookup. Scoped to job-creation calls only
 * (createDevJobCore, the shared core every /v1/dev/* job route funnels through),
 * distinct from the flat per-key request-volume limiter already on those routes.
 *
 * Fails open on a Redis error, matching server.ts's `skipOnError: true` on the
 * general rate limiter: a Redis blip must not turn into a wall of 500s on a
 * safety-net check.
 */
export async function assertMerchantJobRateLimit(
  app: FastifyInstance,
  merchantUserId: string,
): Promise<void> {
  const [merchant] = await app.db
    .select({ jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, merchantUserId));
  const limit = merchant?.jobRateLimitPerMin ?? DEFAULT_JOB_RATE_LIMIT_PER_MIN;

  const bucket = Math.floor(Date.now() / 60_000);
  const key = `job-rate:${merchantUserId}:${bucket}`;

  let count: number;
  try {
    count = await app.redis.incr(key);
    if (count === 1) await app.redis.expire(key, 60);
  } catch (err) {
    app.log.warn({ err, merchantUserId }, 'job rate limit check failed open on redis error');
    return;
  }

  if (count > limit) {
    throw new AppError(
      'RATE_LIMITED',
      429,
      'job submission rate limit exceeded, please slow down',
      { limit },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api exec vitest run test/job-rate-limit.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/job-rate-limit.ts apps/api/test/job-rate-limit.test.ts
git commit -m "feat(api): add per-merchant job-creation rate limit helper"
```

---

### Task 5: Wire the rate limit into the dev API + integration test

**Files:**
- Modify: `apps/api/src/modules/dev/create-job.ts:17-27` (`createDevJobCore`)
- Modify: `apps/api/test/helpers/merchant.ts:7-53` (`createTestMerchant`)
- Create: `apps/api/test/dev-job-rate-limit.test.ts`

**Interfaces:**
- Consumes: `assertMerchantJobRateLimit` (Task 4)
- Produces: both `/v1/dev/tryon` and `/v1/dev/saree-mannequin` 429 past the merchant's limit — no code changes needed in either route file, since both already call `createDevJobCore`

- [ ] **Step 1: Write the failing integration test**

`apps/api/test/dev-job-rate-limit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function form(categorySlug: string) {
  const fd = new FormData();
  fd.set('category', categorySlug);
  fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
  fd.set('garment', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'g.jpg');
  return fd;
}

const post = (fd: FormData, token: string) =>
  fetch(`${base}/v1/dev/tryon`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });

describe('per-merchant job creation rate limit', () => {
  it('rejects the request that crosses the merchant-configured limit with 429', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 2 });
    const { key } = await createTestApiKey(app, m.merchantId);
    const { categoryId: _categoryId, workflowTemplateId: _wf } = await createTestDevTryonCategory(app, {
      slug: `rl-${m.merchantId}`,
    });

    let last: Response | undefined;
    for (let i = 0; i < 3; i++) last = await post(form(`rl-${m.merchantId}`), key);
    expect(last?.status).toBe(429);
    const body = await last!.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('does not throttle a different merchant sharing the same window', async () => {
    const m1 = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1 });
    const m2 = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1 });
    const { key: key1 } = await createTestApiKey(app, m1.merchantId);
    const { key: key2 } = await createTestApiKey(app, m2.merchantId);
    await createTestDevTryonCategory(app, { slug: `rl2-${m1.merchantId}` });
    await createTestDevTryonCategory(app, { slug: `rl2-${m2.merchantId}` });

    expect((await post(form(`rl2-${m1.merchantId}`), key1)).status).toBe(202);
    expect((await post(form(`rl2-${m2.merchantId}`), key2)).status).toBe(202);
  });
});
```

- [ ] **Step 2: Add the test-helper option**

In `apps/api/test/helpers/merchant.ts`, extend `createTestMerchant`'s `opts` (line 9-13) and insert (line 27-35):

```ts
export async function createTestMerchant(
  app: TestApp,
  opts: {
    isActive?: boolean;
    balance?: number;
    demoData?: boolean;
    jobRateLimitPerMin?: number;
  } = {},
) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `merchant-${randomUUID()}@test.com`,
      displayName: 'Test Merchant',
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create test user');

  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Test Co',
      contactName: 'Test Person',
      phone: '0000000000',
      businessAddress: 'Test Address',
      isActive: opts.isActive ?? true,
      demoData: opts.demoData ?? true,
      userId: user.id,
      jobRateLimitPerMin: opts.jobRateLimitPerMin,
    })
    .returning();
```

(everything else in the function is unchanged.)

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm docker:up
pnpm --filter @tryme/api exec vitest run test/dev-job-rate-limit.test.ts
```

Expected: FAIL — first test gets `202` on every request (no rate limit enforced yet), so `last?.status` is `202` not `429`.

- [ ] **Step 4: Wire the check into `createDevJobCore`**

In `apps/api/src/modules/dev/create-job.ts`, add the import and the call as the very first line of the function body:

```ts
import { AppError } from '../../lib/errors.js';
import { assertMerchantJobRateLimit } from '../../lib/job-rate-limit.js';
import { atomicDeduct, refundAndMarkFailed } from '../credits/ledger.js';
```

```ts
export async function createDevJobCore(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    cost: number;
    watermark: boolean;
    source: JobSource;
    buildJobInputs: () => Omit<typeof schema.jobInputs.$inferInsert, 'jobId'>;
  },
): Promise<{ jobId: string }> {
  await assertMerchantJobRateLimit(app, params.merchantUserId);

  const catalogueId = randomUUID();
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api exec vitest run test/dev-job-rate-limit.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Run the existing dev-API test suite to confirm no regression**

```bash
pnpm --filter @tryme/api exec vitest run test/dev-tryon-create.test.ts test/dev-saree-mannequin-create.test.ts test/dev-rate-limit.test.ts
```

Expected: all PASS — the new check runs at `limit=15/min` by default (`DEFAULT_JOB_RATE_LIMIT_PER_MIN`), well above what those tests' request counts hit.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/dev/create-job.ts apps/api/test/helpers/merchant.ts apps/api/test/dev-job-rate-limit.test.ts
git commit -m "feat(api): enforce per-merchant job rate limit on the dev API"
```

---

### Task 6: Admin-web — edit the merchant rate limit

**Files:**
- Modify: `apps/admin-web/src/types.ts:191-203` (`UserMerchant`)
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:23-28` (`EMPTY_EDIT_MERCHANT_FORM`), `:465-476` (`openEditMerchant`), `:477-490` (`handleMerchantEditSave`), `:1352-1361` (drawer JSX)

**Interfaces:**
- Consumes: `GET /admin/users/:id` now returns `merchant.jobRateLimitPerMin` (Task 3), `PATCH /admin/merchants/:id` now accepts it (Task 3)

- [ ] **Step 1: Add the field to the type**

`apps/admin-web/src/types.ts`, in `UserMerchant` (after line 200):

```ts
  maxKioskDevices: number;
  jobRateLimitPerMin: number | null;
  logoKey: string | null;
```

- [ ] **Step 2: Extend the edit form state**

`apps/admin-web/src/pages/UsersPage.tsx`, `EMPTY_EDIT_MERCHANT_FORM` (line 23-28):

```ts
const EMPTY_EDIT_MERCHANT_FORM = {
  companyName: '',
  contactName: '',
  phone: '',
  businessAddress: '',
  jobRateLimitPerMin: '',
};
```

(kept as a string so the input can be blank; converted on save.)

- [ ] **Step 3: Populate it when opening the drawer**

`openEditMerchant` (line 465-475):

```ts
  function openEditMerchant() {
    if (!detail?.merchant) return;
    const m = detail.merchant;
    setMerchantEditForm({
      companyName: m.companyName,
      contactName: m.contactName,
      phone: m.phone,
      businessAddress: m.businessAddress,
      jobRateLimitPerMin: m.jobRateLimitPerMin != null ? String(m.jobRateLimitPerMin) : '',
    });
    setShowEditMerchant(true);
  }
```

- [ ] **Step 4: Convert on save**

`handleMerchantEditSave` (line 477-490) — replace the raw `merchantEditForm` body with a converted payload:

```ts
  async function handleMerchantEditSave() {
    if (!detail?.merchant) return;
    setSavingMerchantEdit(true);
    try {
      const trimmedLimit = merchantEditForm.jobRateLimitPerMin.trim();
      await apiFetch(`/admin/merchants/${detail.merchant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          companyName: merchantEditForm.companyName,
          contactName: merchantEditForm.contactName,
          phone: merchantEditForm.phone,
          businessAddress: merchantEditForm.businessAddress,
          jobRateLimitPerMin: trimmedLimit === '' ? null : Number(trimmedLimit),
        }),
      });
      toast({ title: 'Merchant details updated' });
      setShowEditMerchant(false);
      await openDetail(detail);
    } catch (err) {
      toast({ kind: 'error', title: apiErrorMessage(err, 'Failed to update merchant') });
```

(the `finally` block below is unchanged.)

- [ ] **Step 5: Add the input field**

In the drawer JSX, after the "Business address" field (line 1352-1361):

```tsx
              <div className="field">
                <label>Business address</label>
                <input
                  className="input"
                  value={merchantEditForm.businessAddress}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, businessAddress: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>Job rate limit (per minute)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  placeholder="Default (15/min)"
                  value={merchantEditForm.jobRateLimitPerMin}
                  onChange={(e) =>
                    setMerchantEditForm((f) => ({ ...f, jobRateLimitPerMin: e.target.value }))
                  }
                />
              </div>
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: no errors.

- [ ] **Step 7: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```

Open the admin SPA, go to a merchant user's detail page, click "Edit merchant details", confirm the new field shows "Default (15/min)" placeholder when unset, accepts a number, saves, and re-opening the drawer shows the saved value.

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/UsersPage.tsx
git commit -m "feat(admin-web): edit per-merchant job rate limit"
```

---

### Task 7: `assertQueueCapacity` helper + unit test

**Files:**
- Create: `apps/api/src/lib/queue-capacity-config.ts`
- Create: `apps/api/test/queue-capacity-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MAX_QUEUE_DEPTH` (Task 2), `AppError`
- Produces: `getMaxQueueDepth(app: FastifyInstance): Promise<number>`, `assertQueueCapacity(app: FastifyInstance, additionalJobs: number): Promise<void>` — throws `AppError('SERVER_BUSY', 503, ...)` when `currentQueuedCount + additionalJobs > maxQueueDepth`

- [ ] **Step 1: Write the failing unit test**

`apps/api/test/queue-capacity-config.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { assertQueueCapacity, getMaxQueueDepth } from '../src/lib/queue-capacity-config.js';

function fakeApp(opts: { redisConfig?: string | null; queuedCount: number }) {
  const redis = { get: vi.fn(async () => opts.redisConfig ?? null) };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ c: opts.queuedCount }]),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake FastifyInstance for a unit test
  return { redis, db } as any;
}

describe('getMaxQueueDepth', () => {
  it('returns the default when config:system holds no maxQueueDepth', async () => {
    const app = fakeApp({ redisConfig: null, queuedCount: 0 });
    expect(await getMaxQueueDepth(app)).toBe(50);
  });

  it('returns the admin-configured value when present', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 5 }), queuedCount: 0 });
    expect(await getMaxQueueDepth(app)).toBe(5);
  });
});

describe('assertQueueCapacity', () => {
  it('allows the request when under the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 5 });
    await expect(assertQueueCapacity(app, 3)).resolves.toBeUndefined();
  });

  it('rejects when the request would push past the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 8 });
    await expect(assertQueueCapacity(app, 3)).rejects.toMatchObject({
      code: 'SERVER_BUSY',
      statusCode: 503,
    });
  });

  it('allows a request that lands exactly on the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 7 });
    await expect(assertQueueCapacity(app, 3)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @tryme/api exec vitest run test/queue-capacity-config.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/queue-capacity-config.js'`.

- [ ] **Step 3: Implement the helper**

`apps/api/src/lib/queue-capacity-config.ts`:

```ts
import { schema } from '@tryme/db';
import { DEFAULT_MAX_QUEUE_DEPTH } from '@tryme/types';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

const CONFIG_KEY = 'config:system';

// The three sources that land QUEUED immediately off the Studio/catalogue path
// and therefore compete for a worker inside the sweeper's 10-minute SLA. Does
// NOT include catalog_video (own lane, own 30-minute SLA — see sweeper.ts) or
// the saree-mannequin step-2 rows, which insert as PENDING_MANNEQUIN, not
// QUEUED, until promoted later (see createSareeMannequinJob).
const QUEUE_CAPPED_SOURCES = ['catalog', 'saree', 'saree_mannequin'] as const;

/**
 * Reads the admin-configured ceiling on concurrently QUEUED catalog-path jobs
 * from the same `config:system` Redis key the admin panel edits (GET/PATCH
 * /admin/config), mirroring getMaxBatchJobs() in batch-config.ts. Falls back to
 * DEFAULT_MAX_QUEUE_DEPTH when nothing is stored or the entry is malformed.
 */
export async function getMaxQueueDepth(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const max = cfg.maxQueueDepth;
    return typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_QUEUE_DEPTH;
  } catch {
    return DEFAULT_MAX_QUEUE_DEPTH;
  }
}

/**
 * Rejects a job submission before any credit/DB work if accepting it would push
 * the system-wide QUEUED count (across QUEUE_CAPPED_SOURCES) past the admin's
 * ceiling. This is an admission-control gate, not a correctness guard — a
 * concurrent submission can still race past it, same tradeoff createBatchJobs's
 * preflight balance check already accepts (see create.ts comment there).
 */
export async function assertQueueCapacity(
  app: FastifyInstance,
  additionalJobs: number,
): Promise<void> {
  const maxQueueDepth = await getMaxQueueDepth(app);
  const [row] = await app.db
    .select({ c: count() })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, 'QUEUED'), inArray(schema.jobs.source, QUEUE_CAPPED_SOURCES)));
  const current = row?.c ?? 0;

  if (current + additionalJobs > maxQueueDepth) {
    throw new AppError(
      'SERVER_BUSY',
      503,
      'server is busy, please try again shortly',
      { current, maxQueueDepth },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api exec vitest run test/queue-capacity-config.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/queue-capacity-config.ts apps/api/test/queue-capacity-config.test.ts
git commit -m "feat(api): add queue-depth admission control helper"
```

---

### Task 8: Wire `GET /admin/config` default-merge

**Files:**
- Modify: `apps/api/src/modules/admin/config.routes.ts:1-19` (imports), `:43-63` (`GET /admin/config`)

**Interfaces:**
- Consumes: `DEFAULT_MAX_QUEUE_DEPTH` (Task 2)
- Produces: `GET /admin/config` response includes `maxQueueDepth` even when never set

- [ ] **Step 1: Import the constant**

In `apps/api/src/modules/admin/config.routes.ts`, line 3:

```ts
import { DEFAULT_MAX_BATCH_JOBS, DEFAULT_MAX_QUEUE_DEPTH, PresignAppVideoBody, SystemConfigBody } from '@tryme/types';
```

- [ ] **Step 2: Merge the default**

In the `GET /admin/config` handler (line 43-63), after the `maxBatchJobs` line:

```ts
      cfg.maxBatchJobs = cfg.maxBatchJobs ?? DEFAULT_MAX_BATCH_JOBS;
      cfg.maxQueueDepth = cfg.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/config.routes.ts
git commit -m "feat(admin-api): default-merge maxQueueDepth in GET /admin/config"
```

---

### Task 9: Wire `assertQueueCapacity` into the four Studio-path call sites + integration test

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:1-30` (imports), `:766-843` (`createJob`)
- Modify: `apps/api/src/modules/jobs/createBatch.ts:1-17` (imports), `:70-83` (`createBatchJobs`)
- Modify: `apps/api/src/modules/jobs/createSaree.ts:1-13` (imports), `:47-58` (`createSareeJob`)
- Modify: `apps/api/src/modules/jobs/createSareeMannequin.ts:1-10` (imports), `:57-67` (`createSareeMannequinJob`)
- Create: `apps/api/test/integration/queue-capacity.test.ts`

**Interfaces:**
- Consumes: `assertQueueCapacity` (Task 7)

Each call site inserts the check *after* `plan`/routing is resolved (so the real job count — `plan.looks.length`, batch size, or `1` for the mannequin job — is known) but *before* the DB transaction that writes rows and deducts credits, so a rejected request costs nothing.

- [ ] **Step 1: Write the failing integration test**

This follows the exact pattern already used by `apps/api/test/integration/jobs-create-looks.test.ts` — `app.inject()` with a bearer token from `createVerifiedUserToken` (`apps/api/test/helpers/auth.ts`), directly-seeded `modelFaces`/`modelBackgrounds`/`modelPoseAssets` rows, and a directly-bound upload key via `app.redis.set('upload:owner:...', ...)`.

`apps/api/test/integration/queue-capacity.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { createVerifiedUserToken } from '../helpers/auth.js';
import { type Containers, startContainers } from '../helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

afterEach(async () => {
  await app.redis.del('config:system');
});

async function grantCredits(userId: string, amount: number) {
  await app.db
    .insert(schema.userCredits)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
}

async function seedFaceBackgroundPose() {
  const [face] = await app.db
    .insert(schema.modelFaces)
    .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
    .returning();
  const [bg] = await app.db
    .insert(schema.modelBackgrounds)
    .values({ label: 'Bg', r2Key: 'a.jpg', thumbnailKey: 'a.jpg' })
    .returning();
  const [pose] = await app.db
    .insert(schema.modelPoseAssets)
    .values({ label: 'Pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
    .returning();
  return { faceId: face.id, backgroundId: bg.id, poseId: pose.id };
}

describe('queue-depth admission control', () => {
  it('rejects a submission that would push QUEUED count past the admin ceiling with 503, charging nothing', async () => {
    const { token, userId } = await createVerifiedUserToken(app, 'queue-cap-busy@x.com');
    await grantCredits(userId, 100);
    const { faceId, backgroundId, poseId } = await seedFaceBackgroundPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);

    // Ceiling of 0 with nothing else queued — even a single-look submission (1 job) exceeds it.
    await app.redis.set('config:system', JSON.stringify({ maxQueueDepth: 0 }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [{ poseId, backgroundId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVER_BUSY');

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged for the rejected request

    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(0); // no orphaned row written either
  });

  it('allows the submission when under the default ceiling (config:system unset)', async () => {
    const { token, userId } = await createVerifiedUserToken(app, 'queue-cap-ok@x.com');
    await grantCredits(userId, 100);
    const { faceId, backgroundId, poseId } = await seedFaceBackgroundPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [{ poseId, backgroundId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @tryme/api exec vitest run test/integration/queue-capacity.test.ts --config vitest.integration.config.ts
```

Expected: FAIL on the first test — request returns `201`, not `503` (no cap enforced yet).

- [ ] **Step 3: Wire `createJob` (create.ts)**

Add the import (near the other `../../lib/*` imports, line ~20):

```ts
import { assertOwnsUploadKey, assertGarmentObjectValid } from '../../lib/upload-ownership.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
```

Insert the check right after `plan` is resolved and before the `[[user], routing]` lookup (around line 828-833):

```ts
  const plan = await resolveTryonPlan(app, userId, body, {
    resolvedUpperGarmentKey: resolvedUpperGarmentKey ?? null,
    trustedGarmentKeys: opts?.trustedGarmentKeys,
  });

  await assertQueueCapacity(app, plan.looks.length);

  const [[user], routing] = await Promise.all([
```

- [ ] **Step 4: Wire `createBatchJobs` (createBatch.ts)**

Add the import:

```ts
import { AppError, withRowIndex } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
```

Insert the check right after `totalJobs`/`creditsCharged` are computed and before the balance preflight (around line 172-179):

```ts
  const totalJobs = plans.reduce((n, plan) => n + plan.looks.length, 0);
  const creditsCharged = plans.reduce((n, plan) => n + plan.cost * plan.looks.length, 0);

  await assertQueueCapacity(app, totalJobs);

  // Preflight so an unaffordable batch is rejected with a useful message instead
```

- [ ] **Step 5: Wire `createSareeJob` (createSaree.ts)**

Add the import:

```ts
import { AppError } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
```

Insert the check right after the ban check, before the transaction (around line 52-56):

```ts
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  await assertQueueCapacity(app, 1);

  const { queueStream, priority, watermark } = routing;
```

- [ ] **Step 6: Wire `createSareeMannequinJob` (createSareeMannequin.ts)**

Add the import:

```ts
import { AppError } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
```

Insert the check right after the ban check, before the transaction (around line 63-67) — `additionalJobs: 1` because only the `SAREE_MANNEQUIN` job lands `QUEUED` immediately; the step-2 `CATALOG` rows insert as `PENDING_MANNEQUIN`:

```ts
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  await assertQueueCapacity(app, 1);

  const { queueStream, priority, watermark } = routing;
```

- [ ] **Step 7: Typecheck, then run the new test to verify it passes**

```bash
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/api exec vitest run test/integration/queue-capacity.test.ts --config vitest.integration.config.ts
```

Expected: typecheck clean; test run PASS (2 tests).

- [ ] **Step 8: Run the full integration suite to confirm no regression**

```bash
pnpm --filter @tryme/api test:integration
```

Expected: same pass/fail set as before this task, aside from the two new tests — in particular `jobs-create-looks.test.ts`, `batch-jobs.test.ts`, and `jobs-create-mannequin.test.ts` must still pass with `config:system` unset, i.e. the default `maxQueueDepth: 50` ceiling, which none of those tests' request volumes get near. (`jobs-create.test.ts`, `catalog.test.ts`, `e2e.test.ts` have pre-existing unrelated failures per the comment in `apps/api/vitest.config.ts` — not something this task should fix or worry about.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/createBatch.ts apps/api/src/modules/jobs/createSaree.ts apps/api/src/modules/jobs/createSareeMannequin.ts apps/api/test/integration/queue-capacity.test.ts
git commit -m "feat(api): enforce queue-depth admission control on the Studio job-creation path"
```

---

### Task 10: Admin-web — `maxQueueDepth` Settings field

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx:246-247` (state), `:296-309` (load), `:423-427` (save payload), `:854-865` (JSX, new block), `:1243-1259` (save-button validation)

**Interfaces:**
- Consumes: `GET /admin/config` / `PATCH /admin/config` `maxQueueDepth` (Task 8)

- [ ] **Step 1: Add state**

`apps/admin-web/src/pages/SettingsPage.tsx`, after `maxBatchJobs` (line 247):

```ts
  const [maxOutputPx, setMaxOutputPx] = useState(2048);
  const [maxBatchJobs, setMaxBatchJobs] = useState(200);
  const [maxQueueDepth, setMaxQueueDepth] = useState(50);
```

- [ ] **Step 2: Load it**

In the `useEffect` fetching `/admin/config` (line 296-309), add to the inline response type and the setter:

```ts
    apiFetch<{
      maxOutputPx?: number;
      maxBatchJobs?: number;
      maxQueueDepth?: number;
      seller?: { gstin?: string; legalName?: string; address?: string };
```

```ts
      .then((cfg) => {
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.maxBatchJobs) setMaxBatchJobs(cfg.maxBatchJobs);
        if (cfg.maxQueueDepth) setMaxQueueDepth(cfg.maxQueueDepth);
```

- [ ] **Step 3: Save it**

In the `PATCH /admin/config` payload (line 423-427):

```ts
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          maxOutputPx,
          maxBatchJobs,
          maxQueueDepth,
          seller: {
```

- [ ] **Step 4: Add the input, right after the Max Batch Size block**

After the closing `</div>` of the "Max Batch Size" block (line 866):

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Max Queue Depth
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Ceiling on QUEUED catalog/saree jobs system-wide. New Studio submissions are
                    rejected with "server is busy" once this many jobs are already waiting for a
                    worker, instead of being accepted and silently timing out 10 minutes later.
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r)',
                      background: 'var(--surface-2)',
                      maxWidth: 260,
                    }}
                  >
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={5000}
                      style={{ width: 100 }}
                      value={maxQueueDepth}
                      disabled={sysSaving}
                      onChange={(e) => setMaxQueueDepth(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>jobs queued</span>
                  </div>
                </div>
```

- [ ] **Step 5: Extend save-button validation**

Line 1243-1259:

```tsx
                <div className="setting-actions">
                  <button
                    className="btn primary"
                    onClick={saveSysConfig}
                    disabled={
                      sysSaving ||
                      !Number.isInteger(maxOutputPx) ||
                      maxOutputPx < 512 ||
                      maxOutputPx > 4096 ||
                      !Number.isInteger(maxBatchJobs) ||
                      maxBatchJobs < 1 ||
                      maxBatchJobs > 2000 ||
                      !Number.isInteger(maxQueueDepth) ||
                      maxQueueDepth < 1 ||
                      maxQueueDepth > 5000
                    }
                  >
                    {sysSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: no errors.

- [ ] **Step 7: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```

Open Settings, confirm "Max Queue Depth" appears under "Max Batch Size" with the same visual style, loads `50` by default, saves, and persists across a page reload.

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): add max queue depth setting"
```

---

### Task 11: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

```bash
pnpm typecheck
```

Expected: no errors across all packages.

- [ ] **Step 2: Lint everything**

```bash
pnpm lint
```

Expected: no errors. Fix any biome findings in the files this plan touched.

- [ ] **Step 3: Build everything**

```bash
pnpm build
```

Expected: succeeds, including `@tryme/types` and `@tryme/db` picking up the new exports/column.

- [ ] **Step 4: Run the full api test suite (container-backed, needs `pnpm docker:up`)**

```bash
pnpm docker:up
pnpm --filter @tryme/api test
```

Expected: all pass, including every new file from Tasks 4, 5, 7, 9.

- [ ] **Step 5: Run the integration suite**

```bash
pnpm --filter @tryme/api test:integration
```

Expected: no new failures relative to the pre-existing known failures documented in `apps/api/vitest.config.ts` (`jobs-create.test.ts`, `catalog.test.ts`, `e2e.test.ts` — unrelated pre-existing issues, not introduced by this plan).

- [ ] **Step 6: Confirm the migration applies cleanly from scratch**

```bash
pnpm docker:reset
pnpm docker:up
pnpm db:migrate
```

Expected: no errors — proves the new migration composes correctly with the full existing chain, not just as an incremental apply.

- [ ] **Step 7: Final commit (if any lint/format fixes were needed)**

```bash
git add -A
git status
```

Review the diff is exactly what's expected (no stray files), then commit any final fixes:

```bash
git commit -m "chore: lint/typecheck fixes for catalog job admission control"
```
