# Tryon Media Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically delete a customer's AI Virtual Try-On (Beta) photo and generated result from R2 after an admin-configurable window (5 min–1 week, default 24h), without ever touching studio/saree/shopify catalogue images.

**Architecture:** One new nullable `jobs.mediaPurgedAt` column marks a job as swept. A new dispatcher-side interval sweeper (`apps/dispatcher/src/stream/media-retention-sweeper.ts`), wired next to the existing stuck-job sweeper in `apps/dispatcher/src/index.ts`, polls every 1 minute, reads the current retention threshold from the same `config:system` Redis blob the admin panel already edits, and best-effort deletes only a `tryon` job's own private data (its generated result + the customer's uploaded person photo) — never the garment reference, which is actually a copy of another job's retained catalogue output. Two API routes get a defensive guard so a purged job returns `410` instead of a broken image link.

**Tech Stack:** Drizzle ORM/Postgres, ioredis, Fastify 5, `@tryme/storage` (R2/S3), Vitest integration tests against the existing docker-compose Postgres/Redis/MinIO, React (admin-web Settings page).

**Spec:** `docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md`

---

### Task 1: `jobs.mediaPurgedAt` column + migration

**Files:**
- Modify: `packages/db/src/schema/jobs.ts:47-49`

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/jobs.ts`, find:

```ts
  customerPhotoKey: text('customer_photo_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
```

Replace with:

```ts
  customerPhotoKey: text('customer_photo_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Set by the dispatcher's tryon media-retention sweeper once a 'tryon' job's
  // result/person-photo R2 objects have been deleted for privacy. Null = not
  // yet purged (or not a 'tryon' job — every other source keeps its media
  // forever). See docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md.
  mediaPurgedAt: timestamp('media_purged_at', { withTimezone: true }),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`

Expected: a new file `packages/db/src/migrations/01NN_<adjective>_<name>.sql` (next index after whatever `ls packages/db/src/migrations | grep -E '^[0-9]{4}_' | sort | tail -1` currently shows — 0105 at the time this plan was written) containing:

```sql
ALTER TABLE "jobs" ADD COLUMN "media_purged_at" timestamp with time zone;
```

Verify with: `cat packages/db/src/migrations/01NN_*.sql` (substitute the actual generated filename) and confirm it matches the `ALTER TABLE` statement above, with no other unrelated statements. If drizzle-kit swept in unrelated pending schema drift, stop and check with the user before proceeding — do not silently include unrelated changes.

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm db:migrate`

Expected: output includes the new migration's hash being applied (no "already exists" errors for this specific column).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(db): add jobs.mediaPurgedAt for tryon media retention"
```

---

### Task 2: Shared retention constants + admin config validation

**Files:**
- Modify: `packages/types/src/jobs.ts` (after `SIMPLE_TRYON_COST`, currently line 84)
- Modify: `packages/types/src/admin.ts:1,92-96`

- [ ] **Step 1: Add the shared bounds/default constants**

In `packages/types/src/jobs.ts`, find:

```ts
/** Fallback default — the actual charged cost is admin-configurable, see getTryonCreditCost(). */
export const SIMPLE_TRYON_COST = 5;
```

Replace with:

```ts
/** Fallback default — the actual charged cost is admin-configurable, see getTryonCreditCost(). */
export const SIMPLE_TRYON_COST = 5;

// How long a 'tryon' job's result + uploaded person photo survive in R2 before
// the dispatcher's media-retention sweeper deletes them (privacy — see
// docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md). Shared
// between apps/api (admin config validation/defaults) and apps/dispatcher
// (the sweeper itself), which cannot import from each other directly.
export const MIN_TRYON_MEDIA_RETENTION_MINUTES = 5;
export const MAX_TRYON_MEDIA_RETENTION_MINUTES = 10_080; // 1 week
export const DEFAULT_TRYON_MEDIA_RETENTION_MINUTES = 1_440; // 24h
```

- [ ] **Step 2: Validate the new admin-config field**

In `packages/types/src/admin.ts`, find the top import:

```ts
import { z } from 'zod';
```

Replace with:

```ts
import { z } from 'zod';
import { MAX_TRYON_MEDIA_RETENTION_MINUTES, MIN_TRYON_MEDIA_RETENTION_MINUTES } from './jobs.js';
```

Then find:

```ts
  tryon: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
    })
    .optional(),
});
```

Replace with:

```ts
  tryon: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
      mediaRetentionMinutes: z
        .number()
        .int()
        .min(MIN_TRYON_MEDIA_RETENTION_MINUTES)
        .max(MAX_TRYON_MEDIA_RETENTION_MINUTES)
        .optional(),
    })
    .optional(),
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/jobs.ts packages/types/src/admin.ts
git commit -m "feat(types): add tryon media retention bounds + SystemConfigBody field"
```

---

### Task 3: API defaults + `/admin/config` merge fix + test

The existing `GET /admin/config` handler does `cfg.tryon = cfg.tryon ?? DEFAULT_TRYON_CONFIG;` — a **whole-object** fallback. Any environment that already has `config:system.tryon = { creditCost: N }` saved (very likely, since this field is actively used in the admin Settings page) would keep returning that object as-is, silently omitting the new `mediaRetentionMinutes` default forever. This task fixes that to a field-level merge.

**Files:**
- Modify: `apps/api/src/lib/resolution-config.ts:1,17-19`
- Modify: `apps/api/src/modules/admin/config.routes.ts:27-33`
- Test: `apps/api/test/integration/admin-config-tryon-retention.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/admin-config-tryon-retention.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin config — tryon media retention', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('defaults mediaRetentionMinutes to 1440 when unset', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const res = await app.inject({ method: 'GET', url: '/admin/config', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().tryon.mediaRetentionMinutes).toBe(1440);
  });

  it('accepts the min (5) and max (10080) boundary values', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const minRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { tryon: { creditCost: 5, mediaRetentionMinutes: 5 } },
    });
    expect(minRes.statusCode).toBe(200);
    expect(minRes.json().tryon.mediaRetentionMinutes).toBe(5);

    const maxRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { tryon: { creditCost: 5, mediaRetentionMinutes: 10080 } },
    });
    expect(maxRes.statusCode).toBe(200);
    expect(maxRes.json().tryon.mediaRetentionMinutes).toBe(10080);
  });

  it('rejects values outside [5, 10080]', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const tooLow = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { tryon: { creditCost: 5, mediaRetentionMinutes: 4 } },
    });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { tryon: { creditCost: 5, mediaRetentionMinutes: 10081 } },
    });
    expect(tooHigh.statusCode).toBe(400);
  });

  it('keeps mediaRetentionMinutes defaulted when only creditCost is patched', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { tryon: { creditCost: 7 } },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers });
    const tryon = getRes.json().tryon;
    expect(tryon.creditCost).toBe(7);
    expect(tryon.mediaRetentionMinutes).toBe(1440);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root — `apps/api`'s plain `test`/`test:unit` scripts exclude `test/integration/**`, so integration tests must be run against the dedicated config explicitly): `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/admin-config-tryon-retention.test.ts --reporter=verbose`

Expected: FAIL — `tryon.mediaRetentionMinutes` is `undefined` (default not yet wired), and the boundary-value PATCH requests fail differently since the field isn't validated/persisted yet.

- [ ] **Step 3: Wire the default into `DEFAULT_TRYON_CONFIG`**

In `apps/api/src/lib/resolution-config.ts`, find:

```ts
import { RESOLUTION_COSTS, type Resolution, SIMPLE_TRYON_COST } from '@tryme/types';
```

Replace with:

```ts
import {
  DEFAULT_TRYON_MEDIA_RETENTION_MINUTES,
  RESOLUTION_COSTS,
  type Resolution,
  SIMPLE_TRYON_COST,
} from '@tryme/types';
```

Then find:

```ts
export const DEFAULT_TRYON_CONFIG: { creditCost: number } = {
  creditCost: SIMPLE_TRYON_COST,
};
```

Replace with:

```ts
export const DEFAULT_TRYON_CONFIG: { creditCost: number; mediaRetentionMinutes: number } = {
  creditCost: SIMPLE_TRYON_COST,
  mediaRetentionMinutes: DEFAULT_TRYON_MEDIA_RETENTION_MINUTES,
};
```

- [ ] **Step 4: Fix the GET handler to merge instead of whole-object-fallback**

In `apps/api/src/modules/admin/config.routes.ts`, find:

```ts
      const raw = await app.redis.get(KEY);
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.resolutions = cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG;
      cfg.maxOutputPx = cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
      cfg.tryon = cfg.tryon ?? DEFAULT_TRYON_CONFIG;
      return cfg;
```

Replace with:

```ts
      const raw = await app.redis.get(KEY);
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.resolutions = cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG;
      cfg.maxOutputPx = cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
      // Field-level merge, not `cfg.tryon ?? DEFAULT_TRYON_CONFIG` — an env that
      // already saved { creditCost } without mediaRetentionMinutes must still get
      // the new field's default instead of permanently missing it.
      cfg.tryon = { ...DEFAULT_TRYON_CONFIG, ...(cfg.tryon ?? {}) };
      return cfg;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/admin-config-tryon-retention.test.ts --reporter=verbose`

Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/resolution-config.ts apps/api/src/modules/admin/config.routes.ts apps/api/test/integration/admin-config-tryon-retention.test.ts
git commit -m "feat(api): add tryon media retention to admin config, fix default merge"
```

---

### Task 4: Fix dispatcher integration tests never loading `.env`

Same class of bug already fixed for `apps/api` this session (commit `3a516e0`): `apps/dispatcher/vitest.integration.config.ts` has no `setupFiles`, so `test/helpers/containers.ts`'s `process.env.POSTGRES_PORT ?? '5432'` silently falls back to the wrong port on machines (like this one) where the docker Postgres isn't on the default 5432. This must be fixed **before** Task 5's integration test, or that test will fail with a confusing auth error instead of a real assertion failure.

**Files:**
- Modify: `apps/dispatcher/package.json`
- Create: `apps/dispatcher/test/setup-env.ts`
- Modify: `apps/dispatcher/vitest.config.ts`
- Modify: `apps/dispatcher/vitest.integration.config.ts`

- [ ] **Step 1: Add `dotenv` as a dev dependency**

In `apps/dispatcher/package.json`, find:

```json
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.10",
    "tsx": "^4.11.0",
```

Replace with:

```json
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.10",
    "dotenv": "^17.4.2",
    "tsx": "^4.11.0",
```

Run: `pnpm install`

Expected: lockfile updates, `dotenv` linked into `apps/dispatcher/node_modules`.

- [ ] **Step 2: Create the setup file**

Create `apps/dispatcher/test/setup-env.ts`:

```ts
import { resolve } from 'node:path';
import { config } from 'dotenv';

// Vitest doesn't load .env automatically (unlike `tsx --env-file=` used by dev/start
// scripts) — without this, test/helpers/containers.ts falls back to hardcoded defaults
// (e.g. POSTGRES_PORT=5432) instead of this machine's actual local config. Only fills
// in vars not already set, so an explicit shell export still wins.
config({ path: resolve(process.cwd(), '../../.env') });
```

- [ ] **Step 3: Wire it into both vitest configs**

In `apps/dispatcher/vitest.config.ts`, find:

```ts
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['src/**/*.test.ts'],
```

Replace with:

```ts
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./test/setup-env.ts'],
    include: ['src/**/*.test.ts'],
```

In `apps/dispatcher/vitest.integration.config.ts`, find:

```ts
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['test/integration/**/*.test.ts'],
```

Replace with:

```ts
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./test/setup-env.ts'],
    include: ['test/integration/**/*.test.ts'],
```

- [ ] **Step 4: Verify with a clean shell**

Run (in a shell with no `POSTGRES_PORT`/`DATABASE_URL` manually exported): `pnpm --filter @tryme/dispatcher exec vitest run --config vitest.integration.config.ts test/integration/recovery.test.ts --reporter=verbose`

Expected: the test's `beforeAll` (Postgres `CREATE DATABASE`) succeeds without a connection/auth error. (The test itself may still fail on unrelated pre-existing field-name drift — see the `modelCatalogId`/`poseCatalogId` note in `recovery.test.ts`; that's a known pre-existing issue, not something this step introduces. Only the *connection* needs to succeed here.)

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/package.json pnpm-lock.yaml apps/dispatcher/test/setup-env.ts apps/dispatcher/vitest.config.ts apps/dispatcher/vitest.integration.config.ts
git commit -m "fix(dispatcher): load .env in vitest so integration tests hit the right Postgres port"
```

---

### Task 5: The sweeper itself

**Files:**
- Create: `apps/dispatcher/src/stream/media-retention-sweeper.ts`
- Test: `apps/dispatcher/test/integration/media-retention-sweeper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/dispatcher/test/integration/media-retention-sweeper.test.ts`:

```ts
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredTryonMedia } from '../../src/stream/media-retention-sweeper.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const log = createLogger('test');

async function putObject(env: TestEnv, key: string): Promise<void> {
  await env.s3.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket,
      Key: key,
      Body: Buffer.from('x'),
      ContentType: 'image/jpeg',
    }),
  );
}

async function objectExists(env: TestEnv, key: string): Promise<boolean> {
  try {
    await env.s3.send(new HeadObjectCommand({ Bucket: env.r2Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

describe('purgeExpiredTryonMedia', () => {
  let env: TestEnv;
  let redis: Redis;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis(env.redisUrl);
  }, 60_000);

  afterAll(async () => {
    await redis.del('config:system');
    redis.disconnect();
    await env.cleanup();
  });

  async function seedTryonJob(opts: {
    status: 'COMPLETED' | 'FAILED';
    ageMs: number;
    withOutput: boolean;
  }) {
    const email = `sweeper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
    const [user] = await env.db.insert(schema.users).values({ email, tier: 'free' }).returning();
    const when = new Date(Date.now() - opts.ageMs);

    const [job] = await env.db
      .insert(schema.jobs)
      .values({
        userId: user?.id,
        status: opts.status,
        priority: false,
        creditsCharged: 1,
        source: 'tryon',
        createdAt: when,
        completedAt: opts.status === 'COMPLETED' ? when : null,
      })
      .returning();
    const jobId = job?.id as string;

    const garmentKey = `outputs/other-job-${jobId}.jpg`; // stands in for keys.output(sourceJobId)
    const personKey = `inputs/${jobId}/garment.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: garmentKey,
      params: { personKey, workflowTemplateId: '00000000-0000-0000-0000-000000000000', sourceJobId: '00000000-0000-0000-0000-000000000000' },
    });
    await putObject(env, garmentKey);
    await putObject(env, personKey);

    let resultKey: string | null = null;
    let thumbnailKey: string | null = null;
    if (opts.withOutput) {
      resultKey = `outputs/${jobId}.jpg`;
      thumbnailKey = `outputs/${jobId}.thumb.jpg`;
      await env.db.insert(schema.jobOutputs).values({ jobId, resultKey, thumbnailKey });
      await putObject(env, resultKey);
      await putObject(env, thumbnailKey);
    }

    return { jobId, garmentKey, personKey, resultKey, thumbnailKey };
  }

  it('purges result, thumbnail, and person photo for an eligible completed job, keeps the garment reference and the row', async () => {
    await redis.set('config:system', JSON.stringify({ tryon: { mediaRetentionMinutes: 5 } }));
    const { jobId, garmentKey, personKey, resultKey, thumbnailKey } = await seedTryonJob({
      status: 'COMPLETED',
      ageMs: 2 * 60 * 60 * 1000, // 2h old — past the 5-min threshold
      withOutput: true,
    });

    await purgeExpiredTryonMedia(env.db, redis, env.storage, log);

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.mediaPurgedAt).toBeTruthy();

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output?.resultKey).toBeNull();
    expect(output?.thumbnailKey).toBeNull();

    const [input] = await env.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((input?.params as Record<string, unknown> | null)?.personKey).toBeUndefined();
    expect(input?.upperGarmentKey).toBe(garmentKey);

    expect(await objectExists(env, resultKey as string)).toBe(false);
    expect(await objectExists(env, thumbnailKey as string)).toBe(false);
    expect(await objectExists(env, personKey)).toBe(false);
    // The garment reference is a copy of ANOTHER job's retained output — never deleted.
    expect(await objectExists(env, garmentKey)).toBe(true);
  });

  it('does not touch a job younger than the retention window', async () => {
    await redis.set('config:system', JSON.stringify({ tryon: { mediaRetentionMinutes: 1440 } }));
    const { jobId, resultKey } = await seedTryonJob({
      status: 'COMPLETED',
      ageMs: 60 * 1000, // 1 minute old — well inside the 24h threshold
      withOutput: true,
    });

    await purgeExpiredTryonMedia(env.db, redis, env.storage, log);

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.mediaPurgedAt).toBeNull();
    expect(await objectExists(env, resultKey as string)).toBe(true);
  });

  it('purges a FAILED job\'s person photo even with no job_outputs row', async () => {
    await redis.set('config:system', JSON.stringify({ tryon: { mediaRetentionMinutes: 5 } }));
    const { jobId, personKey } = await seedTryonJob({
      status: 'FAILED',
      ageMs: 2 * 60 * 60 * 1000,
      withOutput: false,
    });

    await purgeExpiredTryonMedia(env.db, redis, env.storage, log);

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.mediaPurgedAt).toBeTruthy();
    expect(await objectExists(env, personKey)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/dispatcher exec vitest run --config vitest.integration.config.ts test/integration/media-retention-sweeper.test.ts --reporter=verbose`

Expected: FAIL — `Cannot find module '../../src/stream/media-retention-sweeper.js'`.

- [ ] **Step 3: Implement the sweeper**

Create `apps/dispatcher/src/stream/media-retention-sweeper.ts`:

```ts
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import type { StorageProvider } from '@tryme/storage';
import {
  DEFAULT_TRYON_MEDIA_RETENTION_MINUTES,
  MAX_TRYON_MEDIA_RETENTION_MINUTES,
  MIN_TRYON_MEDIA_RETENTION_MINUTES,
} from '@tryme/types';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

const CONFIG_KEY = 'config:system';
// Matches the stuck-job sweeper's own batch cap (stream/sweeper.ts) — bounds how
// much work one tick does against a large historical backlog on first deploy.
const BATCH_SIZE = 50;

/**
 * Reads the admin-configured tryon media retention window from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config).
 * Re-read on every sweep tick so a config change takes effect on the next
 * tick without a dispatcher restart. Clamped defensively in case a stale or
 * malformed value ever makes it into Redis outside the validated PATCH route.
 */
async function getRetentionMinutes(redis: Redis): Promise<number> {
  try {
    const raw = await redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const n = cfg.tryon?.mediaRetentionMinutes;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return DEFAULT_TRYON_MEDIA_RETENTION_MINUTES;
    }
    return Math.min(MAX_TRYON_MEDIA_RETENTION_MINUTES, Math.max(MIN_TRYON_MEDIA_RETENTION_MINUTES, n));
  } catch {
    return DEFAULT_TRYON_MEDIA_RETENTION_MINUTES;
  }
}

interface EligibleJob {
  id: string;
  resultKey: string | null;
  thumbnailKey: string | null;
  personKey: string | null;
}

/**
 * Deletes the R2 objects a 'tryon' job privately owns (its generated result +
 * the customer's uploaded person photo) once they're older than the admin-
 * configured retention window. Never touches `job_inputs.upperGarmentKey` —
 * for a tryon job that's a copy of ANOTHER job's (usually catalog) retained
 * output, not this job's own upload. See
 * docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md.
 */
export async function purgeExpiredTryonMedia(
  db: DB,
  redis: Redis,
  storage: StorageProvider,
  log: Logger,
): Promise<void> {
  const retentionMinutes = await getRetentionMinutes(redis);
  const threshold = new Date(Date.now() - retentionMinutes * 60_000);

  let eligible: EligibleJob[];
  try {
    eligible = await db
      .select({
        id: schema.jobs.id,
        resultKey: schema.jobOutputs.resultKey,
        thumbnailKey: schema.jobOutputs.thumbnailKey,
        personKey: sql<string | null>`${schema.jobInputs.params}->>'personKey'`,
      })
      .from(schema.jobs)
      .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .where(
        and(
          eq(schema.jobs.source, 'tryon'),
          isNull(schema.jobs.mediaPurgedAt),
          inArray(schema.jobs.status, ['COMPLETED', 'FAILED']),
          lte(
            sql`coalesce(${schema.jobs.completedAt}, ${schema.jobs.createdAt})`,
            sql`${threshold.toISOString()}`,
          ),
        ),
      )
      .limit(BATCH_SIZE);
  } catch (err) {
    log.error({ err }, 'failed to query expired tryon media');
    return;
  }

  if (eligible.length === 0) return;
  log.info({ count: eligible.length, retentionMinutes }, 'purging expired tryon media');

  for (const job of eligible) {
    await purgeJob(db, storage, job, log);
  }
}

/** Idempotent by S3/R2 semantics — deleting an already-absent key is not an error. */
async function deleteIfPresent(
  storage: StorageProvider,
  key: string | null,
  log: Logger,
): Promise<boolean> {
  if (!key) return true;
  try {
    await storage.deleteObject(key);
    return true;
  } catch (err) {
    log.warn({ err, key }, 'failed to delete tryon media object — will retry next sweep');
    return false;
  }
}

/**
 * Only clears the DB columns (and marks mediaPurgedAt) if every attempted R2
 * delete for this job succeeded — a partial failure leaves the job untouched
 * so the next tick retries it, instead of losing track of an object that
 * failed to delete.
 */
async function purgeJob(
  db: DB,
  storage: StorageProvider,
  job: EligibleJob,
  log: Logger,
): Promise<void> {
  const [resultOk, thumbOk, personOk] = await Promise.all([
    deleteIfPresent(storage, job.resultKey, log),
    deleteIfPresent(storage, job.thumbnailKey, log),
    deleteIfPresent(storage, job.personKey, log),
  ]);

  if (!resultOk || !thumbOk || !personOk) return;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.jobOutputs)
        .set({ resultKey: null, thumbnailKey: null })
        .where(eq(schema.jobOutputs.jobId, job.id));
      await tx
        .update(schema.jobInputs)
        .set({ params: sql`${schema.jobInputs.params} - 'personKey'` })
        .where(eq(schema.jobInputs.jobId, job.id));
      await tx
        .update(schema.jobs)
        .set({ mediaPurgedAt: new Date() })
        .where(eq(schema.jobs.id, job.id));
    });
  } catch (err) {
    log.error({ err, jobId: job.id }, 'failed to record tryon media purge');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/dispatcher exec vitest run --config vitest.integration.config.ts test/integration/media-retention-sweeper.test.ts --reporter=verbose`

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Typecheck**

`apps/dispatcher/package.json` has no `typecheck` script (build emits via `tsc -p tsconfig.json`), so check directly with `--noEmit`:

Run: `pnpm --filter @tryme/dispatcher exec tsc -p tsconfig.json --noEmit`

Expected: no output, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dispatcher/src/stream/media-retention-sweeper.ts apps/dispatcher/test/integration/media-retention-sweeper.test.ts
git commit -m "feat(dispatcher): add tryon media retention sweeper"
```

---

### Task 6: Wire the sweeper into the dispatcher process

**Files:**
- Modify: `apps/dispatcher/src/index.ts:23,127-136,142-143`

- [ ] **Step 1: Import it**

In `apps/dispatcher/src/index.ts`, find:

```ts
import { runSweeper } from './stream/sweeper.js';
```

Replace with:

```ts
import { purgeExpiredTryonMedia } from './stream/media-retention-sweeper.js';
import { runSweeper } from './stream/sweeper.js';
```

- [ ] **Step 2: Start the interval**

Find:

```ts
  const sweeperInterval = setInterval(
    () => {
      void runSweeper(db, pub, log);
    },
    5 * 60 * 1000,
  );

  const recoveryInterval = setInterval(() => {
    void recoverPendingJobs(redis, processorCfg, env.XPENDING_CLAIM_THRESHOLD_MS, log);
  }, 60_000);
```

Replace with:

```ts
  const sweeperInterval = setInterval(
    () => {
      void runSweeper(db, pub, log);
    },
    5 * 60 * 1000,
  );

  const recoveryInterval = setInterval(() => {
    void recoverPendingJobs(redis, processorCfg, env.XPENDING_CLAIM_THRESHOLD_MS, log);
  }, 60_000);

  // Purge expired tryon media (privacy) — polls every 1 min, well under the
  // 5-min configurable retention floor, so admin config changes apply promptly.
  const mediaRetentionInterval = setInterval(() => {
    void purgeExpiredTryonMedia(db, redis, storage, log);
  }, 60_000);
```

- [ ] **Step 3: Clear it on shutdown**

Find:

```ts
    clearInterval(sweeperInterval);
    clearInterval(recoveryInterval);
```

Replace with:

```ts
    clearInterval(sweeperInterval);
    clearInterval(recoveryInterval);
    clearInterval(mediaRetentionInterval);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/dispatcher exec tsc -p tsconfig.json --noEmit`

Expected: no output, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/index.ts
git commit -m "feat(dispatcher): wire tryon media retention sweeper into startup"
```

---

### Task 7: Guard `/v1/jobs/:id/result` and `/thumbnail` against purged media

**Files:**
- Modify: `apps/api/src/modules/jobs/routes.ts:480-524`
- Test: `apps/api/test/integration/jobs-result-purged.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/jobs-result-purged.test.ts`:

```ts
import { schema } from '@tryme/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUserToken } from '../helpers/auth.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('purged tryon media — result/thumbnail routes', () => {
  let c: Containers;
  let app: TestApp;
  let s3: S3Client;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    s3 = new S3Client({
      endpoint: c.r2Endpoint,
      region: 'auto',
      credentials: { accessKeyId: c.r2Key, secretAccessKey: c.r2Secret },
      forcePathStyle: true,
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedJob(opts: { mediaPurgedAt: Date | null }) {
    const email = `purged-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
    const { token, userId } = await createVerifiedUserToken(app, email);
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        status: 'COMPLETED',
        priority: false,
        creditsCharged: 1,
        source: 'tryon',
        completedAt: new Date(),
        mediaPurgedAt: opts.mediaPurgedAt,
      })
      .returning();
    const jobId = job?.id as string;
    await app.db.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: `outputs/other-${jobId}.jpg`,
    });
    return { token, jobId };
  }

  it('returns 410 from /result once media has been purged', async () => {
    const { token, jobId } = await seedJob({ mediaPurgedAt: new Date() });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(410);
  });

  it('returns 410 from /thumbnail once media has been purged', async () => {
    const { token, jobId } = await seedJob({ mediaPurgedAt: new Date() });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/thumbnail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(410);
  });

  it('still returns 200 from /result for a normal, non-purged completed job', async () => {
    const { token, jobId } = await seedJob({ mediaPurgedAt: null });
    await s3.send(
      new PutObjectCommand({
        Bucket: c.r2Bucket,
        Key: `outputs/${jobId}.jpg`,
        Body: Buffer.from('x'),
        ContentType: 'image/jpeg',
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/jobs-result-purged.test.ts --reporter=verbose`

Expected: FAIL — the first two tests get `200` instead of `410` (route doesn't check `mediaPurgedAt` yet).

- [ ] **Step 3: Add the guard to both routes**

In `apps/api/src/modules/jobs/routes.ts`, find:

```ts
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');
      const { url, expiresIn } = await app.storage.presignGet(keys.output(id), 3600);
      return { url, expiresIn };
    },
  );

  app.get(
    '/v1/jobs/:id/thumbnail',
```

Replace with:

```ts
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');
      if (job.mediaPurgedAt) throw new AppError('MEDIA_PURGED', 410, 'media no longer available');
      const { url, expiresIn } = await app.storage.presignGet(keys.output(id), 3600);
      return { url, expiresIn };
    },
  );

  app.get(
    '/v1/jobs/:id/thumbnail',
```

Then find:

```ts
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');

      const [output] = await app.db
        .select({ thumbnailKey: schema.jobOutputs.thumbnailKey })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));
```

Replace with:

```ts
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');
      if (job.mediaPurgedAt) throw new AppError('MEDIA_PURGED', 410, 'media no longer available');

      const [output] = await app.db
        .select({ thumbnailKey: schema.jobOutputs.thumbnailKey })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));
```

(Both `job` lookups already `.select()` the full `jobs` row, so `job.mediaPurgedAt` is available with no query changes.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/jobs-result-purged.test.ts --reporter=verbose`

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/jobs/routes.ts apps/api/test/integration/jobs-result-purged.test.ts
git commit -m "fix(api): return 410 from result/thumbnail routes once tryon media is purged"
```

---

### Task 8: Admin Settings UI field

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx:387,406,414,439,1070-1108,1199-1204`

- [ ] **Step 1: Add state**

Find:

```tsx
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
```

Replace with:

```tsx
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
  const [tryonMediaRetentionMinutes, setTryonMediaRetentionMinutes] = useState(1440);
```

- [ ] **Step 2: Load it from `/admin/config`**

Find:

```tsx
      tryon?: { creditCost: number };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
        if (cfg.tryon) setTryonCreditCost(cfg.tryon.creditCost);
      })
```

Replace with:

```tsx
      tryon?: { creditCost: number; mediaRetentionMinutes?: number };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
        if (cfg.tryon) {
          setTryonCreditCost(cfg.tryon.creditCost);
          if (cfg.tryon.mediaRetentionMinutes) {
            setTryonMediaRetentionMinutes(cfg.tryon.mediaRetentionMinutes);
          }
        }
      })
```

- [ ] **Step 3: Save it**

Find:

```tsx
          tryon: { creditCost: tryonCreditCost },
```

Replace with:

```tsx
          tryon: { creditCost: tryonCreditCost, mediaRetentionMinutes: tryonMediaRetentionMinutes },
```

- [ ] **Step 4: Render the field**

Find:

```tsx
                      <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        credits / try-on
                      </span>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Merchant Catalogue Defaults
                  </div>
```

Replace with:

```tsx
                      <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        credits / try-on
                      </span>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Try-On Media Retention
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    How long a customer's AI Virtual Try-On (Beta) photo and generated result stay
                    in storage before being permanently deleted for privacy. Does not affect
                    studio catalogue, saree, or Shopify images.
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
                      min={5}
                      max={10080}
                      style={{ width: 100 }}
                      value={tryonMediaRetentionMinutes}
                      disabled={sysSaving}
                      onChange={(e) => setTryonMediaRetentionMinutes(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>minutes</span>
                  </div>
                </div>

                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Merchant Catalogue Defaults
                  </div>
```

- [ ] **Step 5: Validate before save**

Find:

```tsx
                    disabled={
                      sysSaving ||
                      !Number.isInteger(maxOutputPx) ||
                      maxOutputPx < 512 ||
                      maxOutputPx > 4096
                    }
```

Replace with:

```tsx
                    disabled={
                      sysSaving ||
                      !Number.isInteger(maxOutputPx) ||
                      maxOutputPx < 512 ||
                      maxOutputPx > 4096 ||
                      !Number.isInteger(tryonMediaRetentionMinutes) ||
                      tryonMediaRetentionMinutes < 5 ||
                      tryonMediaRetentionMinutes > 10080
                    }
```

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm --filter @tryme/admin exec tsc -b --noEmit`

Expected: no errors.

Run: `npx biome check apps/admin-web/src/pages/SettingsPage.tsx`

Expected: no errors (or auto-fixable formatting only — if so, run `npx biome check --write apps/admin-web/src/pages/SettingsPage.tsx` and confirm the diff is whitespace-only).

- [ ] **Step 7: Manual check**

Start the admin dev server (`pnpm --filter @tryme/admin dev`), open Settings, confirm the new "Try-On Media Retention" field appears below "Virtual Try-On Pricing", loads `1440` by default, rejects/disables Save for values outside 5–10080, and persists across a page reload after Save.

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add tryon media retention field to system settings"
```

---

### Task 9: Update progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top**

Prepend to `docs/progress.md`:

```markdown
## 2026-07-13 - Tryon Media Retention (privacy auto-delete)

### Done
- Added `jobs.mediaPurgedAt` and a new dispatcher sweeper (`apps/dispatcher/src/stream/media-retention-sweeper.ts`) that deletes an "AI Virtual Try-On (Beta)" job's generated result and the customer's uploaded person photo from R2 once older than an admin-configurable window — never the garment reference, which is a copy of another (retained) job's catalogue output.
- Scope is strictly `jobs.source = 'tryon'` — studio/saree/shopify catalogue images are never touched.
- New admin setting: Settings → Try-On Media Retention, 5–10080 minutes, default 1440 (24h), stored in the existing `config:system` blob under `tryon.mediaRetentionMinutes`.
- Sweeper polls every 1 minute and re-reads the config each tick, so admin changes apply without a dispatcher restart.
- `GET /v1/jobs/:id/result` and `/thumbnail` now return `410` once a job's media has been purged, instead of a presigned URL for a deleted object.
- Fixed a pre-existing gap where `apps/dispatcher`'s vitest integration config never loaded `.env` (same class of bug fixed for `apps/api` on 2026-07-13 in commit `3a516e0`), which would have silently pointed this work's own tests at the wrong local Postgres port.
- Spec: `docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md`. Plan: `docs/superpowers/plans/2026-07-13-tryon-media-retention.md`.

### Failed / Not Done
- Kiosk jobs' `jobs.customerPhotoKey` (a different, real customer-photo field on a separate flow) is explicitly out of scope for this pass — noted as a follow-up in the spec.

### Open Questions / Decisions
- No "disable retention" option was added on purpose — 5 minutes is a hard floor, not a sentinel, so this privacy feature can't be silently switched off.

---

```

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs(progress): log tryon media retention feature"
```
