# Batch Catalog Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user queue a whole catalog in one action — a grid of rows, each row being one garment + face + background + N poses — charged and created all-or-nothing.

**Architecture:** A new `POST /v1/jobs/batch` validates every row through the existing `resolveTryonPlan()`, sums the cost, and creates all jobs in one Postgres transaction before enqueuing them. Each row becomes its own `catalogueId`, exactly as a single Studio submission does today; a new nullable `jobs.batch_id` column ties the rows together. The Studio page gains a `single | batch` mode toggle whose batch UI lives in new files.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM on Postgres 16, Redis Streams, Vitest, Next.js 15, React 19.

**Spec:** `docs/superpowers/specs/2026-08-08-batch-catalog-generation-design.md`

## Global Constraints

- ESM only. Every relative import inside `apps/api` and `packages/*` ends in `.js`, even when the source file is `.ts`.
- pnpm workspaces. Never add an npm or yarn lockfile.
- No `console.log` in committed code. Use `app.log` / `req.log`.
- All Zod schemas live in `packages/types`. Route handlers import them; they are never redefined inline.
- Design tokens: web components use `C` from `apps/catalogues-web/src/components/tokens.ts`. Never a raw hex value.
- Credit deduct and job insert stay in one Postgres transaction. Refund on terminal failure is also transactional.
- Catalog ID → R2 key resolution happens in the API before enqueue. The dispatcher is not modified by this plan and must not learn that batches exist.
- Migration index is sequential and server-canonical. The current head is `0145_model_face_tags`; this plan adds `0146`.
- Never run `pnpm db:generate` or `pnpm db:migrate` against production. Local Postgres only.
- Integration tests require `pnpm docker:up` to be running first.
- Commit after every task. Do not push.

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `apps/api/vitest.integration.config.ts` | Vitest config that includes `test/integration/**` (the default config excludes it) |
| `packages/types/src/batch.ts` | `BatchRowInputs`, `CreateBatchJobRequest`, `requiredInputsForPoses`, `countBatchJobs`, limits |
| `packages/db/src/migrations/0146_jobs_batch_id.sql` | `jobs.batch_id` column + index |
| `apps/api/src/lib/batch-config.ts` | `getMaxBatchJobs()` — reads the admin `config:system` Redis key |
| `apps/api/src/modules/jobs/createBatch.ts` | Batch validation, costing, transaction, enqueue |
| `apps/api/test/batch-row-rules.test.ts` | Unit tests for the pure rules in `packages/types/src/batch.ts` |
| `apps/api/test/integration/batch-jobs.test.ts` | Integration tests for `POST /v1/jobs/batch` and `GET /v1/batches/:id` |
| `apps/catalogues-web/src/app/(app)/studio/batch/types.ts` | Row/tray client types shared by the batch components |
| `apps/catalogues-web/src/app/(app)/studio/batch/use-batch-state.ts` | Rows reducer, derived counts, per-row validity |
| `apps/catalogues-web/src/app/(app)/studio/batch/garment-tray.tsx` | Multi-file upload + past-assets picker |
| `apps/catalogues-web/src/app/(app)/studio/batch/batch-row.tsx` | One row's six cells |
| `apps/catalogues-web/src/app/(app)/studio/batch/batch-grid.tsx` | Header row, row list, add/duplicate/delete |
| `apps/catalogues-web/src/app/(app)/studio/batch/summary-bar.tsx` | Sticky totals + submit |
| `apps/catalogues-web/src/app/(app)/studio/batch/batch-mode.tsx` | Shell wiring header + tray + grid + summary + submit |

**Modified:**

| Path | Change |
|---|---|
| `apps/api/package.json` | Add `test:integration` script |
| `packages/types/src/index.ts` | Re-export `./batch.js` |
| `packages/db/src/schema/jobs.ts` | Add `batchId` column + `byBatch` index |
| `packages/db/src/migrations/meta/_journal.json` | Append entry `idx: 146` |
| `apps/api/src/lib/errors.ts` | `AppError` gains an optional `details` field |
| `apps/api/src/server.ts` | Error handler spreads `err.details` into the error envelope |
| `apps/api/src/modules/jobs/create.ts` | `resolveTryonPlan` gains an optional lookup `cache` parameter |
| `apps/api/src/modules/jobs/routes.ts` | Register `POST /v1/jobs/batch` and `GET /v1/batches/:id` |
| `apps/catalogues-web/src/app/(app)/studio/page.tsx` | `mode` state + segmented toggle, renders `<BatchMode/>` |
| `apps/catalogues-web/src/app/(app)/catalogues/page.tsx` | Honour `?batch=<id>` by reading `GET /v1/batches/:id` |

---

### Task 1: Make integration tests runnable

`apps/api/vitest.config.ts` excludes `test/integration/**` so the pre-push hook stays hermetic. Passing `--exclude` on the CLI *appends* to that list rather than replacing it, so there is currently no command that runs an integration test. Every later task's verification depends on fixing this first.

**Files:**
- Create: `apps/api/vitest.integration.config.ts`
- Modify: `apps/api/package.json` (scripts block, after `test:unit`)

**Interfaces:**
- Produces: the command `pnpm --filter @tryme/api test:integration -- <path>`, used by every subsequent task.

- [ ] **Step 1: Start the local infra**

```bash
pnpm docker:up
docker ps --format '{{.Names}}\t{{.Status}}'
```

Expected: `tryme-postgres`, `tryme-redis`, `tryme-minio` all `Up ... (healthy)`.

- [ ] **Step 2: Confirm the problem is real**

```bash
cd apps/api && ../../node_modules/.bin/vitest run --exclude '**/node_modules/**' test/integration/jobs-create-looks.test.ts
```

Expected: `No test files found, exiting with code 1`. The printed `exclude:` line still contains `test/integration/**`.

- [ ] **Step 3: Create the integration config**

```typescript
// apps/api/vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

// Integration tests need the docker-compose Postgres/Redis/MinIO on localhost
// (`pnpm docker:up`). The default vitest.config.ts excludes test/integration/**
// so the pre-push unit run stays hermetic; this config is how they get run.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false,
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
```

- [ ] **Step 4: Add the script**

In `apps/api/package.json`, add directly after the `test:unit` line:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

- [ ] **Step 5: Verify against an existing suite**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/jobs-create-looks.test.ts
```

Expected: `Test Files  1 passed (1)` / `Tests  10 passed (10)`.

- [ ] **Step 6: Confirm the unit run is unaffected**

```bash
pnpm --filter @tryme/api test:unit
```

Expected: passes, and no `test/integration/` file appears in the output.

- [ ] **Step 7: Commit**

```bash
git add apps/api/vitest.integration.config.ts apps/api/package.json
git commit -m "test(api): add runnable integration test config

The default vitest config excludes test/integration/**, and CLI --exclude
appends rather than replaces, so integration suites had no run command."
```

---

### Task 2: Batch types and pure row rules

The "does this selection need a lower garment or shoes" rule exists twice today — server-side in `resolveTryonPlan`'s node-ID loop, client-side in Studio's `hasLower`/`hasShoes` checks. Batch would be the third copy. This task extracts one pure implementation into `@tryme/types`, where the API test suite can cover it even though `apps/catalogues-web` has no test runner.

**Files:**
- Create: `packages/types/src/batch.ts`
- Create: `apps/api/test/batch-row-rules.test.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: `INPUT_GARMENT_KEY` from `packages/types/src/jobs.ts`.
- Produces:
  - `MAX_BATCH_ROWS: 100`, `DEFAULT_MAX_BATCH_JOBS: 200`
  - `BatchRowInputs` (Zod), `type BatchRow`
  - `CreateBatchJobRequest` (Zod), `type CreateBatchJobBody`
  - `requiredInputsForPoses(poses: PoseRequirement[]): { needsLower: boolean; needsShoes: boolean }`
  - `countBatchJobs(rows: Array<{ poseIds: string[] }>): number`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/batch-row-rules.test.ts
import {
  CreateBatchJobRequest,
  MAX_BATCH_ROWS,
  countBatchJobs,
  requiredInputsForPoses,
} from '@tryme/types';
import { describe, expect, it } from 'vitest';

const UUID = '00000000-0000-4000-8000-000000000001';
const KEY = `inputs/${UUID}/garment.jpg`;

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    upperGarmentKey: KEY,
    faceId: UUID,
    backgroundId: UUID,
    poseIds: [UUID],
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    garmentTypeId: UUID,
    aspectRatio: '1:1',
    resolution: '2K',
    rows: [validRow()],
    ...overrides,
  };
}

describe('requiredInputsForPoses', () => {
  it('needs neither when no pose asks for one', () => {
    expect(requiredInputsForPoses([{ hasLower: false, hasShoes: false }])).toEqual({
      needsLower: false,
      needsShoes: false,
    });
  });

  it('needs a lower when any single pose asks for one', () => {
    expect(
      requiredInputsForPoses([
        { hasLower: false, hasShoes: false },
        { hasLower: true, hasShoes: false },
      ]),
    ).toEqual({ needsLower: true, needsShoes: false });
  });

  it('needs both when different poses each ask for one', () => {
    expect(
      requiredInputsForPoses([
        { hasLower: true, hasShoes: false },
        { hasLower: false, hasShoes: true },
      ]),
    ).toEqual({ needsLower: true, needsShoes: true });
  });

  it('needs neither for an empty selection', () => {
    expect(requiredInputsForPoses([])).toEqual({ needsLower: false, needsShoes: false });
  });
});

describe('countBatchJobs', () => {
  it('sums poses across rows', () => {
    expect(countBatchJobs([{ poseIds: ['a', 'b'] }, { poseIds: ['c'] }])).toBe(3);
  });

  it('is zero for no rows', () => {
    expect(countBatchJobs([])).toBe(0);
  });
});

describe('CreateBatchJobRequest', () => {
  it('accepts a minimal valid body', () => {
    expect(CreateBatchJobRequest.safeParse(validBody()).success).toBe(true);
  });

  it('rejects a row with no poses', () => {
    const res = CreateBatchJobRequest.safeParse(
      validBody({ rows: [validRow({ poseIds: [] })] }),
    );
    expect(res.success).toBe(false);
  });

  it('rejects an empty rows array', () => {
    expect(CreateBatchJobRequest.safeParse(validBody({ rows: [] })).success).toBe(false);
  });

  it('rejects more than MAX_BATCH_ROWS rows', () => {
    const rows = Array.from({ length: MAX_BATCH_ROWS + 1 }, () => validRow());
    expect(CreateBatchJobRequest.safeParse(validBody({ rows })).success).toBe(false);
  });

  it('rejects a garment key that does not match the presign format', () => {
    const res = CreateBatchJobRequest.safeParse(
      validBody({ rows: [validRow({ upperGarmentKey: 'inputs/../../etc/passwd' })] }),
    );
    expect(res.success).toBe(false);
  });

  it('requires garmentTypeId', () => {
    const body = validBody() as Record<string, unknown>;
    delete body.garmentTypeId;
    expect(CreateBatchJobRequest.safeParse(body).success).toBe(false);
  });

  it('rejects mannequinJobId, thirdGarmentKey and catalogueTemplateMappingId on a row', () => {
    for (const field of ['mannequinJobId', 'thirdGarmentKey', 'catalogueTemplateMappingId']) {
      const parsed = CreateBatchJobRequest.parse(
        validBody({ rows: [validRow({ [field]: UUID })] }),
      );
      expect(parsed.rows[0]).not.toHaveProperty(field);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test:unit -- test/batch-row-rules.test.ts
```

Expected: FAIL — `"requiredInputsForPoses" is not exported by "@tryme/types"`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/types/src/batch.ts
import { z } from 'zod';
import { INPUT_GARMENT_KEY } from './jobs.js';

/**
 * Schema-level ceiling on rows. The operative limit is the admin-configured job
 * cap (the sum of poseIds across rows), enforced server-side — see
 * getMaxBatchJobs() in apps/api/src/lib/batch-config.ts. This exists so a
 * malformed request is rejected by the schema before any DB work happens.
 */
export const MAX_BATCH_ROWS = 100;

/** Fallback when the config:system Redis key holds no batch entry. */
export const DEFAULT_MAX_BATCH_JOBS = 200;

/**
 * One row of a batch: exactly one Studio submission. N poses on a row produce N
 * jobs sharing one catalogueId.
 *
 * Deliberately narrower than CreateTryOnJobInputs. mannequinJobId (saree
 * two-pass), catalogueTemplateMappingId (catalogue templates) and thirdGarmentKey
 * (saree two-input) are absent: each would add a validation branch, and the
 * mannequin flow in particular cannot fit the single-transaction model because
 * each garment's step-2 jobs are unplannable until its mannequin job completes.
 * Zod strips unknown keys, so a client sending them gets them dropped rather
 * than silently honoured.
 */
export const BatchRowInputs = z.object({
  upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY),
  faceId: z.string().uuid(),
  backgroundId: z.string().uuid(),
  poseIds: z.array(z.string().uuid()).min(1),
  lowerCatalogId: z.string().uuid().optional(),
  lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  shoeCatalogId: z.string().uuid().optional(),
});
export type BatchRow = z.infer<typeof BatchRowInputs>;

/**
 * garmentTypeId is required here although it is optional on
 * CreateTryOnJobRequest: batch resolves pose/lower/shoe availability once for the
 * whole grid, which is only possible with a known garment type.
 */
export const CreateBatchJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
  resolution: z.enum(['HD', '2K', '4K']),
  platform: z.string().optional(),
  params: z
    .object({
      outputWidth: z.number().int().min(512).max(4096).optional(),
      outputHeight: z.number().int().min(512).max(4096).optional(),
    })
    .optional(),
  userHint: z.string().max(300).optional(),
  rows: z.array(BatchRowInputs).min(1).max(MAX_BATCH_ROWS),
});
export type CreateBatchJobBody = z.infer<typeof CreateBatchJobRequest>;

export interface PoseRequirement {
  hasLower: boolean;
  hasShoes: boolean;
}

/**
 * Single source of truth for which optional inputs a pose selection requires.
 * The API validates against it; the web app enables/disables the lower and shoe
 * cells with it. A selection needs an input if ANY selected pose's workflow has
 * the corresponding node — matching what the dispatcher will try to patch.
 */
export function requiredInputsForPoses(poses: PoseRequirement[]): {
  needsLower: boolean;
  needsShoes: boolean;
} {
  return {
    needsLower: poses.some((p) => p.hasLower),
    needsShoes: poses.some((p) => p.hasShoes),
  };
}

/** Total jobs a batch will create — one per pose per row. */
export function countBatchJobs(rows: Array<{ poseIds: string[] }>): number {
  return rows.reduce((total, row) => total + row.poseIds.length, 0);
}
```

- [ ] **Step 4: Export it**

In `packages/types/src/index.ts`, add alongside the other `export *` lines:

```typescript
export * from './batch.js';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test:unit -- test/batch-row-rules.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/batch.ts packages/types/src/index.ts apps/api/test/batch-row-rules.test.ts
git commit -m "feat(types): add batch request schemas and shared row rules"
```

---

### Task 3: `jobs.batch_id` column

**Files:**
- Modify: `packages/db/src/schema/jobs.ts`
- Create: `packages/db/src/migrations/0146_jobs_batch_id.sql` (generated)
- Modify: `packages/db/src/migrations/meta/_journal.json` (generated)

**Interfaces:**
- Produces: `schema.jobs.batchId` — nullable `uuid`, indexed as `jobs_batch_idx`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema/jobs.ts`, inside the `jobs` table definition, directly after the `catalogueId` line:

```typescript
    // Groups the jobs created by one POST /v1/jobs/batch. Nullable: every
    // single-job flow leaves it NULL. There is no batches table — batch totals
    // and status are derived by GROUP BY batch_id (see GET /v1/batches/:id).
    batchId: uuid('batch_id'),
```

And in the table's config callback, alongside `byShopifyStoreTime`:

```typescript
    byBatch: index('jobs_batch_idx').on(t.batchId),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm db:generate
```

Expected: creates `packages/db/src/migrations/0146_<name>.sql` and appends `"idx": 146` to `meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL**

```bash
cat packages/db/src/migrations/0146_*.sql
```

Expected, modulo Drizzle's naming:

```sql
ALTER TABLE "jobs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
CREATE INDEX "jobs_batch_idx" ON "jobs" USING btree ("batch_id");
```

If the generated filename is not `0146_jobs_batch_id.sql`, rename it with `git mv` and update the matching `tag` in `meta/_journal.json`. If Drizzle emitted anything beyond these two statements, it has picked up unrelated drift — revert, sync your local DB, and regenerate.

- [ ] **Step 4: Apply it locally**

```bash
pnpm db:migrate
```

Expected: applies cleanly.

- [ ] **Step 5: Verify the column exists**

```bash
docker exec tryme-postgres psql -U postgres -d tryon -c '\d jobs' | grep -E 'batch_id|jobs_batch_idx'
```

Expected: both the `batch_id | uuid` column line and the `jobs_batch_idx` index line.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(db): add jobs.batch_id for batch catalog generation"
```

---

### Task 4: Row-attributed errors

Batch failures must tell the user *which row* failed. `AppError` currently carries only `code`, `statusCode` and `message`, and the error handler emits `{ error: { code, message } }`. This adds an optional structured `details` bag, additively — no existing throw site or response shape changes.

**Files:**
- Modify: `apps/api/src/lib/errors.ts`
- Modify: `apps/api/src/server.ts:271-277`
- Create: `apps/api/test/app-error-details.test.ts`

**Interfaces:**
- Produces:
  - `new AppError(code, statusCode, message, details?)` where `details?: Record<string, unknown>`
  - Response envelope `{ error: { code, message, ...details } }`
  - `withRowIndex(err: unknown, rowIndex: number): unknown` — exported from `apps/api/src/lib/errors.ts`, re-throws non-`AppError` values untouched and returns a new `AppError` carrying `rowIndex` otherwise.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/app-error-details.test.ts
import { describe, expect, it } from 'vitest';
import { AppError, withRowIndex } from '../src/lib/errors.js';

describe('AppError details', () => {
  it('defaults details to undefined', () => {
    expect(new AppError('VALIDATION', 400, 'nope').details).toBeUndefined();
  });

  it('carries a details bag', () => {
    const err = new AppError('VALIDATION', 400, 'nope', { rowIndex: 2 });
    expect(err.details).toEqual({ rowIndex: 2 });
  });
});

describe('withRowIndex', () => {
  it('attaches rowIndex to an AppError, preserving code, status and message', () => {
    const out = withRowIndex(new AppError('BAD_CATALOG', 400, 'pose inactive'), 3);
    expect(out).toBeInstanceOf(AppError);
    const app = out as AppError;
    expect(app.code).toBe('BAD_CATALOG');
    expect(app.statusCode).toBe(400);
    expect(app.message).toBe('pose inactive');
    expect(app.details).toEqual({ rowIndex: 3 });
  });

  it('merges rowIndex into an existing details bag', () => {
    const out = withRowIndex(new AppError('VALIDATION', 400, 'x', { field: 'poseIds' }), 1);
    expect((out as AppError).details).toEqual({ field: 'poseIds', rowIndex: 1 });
  });

  it('returns a non-AppError unchanged so 500s are not disguised as 400s', () => {
    const raw = new TypeError('boom');
    expect(withRowIndex(raw, 0)).toBe(raw);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test:unit -- test/app-error-details.test.ts
```

Expected: FAIL — `withRowIndex is not exported`.

- [ ] **Step 3: Implement**

Replace the contents of `apps/api/src/lib/errors.ts`:

```typescript
export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    /**
     * Structured context merged into the JSON error envelope alongside code and
     * message. Used by batch job creation to tell the caller which row failed.
     * Keep it small and non-sensitive — it is sent verbatim to the client.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Tags a row-scoped failure with its row index for the batch endpoint. Anything
 * that is not an AppError is returned untouched: an unexpected TypeError must
 * stay a 500 rather than being re-dressed as a client error.
 */
export function withRowIndex(err: unknown, rowIndex: number): unknown {
  if (!(err instanceof AppError)) return err;
  return new AppError(err.code, err.statusCode, err.message, {
    ...(err.details ?? {}),
    rowIndex,
  });
}
```

- [ ] **Step 4: Include details in the response envelope**

In `apps/api/src/server.ts`, replace the `AppError` branch of `setErrorHandler`:

```typescript
    if (err instanceof AppError) {
      app.log.warn(
        { code: err.code, statusCode: err.statusCode, msg: err.message, url: _req.url },
        'app error',
      );
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test:unit -- test/app-error-details.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Verify no existing error contract regressed**

```bash
pnpm --filter @tryme/api test:unit
```

Expected: the whole unit suite passes. `details` is undefined everywhere else, so the spread contributes nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/errors.ts apps/api/src/server.ts apps/api/test/app-error-details.test.ts
git commit -m "feat(api): let AppError carry structured details"
```

---

### Task 5: Batch creation — happy path

The core of the feature. Validates every row through the existing `resolveTryonPlan()`, then creates every job in one transaction and enqueues them.

**Files:**
- Create: `apps/api/src/modules/jobs/createBatch.ts`
- Modify: `apps/api/src/modules/jobs/routes.ts`
- Create: `apps/api/test/integration/batch-jobs.test.ts`

**Interfaces:**
- Consumes: `resolveTryonPlan`, `verifyGarmentKey`, `TryonPlan` from `./create.js`; `atomicDeduct` from `../credits/ledger.js`; `promptGuard` from `./sanitize.js`; `AppError`, `withRowIndex` from `../../lib/errors.js`; `CreateBatchJobRequest`, `CreateBatchJobBody` from `@tryme/types`.
- Produces: `createBatchJobs(app: FastifyInstance, userId: string, body: CreateBatchJobBody): Promise<BatchCreateResult>` where

```typescript
export interface BatchCreateResult {
  batchId: string;
  totalJobs: number;
  creditsCharged: number;
  catalogues: Array<{ rowIndex: number; catalogueId: string; jobIds: string[] }>;
  failedJobIds: string[];
}
```

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/test/integration/batch-jobs.test.ts
import { schema } from '@tryme/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('POST /v1/jobs/batch', () => {
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
    await app.redis.del('jobs:priority');
    await app.redis.del('config:system');
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
  });

  async function registerUser(email: string, tier = 'free') {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const token = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token, userId: user.id };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function seedCreditPlan(slug = 'free') {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, watermark: false })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark: false } });
  }

  /** Uploads are bound to their owner in Redis by /v1/uploads/presign; tests bind directly. */
  async function uploadKey(userId: string, token: string) {
    const key = `inputs/${token}/garment.jpg`;
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
    return key;
  }

  async function seedCatalog() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [poseA] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PA', r2Key: 'pa.jpg', thumbnailKey: 'pa.jpg' })
      .returning();
    const [poseB] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PB', r2Key: 'pb.jpg', thumbnailKey: 'pb.jpg' })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ label: 'Shirt', slug: `shirt-${Date.now()}`, genderSlug: 'men' })
      .returning();
    return {
      faceId: face.id,
      bgId: bg.id,
      poseAId: poseA.id,
      poseBId: poseB.id,
      garmentTypeId: garmentType.id,
    };
  }

  it('creates one job per pose per row, one catalogue per row, under one batchId', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-happy@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g1 = await uploadKey(userId, '11111111-1111-4111-8111-111111111111');
    const g2 = await uploadKey(userId, '22222222-2222-4222-8222-222222222222');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g1,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
          {
            upperGarmentKey: g2,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.totalJobs).toBe(3);
    expect(body.catalogues).toHaveLength(2);
    expect(body.catalogues[0].jobIds).toHaveLength(2);
    expect(body.catalogues[1].jobIds).toHaveLength(1);
    expect(body.catalogues[0].catalogueId).not.toBe(body.catalogues[1].catalogueId);
    expect(body.failedJobIds).toEqual([]);

    const allJobIds = body.catalogues.flatMap((cg: { jobIds: string[] }) => cg.jobIds);
    const jobRows = await app.db
      .select({ batchId: schema.jobs.batchId, status: schema.jobs.status })
      .from(schema.jobs)
      .where(inArray(schema.jobs.id, allJobIds));
    expect(jobRows).toHaveLength(3);
    expect(new Set(jobRows.map((j) => j.batchId))).toEqual(new Set([body.batchId]));
    expect(jobRows.every((j) => j.status === 'QUEUED')).toBe(true);

    const streamLen = await app.redis.xlen('jobs:normal');
    expect(streamLen).toBe(3);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1000 - body.creditsCharged);
  });

  it('allows the same garment on two rows with different poses', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-dup-garment@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '33333333-3333-4333-8333-333333333333');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().catalogues).toHaveLength(2);
  });

  it('produces job_inputs identical to the equivalent single-job submissions', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-parity@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const gBatch = await uploadKey(userId, '44444444-4444-4444-8444-444444444444');
    const gSingle = await uploadKey(userId, '55555555-5555-4555-8555-555555555555');

    const batchRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        userHint: 'crisp lighting',
        rows: [
          {
            upperGarmentKey: gBatch,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });
    expect(batchRes.statusCode).toBe(201);

    const singleRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: gSingle,
          faceId: cat.faceId,
          backgroundId: cat.bgId,
          poseIds: [cat.poseAId, cat.poseBId],
          garmentTypeId: cat.garmentTypeId,
        },
        aspectRatio: '1:1',
        resolution: '2K',
        userHint: 'crisp lighting',
      },
    });
    expect(singleRes.statusCode).toBe(201);

    const batchJobIds: string[] = batchRes.json().catalogues[0].jobIds;
    const singleJobIds: string[] = singleRes.json().jobIds;

    // Compare everything except the fields that are expected to differ: the job
    // id, and the garment key (each submission uploaded its own).
    const strip = (row: Record<string, unknown>) => {
      const { jobId, upperGarmentKey, ...rest } = row;
      return rest;
    };
    const load = async (ids: string[]) => {
      const rows = await app.db
        .select()
        .from(schema.jobInputs)
        .where(inArray(schema.jobInputs.jobId, ids));
      return rows
        .map((r) => strip(r as unknown as Record<string, unknown>))
        .sort((a, b) => String(a.poseId).localeCompare(String(b.poseId)));
    };

    expect(await load(batchJobIds)).toEqual(await load(singleJobIds));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: FAIL — all three, with 404 from `/v1/jobs/batch`.

- [ ] **Step 3: Implement `createBatch.ts`**

```typescript
// apps/api/src/modules/jobs/createBatch.ts
import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateBatchJobBody, JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError, withRowIndex } from '../../lib/errors.js';
import { atomicDeduct, refund } from '../credits/ledger.js';
import { resolveTryonPlan, type TryonPlan, verifyGarmentKey } from './create.js';
import { promptGuard } from './sanitize.js';

export interface BatchCreateResult {
  batchId: string;
  totalJobs: number;
  creditsCharged: number;
  catalogues: Array<{ rowIndex: number; catalogueId: string; jobIds: string[] }>;
  failedJobIds: string[];
}

/**
 * Creates every job in a batch, or none of them.
 *
 * A row is exactly one Studio submission — one garment, one face, one
 * background, N poses — so each row is validated by the same resolveTryonPlan()
 * the single-job path uses, and each row's jobs share their own catalogueId. The
 * whole batch shares a batchId; there is no batches table, and progress is
 * derived by GROUP BY batch_id.
 */
export async function createBatchJobs(
  app: FastifyInstance,
  userId: string,
  body: CreateBatchJobBody,
): Promise<BatchCreateResult> {
  const { rows } = body;

  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({
        queueStream: schema.creditPlans.queueStream,
        watermark: schema.creditPlans.watermark,
      })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';
  const watermark: boolean = planRow?.watermark ?? false;

  // H2 ownership: each DISTINCT key is verified once, not once per row — a
  // garment reused across five rows is one Redis lookup. The map remembers the
  // first row using each key so a failure can be attributed to a row.
  const keyFirstRow = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!keyFirstRow.has(row.upperGarmentKey)) keyFirstRow.set(row.upperGarmentKey, index);
    if (row.lowerGarmentKey && !keyFirstRow.has(row.lowerGarmentKey)) {
      keyFirstRow.set(row.lowerGarmentKey, index);
    }
  });
  for (const [key, rowIndex] of keyFirstRow) {
    try {
      await verifyGarmentKey(app, userId, key);
    } catch (err) {
      throw withRowIndex(err, rowIndex);
    }
  }

  // Plan every row before touching credits or inserting anything. resolveTryonPlan
  // is read-only by contract, so a mid-loop rejection leaves no residue.
  const plans: TryonPlan[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    try {
      plans.push(
        await resolveTryonPlan(
          app,
          userId,
          {
            inputs: {
              upperGarmentKey: row.upperGarmentKey,
              faceId: row.faceId,
              backgroundId: row.backgroundId,
              poseIds: row.poseIds,
              garmentTypeId: body.garmentTypeId,
              lowerCatalogId: row.lowerCatalogId,
              lowerGarmentKey: row.lowerGarmentKey,
              shoeCatalogId: row.shoeCatalogId,
            },
            params: body.params,
            userHint: body.userHint,
            aspectRatio: body.aspectRatio,
            resolution: body.resolution,
            platform: body.platform,
          },
          { resolvedUpperGarmentKey: row.upperGarmentKey },
        ),
      );
    } catch (err) {
      throw withRowIndex(err, rowIndex);
    }
  }

  const totalJobs = plans.reduce((n, plan) => n + plan.looks.length, 0);
  const creditsCharged = plans.reduce((n, plan) => n + plan.cost * plan.looks.length, 0);

  const batchId = randomUUID();

  // One transaction for the whole batch. atomicDeduct throwing part-way through
  // (a concurrent spend draining the balance) propagates out of the callback and
  // rolls back every insert, so all-or-nothing survives without a lock.
  const catalogues = await app.db.transaction(async (tx) => {
    const created: BatchCreateResult['catalogues'] = [];
    for (const [rowIndex, plan] of plans.entries()) {
      const row = rows[rowIndex];
      const jobIds: string[] = [];
      for (const look of plan.looks) {
        const [job] = await tx
          .insert(schema.jobs)
          .values({
            userId,
            batchId,
            catalogueId: plan.catalogueId,
            status: 'QUEUED',
            priority,
            queueStream,
            watermark,
            creditsCharged: plan.cost,
            source: JOB_SOURCE.CATALOG,
          })
          .returning();
        await atomicDeduct(tx as unknown as DB, userId, plan.cost, job.id);
        await tx.insert(schema.jobInputs).values({
          jobId: job.id,
          upperGarmentKey: look.upperGarmentKey,
          faceId: row.faceId,
          backgroundId: look.backgroundId,
          poseId: look.poseId,
          garmentTypeId: body.garmentTypeId,
          lowerCatalogId: look.lowerCatalogId,
          lowerGarmentKey: look.lowerGarmentKey,
          shoeCatalogId: look.shoeCatalogId,
          userHint: promptGuard(body.userHint),
          params: look.params,
        });
        jobIds.push(job.id);
      }
      created.push({ rowIndex, catalogueId: plan.catalogueId, jobIds });
    }
    return created;
  });

  const stream = `jobs:${queueStream}`;
  const failedJobIds: string[] = [];
  const costByJobId = new Map<string, number>();
  catalogues.forEach((group, i) => {
    for (const jobId of group.jobIds) costByJobId.set(jobId, plans[i].cost);
  });

  for (const group of catalogues) {
    for (const jobId of group.jobIds) {
      try {
        await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'userId', userId);
        jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.CATALOG });
      } catch (err) {
        app.log.error({ err, jobId, batchId }, 'batch xadd failed — job will be refunded');
        failedJobIds.push(jobId);
      }
    }
  }

  if (failedJobIds.length > 0) {
    await Promise.all(
      failedJobIds.map(async (jobId) => {
        await refund(app.db, userId, costByJobId.get(jobId) ?? 0, jobId, 'REFUND_ENQUEUE_FAIL');
        await app.db
          .update(schema.jobs)
          .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
          .where(eq(schema.jobs.id, jobId));
      }),
    );
    if (failedJobIds.length === totalJobs) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  return { batchId, totalJobs, creditsCharged, catalogues, failedJobIds };
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/jobs/routes.ts`, add `CreateBatchJobRequest` to the `@tryme/types` import, add `import { createBatchJobs } from './createBatch.js';` alongside the other create imports, and register directly after the `/v1/jobs/tryon` block:

```typescript
  app.post(
    '/v1/jobs/batch',
    { preHandler: app.requireUser, schema: { body: CreateBatchJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () => createBatchJobs(app, req.userId, req.body as z.infer<typeof CreateBatchJobRequest>),
      );
      reply.code(201);
      return result;
    },
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Confirm the single-job path is untouched**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/jobs-create-looks.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/createBatch.ts apps/api/src/modules/jobs/routes.ts apps/api/test/integration/batch-jobs.test.ts
git commit -m "feat(api): add POST /v1/jobs/batch"
```

---

### Task 6: Cap, preflight balance, and row-attributed rejections

Task 5 creates jobs but has no cap and no balance preflight — an over-budget batch currently fails part-way through `atomicDeduct`, which rolls back correctly but returns an opaque error. This task adds the cap and the preflight, and confirms every rejection names its row.

**Files:**
- Create: `apps/api/src/lib/batch-config.ts`
- Modify: `apps/api/src/modules/jobs/createBatch.ts`
- Modify: `apps/api/test/integration/batch-jobs.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MAX_BATCH_JOBS` from `@tryme/types`; `countBatchJobs` from `@tryme/types`.
- Produces: `getMaxBatchJobs(app: FastifyInstance): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('POST /v1/jobs/batch')` block in `apps/api/test/integration/batch-jobs.test.ts`:

```typescript
  it('rejects the whole batch when the balance is short, charging nothing', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-poor@x.com');
    await grantCredits(userId, 1);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '66666666-6666-4666-8666-666666666666');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('INSUFFICIENT_CREDITS');
    expect(res.json().error.required).toBeGreaterThan(res.json().error.available);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);

    const ledger = await app.db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger).toHaveLength(0);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1);
  });

  it('rejects a batch whose total job count exceeds the admin cap', async () => {
    await seedCreditPlan();
    await app.redis.set('config:system', JSON.stringify({ maxBatchJobs: 2 }));
    const { token, userId } = await registerUser('batch-cap@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '77777777-7777-4777-8777-777777777777');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(res.json().error.totalJobs).toBe(3);
    expect(res.json().error.maxBatchJobs).toBe(2);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);
  });

  it('names the offending row when it references an inactive pose', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-badrow@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '88888888-8888-4888-8888-888888888888');
    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: false })
      .where(eq(schema.modelPoseAssets.id, cat.poseBId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_CATALOG');
    expect(res.json().error.rowIndex).toBe(1);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);

    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: true })
      .where(eq(schema.modelPoseAssets.id, cat.poseBId));
  });

  it('names the offending row when its garment key belongs to another user', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-thief@x.com');
    const other = await registerUser('batch-victim@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const mine = await uploadKey(userId, '99999999-9999-4999-8999-999999999999');
    const theirs = await uploadKey(other.userId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: mine,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: theirs,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.rowIndex).toBe(1);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);
  });

  it('rejects a row that repeats the same pose', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-duppose@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.rowIndex).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: the five new tests fail — the cap test gets 201, the balance test gets a 402 without `required`/`available`.

- [ ] **Step 3: Add the cap config reader**

```typescript
// apps/api/src/lib/batch-config.ts
import { DEFAULT_MAX_BATCH_JOBS } from '@tryme/types';
import type { FastifyInstance } from 'fastify';

const CONFIG_KEY = 'config:system';

/**
 * Reads the admin-configured ceiling on jobs per batch from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config),
 * mirroring getMaxOutputPx() in resolution-config.ts. Falls back to
 * DEFAULT_MAX_BATCH_JOBS when nothing is stored or the entry is malformed.
 */
export async function getMaxBatchJobs(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const max = cfg.maxBatchJobs;
    return typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_BATCH_JOBS;
  } catch {
    return DEFAULT_MAX_BATCH_JOBS;
  }
}
```

- [ ] **Step 4: Enforce the cap and preflight the balance**

In `apps/api/src/modules/jobs/createBatch.ts`, add to the imports:

```typescript
import { countBatchJobs, type CreateBatchJobBody, JOB_SOURCE } from '@tryme/types';
import { getMaxBatchJobs } from '../../lib/batch-config.js';
```

Insert the cap check immediately after the `if (!user || user.isBanned)` line — before any ownership check, so an oversized batch costs one Redis read rather than N:

```typescript
  // Cap on total jobs, not rows: 50 rows of 10 poses is 500 jobs regardless of
  // how few rows that is.
  const requestedJobs = countBatchJobs(rows);
  const maxBatchJobs = await getMaxBatchJobs(app);
  if (requestedJobs > maxBatchJobs) {
    throw new AppError(
      'VALIDATION',
      400,
      `batch of ${requestedJobs} images exceeds the limit of ${maxBatchJobs}`,
      { totalJobs: requestedJobs, maxBatchJobs },
    );
  }
```

Then insert the preflight between the `creditsCharged` computation and `const batchId`:

```typescript
  // Preflight so an unaffordable batch is rejected with a useful message instead
  // of surfacing as an opaque mid-transaction atomicDeduct failure. This is not
  // the safety net — atomicDeduct inside the transaction below still is, and
  // still rolls the whole batch back if a concurrent spend races past this read.
  const [balanceRow] = await app.db
    .select({ balance: schema.userCredits.balance })
    .from(schema.userCredits)
    .where(eq(schema.userCredits.userId, userId));
  const available = balanceRow?.balance ?? 0;
  if (available < creditsCharged) {
    throw new AppError(
      'INSUFFICIENT_CREDITS',
      402,
      `batch needs ${creditsCharged} credits, balance is ${available}`,
      { required: creditsCharged, available },
    );
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/batch-config.ts apps/api/src/modules/jobs/createBatch.ts apps/api/test/integration/batch-jobs.test.ts
git commit -m "feat(api): enforce batch cap and preflight balance with row-attributed errors"
```

---

### Task 7: Enqueue-failure handling

Task 5 wrote the refund path but nothing exercises it. Redis going down between commit and `XADD` leaves jobs charged and unqueued unless the refund fires.

**Files:**
- Modify: `apps/api/test/integration/batch-jobs.test.ts`

**Interfaces:**
- Consumes: `createBatchJobs` behaviour from Task 5.

- [ ] **Step 1: Write the failing tests**

Append inside the same `describe` block:

```typescript
  it('refunds and fails every job when the queue is unreachable', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-noqueue@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          garmentTypeId: cat.garmentTypeId,
          aspectRatio: '1:1',
          resolution: '2K',
          rows: [
            {
              upperGarmentKey: g,
              faceId: cat.faceId,
              backgroundId: cat.bgId,
              poseIds: [cat.poseAId, cat.poseBId],
            },
          ],
        },
      });
    } finally {
      app.redis.xadd = realXadd;
    }

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ENQUEUE_FAIL');

    const jobRows = await app.db
      .select({ status: schema.jobs.status, errorCode: schema.jobs.errorCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.status === 'FAILED' && j.errorCode === 'ENQUEUE_FAIL')).toBe(
      true,
    );

    // Charged then refunded, so the net balance is whole again.
    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1000);
  });

  it('returns 201 with failedJobIds when only some enqueues fail', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-partialqueue@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

    const realXadd = app.redis.xadd.bind(app.redis);
    let calls = 0;
    app.redis.xadd = (async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('redis blip');
      return (realXadd as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof app.redis.xadd;

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          garmentTypeId: cat.garmentTypeId,
          aspectRatio: '1:1',
          resolution: '2K',
          rows: [
            {
              upperGarmentKey: g,
              faceId: cat.faceId,
              backgroundId: cat.bgId,
              poseIds: [cat.poseAId, cat.poseBId],
            },
          ],
        },
      });
    } finally {
      app.redis.xadd = realXadd;
    }

    expect(res.statusCode).toBe(201);
    expect(res.json().failedJobIds).toHaveLength(1);

    const failedId = res.json().failedJobIds[0];
    const [failed] = await app.db
      .select({ status: schema.jobs.status, errorCode: schema.jobs.errorCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, failedId));
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('ENQUEUE_FAIL');
  });
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: PASS, 10 tests. Task 5's implementation already covers both paths; if either fails, the bug is in `createBatch.ts`'s `failedJobIds` handling — fix it there rather than relaxing the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/batch-jobs.test.ts
git commit -m "test(api): cover batch enqueue-failure refund paths"
```

---

### Task 8: `GET /v1/batches/:id`

The web app needs per-row progress after submit. Everything is derived — there is no batches table.

**Files:**
- Modify: `apps/api/src/modules/jobs/routes.ts`
- Modify: `apps/api/test/integration/batch-jobs.test.ts`

**Interfaces:**
- Produces: `GET /v1/batches/:id` →

```typescript
{
  batchId: string;
  totalJobs: number;
  catalogues: Array<{
    catalogueId: string;
    total: number;
    completed: number;
    failed: number;
    createdAt: string;
  }>;
}
```

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` block:

```typescript
  it('reports per-catalogue progress for a batch, and 404s another user\'s batch', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-progress@x.com');
    const stranger = await registerUser('batch-stranger@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { batchId, catalogues } = created.json();

    // Drive one job to COMPLETED so the counts are not all zero.
    await app.db
      .update(schema.jobs)
      .set({ status: 'COMPLETED' })
      .where(eq(schema.jobs.id, catalogues[0].jobIds[0]));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/batches/${batchId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.batchId).toBe(batchId);
    expect(body.totalJobs).toBe(2);
    expect(body.catalogues).toHaveLength(1);
    expect(body.catalogues[0].catalogueId).toBe(catalogues[0].catalogueId);
    expect(body.catalogues[0].total).toBe(2);
    expect(body.catalogues[0].completed).toBe(1);
    expect(body.catalogues[0].failed).toBe(0);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/batches/${batchId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(foreign.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: FAIL — 404 for the owner too, since the route does not exist.

- [ ] **Step 3: Implement the route**

In `apps/api/src/modules/jobs/routes.ts`, register after the `GET /v1/assets` handler:

```typescript
  // Batch progress. There is no batches table — every field here is derived from
  // jobs grouped by (batch_id, catalogue_id). A batch belonging to another user
  // is a 404 rather than a 403 so the ID's existence is not disclosed.
  app.get(
    '/v1/batches/:id',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await app.db
        .select({
          catalogueId: schema.jobs.catalogueId,
          total: sql<number>`COUNT(*)`.as('total'),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')`.as(
            'completed',
          ),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'FAILED')`.as(
            'failed',
          ),
          createdAt: sql<Date>`MIN(${schema.jobs.createdAt})`.as('createdAt'),
        })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.batchId, id), eq(schema.jobs.userId, req.userId)))
        .groupBy(schema.jobs.catalogueId)
        .orderBy(asc(sql`MIN(${schema.jobs.createdAt})`));

      if (rows.length === 0) throw new AppError('NOT_FOUND', 404, 'batch not found');

      // Raw sql`` aggregates come back from the driver as strings regardless of
      // the sql<number> annotations — those generics are TypeScript-only.
      const catalogues = rows.map((r) => ({
        catalogueId: r.catalogueId,
        total: Number(r.total),
        completed: Number(r.completed),
        failed: Number(r.failed),
        createdAt: new Date(r.createdAt).toISOString(),
      }));

      return {
        batchId: id,
        totalJobs: catalogues.reduce((n, c) => n + c.total, 0),
        catalogues,
      };
    },
  );
```

`and`, `asc`, `eq` and `sql` are already imported at the top of this file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/jobs/routes.ts apps/api/test/integration/batch-jobs.test.ts
git commit -m "feat(api): add GET /v1/batches/:id progress endpoint"
```

---

### Task 9: Lookup cache in `resolveTryonPlan`

`resolveTryonPlan` issues roughly six queries per call. A 30-row batch is about 180. This adds an optional per-request cache; callers that pass nothing behave exactly as before. Task 5's parity test is the guard: if the cache changes what lands in `job_inputs`, it fails.

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts`
- Modify: `apps/api/src/modules/jobs/createBatch.ts`

**Interfaces:**
- Produces:

```typescript
export interface TryonPlanCache {
  faces: Map<string, boolean>;
  backgrounds: Map<string, boolean>;
  poses: Map<string, boolean>;
  catalogItems: Map<string, boolean>;
  garmentTypes: Map<string, boolean>;
  maxOutputPx?: number;
  resolutionCosts: Map<string, number>;
}
export function createTryonPlanCache(): TryonPlanCache;
```

`resolveTryonPlan`'s `opts` gains `cache?: TryonPlanCache`.

- [ ] **Step 1: Capture the current query count**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts 2>&1 | grep -c 'select'
```

Record the number. It is a rough before/after signal, not an assertion.

- [ ] **Step 2: Add the cache type and factory**

In `apps/api/src/modules/jobs/create.ts`, above `resolveTryonPlan`:

```typescript
/**
 * Per-request memo for resolveTryonPlan's existence checks. Batch creation calls
 * resolveTryonPlan once per row, and rows overwhelmingly share the same face,
 * background, poses and garment type — without this, a 30-row batch reissues the
 * same handful of queries 30 times.
 *
 * Only ID-existence and admin-config lookups are cached. Per-pose workflow
 * resolution is NOT, because it depends on (poseId, garmentTypeId) together and
 * on pose_garment_configs overrides that vary per row.
 *
 * Lifetime is a single request. Never hold one across requests: an admin
 * deactivating an asset mid-flight must be visible to the next request.
 */
export interface TryonPlanCache {
  faces: Map<string, boolean>;
  backgrounds: Map<string, boolean>;
  poses: Map<string, boolean>;
  catalogItems: Map<string, boolean>;
  garmentTypes: Map<string, boolean>;
  maxOutputPx?: number;
  resolutionCosts: Map<string, number>;
}

export function createTryonPlanCache(): TryonPlanCache {
  return {
    faces: new Map(),
    backgrounds: new Map(),
    poses: new Map(),
    catalogItems: new Map(),
    garmentTypes: new Map(),
    resolutionCosts: new Map(),
  };
}
```

- [ ] **Step 3: Widen the `opts` parameter**

Change `resolveTryonPlan`'s signature:

```typescript
  opts: {
    resolvedUpperGarmentKey: string | null;
    trustedGarmentKeys?: Set<string>;
    cache?: TryonPlanCache;
  },
```

- [ ] **Step 4: Route the config reads through the cache**

Replace the `maxOutputPx` and `COST` lines:

```typescript
  const maxOutputPx =
    opts.cache?.maxOutputPx ??
    (await (async () => {
      const value = await getMaxOutputPx(app);
      if (opts.cache) opts.cache.maxOutputPx = value;
      return value;
    })());
```

and, after `resolution` is computed:

```typescript
  const COST =
    opts.cache?.resolutionCosts.get(resolution) ??
    (await (async () => {
      const value = await getResolutionCreditCost(app, resolution);
      opts.cache?.resolutionCosts.set(resolution, value);
      return value;
    })());
```

- [ ] **Step 5: Route the existence checks through the cache**

Replace the `Promise.all([...])` that fetches `face`, `backgroundRows` and `poses`, and the assertions immediately after it, with:

```typescript
  // Only IDs not already known-good in the cache hit the database.
  const uncachedBackgroundIds = distinctBackgroundIds.filter(
    (id) => !opts.cache?.backgrounds.get(id),
  );
  const uncachedPoseIds = distinctPoseIds.filter((id) => !opts.cache?.poses.get(id));
  const faceCached = opts.cache?.faces.get(faceId) === true;

  const [face, backgroundRows, poses] = await Promise.all([
    faceCached
      ? Promise.resolve([{ id: faceId }])
      : app.db
          .select({ id: schema.modelFaces.id })
          .from(schema.modelFaces)
          .where(and(eq(schema.modelFaces.id, faceId), eq(schema.modelFaces.isActive, true))),
    uncachedBackgroundIds.length === 0
      ? Promise.resolve([])
      : app.db
          .select({ id: schema.modelBackgrounds.id })
          .from(schema.modelBackgrounds)
          .where(
            and(
              inArray(schema.modelBackgrounds.id, uncachedBackgroundIds),
              eq(schema.modelBackgrounds.isActive, true),
              isNull(schema.modelBackgrounds.deletedAt),
              or(
                ne(schema.modelBackgrounds.scope, 'user'),
                and(
                  eq(schema.modelBackgrounds.scope, 'user'),
                  eq(schema.modelBackgrounds.userId, userId),
                ),
              ),
            ),
          ),
    uncachedPoseIds.length === 0
      ? Promise.resolve([])
      : app.db
          .select({ id: schema.modelPoseAssets.id })
          .from(schema.modelPoseAssets)
          .where(
            and(
              inArray(schema.modelPoseAssets.id, uncachedPoseIds),
              eq(schema.modelPoseAssets.isActive, true),
              isNull(schema.modelPoseAssets.deletedAt),
            ),
          ),
  ]);

  if (!face[0]) throw new AppError('BAD_CATALOG', 400, 'face not found or inactive');
  if (backgroundRows.length !== uncachedBackgroundIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more backgrounds not found or inactive');
  if (poses.length !== uncachedPoseIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more poses not found or inactive');

  // Only successful lookups are memoised. A miss throws above, so a failing ID is
  // never cached as good — and never cached as bad either, which keeps the cache
  // a pure optimisation.
  if (opts.cache) {
    opts.cache.faces.set(faceId, true);
    for (const id of uncachedBackgroundIds) opts.cache.backgrounds.set(id, true);
    for (const id of uncachedPoseIds) opts.cache.poses.set(id, true);
  }
```

Apply the same pattern to the `catalogChecks` block: skip the query when `opts.cache?.catalogItems.get(lowerCatalogId) === true` (likewise `shoeCatalogId` and `garmentTypes.get(garmentTypeId)`), and set the flag after each check passes.

- [ ] **Step 6: Use the cache from batch creation**

In `apps/api/src/modules/jobs/createBatch.ts`, import `createTryonPlanCache`, create one before the planning loop, and pass it:

```typescript
  const cache = createTryonPlanCache();
```

```typescript
          { resolvedUpperGarmentKey: row.upperGarmentKey, cache },
```

- [ ] **Step 7: Run the full batch and single-job suites**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts
pnpm --filter @tryme/api test:integration -- test/integration/jobs-create-looks.test.ts
pnpm --filter @tryme/api test:integration -- test/integration/jobs-create-mannequin.test.ts
pnpm --filter @tryme/api test:integration -- test/integration/jobs-create-background-ownership.test.ts
```

Expected: all pass. The parity test in `batch-jobs.test.ts` is the one that matters — it proves batch and single-job submissions still write identical `job_inputs`.

- [ ] **Step 8: Confirm the query count dropped**

```bash
pnpm --filter @tryme/api test:integration -- test/integration/batch-jobs.test.ts 2>&1 | grep -c 'select'
```

Expected: materially lower than the Step 1 figure.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/createBatch.ts
git commit -m "perf(api): memoise resolveTryonPlan lookups across a batch"
```

---

### Task 10: Batch client state

Pure state module for the grid. It holds no JSX so the reducer logic stays reviewable on its own, and it delegates the lower/shoe rule to `requiredInputsForPoses` from Task 2 rather than re-deriving it.

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/types.ts`
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/use-batch-state.ts`

**Interfaces:**
- Consumes: `requiredInputsForPoses`, `countBatchJobs` from `@tryme/types`.
- Produces:

```typescript
export interface TrayGarment {
  id: string;              // client-side id, stable across re-render
  r2Key: string | null;    // null while uploading
  previewUrl: string;      // object URL or presigned GET
  fileName: string;
  progress: number;        // 0-100
  error: string | null;
}

export interface BatchRowState {
  id: string;
  garmentId: string | null;
  faceId: string;
  backgroundId: string;
  poseIds: string[];
  lowerCatalogId: string;
  shoeCatalogId: string;
}

export interface PoseOption { id: string; hasLower: boolean; hasShoes: boolean }

export function useBatchState(defaultFaceId: string): {
  rows: BatchRowState[];
  addRow: () => void;
  duplicateRow: (rowId: string) => void;
  removeRow: (rowId: string) => void;
  patchRow: (rowId: string, patch: Partial<BatchRowState>) => void;
  setPoses: (rowId: string, poseIds: string[], poses: PoseOption[]) => void;
  resetRows: () => void;
};

export function rowIssues(row: BatchRowState, poses: PoseOption[]): string[];
export function batchIssues(rows: BatchRowState[], poses: PoseOption[]): { invalidRowIds: string[]; totalJobs: number };
```

- [ ] **Step 1: Write the types module**

```typescript
// apps/catalogues-web/src/app/(app)/studio/batch/types.ts
export interface TrayGarment {
  /** Stable client-side id. Not the R2 key — that arrives after the upload. */
  id: string;
  /** null while the upload is in flight or has failed. */
  r2Key: string | null;
  previewUrl: string;
  fileName: string;
  progress: number;
  error: string | null;
}

export interface BatchRowState {
  id: string;
  garmentId: string | null;
  faceId: string;
  backgroundId: string;
  poseIds: string[];
  lowerCatalogId: string;
  shoeCatalogId: string;
}

export interface PoseOption {
  id: string;
  hasLower: boolean;
  hasShoes: boolean;
}
```

- [ ] **Step 2: Write the state hook**

```typescript
// apps/catalogues-web/src/app/(app)/studio/batch/use-batch-state.ts
'use client';
import { countBatchJobs, requiredInputsForPoses } from '@tryme/types';
import { useCallback, useState } from 'react';
import type { BatchRowState, PoseOption } from './types';

function newRow(faceId: string): BatchRowState {
  return {
    id: crypto.randomUUID(),
    garmentId: null,
    faceId,
    backgroundId: '',
    poseIds: [],
    lowerCatalogId: '',
    shoeCatalogId: '',
  };
}

/**
 * Lists what a row is still missing. Empty means the row is submittable.
 * The lower/shoe rule comes from requiredInputsForPoses so the client and the
 * API cannot drift — the API rejects exactly what this predicts.
 */
export function rowIssues(row: BatchRowState, poses: PoseOption[]): string[] {
  const issues: string[] = [];
  if (!row.garmentId) issues.push('garment');
  if (!row.faceId) issues.push('model');
  if (!row.backgroundId) issues.push('background');
  if (row.poseIds.length === 0) issues.push('pose');

  const selected = poses.filter((p) => row.poseIds.includes(p.id));
  const { needsLower, needsShoes } = requiredInputsForPoses(selected);
  if (needsLower && !row.lowerCatalogId) issues.push('lower garment');
  if (needsShoes && !row.shoeCatalogId) issues.push('shoes');
  return issues;
}

export function batchIssues(
  rows: BatchRowState[],
  poses: PoseOption[],
): { invalidRowIds: string[]; totalJobs: number } {
  return {
    invalidRowIds: rows.filter((r) => rowIssues(r, poses).length > 0).map((r) => r.id),
    totalJobs: countBatchJobs(rows),
  };
}

export function useBatchState(defaultFaceId: string) {
  const [rows, setRows] = useState<BatchRowState[]>([newRow(defaultFaceId)]);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, newRow(defaultFaceId)]);
  }, [defaultFaceId]);

  const duplicateRow = useCallback((rowId: string) => {
    setRows((prev) => {
      const index = prev.findIndex((r) => r.id === rowId);
      if (index === -1) return prev;
      const copy = { ...prev[index], id: crypto.randomUUID() };
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });
  }, []);

  // The grid must never reach zero rows — an empty grid has no affordance to add
  // one back that is discoverable mid-task.
  const removeRow = useCallback(
    (rowId: string) => {
      setRows((prev) => (prev.length === 1 ? [newRow(defaultFaceId)] : prev.filter((r) => r.id !== rowId)));
    },
    [defaultFaceId],
  );

  const patchRow = useCallback((rowId: string, patch: Partial<BatchRowState>) => {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }, []);

  /**
   * Changing the pose selection can retire the lower/shoe requirement. Clear the
   * now-irrelevant values rather than submitting them: the API strips inputs the
   * workflow does not support, so leaving them set would show the user a
   * selection that silently has no effect.
   */
  const setPoses = useCallback((rowId: string, poseIds: string[], poses: PoseOption[]) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        const selected = poses.filter((p) => poseIds.includes(p.id));
        const { needsLower, needsShoes } = requiredInputsForPoses(selected);
        return {
          ...r,
          poseIds,
          lowerCatalogId: needsLower ? r.lowerCatalogId : '',
          shoeCatalogId: needsShoes ? r.shoeCatalogId : '',
        };
      }),
    );
  }, []);

  const resetRows = useCallback(() => {
    setRows([newRow(defaultFaceId)]);
  }, [defaultFaceId]);

  return { rows, addRow, duplicateRow, removeRow, patchRow, setPoses, resetRows };
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/batch/types.ts" "apps/catalogues-web/src/app/(app)/studio/batch/use-batch-state.ts"
git commit -m "feat(web): add batch grid state module"
```

---

### Task 11: Garment tray

Multi-file upload plus a past-uploads picker. Each file uploads independently so one failure does not block the rest.

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/garment-tray.tsx`

**Interfaces:**
- Consumes: `TrayGarment` from `./types`; `api` from `@/lib/api`; `C` from `@/components/tokens`.
- Produces:

```typescript
export function GarmentTray(props: {
  garments: TrayGarment[];
  onAdd: (garments: TrayGarment[]) => void;
  onPatch: (id: string, patch: Partial<TrayGarment>) => void;
  onRemove: (id: string) => void;
  selectedGarmentId: string | null;
  onSelect: (id: string) => void;
}): React.ReactElement;

export async function uploadTrayFile(
  file: File,
  onProgress: (pct: number) => void,
): Promise<string>;
```

- [ ] **Step 1: Write the module**

```tsx
// apps/catalogues-web/src/app/(app)/studio/batch/garment-tray.tsx
'use client';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';
import { useCallback, useRef } from 'react';
import type { TrayGarment } from './types';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Presigns and uploads one file, resolving to its R2 key. Each call gets its own
 * key from /v1/uploads/presign (the UUID in the key is a per-upload token, not
 * the user id), so parallel uploads never collide.
 */
export async function uploadTrayFile(
  file: File,
  onProgress: (pct: number) => void,
): Promise<string> {
  const { uploadUrl, r2Key } = await api.post<{
    uploadUrl: string;
    r2Key: string;
    expiresIn: number;
  }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
  await api.uploadToR2WithProgress(uploadUrl, file, onProgress);
  return r2Key;
}

export function GarmentTray({
  garments,
  onAdd,
  onPatch,
  onRemove,
  selectedGarmentId,
  onSelect,
}: {
  garments: TrayGarment[];
  onAdd: (garments: TrayGarment[]) => void;
  onPatch: (id: string, patch: Partial<TrayGarment>) => void;
  onRemove: (id: string) => void;
  selectedGarmentId: string | null;
  onSelect: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      const files = Array.from(fileList);

      const pending: TrayGarment[] = files.map((file) => ({
        id: crypto.randomUUID(),
        r2Key: null,
        previewUrl: URL.createObjectURL(file),
        fileName: file.name,
        progress: 0,
        error: file.size > MAX_FILE_BYTES ? 'Over 10 MB' : null,
      }));
      onAdd(pending);

      // Uploads run independently: one rejected file leaves the others alone,
      // and the tile keeps its own retry affordance.
      pending.forEach((entry, i) => {
        if (entry.error) return;
        uploadTrayFile(files[i], (pct) => onPatch(entry.id, { progress: pct }))
          .then((r2Key) => onPatch(entry.id, { r2Key, progress: 100, error: null }))
          .catch((err: Error) => onPatch(entry.id, { error: err.message || 'Upload failed' }));
      });
    },
    [onAdd, onPatch],
  );

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ color: C.text }}>Garments</strong>
        <button type="button" onClick={() => inputRef.current?.click()}>
          Add images
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFiles(e.target.files);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = '';
        }}
      />

      <div
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => e.preventDefault()}
        style={{
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
          gap: 8,
          minHeight: 112,
        }}
      >
        {garments.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            title={g.fileName}
            style={{
              position: 'relative',
              padding: 0,
              borderRadius: 8,
              overflow: 'hidden',
              border: `2px solid ${g.id === selectedGarmentId ? C.pink : C.border}`,
              opacity: g.r2Key ? 1 : 0.6,
              cursor: 'pointer',
            }}
          >
            {/* biome-ignore lint/performance/noImgElement: object URLs cannot go through next/image */}
            <img
              src={g.previewUrl}
              alt={g.fileName}
              style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }}
            />
            {!g.r2Key && !g.error && (
              <span style={{ position: 'absolute', inset: 'auto 0 0 0', fontSize: 11 }}>
                {g.progress}%
              </span>
            )}
            {g.error && (
              <span style={{ position: 'absolute', inset: 'auto 0 0 0', fontSize: 11 }}>
                {g.error}
              </span>
            )}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(g.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  onRemove(g.id);
                }
              }}
              style={{ position: 'absolute', top: 2, right: 4, fontSize: 12 }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify `api.uploadToR2WithProgress` accepts a two-argument callback form**

```bash
grep -n 'uploadToR2WithProgress' apps/catalogues-web/src/lib/api.ts
```

If its signature requires an `AbortSignal`, pass `new AbortController().signal` as the fourth argument in `uploadTrayFile`.

- [ ] **Step 3: Add the past-uploads tab**

`/v1/assets` lists the user's previously uploaded garments, deduplicated by R2 key, each with a presigned thumbnail URL. Those are already-owned keys, so they enter the tray fully uploaded.

Add to the imports:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
```

Add inside `GarmentTray`, above the `return`:

```typescript
  const [tab, setTab] = useState<'upload' | 'past'>('upload');

  const pastAssets = useQuery({
    queryKey: ['assets'],
    queryFn: () =>
      api.get<Array<{ r2Key: string; thumbnailUrl?: string | null; uploadedAt: string }>>(
        '/v1/assets',
      ),
    enabled: tab === 'past',
  });

  // A past asset already has its key, so it lands in the tray at 100% with no
  // upload. Re-adding one that is already present is a no-op rather than a
  // duplicate tile.
  const addPastAsset = (r2Key: string, thumbnailUrl: string | null) => {
    if (garments.some((g) => g.r2Key === r2Key)) return;
    onAdd([
      {
        id: crypto.randomUUID(),
        r2Key,
        previewUrl: thumbnailUrl ?? '',
        fileName: r2Key.split('/').slice(-2, -1)[0] ?? 'Previous upload',
        progress: 100,
        error: null,
      },
    ]);
  };
```

Render the tab strip directly under the `Garments` heading row:

```tsx
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {(['upload', 'past'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: `1px solid ${tab === t ? C.pink : C.border}`,
              background: 'transparent',
              color: tab === t ? C.pink : C.textMuted,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t === 'upload' ? 'New uploads' : 'Past uploads'}
          </button>
        ))}
      </div>

      {tab === 'past' && (
        <div
          style={{
            marginTop: 8,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
            gap: 8,
          }}
        >
          {(pastAssets.data ?? []).map((asset) => (
            <button
              key={asset.r2Key}
              type="button"
              onClick={() => addPastAsset(asset.r2Key, asset.thumbnailUrl ?? null)}
              style={{
                padding: 0,
                borderRadius: 8,
                overflow: 'hidden',
                border: `1px solid ${C.border}`,
                cursor: 'pointer',
              }}
            >
              {/* biome-ignore lint/performance/noImgElement: presigned R2 URLs cannot go through next/image */}
              <img
                src={asset.thumbnailUrl ?? ''}
                alt="Previous upload"
                style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }}
              />
            </button>
          ))}
          {pastAssets.data?.length === 0 && (
            <p style={{ color: C.textMuted, fontSize: 13 }}>No previous uploads yet.</p>
          )}
        </div>
      )}
```

Wrap the existing drop-zone `div` so it only renders when `tab === 'upload'`.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/batch/garment-tray.tsx"
git commit -m "feat(web): add batch garment tray with parallel uploads"
```

---

### Task 12: Row and grid

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/batch-row.tsx`
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/batch-grid.tsx`

**Interfaces:**
- Consumes: `BatchRowState`, `PoseOption`, `TrayGarment` from `./types`; `rowIssues` from `./use-batch-state`; `SelectGridModal` from `../select-modal`.
- Produces:

```typescript
export interface PickerItem { id: string; label: string; thumbnailUrl?: string | null; tags?: string[] }

export function BatchRow(props: {
  row: BatchRowState;
  index: number;
  garments: TrayGarment[];
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  invalid: boolean;
  onPatch: (patch: Partial<BatchRowState>) => void;
  onSetPoses: (poseIds: string[]) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}): React.ReactElement;

export function BatchGrid(props: { /* the same option lists, plus rows and the handlers from useBatchState */ }): React.ReactElement;
```

- [ ] **Step 1: Write `batch-row.tsx`**

```tsx
// apps/catalogues-web/src/app/(app)/studio/batch/batch-row.tsx
'use client';
import { C } from '@/components/tokens';
import { requiredInputsForPoses } from '@tryme/types';
import { useState } from 'react';
import { SelectGridModal } from '../select-modal';
import type { BatchRowState, PoseOption, TrayGarment } from './types';
import { rowIssues } from './use-batch-state';

export interface PickerItem {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  tags?: string[];
}

type OpenPicker = 'garment' | 'face' | 'background' | 'pose' | 'lower' | 'shoe' | null;

/** A single grid cell: shows the current selection, opens a picker on click. */
function Cell({
  label,
  value,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: disabled ? C.bgMuted : C.white,
        color: disabled ? C.textMuted : C.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: '100%',
      }}
    >
      <span style={{ display: 'block', fontSize: 11, color: C.textMuted }}>{label}</span>
      <span style={{ display: 'block', fontSize: 13 }}>{value}</span>
    </button>
  );
}

export function BatchRow({
  row,
  index,
  garments,
  faces,
  backgrounds,
  poses,
  lowerItems,
  shoeItems,
  invalid,
  onPatch,
  onSetPoses,
  onDuplicate,
  onRemove,
}: {
  row: BatchRowState;
  index: number;
  garments: TrayGarment[];
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  invalid: boolean;
  onPatch: (patch: Partial<BatchRowState>) => void;
  onSetPoses: (poseIds: string[]) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const [picker, setPicker] = useState<OpenPicker>(null);

  const garment = garments.find((g) => g.id === row.garmentId) ?? null;
  const face = faces.find((f) => f.id === row.faceId) ?? null;
  const background = backgrounds.find((b) => b.id === row.backgroundId) ?? null;
  const selectedPoses = poses.filter((p) => row.poseIds.includes(p.id));
  const { needsLower, needsShoes } = requiredInputsForPoses(selectedPoses);
  const issues = rowIssues(row, poses);

  const garmentItems: PickerItem[] = garments.map((g) => ({
    id: g.id,
    label: g.fileName,
    thumbnailUrl: g.previewUrl,
  }));

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px repeat(6, 1fr) 72px',
          gap: 8,
          alignItems: 'center',
          padding: 8,
          borderRadius: 10,
          border: `1px solid ${invalid ? C.danger : 'transparent'}`,
        }}
      >
        <span style={{ color: C.textMuted, fontSize: 12 }}>{index + 1}</span>

        <Cell
          label="Garment"
          value={garment?.fileName ?? 'Choose'}
          onClick={() => setPicker('garment')}
        />
        <Cell label="Model" value={face?.label ?? 'Choose'} onClick={() => setPicker('face')} />
        <Cell
          label="Background"
          value={background?.label ?? 'Choose'}
          onClick={() => setPicker('background')}
        />
        <Cell
          label="Poses"
          value={row.poseIds.length ? `${row.poseIds.length} selected` : 'Choose'}
          onClick={() => setPicker('pose')}
        />
        <Cell
          label="Lower"
          value={
            needsLower
              ? (lowerItems.find((i) => i.id === row.lowerCatalogId)?.label ?? 'Choose')
              : 'Not needed'
          }
          disabled={!needsLower}
          onClick={() => setPicker('lower')}
        />
        <Cell
          label="Shoes"
          value={
            needsShoes
              ? (shoeItems.find((i) => i.id === row.shoeCatalogId)?.label ?? 'Choose')
              : 'Not needed'
          }
          disabled={!needsShoes}
          onClick={() => setPicker('shoe')}
        />

        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={onDuplicate} title="Duplicate row">
            ⧉
          </button>
          <button type="button" onClick={onRemove} title="Remove row">
            ×
          </button>
        </div>
      </div>

      {invalid && (
        <p style={{ margin: '0 0 8px 40px', fontSize: 12, color: C.danger }}>
          Missing: {issues.join(', ')}
        </p>
      )}

      {picker === 'garment' && (
        <SelectGridModal
          title="Choose garment"
          items={garmentItems}
          selectedIds={row.garmentId ? [row.garmentId] : []}
          onSelect={(id) => {
            onPatch({ garmentId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'face' && (
        <SelectGridModal
          title="Choose model"
          items={faces}
          selectedIds={row.faceId ? [row.faceId] : []}
          onSelect={(id) => {
            onPatch({ faceId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'background' && (
        <SelectGridModal
          title="Choose background"
          items={backgrounds}
          selectedIds={row.backgroundId ? [row.backgroundId] : []}
          onSelect={(id) => {
            onPatch({ backgroundId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'pose' && (
        <SelectGridModal
          title="Choose poses"
          items={poses}
          multiSelect
          selectedIds={row.poseIds}
          continueLabel="Done"
          onSelect={(id) =>
            onSetPoses(
              row.poseIds.includes(id)
                ? row.poseIds.filter((p) => p !== id)
                : [...row.poseIds, id],
            )
          }
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'lower' && (
        <SelectGridModal
          title="Choose lower garment"
          items={lowerItems}
          selectedIds={row.lowerCatalogId ? [row.lowerCatalogId] : []}
          onSelect={(id) => {
            onPatch({ lowerCatalogId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === 'shoe' && (
        <SelectGridModal
          title="Choose shoes"
          items={shoeItems}
          selectedIds={row.shoeCatalogId ? [row.shoeCatalogId] : []}
          onSelect={(id) => {
            onPatch({ shoeCatalogId: id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Write `batch-grid.tsx`**

```tsx
// apps/catalogues-web/src/app/(app)/studio/batch/batch-grid.tsx
'use client';
import { C } from '@/components/tokens';
import { BatchRow, type PickerItem } from './batch-row';
import type { BatchRowState, PoseOption, TrayGarment } from './types';

export function BatchGrid({
  rows,
  invalidRowIds,
  garments,
  faces,
  backgrounds,
  poses,
  lowerItems,
  shoeItems,
  onPatchRow,
  onSetPoses,
  onDuplicateRow,
  onRemoveRow,
  onAddRow,
}: {
  rows: BatchRowState[];
  invalidRowIds: string[];
  garments: TrayGarment[];
  faces: PickerItem[];
  backgrounds: PickerItem[];
  poses: Array<PickerItem & PoseOption>;
  lowerItems: PickerItem[];
  shoeItems: PickerItem[];
  onPatchRow: (rowId: string, patch: Partial<BatchRowState>) => void;
  onSetPoses: (rowId: string, poseIds: string[]) => void;
  onDuplicateRow: (rowId: string) => void;
  onRemoveRow: (rowId: string) => void;
  onAddRow: () => void;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      {rows.map((row, index) => (
        <BatchRow
          key={row.id}
          row={row}
          index={index}
          garments={garments}
          faces={faces}
          backgrounds={backgrounds}
          poses={poses}
          lowerItems={lowerItems}
          shoeItems={shoeItems}
          invalid={invalidRowIds.includes(row.id)}
          onPatch={(patch) => onPatchRow(row.id, patch)}
          onSetPoses={(poseIds) => onSetPoses(row.id, poseIds)}
          onDuplicate={() => onDuplicateRow(row.id)}
          onRemove={() => onRemoveRow(row.id)}
        />
      ))}
      <button
        type="button"
        onClick={onAddRow}
        style={{
          marginTop: 8,
          padding: '8px 14px',
          borderRadius: 8,
          border: `1px dashed ${C.border}`,
          background: 'transparent',
          color: C.text,
          cursor: 'pointer',
        }}
      >
        + Add row
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Make the row responsive**

The six-column grid is unusable below roughly 900px. The row keeps identical state and pickers and only changes its layout: stacked full-width cells with their labels, instead of a table row.

Add to `batch-row.tsx`, above `BatchRow`:

```typescript
/**
 * Matches the CSS breakpoint the rest of Studio uses. A media-query hook rather
 * than a CSS class because the grid template lives in inline styles alongside
 * the rest of this page's styling.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}
```

Import `useEffect` alongside `useState`. Inside `BatchRow`, call it and swap the container style:

```typescript
  const narrow = useIsNarrow();
```

```typescript
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '32px repeat(6, 1fr) 72px',
          gap: 8,
          alignItems: narrow ? 'stretch' : 'center',
          padding: 8,
          borderRadius: 10,
          border: `1px solid ${invalid ? C.danger : narrow ? C.border : 'transparent'}`,
          marginBottom: narrow ? 12 : 0,
        }}
```

On narrow screens the row index reads as a heading rather than a bare number, so change the index span to:

```tsx
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          {narrow ? `Row ${index + 1}` : index + 1}
        </span>
```

- [ ] **Step 4: Confirm the token names used above exist**

```bash
grep -nE 'pink|text|textMuted|border|white|bgMuted|danger' apps/catalogues-web/src/components/tokens.ts
```

Substitute the nearest existing token for any name that is absent. Do not introduce a raw hex value.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/batch/batch-row.tsx" "apps/catalogues-web/src/app/(app)/studio/batch/batch-grid.tsx"
git commit -m "feat(web): add batch row and grid components"
```

---

### Task 13: Batch mode shell, summary bar, and Studio toggle

Wires everything together and puts a `Single | Batch` toggle on the Studio page.

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/summary-bar.tsx`
- Create: `apps/catalogues-web/src/app/(app)/studio/batch/batch-mode.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: everything from Tasks 10–12; `POST /v1/jobs/batch` from Task 5.
- Produces: `<BatchMode />`, rendered by `page.tsx` when `mode === 'batch'`.

- [ ] **Step 1: Write `summary-bar.tsx`**

```tsx
// apps/catalogues-web/src/app/(app)/studio/batch/summary-bar.tsx
'use client';
import { C } from '@/components/tokens';

export function SummaryBar({
  rowCount,
  totalJobs,
  creditCost,
  balance,
  maxBatchJobs,
  invalidRowCount,
  submitting,
  onSubmit,
}: {
  rowCount: number;
  totalJobs: number;
  creditCost: number;
  balance: number | null;
  maxBatchJobs: number;
  invalidRowCount: number;
  submitting: boolean;
  onSubmit: () => void;
}) {
  // One specific reason, in the order the user can act on it.
  const blockedReason =
    invalidRowCount > 0
      ? `${invalidRowCount} row${invalidRowCount === 1 ? '' : 's'} incomplete`
      : totalJobs === 0
        ? 'Add at least one pose'
        : totalJobs > maxBatchJobs
          ? `Over the ${maxBatchJobs}-image limit`
          : balance !== null && balance < creditCost
            ? `Need ${creditCost} credits, you have ${balance}`
            : null;

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 16px',
        marginTop: 16,
        borderTop: `1px solid ${C.border}`,
        background: C.white,
      }}
    >
      <span style={{ color: C.textMuted, fontSize: 13 }}>
        {rowCount} rows · {totalJobs} images · {creditCost} credits
        {balance !== null ? ` · balance ${balance}` : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {blockedReason && <span style={{ color: C.danger, fontSize: 13 }}>{blockedReason}</span>}
        <button type="button" disabled={!!blockedReason || submitting} onClick={onSubmit}>
          {submitting ? 'Submitting…' : `Generate ${totalJobs} images`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `batch-mode.tsx`**

```tsx
// apps/catalogues-web/src/app/(app)/studio/batch/batch-mode.tsx
'use client';
import { api } from '@/lib/api';
import { DEFAULT_MAX_BATCH_JOBS } from '@tryme/types';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { PickerItem } from './batch-row';
import { BatchGrid } from './batch-grid';
import { GarmentTray } from './garment-tray';
import { SummaryBar } from './summary-bar';
import type { PoseOption, TrayGarment } from './types';
import { batchIssues, useBatchState } from './use-batch-state';

export function BatchMode({
  gender,
  garmentTypeId,
  defaultFaceId,
  aspectRatio,
  resolution,
  platform,
  creditCostPerImage,
  balance,
}: {
  gender: string;
  garmentTypeId: string;
  defaultFaceId: string;
  aspectRatio: string;
  resolution: string;
  platform?: string;
  creditCostPerImage: number;
  balance: number | null;
}) {
  const router = useRouter();
  const [garments, setGarments] = useState<TrayGarment[]>([]);
  const [selectedGarmentId, setSelectedGarmentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const { rows, addRow, duplicateRow, removeRow, patchRow, setPoses } =
    useBatchState(defaultFaceId);

  const faces = useQuery({
    queryKey: ['batch-faces', gender, garmentTypeId],
    queryFn: () =>
      api.get<PickerItem[]>(`/v1/models/faces?gender=${gender}&garmentTypeId=${garmentTypeId}`),
  });
  const backgrounds = useQuery({
    queryKey: ['batch-backgrounds', defaultFaceId],
    queryFn: () => api.get<PickerItem[]>(`/v1/models/backgrounds?faceId=${defaultFaceId}`),
    enabled: !!defaultFaceId,
  });
  const poses = useQuery({
    queryKey: ['batch-poses', gender, garmentTypeId],
    queryFn: () =>
      api.get<Array<PickerItem & PoseOption>>(
        `/v1/models/poses?gender=${gender}&garmentTypeId=${garmentTypeId}`,
      ),
    enabled: !!garmentTypeId,
  });
  const lowerItems = useQuery({
    queryKey: ['batch-lower'],
    queryFn: () => api.get<PickerItem[]>('/v1/catalog/lower'),
  });
  const shoeItems = useQuery({
    queryKey: ['batch-shoe'],
    queryFn: () => api.get<PickerItem[]>('/v1/catalog/shoe'),
  });

  const poseOptions = useMemo(() => poses.data ?? [], [poses.data]);
  const { invalidRowIds, totalJobs } = batchIssues(rows, poseOptions);

  const onAddGarments = useCallback((added: TrayGarment[]) => {
    setGarments((prev) => [...prev, ...added]);
  }, []);
  const onPatchGarment = useCallback((id: string, patch: Partial<TrayGarment>) => {
    setGarments((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }, []);
  const onRemoveGarment = useCallback((id: string) => {
    setGarments((prev) => prev.filter((g) => g.id !== id));
  }, []);

  async function handleSubmit() {
    setSubmitting(true);
    setError('');
    try {
      // Rows carry a client-side garment id; the API takes the R2 key. A row
      // whose upload has not landed yet is not submittable, and rowIssues has
      // already blocked that case via the disabled submit button.
      const payloadRows = rows.map((row) => {
        const garment = garments.find((g) => g.id === row.garmentId);
        if (!garment?.r2Key) throw new Error('A garment is still uploading');
        return {
          upperGarmentKey: garment.r2Key,
          faceId: row.faceId,
          backgroundId: row.backgroundId,
          poseIds: row.poseIds,
          ...(row.lowerCatalogId ? { lowerCatalogId: row.lowerCatalogId } : {}),
          ...(row.shoeCatalogId ? { shoeCatalogId: row.shoeCatalogId } : {}),
        };
      });

      const result = await api.post<{ batchId: string }>('/v1/jobs/batch', {
        garmentTypeId,
        aspectRatio,
        resolution,
        ...(platform ? { platform } : {}),
        rows: payloadRows,
      });
      router.push(`/catalogues?batch=${result.batchId}`);
    } catch (e) {
      setError((e as Error).message || 'Batch submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <GarmentTray
        garments={garments}
        onAdd={onAddGarments}
        onPatch={onPatchGarment}
        onRemove={onRemoveGarment}
        selectedGarmentId={selectedGarmentId}
        onSelect={setSelectedGarmentId}
      />

      <BatchGrid
        rows={rows}
        invalidRowIds={invalidRowIds}
        garments={garments}
        faces={faces.data ?? []}
        backgrounds={backgrounds.data ?? []}
        poses={poseOptions}
        lowerItems={lowerItems.data ?? []}
        shoeItems={shoeItems.data ?? []}
        onPatchRow={patchRow}
        onSetPoses={(rowId, poseIds) => setPoses(rowId, poseIds, poseOptions)}
        onDuplicateRow={duplicateRow}
        onRemoveRow={removeRow}
        onAddRow={addRow}
      />

      {error && <p role="alert">{error}</p>}

      <SummaryBar
        rowCount={rows.length}
        totalJobs={totalJobs}
        creditCost={totalJobs * creditCostPerImage}
        balance={balance}
        maxBatchJobs={DEFAULT_MAX_BATCH_JOBS}
        invalidRowCount={invalidRowIds.length}
        submitting={submitting}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
```

- [ ] **Step 3: Add the mode toggle to the Studio page**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, add the import:

```typescript
import { BatchMode } from './batch/batch-mode';
```

Add the state next to the other `useState` declarations near line 385:

```typescript
  const [mode, setMode] = useState<'single' | 'batch'>('single');
```

Render the toggle above the existing wizard, and gate the wizard on `mode === 'single'`:

```tsx
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['single', 'batch'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={{
              padding: '6px 14px',
              borderRadius: 999,
              border: `1px solid ${mode === m ? C.pink : C.border}`,
              background: mode === m ? C.pink : 'transparent',
              color: mode === m ? C.white : C.text,
              cursor: 'pointer',
            }}
          >
            {m === 'single' ? 'Single' : 'Batch'}
          </button>
        ))}
      </div>

      {mode === 'batch' ? (
        <BatchMode
          gender={gender}
          garmentTypeId={garmentTypeId}
          defaultFaceId={faceId}
          aspectRatio={aspect}
          resolution={resolution}
          platform={platform}
          creditCostPerImage={creditCostPerImage}
          balance={balance}
        />
      ) : (
        /* existing single-mode wizard JSX, unchanged */
      )}
```

`resolution`, `creditCostPerImage` and `balance` already exist on this page — find their current identifiers with `grep -nE 'resolution|creditCost|balance' page.tsx` and use those names rather than introducing new state.

- [ ] **Step 4: Clear pose selections when the garment type changes**

Pose availability is scoped to the garment type — `/v1/models/poses?garmentTypeId=` returns a different set, and `pose_garment_configs` can deactivate a pose for one type specifically. Leaving stale pose ids in the rows would submit combinations the API rejects with a `BAD_CATALOG` naming a row the user never touched.

In `batch-mode.tsx`, take `resetRows` from `useBatchState` and add:

```typescript
  const [confirmingTypeChange, setConfirmingTypeChange] = useState<string | null>(null);
  const [appliedGarmentTypeId, setAppliedGarmentTypeId] = useState(garmentTypeId);

  // Changing the type mid-grid throws away work, so ask first rather than
  // silently emptying the rows the user just filled in.
  useEffect(() => {
    if (garmentTypeId === appliedGarmentTypeId) return;
    const hasWork = rows.some((r) => r.poseIds.length > 0 || r.garmentId);
    if (!hasWork) {
      setAppliedGarmentTypeId(garmentTypeId);
      resetRows();
      return;
    }
    setConfirmingTypeChange(garmentTypeId);
  }, [garmentTypeId, appliedGarmentTypeId, rows, resetRows]);
```

Render the confirmation above the grid:

```tsx
      {confirmingTypeChange && (
        <div role="alertdialog" style={{ padding: 12, border: `1px solid ${C.danger}`, borderRadius: 8 }}>
          <p style={{ margin: 0, color: C.text }}>
            Changing the garment type clears every row — poses differ per type.
          </p>
          <button
            type="button"
            onClick={() => {
              setAppliedGarmentTypeId(confirmingTypeChange);
              resetRows();
              setConfirmingTypeChange(null);
            }}
          >
            Clear rows and continue
          </button>
        </div>
      )}
```

Import `useEffect` alongside the other React hooks.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 6: Run the app and exercise the flow**

```bash
pnpm --filter @tryme/api dev &
pnpm --filter @tryme/web dev
```

Open `http://localhost:3000/studio`, switch to Batch, and confirm:
- dropping three images shows three tiles that each reach 100%;
- a row with no pose shows `Missing: pose` and the submit button names the incomplete row count;
- selecting a pose that needs a lower garment enables the Lower cell, and deselecting it disables and clears it;
- submitting redirects to `/catalogues?batch=<uuid>` and the jobs appear.

- [ ] **Step 7: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/batch/summary-bar.tsx" "apps/catalogues-web/src/app/(app)/studio/batch/batch-mode.tsx" "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): add batch generation mode to Studio"
```

---

### Task 14: Batch-filtered catalogues view

`/catalogues?batch=<id>` shows only that batch's catalogues with live progress.

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogues/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/batches/:id` from Task 8.

- [ ] **Step 1: Read the current page**

```bash
sed -n '1,80p' "apps/catalogues-web/src/app/(app)/catalogues/page.tsx"
```

Note how it fetches its list and what its card component expects.

- [ ] **Step 2: Add the batch-scoped query**

Add near the existing queries:

```typescript
  const searchParams = useSearchParams();
  const batchId = searchParams.get('batch');

  // A batch view is a filtered catalogues list, not a separate page: the batch
  // endpoint returns the same catalogueIds plus per-catalogue progress counts.
  const batch = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () =>
      api.get<{
        batchId: string;
        totalJobs: number;
        catalogues: Array<{
          catalogueId: string;
          total: number;
          completed: number;
          failed: number;
          createdAt: string;
        }>;
      }>(`/v1/batches/${batchId}`),
    enabled: !!batchId,
    // Poll while anything is still running. The per-user SSE stream also pushes
    // job transitions, but a poll is the simpler correctness floor here.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 4000;
      const done = data.catalogues.every((c) => c.completed + c.failed === c.total);
      return done ? false : 4000;
    },
  });
```

`useSearchParams` comes from `next/navigation`.

- [ ] **Step 3: Render the batch banner and filter the list**

Above the existing list:

```tsx
      {batchId && batch.data && (
        <div style={{ marginBottom: 16 }}>
          <strong style={{ color: C.text }}>
            Batch — {batch.data.catalogues.length} catalogues, {batch.data.totalJobs} images
          </strong>
          <span style={{ marginLeft: 12, color: C.textMuted, fontSize: 13 }}>
            {batch.data.catalogues.reduce((n, c) => n + c.completed, 0)} done,{' '}
            {batch.data.catalogues.reduce((n, c) => n + c.failed, 0)} failed
          </span>
        </div>
      )}
```

Then filter whatever array the page currently maps over:

```typescript
  const batchCatalogueIds = new Set(batch.data?.catalogues.map((c) => c.catalogueId) ?? []);
  const visibleCatalogues = batchId
    ? catalogues.filter((c) => batchCatalogueIds.has(c.catalogueId))
    : catalogues;
```

Substitute the page's real variable names for `catalogues` / `c.catalogueId`.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Verify end to end**

With the dev servers running, submit a batch from Studio and confirm the redirect lands on a filtered list whose counts advance as jobs complete.

- [ ] **Step 6: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/catalogues/page.tsx"
git commit -m "feat(web): filter catalogues by batch with live progress"
```

---

### Task 15: Full verification and docs

**Files:**
- Modify: `docs/progress.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both clean.

- [ ] **Step 2: Full unit suite**

```bash
pnpm --filter @tryme/api test:unit
```

Expected: passes.

- [ ] **Step 3: Full integration suite**

```bash
pnpm docker:up
pnpm --filter @tryme/api test:integration
```

Expected: `batch-jobs.test.ts` passes with 11 tests. Pre-existing failures listed in `apps/api/vitest.config.ts` (`jobs-create.test.ts`, `catalog.test.ts`, `e2e.test.ts`) may still fail — confirm they fail for their documented reasons and not because of this work, by checking they also fail on `git stash`.

- [ ] **Step 4: Document the new endpoints in CLAUDE.md**

In the `jobs/` row of the "API Route Modules" table, add `/v1/jobs/batch` and `/v1/batches/:id` to the listed routes.

- [ ] **Step 5: Add a dated progress entry**

Add a new entry at the top of `docs/progress.md` with **Done** (what shipped), **Failed / Not Done** (saree two-pass, catalogue templates and `thirdGarmentKey` are out of scope for batch v1), and **Open Questions / Decisions** (whether `maxBatchJobs` needs an admin-panel control rather than a raw `config:system` edit).

- [ ] **Step 6: Commit**

```bash
git add docs/progress.md CLAUDE.md
git commit -m "docs: record batch catalog generation"
```

---

## Notes for the implementer

**The parity test is the load-bearing one.** Task 9 refactors `resolveTryonPlan`, which every job-creation path in the product depends on. If `batch-jobs.test.ts`'s parity case fails, the cache has changed what the dispatcher receives — fix the cache, never the assertion.

**`atomicDeduct` inside a transaction is intentional.** It opens its own `db.transaction()`, which Drizzle turns into a savepoint when nested. The error propagating out of the callback is what rolls the batch back; do not wrap it in a `try/catch` that swallows it.

**The `config:system` Redis key is shared.** `getMaxBatchJobs` reads the same key as `getMaxOutputPx` and the resolution costs. Tests that write it must delete it in `beforeEach`, as `batch-jobs.test.ts` does.

**Do not touch the dispatcher.** Batch jobs are ordinary `CATALOG` jobs on the ordinary streams. If something seems to require a dispatcher change, the API is writing the wrong `job_inputs`.
