# Bulk Upload (Catalogue + Admin-Held Flat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchants two bulk-upload modes in the try-on library app — direct catalogue-image upload (no GPU), and flat-image upload whose GPU jobs are held until an admin releases them globally during free-GPU hours.

**Architecture:** Bulk catalogue upload is pure frontend — it loops the existing single-item `POST /v1/merchant/catalog` path, which creates rows with `sourceKind='uploaded'` and no job. Bulk flat upload reuses the entire existing job pipeline but adds one new `jobs.status` value, `HELD`: `createMerchantCatalogJob` deducts credits and writes `jobs`/`job_inputs` in the same transaction as today, then **skips the Redis `XADD`**, so the dispatcher never sees the job. A new admin route sweeps every `HELD` row across all merchants and `XADD`s them to `jobs:low`. Because the merchant is no longer on-screen when generation finishes, a merchant-triggered reconcile route turns completed held jobs into `merchant_catalog_items` rows with `isActive=false`; the existing `PATCH /v1/merchant/catalog/:id` flips them active once SKU + prices are filled in, which is exactly what the existing kiosk query (`isActive AND moderationStatus='approved'`) already gates on.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM / PostgreSQL 16, Redis 7 Streams, Next.js 15 (`apps/catalogues-web`), Vite + React SPA (`apps/admin-web`), Vitest.

## Global Constraints

- pnpm workspaces only — never introduce an npm or yarn lockfile.
- ESM only (`"type": "module"`), TypeScript 5.6, Node 20+.
- No `console.log` in committed code — use `app.log` / `@tryme/logger`.
- All request/response shapes live in `packages/types` as Zod schemas; routes import them.
- Credit deduct + job insert must remain one Postgres transaction.
- All `/admin/*` routes go through `requireAdmin([...])` from `apps/api/src/modules/admin/guard.js`.
- Frontend colors come from `C` in `apps/catalogues-web/src/components/tokens.ts` — never raw hex. (Exception: the existing bulk-upload page already hardcodes `#10b981` for its "Generated" badge; match surrounding code rather than refactoring it.)
- `pnpm docker:up` must be running before any `pnpm test` — tests create a fresh Postgres DB + MinIO bucket per file.
- Migration index is canonical and sequential. The highest existing index is **0136** (`0136_merchant_demo_data.sql`), so the new migration is **0137**.
- Do NOT touch `apps/admin-mobile` — admin mobile development is paused.

---

### Task 1: `jobs.queued_at` column + sweeper staleness fix

A `HELD` job can sit for days. `jobs.status` is unconstrained `text` (migration `0119_drop_jobs_status_check.sql` explicitly dropped the out-of-band CHECK), so adding the value `HELD` needs no migration — and the sweeper's two passes target `status='QUEUED'` and `IN_FLIGHT_STATES`, so `HELD` jobs are already immune to it.

The landmine is **release**: the sweeper's pass-1 staleness is `coalesce(<last PREPROCESSING event>, jobs.created_at)`. A job created three days ago and released just now has no PREPROCESSING event yet, so staleness resolves to `created_at` — three days old, past the 10-minute SLA — and the very next sweeper tick would fail-and-refund a perfectly healthy job. This task adds a nullable `queued_at` stamp that release sets, and slots it into the coalesce ahead of `created_at`. Null for every other job, so existing behavior is bit-for-bit unchanged.

**Files:**
- Create: `packages/db/src/migrations/0137_jobs_queued_at.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/jobs.ts:53-56`
- Modify: `apps/dispatcher/src/stream/sweeper.ts:70`
- Test: `apps/dispatcher/test/integration/sweeper-held-release.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `schema.jobs.queuedAt` — `timestamp with time zone`, nullable, TS type `Date | null`. Task 3 sets it at release time.

- [ ] **Step 1: Write the failing test**

Create `apps/dispatcher/test/integration/sweeper-held-release.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runSweeper } from '../../src/stream/sweeper.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/**
 * Held bulk-flat jobs are created now and released days later. The sweeper's
 * QUEUED staleness must date from the release (queued_at), not from creation —
 * otherwise every released batch is failed-and-refunded on the next tick.
 */
describe('sweeper — held-then-released jobs', () => {
  let env: TestEnv;
  let pub: Redis;

  beforeAll(async () => {
    env = await setupTestEnv();
    pub = new Redis('redis://127.0.0.1:6379');
  }, 60_000);

  afterAll(async () => {
    pub.disconnect();
    await env.cleanup();
  });

  async function seedJob(values: Partial<typeof schema.jobs.$inferInsert>): Promise<string> {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `held-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user?.id, balance: 0 });

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user?.id, creditsCharged: 20, source: 'merchant_catalog', ...values })
      .returning();
    return job?.id as string;
  }

  async function statusOf(jobId: string): Promise<string> {
    const [row] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    return row?.status as string;
  }

  it('spares a job released seconds ago even though it was created days ago', async () => {
    const log = createLogger('test');

    const justReleased = await seedJob({
      status: 'QUEUED',
      createdAt: new Date(Date.now() - 3 * DAY),
      queuedAt: new Date(),
    });
    const stillHeld = await seedJob({
      status: 'HELD',
      createdAt: new Date(Date.now() - 3 * DAY),
    });
    const genuinelyOrphaned = await seedJob({
      status: 'QUEUED',
      createdAt: new Date(Date.now() - 3 * DAY),
    });

    await runSweeper(env.db, pub, log);

    expect(await statusOf(justReleased)).toBe('QUEUED');
    // HELD is not QUEUED and not in-flight — the sweeper must never touch it.
    expect(await statusOf(stillHeld)).toBe('HELD');
    // Control: without queued_at, a 3-day-old QUEUED job is still swept.
    expect(await statusOf(genuinelyOrphaned)).toBe('FAILED');
  });

  it('sweeps a released job once it exceeds the SLA measured from queued_at', async () => {
    const log = createLogger('test');

    const staleRelease = await seedJob({
      status: 'QUEUED',
      createdAt: new Date(Date.now() - 3 * DAY),
      queuedAt: new Date(Date.now() - 12 * MIN),
    });

    await runSweeper(env.db, pub, log);

    expect(await statusOf(staleRelease)).toBe('FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/dispatcher test -- sweeper-held-release`
Expected: FAIL — TypeScript/Drizzle error that `queuedAt` does not exist on the jobs insert type.

- [ ] **Step 3: Create the migration**

Create `packages/db/src/migrations/0137_jobs_queued_at.sql`:

```sql
-- When a bulk-flat batch is HELD, the job row is written immediately but only
-- enters the Redis stream when an admin releases it — potentially days later.
-- The dispatcher's stuck-job sweeper measures QUEUED staleness from created_at,
-- which would fail-and-refund a healthy job on the first tick after release.
-- queued_at records when the job actually entered the stream; the sweeper
-- prefers it over created_at. NULL for every job enqueued at creation time,
-- which preserves the existing behaviour exactly.
ALTER TABLE "jobs" ADD COLUMN "queued_at" timestamp with time zone;
```

- [ ] **Step 4: Register the migration in the journal**

In `packages/db/src/migrations/meta/_journal.json`, append to the `entries` array after the `0136_merchant_demo_data` object (mind the comma on the preceding `}`):

```json
    {
      "idx": 137,
      "version": "7",
      "when": 1785537600000,
      "tag": "0137_jobs_queued_at",
      "breakpoints": true
    }
```

- [ ] **Step 5: Add the column to the Drizzle schema**

In `packages/db/src/schema/jobs.ts`, replace:

```ts
  customerPhotoKey: text('customer_photo_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

with:

```ts
  customerPhotoKey: text('customer_photo_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Set only when a job enters the Redis stream later than it was created —
  // i.e. when an admin releases a HELD bulk-flat batch. NULL means "enqueued at
  // creation", so the sweeper falls back to created_at. See sweeper.ts.
  queuedAt: timestamp('queued_at', { withTimezone: true }),
```

- [ ] **Step 6: Teach the sweeper to prefer `queued_at`**

In `apps/dispatcher/src/stream/sweeper.ts`, replace:

```ts
    const staleness = sql`coalesce(${lastAttempt.lastAttemptAt}, ${schema.jobs.createdAt})`;
```

with:

```ts
    // queued_at is set only when a HELD job is released into the stream long
    // after creation; without it a batch released after days of holding would
    // look orphaned on the very next tick and be refunded out from under itself.
    const staleness = sql`coalesce(${lastAttempt.lastAttemptAt}, ${schema.jobs.queuedAt}, ${schema.jobs.createdAt})`;
```

- [ ] **Step 7: Apply the migration and run the tests**

Run:
```bash
pnpm db:migrate
pnpm --filter @tryme/dispatcher test -- sweeper-held-release
pnpm --filter @tryme/dispatcher test -- sweeper-video-sla
```
Expected: `pnpm db:migrate` applies `0137`; both test files PASS. The `sweeper-video-sla` run proves the coalesce change did not regress existing SLA behavior.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/migrations/0137_jobs_queued_at.sql packages/db/src/migrations/meta/_journal.json packages/db/src/schema/jobs.ts apps/dispatcher/src/stream/sweeper.ts apps/dispatcher/test/integration/sweeper-held-release.test.ts
git commit -m "feat(jobs): add queued_at so released HELD jobs aren't swept as orphans"
```

---

### Task 2: Hold bulk-flat jobs instead of enqueueing them

`createMerchantCatalogJob` gains an optional `hold` flag. When set: status `HELD`, `queueStream: 'low'` (released batches must never preempt live customer traffic), a `heldBatch: true` marker in `job_inputs.params` so the reconcile route in Task 4 can find them, and **no `XADD`**. Credits are still deducted inside the same transaction — unchanged.

`POST /v1/merchant/catalog/generate-bulk` then always holds. The single-item `POST /v1/merchant/catalog/generate` is deliberately left alone: it stays interactive because the merchant is waiting on-screen for it.

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts:41-51`, `:221-270`
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:911-921`
- Test: `apps/api/test/integration/merchant-catalog-bulk-hold.test.ts`

**Interfaces:**
- Consumes: `schema.jobs.queuedAt` from Task 1 (not written here — release writes it).
- Produces:
  - `createMerchantCatalogJob(app, params)` — `params` gains `hold?: boolean`. Return type is unchanged: `Promise<{ jobId: string }>`.
  - Held rows are identified everywhere downstream by `jobs.status = 'HELD'` and `job_inputs.params->>'heldBatch' = 'true'`. Tasks 3 and 4 both rely on exactly these two markers.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/merchant-catalog-bulk-hold.test.ts`. The seed helpers are copied from `apps/api/test/integration/merchant-catalog-generate.test.ts` (repeated rather than imported — that file exports nothing):

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

describe('merchant catalog bulk generate — held batches', () => {
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

  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:low');
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  async function seedEverything() {
    const genderSlug = 'women';

    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `regular-wf-${randomUUID()}`,
        label: 'Regular workflow',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `Pose ${randomUUID()}`,
        r2Key: 'poses/seed/pose.jpg',
        thumbnailKey: 'poses/seed/pose.thumb.jpg',
        genderSlug,
        workflowTemplateId: wf.id,
      })
      .returning();
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: genderSlug,
        label: `Face ${randomUUID()}`,
        r2Key: 'faces/seed/face.jpg',
        thumbnailKey: 'faces/seed/face.thumb.jpg',
      })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: `Bg ${randomUUID()}`,
        r2Key: 'bg/seed/bg.jpg',
        thumbnailKey: 'bg/seed/bg.thumb.jpg',
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug,
        slug: `type-${randomUUID()}`,
        label: 'Type',
        defaultPoseId: pose.id,
        requiresMannequinStep: true,
      })
      .returning();

    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { [genderSlug]: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const [merchantUser] = await app.db
      .insert(schema.users)
      .values({ email: `m-${randomUUID()}@test.com`, passwordHash: 'unused' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Merchant Co',
        contactName: 'Owner',
        phone: '9999999999',
        businessAddress: 'Test Street',
        isActive: true,
        userId: merchantUser.id,
      })
      .returning();
    await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: 0 });
    await app.db.insert(schema.userCredits).values({ userId: merchantUser.id, balance: 500 });

    const [subcategory] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.id,
        category: genderSlug,
        name: 'Kurtis',
        garmentSubcategoryId: garmentType.id,
      })
      .returning();

    const token = await signAccess(secret, merchantUser.id, { kind: 'access' }, '15m');
    return {
      auth: { authorization: `Bearer ${token}` },
      subcategoryId: subcategory.id,
      userId: merchantUser.id,
    };
  }

  async function presignFlat(auth: Record<string, string>) {
    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });
    return r2Key;
  }

  it('creates HELD jobs that never reach Redis, while still charging credits', async () => {
    const { auth, subcategoryId, userId } = await seedEverything();
    const keyA = await presignFlat(auth);
    const keyB = await presignFlat(auth);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate-bulk',
      headers: auth,
      payload: { subcategoryId, flatImageKeys: [keyA, keyB] },
    });

    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json() as { jobIds: string[] };
    expect(jobIds).toHaveLength(2);

    for (const jobId of jobIds) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('HELD');
      // Released batches ride the low lane so they never preempt live traffic.
      expect(job.queueStream).toBe('low');
      expect(job.queuedAt).toBeNull();

      const [input] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      expect((input.params as { heldBatch?: boolean }).heldBatch).toBe(true);
    }

    // Nothing was enqueued anywhere.
    expect(await app.redis.xlen('jobs:normal')).toBe(0);
    expect(await app.redis.xlen('jobs:low')).toBe(0);

    // Credits were still deducted at upload time.
    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBeLessThan(500);
  });

  it('leaves the single-item generate flow interactive (QUEUED + enqueued)', async () => {
    const { auth, subcategoryId } = await seedEverything();
    const key = await presignFlat(auth);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: key },
    });

    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(await app.redis.xlen('jobs:normal')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-bulk-hold`
Expected: FAIL — first test errors with `expected 'QUEUED' to be 'HELD'`.

- [ ] **Step 3: Add the `hold` flag to `createMerchantCatalogJob`**

In `apps/api/src/modules/merchant/create-job.ts`, replace the signature:

```ts
export async function createMerchantCatalogJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    category: string;
    flatImageKey: string;
    subcategoryId: string;
    merchantId: string;
  },
): Promise<{ jobId: string }> {
```

with:

```ts
export async function createMerchantCatalogJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    category: string;
    flatImageKey: string;
    subcategoryId: string;
    merchantId: string;
    // Bulk-flat batches are parked at status HELD and never enqueued here; an
    // admin releases every merchant's held jobs at once during free-GPU hours
    // (POST /admin/held-jobs/release). Credits are still deducted now, in the
    // same transaction, so a released batch can never fail for lack of balance.
    hold?: boolean;
  },
): Promise<{ jobId: string }> {
```

- [ ] **Step 4: Branch the insert and the enqueue**

Still in `apps/api/src/modules/merchant/create-job.ts`, replace the block that runs from `const jobId = randomUUID();` through the end of the `xadd` call, stopping just before `return { jobId };`.

**This file has two functions with an identical-looking block.** Edit the one in `createMerchantCatalogJob` — the first occurrence, around line 221, whose `jobInputs` insert sets `kind: 'merchant_catalog'`. Leave `createMerchantSareeMannequinJob` (second occurrence, `kind: 'saree_mannequin'`) completely untouched: the mobile saree flow is interactive and is not part of this feature.

Replace it with:

```ts
  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: params.hold ? 'HELD' : 'QUEUED',
      // Merchant-generated catalogue images are never watermarked, regardless of
      // the user's plan tier — merchants are paying customers of a distinct product.
      watermark: false,
      // A released batch is bulk backfill, not someone waiting on a screen — it
      // must never sit in front of live customer traffic.
      queueStream: params.hold ? 'low' : 'normal',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_CATALOG,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      lowerCatalogId: lowerItem?.id ?? null,
      shoeCatalogId: shoeItem?.id ?? null,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
        // The merchant's flatImageKey is always a raw, never-processed photo -
        // tells the dispatcher to run the mannequin compositing step inline
        // before the real generation. See apps/dispatcher/src/job/processor.ts's
        // requiresMannequinStep branch.
        needsMannequinStep: garmentType.requiresMannequinStep,
        // Marks the job for POST /v1/merchant/catalog/reconcile-held, which turns
        // it into a product row once it completes — the merchant is long gone by
        // then and cannot call /import themselves.
        ...(params.hold ? { heldBatch: true } : {}),
      },
    });
  });

  // Held jobs enter the stream only when an admin releases them.
  if (!params.hold) {
    await app.redis.xadd(
      'jobs:normal',
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      jobId,
      'userId',
      params.userId,
    );
  }
```

- [ ] **Step 5: Make the bulk route hold**

In `apps/api/src/modules/merchant/catalog.routes.ts`, inside the `/v1/merchant/catalog/generate-bulk` handler, replace:

```ts
          const { jobId } = await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
          });
```

with:

```ts
          const { jobId } = await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
            // Every bulk-flat batch is held for admin release — see Task 3's
            // POST /admin/held-jobs/release. The single-item /generate route
            // stays interactive because the merchant is waiting on it.
            hold: true,
          });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-bulk-hold`
Expected: both tests PASS.

Then run the existing generate suite to confirm the single-item path is untouched:

Run: `pnpm --filter @tryme/api test -- merchant-catalog-generate`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-bulk-hold.test.ts
git commit -m "feat(merchant): hold bulk-flat generate jobs instead of enqueueing them"
```

---

### Task 3: Admin held-queue view + global release

Two admin routes: one read (how many jobs are waiting, whose, and how old), one action (release everything). Release is global by design — the admin decides GPUs are free, and every merchant's backlog goes at once.

The release loop uses a status-guarded `UPDATE ... WHERE status = 'HELD'` per row so two admins double-clicking cannot enqueue the same job twice.

**Files:**
- Create: `apps/api/src/modules/admin/held-jobs.routes.ts`
- Modify: `apps/api/src/server.ts` (import + register)
- Modify: `packages/types/src/admin.ts` (append response schemas)
- Test: `apps/api/test/integration/admin-held-jobs.test.ts`

**Interfaces:**
- Consumes: `jobs.status = 'HELD'` and `schema.jobs.queuedAt` from Tasks 1–2.
- Produces:
  - `GET /admin/held-jobs` → `{ total: number, byUser: Array<{ userId: string | null, email: string | null, count: number, oldestCreatedAt: string }> }`
  - `POST /admin/held-jobs/release` → `{ released: number }`
  - Exported route plugin `adminHeldJobsRoutes(app: FastifyInstance): Promise<void>`
  - Zod schemas `AdminHeldJobsResponse` and `AdminHeldJobsReleaseResponse` from `@tryme/types`. Task 6 consumes both.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/admin-held-jobs.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin held jobs', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  beforeEach(async () => {
    await app.redis.del('jobs:low');
    await app.db.delete(schema.jobs);
  });

  async function seedHeldJob(email: string): Promise<{ jobId: string; userId: string }> {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash: 'x' })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId: user.id,
        status: 'HELD',
        queueStream: 'low',
        creditsCharged: 20,
        source: 'merchant_catalog',
      })
      .returning();
    return { jobId: job.id, userId: user.id };
  }

  it('reports the global held queue grouped by owning user', async () => {
    const a = await seedHeldJob(`held-a-${randomUUID()}@test.com`);
    await seedHeldJob(`held-b-${randomUUID()}@test.com`);
    // A non-held job must not be counted.
    await app.db.insert(schema.jobs).values({ userId: a.userId, status: 'QUEUED' });

    const res = await app.inject({ method: 'GET', url: '/admin/held-jobs', headers });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      byUser: Array<{ userId: string; count: number }>;
    };
    expect(body.total).toBe(2);
    expect(body.byUser).toHaveLength(2);
  });

  it('releases every held job across all merchants into jobs:low', async () => {
    const a = await seedHeldJob(`rel-a-${randomUUID()}@test.com`);
    const b = await seedHeldJob(`rel-b-${randomUUID()}@test.com`);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { released: number }).released).toBe(2);

    for (const { jobId } of [a, b]) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('QUEUED');
      // Stamped so the dispatcher's sweeper dates staleness from release, not creation.
      expect(job.queuedAt).toBeInstanceOf(Date);
    }

    expect(await app.redis.xlen('jobs:low')).toBe(2);
  });

  it('is idempotent — a second release enqueues nothing', async () => {
    await seedHeldJob(`idem-${randomUUID()}@test.com`);

    await app.inject({ method: 'POST', url: '/admin/held-jobs/release', headers });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers,
    });

    expect((second.json() as { released: number }).released).toBe(0);
    expect(await app.redis.xlen('jobs:low')).toBe(1);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/held-jobs/release' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-held-jobs`
Expected: FAIL — all routes 404.

- [ ] **Step 3: Add the response schemas**

Append to `packages/types/src/admin.ts`:

```ts
export const AdminHeldJobsResponse = z.object({
  total: z.number().int(),
  byUser: z.array(
    z.object({
      userId: z.string().uuid().nullable(),
      email: z.string().nullable(),
      count: z.number().int(),
      oldestCreatedAt: z.string(),
    }),
  ),
});
export type AdminHeldJobsResponse = z.infer<typeof AdminHeldJobsResponse>;

export const AdminHeldJobsReleaseResponse = z.object({
  released: z.number().int(),
});
export type AdminHeldJobsReleaseResponse = z.infer<typeof AdminHeldJobsReleaseResponse>;
```

If `packages/types/src/admin.ts` does not already import zod at the top, add `import { z } from 'zod';` as its first line.

- [ ] **Step 4: Write the routes**

Create `apps/api/src/modules/admin/held-jobs.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './guard.js';

/**
 * Bulk-flat catalogue jobs are parked at status HELD at upload time (credits
 * already deducted) and only enter the Redis stream when an admin decides GPU
 * capacity is free. Release is deliberately global: one button drains every
 * merchant's backlog at once, rather than per-merchant scheduling.
 */
export async function adminHeldJobsRoutes(app: FastifyInstance) {
  app.get(
    '/admin/held-jobs',
    { preHandler: requireAdmin(['SUPER_ADMIN', 'ADMIN']) },
    async () => {
      const rows = await app.db
        .select({
          userId: schema.jobs.userId,
          email: schema.users.email,
          count: count(),
          oldestCreatedAt: sql<string>`min(${schema.jobs.createdAt})`,
        })
        .from(schema.jobs)
        .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
        .where(eq(schema.jobs.status, 'HELD'))
        .groupBy(schema.jobs.userId, schema.users.email);

      return {
        total: rows.reduce((sum, row) => sum + row.count, 0),
        byUser: rows,
      };
    },
  );

  app.post(
    '/admin/held-jobs/release',
    { preHandler: requireAdmin(['SUPER_ADMIN', 'ADMIN']) },
    async (req) => {
      const held = await app.db
        .select({ id: schema.jobs.id, userId: schema.jobs.userId })
        .from(schema.jobs)
        .where(eq(schema.jobs.status, 'HELD'));

      const now = new Date();
      let released = 0;
      for (const job of held) {
        // Status-guarded so two admins releasing at the same moment cannot
        // enqueue the same job twice — the loser's UPDATE matches no rows.
        const [claimed] = await app.db
          .update(schema.jobs)
          .set({ status: 'QUEUED', queuedAt: now })
          .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'HELD')))
          .returning({ id: schema.jobs.id });
        if (!claimed) continue;

        await app.redis.xadd(
          'jobs:low',
          'MAXLEN',
          '~',
          10000,
          '*',
          'jobId',
          job.id,
          'userId',
          job.userId ?? '',
        );
        released++;
      }

      req.log.info({ released }, 'released held bulk-flat jobs');
      return { released };
    },
  );
}
```

- [ ] **Step 5: Register the routes**

In `apps/api/src/server.ts`, add the import alongside the other admin imports (alphabetical — between `adminDevApiRoutes` and `adminJobsRoutes`):

```ts
import { adminHeldJobsRoutes } from './modules/admin/held-jobs.routes.js';
```

Then register it next to the other admin route registrations (search for `adminJobsRoutes` in the `app.register` block and add immediately before it):

```ts
  await app.register(adminHeldJobsRoutes);
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @tryme/api test -- admin-held-jobs`
Expected: all four tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/held-jobs.routes.ts apps/api/src/server.ts packages/types/src/admin.ts apps/api/test/integration/admin-held-jobs.test.ts
git commit -m "feat(admin): held-job queue view and global release endpoint"
```

---

### Task 4: Reconcile completed held jobs into pending products

Nobody is watching when a released batch finishes, so the client-side `/import` call the interactive flow uses can never fire. This route sweeps the merchant's own completed held jobs and materializes each into a `merchant_catalog_items` row — `isActive: false`, so it is invisible to the kiosk until details are filled in (Task 5).

Idempotency comes free from the existing partial unique index `merchant_catalog_items_merchant_source_job_unique` on `(merchant_id, source_job_id)`; `copyJobOutputIntoProduct` already maps its `23505` violation to a 409, which this route swallows.

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:14` (imports), `:59-124` (`copyJobOutputIntoProduct`), and append a new route before the closing `}` of `merchantCatalogRoutes`
- Test: `apps/api/test/integration/merchant-catalog-reconcile-held.test.ts`

**Interfaces:**
- Consumes: the `heldBatch: true` marker written in Task 2.
- Produces:
  - `POST /v1/merchant/catalog/reconcile-held` → `{ created: MerchantCatalogItem[] }`
  - `copyJobOutputIntoProduct` gains `isActive?: boolean` (defaults `true`, preserving the existing `/import` behavior).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/merchant-catalog-reconcile-held.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('merchant catalog reconcile-held', () => {
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

  async function seedMerchantWithCompletedHeldJob() {
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-${randomUUID()}`,
        label: 'wf',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `Pose ${randomUUID()}`,
        r2Key: 'poses/p.jpg',
        thumbnailKey: 'poses/p.thumb.jpg',
        genderSlug: 'women',
        workflowTemplateId: wf.id,
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `type-${randomUUID()}`,
        label: 'Type',
        defaultPoseId: pose.id,
      })
      .returning();

    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `rec-${randomUUID()}@test.com`, passwordHash: 'x' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Co',
        contactName: 'Owner',
        phone: '9999999999',
        businessAddress: 'Street',
        isActive: true,
        userId: user.id,
      })
      .returning();
    await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: 0 });
    const [subcategory] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.id,
        category: 'women',
        name: 'Kurtis',
        garmentSubcategoryId: garmentType.id,
      })
      .returning();

    // A completed, released, held job with a real object in storage.
    const resultKey = `results/${randomUUID()}.jpg`;
    await app.storage.putObject(resultKey, Buffer.from('result'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'COMPLETED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'flat/source.jpg',
      params: { kind: 'merchant_catalog', subcategoryId: subcategory.id, heldBatch: true },
    });
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey });

    const token = await signAccess(secret, user.id, { kind: 'access' }, '15m');
    return {
      auth: { authorization: `Bearer ${token}` },
      jobId: job.id,
      subcategoryId: subcategory.id,
    };
  }

  it('creates an inactive product row for each completed held job', async () => {
    const { auth, jobId } = await seedMerchantWithCompletedHeldJob();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const { created } = res.json() as { created: Array<{ id: string }> };
    expect(created).toHaveLength(1);

    const [item] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.sourceJobId, jobId));
    // Invisible to the kiosk until the merchant fills in SKU + prices.
    expect(item.isActive).toBe(false);
    expect(item.sourceKind).toBe('generated');
    expect(item.flatSourceKey).toBe('flat/source.jpg');
    expect(item.actualPricePaise).toBe(0);
  });

  it('is idempotent — a second call creates nothing new', async () => {
    const { auth } = await seedMerchantWithCompletedHeldJob();

    await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    expect((second.json() as { created: unknown[] }).created).toHaveLength(0);
  });

  it('keeps the pending product out of the kiosk catalog', async () => {
    const { auth } = await seedMerchantWithCompletedHeldJob();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    const rows = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.isActive, true));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-reconcile-held`
Expected: FAIL — route 404s.

- [ ] **Step 3: Let `copyJobOutputIntoProduct` create inactive rows**

In `apps/api/src/modules/merchant/catalog.routes.ts`, add `isActive` to the params type — replace:

```ts
    sourceKind: 'imported' | 'generated';
    flatSourceKey?: string;
    label?: string;
  },
): Promise<MerchantCatalogRow> {
```

with:

```ts
    sourceKind: 'imported' | 'generated';
    flatSourceKey?: string;
    label?: string;
    // Held-batch products land inactive: nobody was on screen to give them a
    // SKU or a price, and the kiosk query filters on isActive. Defaults true so
    // the interactive /import path is unchanged.
    isActive?: boolean;
  },
): Promise<MerchantCatalogRow> {
```

Then, in the same function, replace:

```ts
        sourceJobId: params.job.id,
        sourceKind: params.sourceKind,
        flatSourceKey: params.flatSourceKey ?? null,
      })
```

with:

```ts
        sourceJobId: params.job.id,
        sourceKind: params.sourceKind,
        flatSourceKey: params.flatSourceKey ?? null,
        isActive: params.isActive ?? true,
      })
```

- [ ] **Step 4: Add `isNull` to the drizzle imports**

In `apps/api/src/modules/merchant/catalog.routes.ts`, replace:

```ts
import { and, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
```

with:

```ts
import { and, count, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
```

- [ ] **Step 5: Add the reconcile route**

In `apps/api/src/modules/merchant/catalog.routes.ts`, append this route immediately before the final closing `}` of `export async function merchantCatalogRoutes(app: FastifyInstance) {`:

```ts
  /**
   * Materializes completed held-batch jobs into products. The interactive
   * generate flow finalizes each job from the browser via /import, but a held
   * batch completes hours or days after the merchant closed the app — so the
   * app calls this on load instead. Rows land isActive=false; PATCHing in a SKU
   * and prices is what publishes them to the kiosk.
   */
  app.post(
    '/v1/merchant/catalog/reconcile-held',
    { preHandler: app.requireMerchant },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const rows = await app.db
        .select({
          jobId: schema.jobs.id,
          catalogueId: schema.jobs.catalogueId,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
          flatKey: schema.jobInputs.upperGarmentKey,
          params: schema.jobInputs.params,
        })
        .from(schema.jobs)
        .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .leftJoin(
          schema.merchantCatalogItems,
          eq(schema.merchantCatalogItems.sourceJobId, schema.jobs.id),
        )
        .where(
          and(
            eq(schema.jobs.userId, client.userId),
            eq(schema.jobs.status, 'COMPLETED'),
            sql`${schema.jobInputs.params}->>'heldBatch' = 'true'`,
            isNull(schema.merchantCatalogItems.id),
          ),
        )
        .limit(200);

      const created: Awaited<ReturnType<typeof serializeCatalogItem>>[] = [];
      for (const row of rows) {
        const subcategoryId = (row.params as { subcategoryId?: string } | null)?.subcategoryId;
        if (!row.resultKey || !subcategoryId) continue;
        try {
          const item = await copyJobOutputIntoProduct(app, {
            merchantId,
            subcategoryId,
            job: { id: row.jobId, catalogueId: row.catalogueId },
            resultKey: row.resultKey,
            thumbnailKey: row.thumbnailKey,
            sourceKind: 'generated',
            flatSourceKey: row.flatKey ?? undefined,
            isActive: false,
          });
          created.push(await serializeCatalogItem(app, item));
        } catch (err) {
          // 409 = another concurrent reconcile already claimed this job.
          if (err instanceof AppError && err.statusCode === 409) continue;
          app.log.warn({ err, jobId: row.jobId }, 'reconcile-held: failed to finalize job');
        }
      }

      return { created };
    },
  );
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-reconcile-held`
Expected: all three tests PASS.

Then confirm the interactive import path still creates active rows:

Run: `pnpm --filter @tryme/api test -- merchant-catalog`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-reconcile-held.test.ts
git commit -m "feat(merchant): reconcile completed held jobs into inactive pending products"
```

---

### Task 5: Publish a pending product when its details are completed

A pending row is recognizable: `isActive=false`, `sourceKind='generated'`, and both prices still ₹0 — a state only the reconcile route produces. When a PATCH supplies a non-empty SKU and both prices, that row is complete and goes live. Everything else — a merchant deliberately deactivating a product, editing an already-published one, or explicitly sending `isActive` — is left alone.

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:561-604` (the PATCH handler)
- Test: `apps/api/test/integration/merchant-catalog-publish-pending.test.ts`

**Interfaces:**
- Consumes: inactive `sourceKind='generated'` rows from Task 4.
- Produces: no new route or type — `PATCH /v1/merchant/catalog/:id` gains the auto-activate behavior. Task 8's frontend relies on it and sends no `isActive` field.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/merchant-catalog-publish-pending.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('merchant catalog — publishing a pending held-batch product', () => {
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

  async function seed(itemOverrides: Partial<typeof schema.merchantCatalogItems.$inferInsert>) {
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-${randomUUID()}`,
        label: 'wf',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `Pose ${randomUUID()}`,
        r2Key: 'poses/p.jpg',
        thumbnailKey: 'poses/p.thumb.jpg',
        genderSlug: 'women',
        workflowTemplateId: wf.id,
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `type-${randomUUID()}`,
        label: 'Type',
        defaultPoseId: pose.id,
      })
      .returning();
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `pub-${randomUUID()}@test.com`, passwordHash: 'x' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Co',
        contactName: 'Owner',
        phone: '9999999999',
        businessAddress: 'Street',
        isActive: true,
        userId: user.id,
      })
      .returning();
    await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: 0 });
    const [subcategory] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.id,
        category: 'women',
        name: 'Kurtis',
        garmentSubcategoryId: garmentType.id,
      })
      .returning();
    const [item] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        merchantId: merchant.id,
        subcategoryId: subcategory.id,
        label: 'Job abcd1234',
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: `merchant/${randomUUID()}.jpg`,
        thumbnailKey: `merchant/${randomUUID()}.thumb.jpg`,
        sourceKind: 'generated',
        isActive: false,
        ...itemOverrides,
      })
      .returning();

    const token = await signAccess(secret, user.id, { kind: 'access' }, '15m');
    return { auth: { authorization: `Bearer ${token}` }, itemId: item.id };
  }

  it('activates a pending product once SKU and both prices are supplied', async () => {
    const { auth, itemId } = await seed({});

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { label: 'Product SH-1', sku: 'SH-1', actualPrice: 1200, offerPrice: 999 },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(true);
    expect(row.actualPricePaise).toBe(120000);
  });

  it('leaves a pending product inactive when the SKU is still missing', async () => {
    const { auth, itemId } = await seed({});

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { actualPrice: 1200, offerPrice: 999 },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });

  it('does not resurrect a product the merchant deliberately deactivated', async () => {
    // Already published once (prices set), then switched off by the merchant.
    const { auth, itemId } = await seed({
      isActive: false,
      sku: 'OLD-1',
      actualPricePaise: 50000,
      offerPricePaise: 45000,
    });

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { sku: 'OLD-1', actualPrice: 600, offerPrice: 550 },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });

  it('respects an explicit isActive in the body', async () => {
    const { auth, itemId } = await seed({});

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { sku: 'SH-2', actualPrice: 800, offerPrice: 700, isActive: false },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-publish-pending`
Expected: FAIL — the first test reports `expected false to be true`.

- [ ] **Step 3: Add the auto-activate branch to the PATCH handler**

In `apps/api/src/modules/merchant/catalog.routes.ts`, inside the `PATCH /v1/merchant/catalog/:id` handler, replace:

```ts
      const [updated] = await app.db
        .update(schema.merchantCatalogItems)
        .set({
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
```

with:

```ts
      const [existing] = await app.db
        .select()
        .from(schema.merchantCatalogItems)
        .where(
          and(
            eq(schema.merchantCatalogItems.id, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!existing) throw new AppError('NOT_FOUND', 404, 'catalog item not found');

      // A held-batch product is materialized inactive with ₹0 prices and no SKU
      // (see /reconcile-held). Filling those in is what publishes it to the
      // kiosk. The ₹0 test is what distinguishes it from a product the merchant
      // priced and then deliberately switched off — that one stays off.
      const isPendingHeldProduct =
        !existing.isActive &&
        existing.sourceKind === 'generated' &&
        existing.actualPricePaise === 0 &&
        existing.offerPricePaise === 0;
      const completesDetails =
        !!body.sku?.trim() && body.actualPrice !== undefined && body.offerPrice !== undefined;
      const autoActivate =
        isPendingHeldProduct && completesDetails && body.isActive === undefined;

      const [updated] = await app.db
        .update(schema.merchantCatalogItems)
        .set({
          ...(autoActivate ? { isActive: true } : {}),
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
```

The `autoActivate` spread goes first so an explicit `body.isActive` later in the same object literal always wins.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-publish-pending`
Expected: all four tests PASS.

- [ ] **Step 5: Run the whole merchant catalog suite for regressions**

Run:
```bash
pnpm --filter @tryme/api test -- merchant-catalog
pnpm --filter @tryme/api test -- kiosk
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-publish-pending.test.ts
git commit -m "feat(merchant): publish a pending held-batch product when SKU and prices are filled in"
```

---

### Task 6: Admin held-batch queue page

A page under Operations showing the total held count, a per-merchant breakdown with the oldest upload date, and one Release button. Deliberately plain — it exists so an admin can glance at the backlog and drain it.

**Files:**
- Create: `apps/admin-web/src/pages/HeldBatchesPage.tsx`
- Modify: `apps/admin-web/src/App.tsx` (import, `PATH_LABELS`, `<Route>`)
- Modify: `apps/admin-web/src/components/Sidebar.tsx` (Operations group)

**Interfaces:**
- Consumes: `GET /admin/held-jobs` and `POST /admin/held-jobs/release` from Task 3, and `apiFetch<T>(path, init?)` from `apps/admin-web/src/lib/data.ts`.
- Produces: default-exported `HeldBatchesPage` component taking `{ toast }` from the shared `pageProps`.

- [ ] **Step 1: Write the page**

Create `apps/admin-web/src/pages/HeldBatchesPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';

interface HeldByUser {
  userId: string | null;
  email: string | null;
  count: number;
  oldestCreatedAt: string;
}

interface HeldJobsResponse {
  total: number;
  byUser: HeldByUser[];
}

export default function HeldBatchesPage({
  toast,
}: {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}) {
  const [data, setData] = useState<HeldJobsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReleasing, setIsReleasing] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(await apiFetch<HeldJobsResponse>('/admin/held-jobs'));
    } catch (e) {
      toast({ kind: 'error', title: 'Failed to load held batches', body: apiErrorMessage(e) });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async () => {
    setIsReleasing(true);
    try {
      const { released } = await apiFetch<{ released: number }>('/admin/held-jobs/release', {
        method: 'POST',
      });
      toast({ title: `Released ${released} job${released === 1 ? '' : 's'} to the GPU queue` });
      await load();
    } catch (e) {
      toast({ kind: 'error', title: 'Release failed', body: apiErrorMessage(e) });
    } finally {
      setIsReleasing(false);
    }
  };

  const total = data?.total ?? 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Held Batches</h1>
          <p className="muted">
            Bulk flat-image uploads waiting for GPU time. Releasing sends every merchant&apos;s
            backlog to the low-priority queue at once.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={isReleasing || total === 0}
          onClick={() => void release()}
        >
          {isReleasing ? 'Releasing…' : `Release all (${total})`}
        </button>
      </div>

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : total === 0 ? (
        <p className="muted">Nothing is held right now.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Merchant</th>
              <th>Held images</th>
              <th>Oldest upload</th>
            </tr>
          </thead>
          <tbody>
            {data?.byUser.map((row) => (
              <tr key={row.userId ?? 'unknown'}>
                <td>{row.email ?? '(unknown)'}</td>
                <td>{row.count}</td>
                <td>{new Date(row.oldestCreatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

If `apps/admin-web/src/pages/WorkersPage.tsx` uses different class names for its page shell, table, or buttons, match those instead — the point is that this page looks like its neighbors, not that it uses these exact strings.

- [ ] **Step 2: Wire the route**

In `apps/admin-web/src/App.tsx`, add the import between `DevApiPage` and `JobsPage`:

```tsx
import HeldBatchesPage from './pages/HeldBatchesPage';
```

Add to `PATH_LABELS`, after the `jobs` entry:

```tsx
  'held-batches': 'Held Batches',
```

Add the route immediately after the `/jobs` route:

```tsx
            <Route path="/held-batches" element={<HeldBatchesPage {...pageProps} />} />
```

- [ ] **Step 3: Add the sidebar entry**

In `apps/admin-web/src/components/Sidebar.tsx`, inside the `Operations` group's `items` array, add immediately after the `jobs` item:

```tsx
      {
        k: 'held-batches',
        label: 'Held Batches',
        icon: Icon.Jobs,
        roles: ['SUPER_ADMIN', 'ADMIN'],
      },
```

- [ ] **Step 4: Typecheck and lint**

Run:
```bash
pnpm --filter @tryme/admin build
pnpm lint
```
Expected: both succeed. If `apiErrorMessage` is not exported from `../lib/data`, check its actual name with `grep -n "export.*apiErrorMessage\|export.*errorMessage" apps/admin-web/src/lib/data.ts` and use that.

- [ ] **Step 5: Verify in the running app**

Run: `pnpm --filter @tryme/admin dev`, log in, open **Operations → Held Batches**.
Expected: the page renders with "Nothing is held right now." (no held jobs seeded yet), and the Release button is disabled.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/HeldBatchesPage.tsx apps/admin-web/src/App.tsx apps/admin-web/src/components/Sidebar.tsx
git commit -m "feat(admin-web): held batches queue page with global release"
```

---

### Task 7: Bulk catalogue-image upload mode

The bulk-upload screen gains the same Catalogue / Flat toggle `ProductForm` already has. Catalogue mode needs no generation at all: each queued file gets SKU and price inputs straight away, and saving uploads image + thumbnail per item and POSTs `/v1/merchant/catalog`.

**Files:**
- Modify: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx`

**Interfaces:**
- Consumes: `presignAndUpload(file, kind)` and `deleteProduct(id)` from `apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts`; `POST /v1/merchant/catalog` (`MerchantCatalogCreateBody`).
- Produces: `QueueItem['status']` gains `'uploaded'` — the catalogue-mode analogue of `'generated'` (details editable, ready to save, but no job and no server row yet). Task 8 assumes this union member exists.

- [ ] **Step 1: Add the mode state and widen the status union**

In `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx`, replace:

```tsx
interface QueueItem {
  id: string;
  file: File;
  fileUrl: string;
  status: 'queued' | 'uploading' | 'generating' | 'generated' | 'failed';
```

with:

```tsx
interface QueueItem {
  id: string;
  file: File;
  fileUrl: string;
  // 'uploaded' is catalogue mode's counterpart to 'generated': the merchant
  // supplied a finished product photo, so there is nothing to generate and the
  // detail fields open immediately. No server row exists until Save.
  status: 'queued' | 'uploading' | 'generating' | 'generated' | 'uploaded' | 'failed';
```

Then, after the `const [items, setItems] = useState<QueueItem[]>([]);` line, add both the mode state and the derived "ready to save" status that the rest of this task keys off:

```tsx
  const [imageMode, setImageMode] = useState<'catalogue' | 'flat'>('catalogue');
  // Which status means "details editable, ready to save" in the current mode.
  const readyStatus = imageMode === 'catalogue' ? 'uploaded' : 'generated';
```

- [ ] **Step 2: Open the detail fields immediately in catalogue mode**

Replace the `processFiles` function:

```tsx
  const processFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: generateId(),
        file,
        fileUrl: URL.createObjectURL(file),
        status: 'queued',
        sku: '',
        actualPrice: '',
        offerPrice: '',
        hasError: false,
      }));
    setItems((prev) => [...prev, ...newItems]);
  };
```

with:

```tsx
  const processFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files)
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({
        id: generateId(),
        file,
        fileUrl: URL.createObjectURL(file),
        // Catalogue images are already final — no generate step to wait through.
        status: imageMode === 'catalogue' ? 'uploaded' : 'queued',
        sku: '',
        actualPrice: '',
        offerPrice: '',
        hasError: false,
      }));
    setItems((prev) => [...prev, ...newItems]);
  };
```

- [ ] **Step 3: Add the catalogue-mode save path**

Replace the whole `handleAddCatalogue` function with a version that branches on mode:

```tsx
  const handleAddCatalogue = async () => {
    let hasValidationError = false;
    const validated = items.map((item) => {
      if (item.status !== readyStatus) return item;
      const act = parseInt(item.actualPrice, 10) || 0;
      const off = parseInt(item.offerPrice, 10) || 0;
      const isValid =
        item.sku.trim() !== '' && item.actualPrice !== '' && item.offerPrice !== '' && off <= act;
      if (!isValid) hasValidationError = true;
      return { ...item, hasError: !isValid };
    });
    setItems(validated);
    if (hasValidationError) return;

    const ready = validated.filter((i) => i.status === readyStatus);
    if (ready.length === 0) return;

    setIsSaving(true);
    setSaveError(undefined);
    try {
      if (imageMode === 'catalogue') {
        // No job, no generation — upload each finished photo and create the row.
        await Promise.all(
          ready.map(async (item) => {
            const [{ r2Key }, { r2Key: thumbnailKey }] = await Promise.all([
              presignAndUpload(item.file, 'image'),
              presignAndUpload(item.file, 'thumbnail'),
            ]);
            await api.post('/v1/merchant/catalog', {
              subcategoryId,
              r2Key,
              thumbnailKey,
              label: `Product ${item.sku.trim().toUpperCase()}`,
              sku: item.sku.trim(),
              actualPrice: parseInt(item.actualPrice, 10),
              offerPrice: parseInt(item.offerPrice, 10),
            });
          }),
        );
      } else {
        await Promise.all(
          ready
            .filter((i): i is QueueItem & { itemId: string } => !!i.itemId)
            .map((item) =>
              api.patch(`/v1/merchant/catalog/${item.itemId}`, {
                label: `Product ${item.sku.toUpperCase()}`,
                sku: item.sku.trim(),
                actualPrice: parseInt(item.actualPrice, 10),
                offerPrice: parseInt(item.offerPrice, 10),
              }),
            ),
        );
      }
      qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
      qc.invalidateQueries({ queryKey: ['merchant-catalog-subcategories'] });
      goBackToProducts();
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Failed to save some items. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };
```

- [ ] **Step 4: Make the derived counters and the JSX guards mode-aware**

Replace:

```tsx
  const hasQueued = items.some((i) => i.status === 'queued');
  const hasGenerated = items.some((i) => i.status === 'generated');
  const generatedCount = items.filter((i) => i.status === 'generated').length;
```

with:

```tsx
  const hasQueued = items.some((i) => i.status === 'queued');
  const hasGenerated = items.some((i) => i.status === readyStatus);
  const generatedCount = items.filter((i) => i.status === readyStatus).length;
```

(`isAnyGenerating` on the next line stays exactly as it is — `'uploading'` and `'generating'` are flat-mode-only states.)

Then update the JSX, which currently tests `item.status === 'generated'` in three places:

1. The per-card detail-input block (`{item.status === 'generated' && (` wrapping the SKU and price inputs) → change to `{item.status === readyStatus && (`.
2. The "✓ Generated" badge → change to `{item.status === readyStatus && (` and make the text mode-aware: `{imageMode === 'catalogue' ? '✓ Ready' : '✓ Generated'}`.
3. The `hasGenerated &&` guard around the "Set price for all" row already reads from the updated `hasGenerated`, so it needs no edit.

**Leave the two cleanup conditions alone.** In the unmount `useEffect` and in `handleRemoveItem`, `item.status === 'generated' && item.itemId` must keep testing the literal `'generated'`: only flat-mode items have a server-side product row to `deleteProduct`. A catalogue-mode `'uploaded'` item exists purely in browser state until Save, so calling `deleteProduct` for one would be a no-op at best.

- [ ] **Step 5: Render the mode toggle**

Immediately after the opening `<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>`, insert:

```tsx
        <div
          style={{
            display: 'flex',
            borderRadius: 8,
            border: `1px solid ${C.border2}`,
            overflow: 'hidden',
            background: C.white,
          }}
        >
          <button
            type="button"
            onClick={() => setImageMode('catalogue')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'catalogue' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'catalogue' ? C.pink : C.text,
              fontWeight: imageMode === 'catalogue' ? 600 : 500,
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
              borderRight: `1px solid ${C.border2}`,
            }}
          >
            Catalogue Images
          </button>
          <button
            type="button"
            onClick={() => setImageMode('flat')}
            disabled={busy || items.length > 0}
            style={{
              flex: 1,
              padding: '12px 16px',
              border: 'none',
              background: imageMode === 'flat' ? 'rgba(245, 92, 122, 0.08)' : 'transparent',
              color: imageMode === 'flat' ? C.pink : C.text,
              fontWeight: imageMode === 'flat' ? 600 : 500,
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: busy || items.length > 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Flat Images
          </button>
        </div>
```

The toggle locks once files are queued — switching mode mid-queue would strand items in the wrong lifecycle.

- [ ] **Step 6: Hide the Generate All control in catalogue mode**

Replace:

```tsx
              <GradBtn type="button" onClick={handleGenerateAll} disabled={!hasQueued || busy}>
                {isGeneratingAll && <SpinnerIcon size={14} />}
                {isGeneratingAll ? 'Generating…' : 'Generate All'}
              </GradBtn>
```

with:

```tsx
              {imageMode === 'flat' && (
                <GradBtn type="button" onClick={handleGenerateAll} disabled={!hasQueued || busy}>
                  {isGeneratingAll && <SpinnerIcon size={14} />}
                  {isGeneratingAll ? 'Sending…' : 'Send for Processing'}
                </GradBtn>
              )}
```

Also update the upload prompt copy — replace `Tap to choose flat images` with:

```tsx
            {imageMode === 'catalogue' ? 'Tap to choose product photos' : 'Tap to choose flat images'}
```

- [ ] **Step 7: Typecheck and verify in the app**

Run:
```bash
pnpm --filter @tryme/web build
```
Expected: build succeeds.

Then run `pnpm --filter @tryme/web dev`, log in as a merchant, open a subcategory → Bulk Upload, keep **Catalogue Images** selected, add two photos, fill SKU + prices, and press "Add 2 to Catalogue".
Expected: both products appear in the subcategory list immediately, priced, with no generation step.

- [ ] **Step 8: Commit**

```bash
git add "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx"
git commit -m "feat(tryon-library): bulk catalogue-image upload mode"
```

---

### Task 8: Fire-and-forget flat batches + pending products in the app

Flat mode can no longer poll — the jobs sit `HELD` until an admin releases them, which may be days. So "Send for Processing" uploads, calls `generate-bulk`, and confirms. Separately, the products screen calls `reconcile-held` on mount so finished batches materialize, and marks pending (inactive, ₹0) products so the merchant knows to complete them.

**Files:**
- Modify: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx`
- Modify: `apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts`
- Modify: `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/page.tsx`
- Modify: `apps/catalogues-web/src/app/tryon-library-app/components/ProductCard.tsx`
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: `POST /v1/merchant/catalog/generate-bulk` (Task 2), `POST /v1/merchant/catalog/reconcile-held` (Task 4), and auto-activate on PATCH (Task 5).
- Produces: `reconcileHeldProducts(): Promise<{ created: MerchantCatalogItem[] }>` exported from `catalog-app-helpers.ts`.

- [ ] **Step 1: Add the reconcile helper**

Append to `apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts`:

```ts
/**
 * Materializes any bulk-flat batches that finished while the merchant was away.
 * Held batches run whenever an admin releases them, so there is no in-page poll
 * to finalize them — the products screen calls this on mount instead. Rows come
 * back inactive until the merchant fills in SKU and prices.
 */
export function reconcileHeldProducts(): Promise<{ created: MerchantCatalogItem[] }> {
  return api
    .post<{ created: MerchantCatalogItem[] }>('/v1/merchant/catalog/reconcile-held', {})
    .catch(() => ({ created: [] }));
}
```

- [ ] **Step 2: Stop polling held batches**

In `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx`, replace the tail of `handleGenerateAll` — everything from `if (jobIds.length > 0) {` through the closing of the `try/catch` and the final `setIsGeneratingAll(false);` — with:

```tsx
    // Held batches run only when an admin releases them, so there is nothing to
    // poll here. The images land in the products list (marked "Needs details")
    // once generation finishes — see reconcileHeldProducts on that screen.
    setItems((prev) =>
      prev.map((p) => (jobIdByLocalId.get(p.id) ? { ...p, status: 'generating' } : p)),
    );
    setIsGeneratingAll(false);
    setSentForProcessing(jobIds.length);
```

Add the new state next to the other `useState` declarations:

```tsx
  const [sentForProcessing, setSentForProcessing] = useState(0);
```

Then remove `pollGenerateBatch` and `finalizeGeneratedProduct` from the import block at the top of the file if nothing else references them (`finalizeCompletedJob` and its `finalizingJobIds` ref become dead and should be deleted too).

- [ ] **Step 3: Show the confirmation**

Immediately before the `{saveError && (` block in the JSX, insert:

```tsx
        {sentForProcessing > 0 && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: C.lighter,
              border: `1px solid ${C.border}`,
              fontSize: 13,
              color: C.text,
              lineHeight: 1.4,
            }}
          >
            {sentForProcessing} image{sentForProcessing === 1 ? '' : 's'} sent for processing.
            They&apos;re queued for the next processing window — you&apos;ll find them in this
            category once they&apos;re ready, waiting for SKU and pricing.
          </div>
        )}
```

- [ ] **Step 4: Reconcile on the products screen**

In `apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/page.tsx`, add the import:

```tsx
import { reconcileHeldProducts } from '../../catalog-app-helpers';
```

Then, after the existing products query is declared, add:

```tsx
  // Pull in any held batches that finished while the merchant was away.
  useEffect(() => {
    let cancelled = false;
    void reconcileHeldProducts().then(({ created }) => {
      if (cancelled || created.length === 0) return;
      qc.invalidateQueries({ queryKey: ['merchant-catalog-products', subcategoryId] });
    });
    return () => {
      cancelled = true;
    };
  }, [qc, subcategoryId]);
```

Match the file's existing names for the query client (`qc`) and the route param (`subcategoryId`); if they differ, use the local ones. Add `useEffect` to the `react` import if it is not already there.

- [ ] **Step 5: Flag pending products**

In `apps/catalogues-web/src/app/tryon-library-app/components/ProductCard.tsx`, inside the card's image container (alongside any existing overlay badge), add:

```tsx
      {!item.isActive && item.actualPrice === 0 && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            left: 6,
            background: C.pink,
            color: C.white,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
            textTransform: 'uppercase',
          }}
        >
          Needs details
        </div>
      )}
```

If the image container is not already `position: 'relative'`, set it. Confirm the prop holding the item is named `item`; if it is `product`, use that.

- [ ] **Step 6: Typecheck and verify end-to-end**

Run:
```bash
pnpm --filter @tryme/web build
pnpm typecheck
```
Expected: both succeed.

Then, with `pnpm docker:up`, the API, the dispatcher, and both web apps running:
1. In the try-on library app, bulk-upload 2 flat images → expect the "sent for processing" confirmation, and no progress spinner.
2. In the admin panel, open **Operations → Held Batches** → expect a count of 2 → press Release.
3. Once the dispatcher finishes both jobs, reload the subcategory in the library app → expect 2 products tagged **Needs details** at ₹0.
4. Open one, fill in SKU + prices, save.
5. Query the kiosk catalog (`GET /v1/kiosk/catalog` with a kiosk device token) → expect only the completed product, not the still-pending one.

- [ ] **Step 7: Update the progress log**

Add a new dated entry at the top of `docs/progress.md`:

```markdown
## 2026-08-01 — Bulk upload: catalogue images + admin-held flat batches

**Done**
- `jobs.queued_at` (migration 0137) so the dispatcher sweeper dates QUEUED staleness from release, not creation — without it every released batch was fail-and-refunded on the next tick.
- New `jobs.status` value `HELD`. `createMerchantCatalogJob(..., { hold: true })` deducts credits and writes the job/inputs rows as usual but skips the `XADD`; `POST /v1/merchant/catalog/generate-bulk` now always holds. Single-item `/generate` stays interactive.
- `GET /admin/held-jobs` + `POST /admin/held-jobs/release` — global, status-guarded release into `jobs:low`. Admin page at Operations → Held Batches.
- `POST /v1/merchant/catalog/reconcile-held` materializes completed held jobs into `isActive: false` products; `PATCH /v1/merchant/catalog/:id` publishes one when a SKU and both prices are supplied.
- Bulk upload screen gained a Catalogue / Flat toggle: catalogue mode uploads finished photos directly (no job), flat mode is fire-and-forget.

**Failed / Not Done**
- No way for a merchant to cancel or refund a held batch before release; credits are deducted at upload.
- No notification when a batch completes — the merchant discovers it by opening the app.

**Open Questions / Decisions**
- Decided: credits deduct at upload (keeps the deduct+insert transaction invariant, and a released batch can never fail for lack of balance).
- Decided: release is manual-only. A scheduled off-peak window was considered and deferred.
- Open: should released batches get their own queue lane rather than sharing `jobs:low` with other low-priority work?
```

- [ ] **Step 8: Commit**

```bash
git add "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/bulk-upload/page.tsx" apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts "apps/catalogues-web/src/app/tryon-library-app/subcategory/[id]/page.tsx" apps/catalogues-web/src/app/tryon-library-app/components/ProductCard.tsx docs/progress.md
git commit -m "feat(tryon-library): fire-and-forget held flat batches with pending-product reconcile"
```

---

## Notes for the implementer

**Why `HELD` needs no migration.** `jobs.status` is plain `text` in Drizzle, and `packages/db/src/migrations/0119_drop_jobs_status_check.sql` dropped the out-of-band production CHECK constraint that used to reject new status values. Adding `HELD` is therefore a code-only change. The one thing that *did* need a migration is `queued_at` (Task 1).

**Why the sweeper needs no `HELD` exclusion.** `runSweeper` pass 1 filters `status = 'QUEUED'` and pass 2 filters `IN_FLIGHT_STATES = ['PREPROCESSING','GENERATING','UPLOADING']`. `HELD` matches neither, so held jobs are already immune. Task 1's test asserts this so a future refactor cannot quietly break it.

**Why release targets `jobs:low`.** The GPU consumer reads `jobs:priority | jobs:normal | jobs:low`. A released backlog is bulk backfill; if an admin ever releases during business hours it must queue behind live customer traffic.

**Credits are never refunded for an unreleased batch.** Deduction happens at upload. If a merchant uploads and the admin never releases, the credits stay spent. This is a deliberate consequence of the credit-timing decision, not an oversight — a cancel/refund path is listed as not-done in the progress entry.
