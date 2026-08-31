# Job Taxonomy Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eight independently-hardcoded job-type/job-source vocabularies across `apps/api`, `apps/dispatcher`, and `apps/admin-web` with one canonical registry (`packages/types/src/job-taxonomy.ts`), fixing a real bug (the admin Workers page can't assign the `merchant` worker pool) and a metric-label mismatch (`catalog` vs `catalogue`) along the way.

**Architecture:** Two independent, flat `as const` enums — `JOB_SOURCE` (13 values, the fine-grained "what created this job" taxonomy) and `WORKER_POOL` (5 values, the coarse "which admin-managed worker capability" split) — plus their Zod schemas, live in `packages/types` (already the cross-service shared-shapes package per `CLAUDE.md`). No mapping between the two levels exists (a prior draft's `SOURCE_TO_POOL` was proven incorrect for `merchant_catalog`, which claims two pools sequentially, and removed — see the design spec §9). Every dispatcher/API/admin-web call site that today embeds one of these vocabularies as a raw string switches to importing the shared constant instead. A three-way split of the legacy `source = 'api'` value, a backfill migration, and a permanent (not time-boxed) legacy-value allowance in three read filters close out the one genuinely stateful part of the change.

**Tech Stack:** TypeScript, Zod, Drizzle ORM (Postgres), Fastify 5, Vitest, React (admin-web, no test runner).

**Design spec:** `docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md` — read before starting if anything in a task seems to disagree with the summary above; the spec is the source of truth for *why*, this plan is the source of truth for *how*.

## Global Constraints

- Never hardcode a `JOB_SOURCE`/`WORKER_POOL`/`LEGACY_JOB_SOURCE` string literal in application code once `packages/types/src/job-taxonomy.ts` exists — always import the named constant.
- `apps/admin-web` gets zero new workspace-package dependencies and zero new test infrastructure (no `test` script, no test-framework devDependency) — this is a deliberate, existing boundary (spec §2, §8). Admin-web tasks fetch taxonomy data over HTTP and are verified manually via the dev server, not via `pnpm test`.
- Never run `pnpm db:generate`, hand-edit `_journal.json`, or apply a migration against a production/live DB directly — the migration in this plan goes through the normal `db:generate` → PR → CI/CD → `db:migrate:prod` path per `CLAUDE.md`.
- `jobs.source` stays a freeform `text` column — no CHECK constraint or DB enum is added (spec §10).
- No `SOURCE_TO_POOL` (or any source→pool mapping, of any shape) is introduced anywhere in this plan — see spec §9 for why one was rejected. Dispatcher pool selection stays driven by job phase/shape, exactly as it works today; only the string literals become named constants.
- Every `pnpm --filter <pkg> typecheck` / `pnpm --filter <pkg> test` command in this plan must be run from the repo root (`C:\Users\prave\OneDrive\Desktop\tryme`).

---

## File Structure

**Create:**
- `packages/types/src/job-taxonomy.ts` — the registry: `JOB_SOURCE`, `JobSource`, `jobSourceSchema`, `LEGACY_JOB_SOURCE`, `WORKER_POOL`, `WorkerPool`, `workerPoolSchema`
- `packages/db/src/migrations/0133_backfill_api_source_split.sql` — three-way classification backfill for historical `source = 'api'` rows
- `apps/api/test/integration/admin-job-taxonomy.test.ts` — tests for the two new `GET` routes and the `workers.routes.ts` `merchant` regression
- `apps/api/test/integration/api-source-migration.test.ts` — executes the real migration `.sql` file against seeded legacy rows and asserts classification

**Modify (grouped by task):**
- `packages/types/src/index.ts` — barrel export
- `apps/api/src/modules/admin/workers.routes.ts` — Zod fix + new `/admin/workers/job-types` route
- `apps/dispatcher/src/job/processor.ts`, `apps/dispatcher/src/job/mannequin-phase.ts`, `apps/dispatcher/src/stream/sweeper.ts` — literal → `WORKER_POOL`/`JOB_SOURCE` constants
- `apps/admin-web/src/pages/WorkersPage.tsx` — fetch job types instead of hardcoding them
- `apps/api/src/modules/jobs/create.ts`, `apps/api/src/modules/jobs/createSaree.ts`, `apps/api/src/modules/jobs/createSareeMannequin.ts` — typed `source`, literal → constant
- `apps/api/src/modules/merchant/create-job.ts`, `apps/api/src/modules/merchant/create-tryon-job.ts`, `apps/api/src/modules/kiosk/create-job.ts`, `apps/api/src/modules/shopify/customer.routes.ts` — literal → constant
- `apps/api/src/modules/admin/job-type.ts`, `apps/api/src/modules/admin/credit-analysis.routes.ts` — literal → constant
- `apps/api/src/modules/admin/jobs.routes.ts` — new `/admin/jobs/sources` route
- `apps/admin-web/src/lib/data.ts` — `jobTypeBadge` fallback warning
- `apps/api/src/modules/dev/create-job.ts`, `apps/api/src/modules/dev/create-saree-mannequin-job.ts`, `apps/api/src/modules/dev/catalog.routes.ts`, `apps/api/src/modules/dev/routes.ts`, `apps/api/src/modules/merchant/api-keys.routes.ts` — three-way `api` split, permanent legacy-inclusion read filters
- `apps/api/test/merchant-api-keys.test.ts`, `apps/api/test/dev-read-routes.test.ts` — seed `JOB_SOURCE.API_TRYON` instead of raw `'api'`

---

## Task 1: The Registry — `packages/types/src/job-taxonomy.ts`

**Files:**
- Create: `packages/types/src/job-taxonomy.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/db/src/schema/jobs.ts:33-36` (stale comment cleanup)

**Interfaces:**
- Produces: `JOB_SOURCE` (const object, 13 keys), `JobSource` (type), `jobSourceSchema` (Zod enum), `LEGACY_JOB_SOURCE` (const object, 1 key: `API`), `WORKER_POOL` (const object, 5 keys), `WorkerPool` (type), `workerPoolSchema` (Zod enum) — all exported from `@tryme/types`. Every later task consumes these.

`packages/types` has no test script or test-framework dependency (confirmed: `packages/types/package.json` has only `dev`/`build`/`build:cjs`/`typecheck` scripts). This task is verified by `typecheck` only; the schemas' runtime behavior is exercised indirectly by Task 2/4/9's real API tests, which do have vitest.

- [ ] **Step 1: Write the registry file**

```ts
// packages/types/src/job-taxonomy.ts
import { z } from 'zod';

// The fine-grained "what created this job" taxonomy — stored in jobs.source.
// See docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md.
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
  KIOSK: 'kiosk',
  API_TRYON: 'api_tryon',
  API_SAREE_MANNEQUIN: 'api_saree_mannequin',
  API_CATALOG: 'api_catalog',
} as const;
export type JobSource = (typeof JOB_SOURCE)[keyof typeof JOB_SOURCE];
export const jobSourceSchema = z.enum(
  Object.values(JOB_SOURCE) as [JobSource, ...JobSource[]],
);

// Not part of JobSource — deliberately excluded from jobSourceSchema and every
// exhaustiveness check over JOB_SOURCE, so a switch/map keyed by JobSource can't
// accidentally treat 'api' as a live value a writer might still produce. No writer
// in this codebase can produce this value after the dev-API three-way split ships
// (see the dev/ job creators) — it exists solely so the permanent legacy-inclusion
// read filters (apps/api/src/modules/dev/routes.ts, dev/catalog.routes.ts,
// merchant/api-keys.routes.ts) reference a named export instead of a repeated raw
// string literal.
export const LEGACY_JOB_SOURCE = {
  API: 'api',
} as const;

// The coarse "which admin-managed worker capability" split — the only thing
// workers.allowed_job_types and the dispatcher's selectWorker() compare against.
// No source-to-pool mapping exists: merchant_catalog jobs claim two different
// pools sequentially depending on job_inputs.params.needsMannequinStep, which no
// static per-source table can express (see the design spec §9). Every dispatcher
// call site keeps claiming the specific pool its own phase needs, unchanged from
// today's behavior — only the string literal's origin changes.
export const WORKER_POOL = {
  CATALOGUE: 'catalogue',
  TRYON: 'tryon',
  SAREE: 'saree',
  SHOPIFY: 'shopify',
  MERCHANT: 'merchant',
} as const;
export type WorkerPool = (typeof WORKER_POOL)[keyof typeof WORKER_POOL];
export const workerPoolSchema = z.enum(
  Object.values(WORKER_POOL) as [WorkerPool, ...WorkerPool[]],
);
```

- [ ] **Step 2: Export it from the package barrel**

In `packages/types/src/index.ts`, add a new line (alphabetically, after `jobs.js`):

```ts
export * from './job-taxonomy.js';
```

- [ ] **Step 3: Update the stale schema comment**

In `packages/db/src/schema/jobs.ts:33-36`, the `source` column comment currently reads:

```ts
  // Which flow created this job — 'catalog' | 'tryon' | 'saree' | 'shopify' | 'api'.
  // Null for kiosk jobs (attributed via merchants.userId instead, see the
  // admin credit-analysis routes) and for historical rows not yet backfilled.
  source: text('source'),
```

Replace with:

```ts
  // Which flow created this job. Canonical value set + a matching WORKER_POOL split
  // live in @tryme/types (packages/types/src/job-taxonomy.ts) — see
  // docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md. Null for
  // kiosk jobs (attributed via merchants.userId instead, see the admin
  // credit-analysis routes) and for historical rows not yet backfilled.
  source: text('source'),
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`
Expected: PASS, no errors. This confirms both Zod enums compile as non-empty tuples and every export resolves.

Run: `pnpm --filter @tryme/db typecheck`
Expected: PASS (comment-only change, but confirms the schema file still compiles).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/job-taxonomy.ts packages/types/src/index.ts packages/db/src/schema/jobs.ts
git commit -m "feat(types): add job taxonomy registry (JOB_SOURCE, WORKER_POOL)"
```

---

## Task 2: Fix the Reported Bug — `merchant` Worker Pool Validation

**Files:**
- Modify: `apps/api/src/modules/admin/workers.routes.ts:1-8` (import), `:94` (POST body schema), `:166` (PATCH body schema)
- Test: `apps/api/test/integration/admin-workers.test.ts` (append)

**Interfaces:**
- Consumes: `workerPoolSchema` (Task 1)

This is the originally-reported bug: an admin cannot assign the `merchant` worker pool to a worker because both `POST /admin/workers` and `PATCH /admin/workers/:id` reject it. Fixed here standalone since it's independently valuable and independently testable.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/integration/admin-workers.test.ts`, inside the existing `describe('PATCH /admin/workers/:id — registry status sync', ...)` block is the wrong place (that block is scoped to registry-sync behavior) — add a new top-level `describe` block at the end of the file, after the existing one closes:

```ts
describe('POST /admin/workers — allowedJobTypes validation', () => {
  let c: Containers;
  let app: TestApp;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('accepts merchant as an allowed job type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/workers',
      headers: authHeader,
      payload: {
        id: 'test-worker-merchant-pool',
        label: '',
        url: 'https://example.com/',
        apiKey: 'k'.repeat(8),
        allowedJobTypes: ['merchant'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().allowedJobTypes).toEqual(['merchant']);
  });

  it('rejects an unknown job type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/workers',
      headers: authHeader,
      payload: {
        id: 'test-worker-bad-pool',
        label: '',
        url: 'https://example.com/',
        apiKey: 'k'.repeat(8),
        allowedJobTypes: ['not-a-real-pool'],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify the first test fails**

Run: `pnpm --filter @tryme/api test -- admin-workers`
Expected: `accepts merchant as an allowed job type` FAILS with `statusCode` 400 (Zod rejects `'merchant'` — not in `['catalogue','tryon','saree','shopify']`), `rejects an unknown job type` PASSES already (it's already rejected, just not for the reason we'll assert going forward).

- [ ] **Step 3: Fix the two Zod validators**

In `apps/api/src/modules/admin/workers.routes.ts`, add the import (after the existing `import { z } from 'zod';` line):

```ts
import { workerPoolSchema } from '@tryme/types';
```

Replace the POST body schema field (line 94):

```ts
          allowedJobTypes: z.array(z.enum(['catalogue', 'tryon', 'saree', 'shopify'])).default([]),
```

with:

```ts
          allowedJobTypes: z.array(workerPoolSchema).default([]),
```

Replace the PATCH body schema field (line 166):

```ts
          allowedJobTypes: z.array(z.enum(['catalogue', 'tryon', 'saree', 'shopify'])).optional(),
```

with:

```ts
          allowedJobTypes: z.array(workerPoolSchema).optional(),
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `pnpm --filter @tryme/api test -- admin-workers`
Expected: PASS, both new tests green, and the pre-existing `PATCH /admin/workers/:id — registry status sync` tests in the same file still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/workers.routes.ts apps/api/test/integration/admin-workers.test.ts
git commit -m "fix(admin): allow merchant as a valid worker job type"
```

---

## Task 3: Dispatcher Pool & Source Call Sites

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1-31` (import), and 6 `selectWorker` call sites
- Modify: `apps/dispatcher/src/job/mannequin-phase.ts:1-19` (import), 1 `selectWorker` call site
- Modify: `apps/dispatcher/src/stream/sweeper.ts:1-15` (import + constant)

**Interfaces:**
- Consumes: `WORKER_POOL`, `JOB_SOURCE` (Task 1)

Pure mechanical swap — no dispatch behavior changes, each call site keeps claiming the exact pool it claims today. Verified via the existing dispatcher integration suite (a genuine behavior-preserving refactor: the existing tests are the correct regression harness, no new test needed).

- [ ] **Step 1: Run the existing suite to confirm the baseline passes**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: PASS (baseline, before any change).

- [ ] **Step 2: `processor.ts` — add the import and replace the 6 call sites**

Add to the top import block of `apps/dispatcher/src/job/processor.ts` (after `import { and, eq, sql } from 'drizzle-orm';`):

```ts
import { WORKER_POOL } from '@tryme/types';
```

Replace each of the following (all six are distinct enough in surrounding context — `'saree'` appears twice in this file at lines 1146 and 1364, both replaced identically, so a single `replace_all` on the exact string `selectWorker(redis, 'saree')` is safe and correct here):

- `selectWorker(redis, 'catalogue')` → `selectWorker(redis, WORKER_POOL.CATALOGUE)`
- `selectWorker(redis, 'tryon')` → `selectWorker(redis, WORKER_POOL.TRYON)`
- `selectWorker(redis, 'saree')` (both occurrences) → `selectWorker(redis, WORKER_POOL.SAREE)`
- `selectWorker(redis, 'merchant')` → `selectWorker(redis, WORKER_POOL.MERCHANT)`
- `selectWorker(redis, 'shopify')` → `selectWorker(redis, WORKER_POOL.SHOPIFY)`

- [ ] **Step 3: `mannequin-phase.ts` — add the import and replace the 1 call site**

Add to the top import block of `apps/dispatcher/src/job/mannequin-phase.ts` (after `import { selectWorker } from '../worker/selector.js';`):

```ts
import { WORKER_POOL } from '@tryme/types';
```

Replace:

```ts
  const worker = await selectWorker(redis, 'saree');
```

with:

```ts
  const worker = await selectWorker(redis, WORKER_POOL.SAREE);
```

- [ ] **Step 4: `sweeper.ts` — add the import and replace the constant**

Add to the top import block of `apps/dispatcher/src/stream/sweeper.ts` (after `import { transitionJob } from '../job/state.js';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Replace:

```ts
const VIDEO_SOURCE = 'catalog_video';
```

with:

```ts
const VIDEO_SOURCE = JOB_SOURCE.CATALOG_VIDEO;
```

- [ ] **Step 5: Run the suite again to verify no regression**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: PASS — identical results to Step 1 (same pool/source string values, only their origin changed).

- [ ] **Step 6: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/src/job/mannequin-phase.ts apps/dispatcher/src/stream/sweeper.ts
git commit -m "refactor(dispatcher): use WORKER_POOL/JOB_SOURCE constants instead of string literals"
```

---

## Task 4: New Route — `GET /admin/workers/job-types`

**Files:**
- Modify: `apps/api/src/modules/admin/workers.routes.ts`
- Test: `apps/api/test/integration/admin-job-taxonomy.test.ts` (create)

**Interfaces:**
- Consumes: `WORKER_POOL` (Task 1)
- Produces: `GET /admin/workers/job-types` → `WorkerPool[]` — consumed by Task 5

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/admin-job-taxonomy.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('GET /admin/workers/job-types', () => {
  let c: Containers;
  let app: TestApp;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    authHeader = await adminAuthHeader(app, 'SUPPORT');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('returns all 5 worker pools', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/workers/job-types',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sort()).toEqual(
      ['catalogue', 'merchant', 'saree', 'shopify', 'tryon'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-job-taxonomy`
Expected: FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Add the route**

In `apps/api/src/modules/admin/workers.routes.ts`, add the route inside `adminWorkersRoutes`, directly after the closing brace of the existing `GET /admin/workers` handler (before `app.post('/admin/workers', ...)`):

```ts
  app.get(
    '/admin/workers/job-types',
    { preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) },
    async () => Object.values(WORKER_POOL),
  );
```

Add `WORKER_POOL` to the `@tryme/types` import already added in Task 2:

```ts
import { WORKER_POOL, workerPoolSchema } from '@tryme/types';
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-job-taxonomy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/workers.routes.ts apps/api/test/integration/admin-job-taxonomy.test.ts
git commit -m "feat(admin): add GET /admin/workers/job-types"
```

---

## Task 5: `WorkersPage.tsx` — Fetch Job Types Instead of Hardcoding Them

**Files:**
- Modify: `apps/admin-web/src/pages/WorkersPage.tsx`

**Interfaces:**
- Consumes: `GET /admin/workers/job-types` (Task 4)

No automated test — `apps/admin-web` has no test runner (Global Constraints). Verified manually via the dev server (Step 4).

- [ ] **Step 1: Remove the hardcoded type/list/label-map, add fetched state**

Replace (lines 6, 27-33):

```tsx
type JobType = 'catalogue' | 'tryon' | 'saree' | 'shopify';
```
```tsx
const JOB_TYPES: JobType[] = ['catalogue', 'tryon', 'saree', 'shopify'];
const JOB_TYPE_LABELS: Record<JobType, string> = {
  catalogue: 'Catalogue',
  tryon: 'Tryon',
  saree: 'Saree',
  shopify: 'Shopify',
};
```

with:

```tsx
type JobType = string;

function jobTypeLabel(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
```

(`Worker`'s `allowedJobTypes: JobType[]` field, `EMPTY_FORM`'s `allowedJobTypes: [] as JobType[]`, and every other reference to `JobType` elsewhere in the file keep compiling unchanged — `JobType` is still a valid type name, now `string` instead of a union.)

- [ ] **Step 2: Fetch the job-types list on mount**

In the `WorkersPage` component, add a new state variable next to the existing ones (after `const [workers, setWorkers] = useState<Worker[]>([]);`):

```tsx
  const [jobTypes, setJobTypes] = useState<string[]>([]);
```

Add a fetch alongside the existing `load` callback — insert a second `useEffect` after the existing one (after the `useEffect` that calls `load()` and sets the polling interval):

```tsx
  useEffect(() => {
    apiFetch<string[]>('/admin/workers/job-types')
      .then(setJobTypes)
      .catch((e) => {
        toast({
          kind: 'error',
          title: 'Failed to load job types',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      });
  }, [toast]);
```

- [ ] **Step 3: Replace the two `JOB_TYPES`/`JOB_TYPE_LABELS` usages**

Replace (line ~306, the read-only badge in the workers table row):

```tsx
                            {JOB_TYPE_LABELS[t]}
```

— there are two identical occurrences of this exact line (the table-row badge and the add/edit-modal checkbox label). Both should become:

```tsx
                            {jobTypeLabel(t)}
```

Use `replace_all` since both call sites want the identical transformation.

Replace (line ~512, the add/edit modal's checkbox source):

```tsx
                {JOB_TYPES.map((t) => (
```

with:

```tsx
                {jobTypes.map((t) => (
```

- [ ] **Step 4: Manually verify in the dev server**

Run: `pnpm --filter @tryme/admin dev` (and, separately, ensure `pnpm --filter @tryme/api dev` and `pnpm docker:up` are running so the admin app has a live backend).

In the browser: navigate to the Workers page, open "Add worker", confirm the job-type checkboxes now show `Catalogue`, `Tryon`, `Saree`, `Shopify`, and `Merchant` (5 options, not 4) — capitalized correctly by `jobTypeLabel`. Check the `Merchant` box, save, confirm the new worker's row badge renders `Merchant`.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/pages/WorkersPage.tsx
git commit -m "feat(admin-web): fetch worker job types from the API instead of hardcoding them"
```

---

## Task 6: Job-Source Writers, Batch A — `apps/api/src/modules/jobs/`

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts` (import, `createJob`'s `opts.source` type + default, `createSimpleTryonJob`'s literal, catalog-video literal, 3 `jobsCreatedTotal.inc` calls)
- Modify: `apps/api/src/modules/jobs/createSaree.ts` (import, literal, metric)
- Modify: `apps/api/src/modules/jobs/createSareeMannequin.ts` (import, 2 literals, metric)

**Interfaces:**
- Consumes: `JOB_SOURCE`, `JobSource` (Task 1)

Pure mechanical swap for the metric/literal fixes; `createJob`'s `opts.source` type change is the one with real teeth (Task 11 depends on it being `JobSource`, not `string`). Verified via the existing suite — behavior-preserving except the Prometheus label value for catalogue jobs, which intentionally changes from `'catalogue'` to `'catalog'` (this is the exact drift the whole plan exists to fix; no test in this repo asserts the old label value, confirmed by grep for `'catalogue'` across `apps/api/test/`).

- [ ] **Step 1: Confirm no test asserts the old metric label**

Run: `grep -rn "kind.*'catalogue'\|kind: 'catalogue'" apps/api/test/` (or use the Grep tool with pattern `kind.*catalogue`, path `apps/api/test`)
Expected: no matches — confirms Step 3 below is safe.

- [ ] **Step 2: Run the existing suite to confirm the baseline passes**

Run: `pnpm --filter @tryme/api test -- jobs`
Expected: PASS (baseline).

- [ ] **Step 3: `create.ts` — import, typed `source`, 3 literals, 3 metrics**

Add `JOB_SOURCE` to the existing `@tryme/types` import block (currently starting `import { ASPECT_DIMENSIONS, type CreateCatalogVideoJobRequest, ...`):

```ts
import {
  ASPECT_DIMENSIONS,
  type CreateCatalogVideoJobRequest,
  type CreateSimpleTryonRequest,
  type CreateTryOnJobRequest,
  JOB_SOURCE,
  type JobSource,
  type Resolution,
  resolutionFromDims,
  type SareeStep2Inputs,
} from '@tryme/types';
```

Change `createJob`'s `opts` parameter type (line 630-638):

```ts
  opts?: {
    trustedGarmentKeys?: Set<string>;
    /** Set by the public developer API so the resulting jobs are readable through
     *  /v1/dev/jobs/:id and /v1/dev/catalogues/:id, which scope by merchant via a
     *  join on api_keys and filter jobs.source = 'api'. Omitting either field there
     *  makes every generated job 404 on its own status endpoint. */
    apiKeyId?: string;
    source?: string;
  },
```

to:

```ts
  opts?: {
    trustedGarmentKeys?: Set<string>;
    /** Set by the public developer API so the resulting jobs are readable through
     *  /v1/dev/jobs/:id and /v1/dev/catalogues/:id, which scope by merchant via a
     *  join on api_keys and filter jobs.source against the api_* JobSource values.
     *  Omitting either field there makes every generated job 404 on its own status
     *  endpoint. */
    apiKeyId?: string;
    source?: JobSource;
  },
```

Change the insert default (line 726):

```ts
          source: opts?.source ?? 'catalog',
```

to:

```ts
          source: opts?.source ?? JOB_SOURCE.CATALOG,
```

Change the metric at line 754:

```ts
      jobsCreatedTotal.inc({ priority: queueStream, kind: 'catalogue' });
```

to:

```ts
      jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.CATALOG });
```

Change the `createSimpleTryonJob` insert (line 890):

```ts
        source: 'tryon',
```

to:

```ts
        source: JOB_SOURCE.TRYON,
```

Change its metric (line 910):

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'tryon' });
```

to:

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.TRYON });
```

Change the catalog-video insert (line 971):

```ts
        source: 'catalog_video',
```

to:

```ts
        source: JOB_SOURCE.CATALOG_VIDEO,
```

Change its metric (line 999):

```ts
    jobsCreatedTotal.inc({ priority: 'video', kind: 'catalog_video' });
```

to:

```ts
    jobsCreatedTotal.inc({ priority: 'video', kind: JOB_SOURCE.CATALOG_VIDEO });
```

- [ ] **Step 4: `createSaree.ts` — import, literal, metric**

Change the import (line 5):

```ts
import type { CreateSareeJobRequest } from '@tryme/types';
```

to:

```ts
import { JOB_SOURCE, type CreateSareeJobRequest } from '@tryme/types';
```

Change the insert (line 78):

```ts
        source: 'saree',
```

to:

```ts
        source: JOB_SOURCE.SAREE,
```

Change the metric (line 98):

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'saree' });
```

to:

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.SAREE });
```

- [ ] **Step 5: `createSareeMannequin.ts` — import, 2 literals, metric**

Change the import (line 3):

```ts
import type { CreateSareeMannequinJobRequest } from '@tryme/types';
```

to:

```ts
import { JOB_SOURCE, type CreateSareeMannequinJobRequest } from '@tryme/types';
```

Change the mannequin-job insert (line 86):

```ts
        source: 'saree_mannequin',
```

to:

```ts
        source: JOB_SOURCE.SAREE_MANNEQUIN,
```

Change the step-2 job insert (line 115):

```ts
        source: 'catalog',
```

to:

```ts
        source: JOB_SOURCE.CATALOG,
```

Change the metric (line 150):

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'saree_mannequin' });
```

to:

```ts
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.SAREE_MANNEQUIN });
```

- [ ] **Step 6: Run the suite again to verify no regression**

Run: `pnpm --filter @tryme/api test -- jobs`
Expected: PASS — identical results to Step 2.

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/createSaree.ts apps/api/src/modules/jobs/createSareeMannequin.ts
git commit -m "refactor(api): use JOB_SOURCE constants in jobs/ writers, fix catalog/catalogue metric mismatch"
```

---

## Task 7: Job-Source Writers, Batch B — Merchant / Kiosk / Shopify

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts` (import, 2 literals)
- Modify: `apps/api/src/modules/merchant/create-tryon-job.ts` (new import, 1 literal)
- Modify: `apps/api/src/modules/kiosk/create-job.ts` (new import, 1 literal)
- Modify: `apps/api/src/modules/shopify/customer.routes.ts` (import, 1 literal)

**Interfaces:**
- Consumes: `JOB_SOURCE` (Task 1)

Pure mechanical swap, no behavior change. Verified via each domain's existing suite.

- [ ] **Step 1: Run the existing suites to confirm the baseline passes**

Run: `pnpm --filter @tryme/api test -- merchant`
Run: `pnpm --filter @tryme/api test -- shopify`
Expected: both PASS (baseline).

- [ ] **Step 2: `merchant/create-job.ts`**

Add `JOB_SOURCE` to the existing `@tryme/types` import (line 3):

```ts
import { ASPECT_DIMENSIONS, JOB_SOURCE, type Resolution, resolutionFromDims } from '@tryme/types';
```

Change line 227:

```ts
      source: 'merchant_catalog',
```

to:

```ts
      source: JOB_SOURCE.MERCHANT_CATALOG,
```

Change line 374:

```ts
      source: 'merchant_catalog_saree_mannequin',
```

to:

```ts
      source: JOB_SOURCE.MERCHANT_CATALOG_SAREE_MANNEQUIN,
```

- [ ] **Step 3: `merchant/create-tryon-job.ts`**

Add a new import line after `import type { FastifyInstance } from 'fastify';`:

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change line 30:

```ts
      source: 'merchant_tryon',
```

to:

```ts
      source: JOB_SOURCE.MERCHANT_TRYON,
```

- [ ] **Step 4: `kiosk/create-job.ts`**

Add a new import line after `import type { FastifyInstance } from 'fastify';`:

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change line 33:

```ts
      source: 'kiosk',
```

to:

```ts
      source: JOB_SOURCE.KIOSK,
```

- [ ] **Step 5: `shopify/customer.routes.ts`**

Add `JOB_SOURCE` to the existing `@tryme/types` import (lines 3-7):

```ts
import {
  JOB_SOURCE,
  ShopifyCustomerJobRequest,
  ShopifyCustomerPhotoPreviewRequest,
  ShopifyCustomerPresignRequest,
} from '@tryme/types';
```

Change line 218:

```ts
          source: 'shopify',
```

to:

```ts
          source: JOB_SOURCE.SHOPIFY,
```

- [ ] **Step 6: Run the suites again to verify no regression**

Run: `pnpm --filter @tryme/api test -- merchant`
Run: `pnpm --filter @tryme/api test -- shopify`
Expected: both PASS — identical results to Step 1.

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts apps/api/src/modules/merchant/create-tryon-job.ts apps/api/src/modules/kiosk/create-job.ts apps/api/src/modules/shopify/customer.routes.ts
git commit -m "refactor(api): use JOB_SOURCE constants in merchant/kiosk/shopify writers"
```

---

## Task 8: Derived Helpers — `job-type.ts` and `credit-analysis.routes.ts`

**Files:**
- Modify: `apps/api/src/modules/admin/job-type.ts`
- Modify: `apps/api/src/modules/admin/credit-analysis.routes.ts`

**Interfaces:**
- Consumes: `JOB_SOURCE` (Task 1)

- [ ] **Step 1: Run the existing suites to confirm the baseline passes**

Run: `pnpm --filter @tryme/api test -- admin-jobs-type`
Run: `pnpm --filter @tryme/api test -- admin-credit-analysis`
Expected: both PASS (baseline).

- [ ] **Step 2: `job-type.ts`**

Add the import (after `import { sql } from 'drizzle-orm';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change:

```ts
export function jobTypeSql() {
  return sql<string>`COALESCE(${schema.jobs.source}, CASE WHEN ${schema.jobInputs.faceId} IS NULL THEN 'tryon' ELSE 'catalog' END)`;
}
```

to:

```ts
export function jobTypeSql() {
  return sql<string>`COALESCE(${schema.jobs.source}, CASE WHEN ${schema.jobInputs.faceId} IS NULL THEN ${JOB_SOURCE.TRYON} ELSE ${JOB_SOURCE.CATALOG} END)`;
}
```

- [ ] **Step 3: `credit-analysis.routes.ts`**

Add the import (after `import { AppError } from '../../lib/errors.js';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change:

```ts
const SOURCES = ['catalog', 'tryon', 'saree', 'kiosk', 'shopify'] as const;
```

to:

```ts
const SOURCES = [
  JOB_SOURCE.CATALOG,
  JOB_SOURCE.TRYON,
  JOB_SOURCE.SAREE,
  JOB_SOURCE.KIOSK,
  JOB_SOURCE.SHOPIFY,
] as const;
```

(The `sourceCondition` switch below it, and the `'kiosk'`/`'shopify'` derived-condition special cases inside it, are unchanged — they already switch on the string values, which are unchanged; only the array literal that seeds the Zod enum changes.)

- [ ] **Step 4: Run the suites again to verify no regression**

Run: `pnpm --filter @tryme/api test -- admin-jobs-type`
Run: `pnpm --filter @tryme/api test -- admin-credit-analysis`
Expected: both PASS — identical results to Step 1.

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/job-type.ts apps/api/src/modules/admin/credit-analysis.routes.ts
git commit -m "refactor(api): use JOB_SOURCE constants in jobTypeSql and credit-analysis SOURCES"
```

---

## Task 9: New Route — `GET /admin/jobs/sources`

**Files:**
- Modify: `apps/api/src/modules/admin/jobs.routes.ts`
- Test: `apps/api/test/integration/admin-job-taxonomy.test.ts` (append)

**Interfaces:**
- Consumes: `JOB_SOURCE` (Task 1)
- Produces: `GET /admin/jobs/sources` → `JobSource[]` — the API-contract exposure that resolves the `apps/admin-web` boundary for `jobTypeBadge` (Task 10 does **not** consume this route — see spec §8: this route tests registry completeness only, it is not read by `jobTypeBadge`)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/integration/admin-job-taxonomy.test.ts`, a new `describe` block after the existing one:

```ts
describe('GET /admin/jobs/sources', () => {
  let c: Containers;
  let app: TestApp;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    authHeader = await adminAuthHeader(app, 'SUPPORT');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('returns all 13 job sources', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/jobs/sources',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as string[];
    expect(body).toHaveLength(13);
    expect(body.sort()).toEqual(
      [
        'catalog',
        'tryon',
        'catalog_video',
        'saree',
        'saree_mannequin',
        'shopify',
        'merchant_catalog',
        'merchant_catalog_saree_mannequin',
        'merchant_tryon',
        'kiosk',
        'api_tryon',
        'api_saree_mannequin',
        'api_catalog',
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-job-taxonomy`
Expected: the new test FAILS with 404 (route doesn't exist yet); the two Task 4 tests still pass.

- [ ] **Step 3: Add the route**

In `apps/api/src/modules/admin/jobs.routes.ts`, add the import (after `import { jobTypeSql } from './job-type.js';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Add the route inside `adminJobsRoutes`, directly after the `const W = requireAdmin([...]);` line and before the existing `app.get('/admin/jobs', ...)`:

```ts
  app.get('/admin/jobs/sources', { preHandler: R }, async () => Object.values(JOB_SOURCE));
```

- [ ] **Step 4: Run the test again to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-job-taxonomy`
Expected: PASS, all three tests (2 from Task 4, 1 new) green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/jobs.routes.ts apps/api/test/integration/admin-job-taxonomy.test.ts
git commit -m "feat(admin): add GET /admin/jobs/sources"
```

---

## Task 10: `jobTypeBadge` Fallback Warning

**Files:**
- Modify: `apps/admin-web/src/lib/data.ts`

**Interfaces:**
- Consumes: nothing from this plan's registry (deliberately — see spec §8, this task does not fetch `/admin/jobs/sources`; that route tests registry completeness only, not this map)

No automated test — per spec §8, this is a deliberate, accepted weaker safeguard than a test, because adding one would require a test runner in a package that has none (Global Constraints). Verified manually.

- [ ] **Step 1: Add the fallback warning**

In `apps/admin-web/src/lib/data.ts`, change:

```ts
export function jobTypeBadge(t: string): [string, string] {
  const m: Record<string, [string, string]> = {
    catalog: ['', 'Catalog'],
    tryon: ['info', 'Try On'],
    saree: ['accent', 'Saree'],
    saree_mannequin: ['warn', 'Saree Prep'],
    shopify: ['success', 'Shopify'],
    merchant_tryon: ['accent', 'Merchant Try-On'],
    kiosk: ['accent', 'Kiosk'],
    merchant_catalog: ['accent', 'Try On Library'],
    merchant_catalog_saree_mannequin: ['warn', 'Try On Library Prep'],
    api: ['success', 'API'],
  };
  return m[t] || ['', t];
}
```

to:

```ts
export function jobTypeBadge(t: string): [string, string] {
  const m: Record<string, [string, string]> = {
    catalog: ['', 'Catalog'],
    catalog_video: ['success', 'Catalog Video'],
    tryon: ['info', 'Try On'],
    saree: ['accent', 'Saree'],
    saree_mannequin: ['warn', 'Saree Prep'],
    shopify: ['success', 'Shopify'],
    merchant_tryon: ['accent', 'Merchant Try-On'],
    kiosk: ['accent', 'Kiosk'],
    merchant_catalog: ['accent', 'Try On Library'],
    merchant_catalog_saree_mannequin: ['warn', 'Try On Library Prep'],
    api_tryon: ['success', 'API Try On'],
    api_saree_mannequin: ['success', 'API Saree Prep'],
    api_catalog: ['success', 'API Catalog'],
  };
  if (!m[t]) {
    console.warn(`jobTypeBadge: unrecognized job source "${t}" — add it to the label map in apps/admin-web/src/lib/data.ts`);
  }
  return m[t] || ['', t];
}
```

(This also fixes the `catalog_video` gap identified in the design spec §2 — it had no entry at all before this change — and updates the old single `api` key to the three post-split values, since the raw `'api'` value stops being written by any job-creation path after Task 11 ships. `merchant_catalog_saree_mannequin`'s existing entry and every other pre-existing key are unchanged.)

- [ ] **Step 2: Manually verify in the dev server**

Run: `pnpm --filter @tryme/admin dev` (with the API and docker infra running).

In the browser: open the Jobs page, open the browser devtools console, confirm no `jobTypeBadge: unrecognized job source` warnings appear for existing job records. (After Task 11/12 ship, no job in the DB should have an unrecognized source string — this is the regression check for that.)

- [ ] **Step 3: Commit**

```bash
git add apps/admin-web/src/lib/data.ts
git commit -m "feat(admin-web): add catalog_video/api-split badge entries, warn on unrecognized job source"
```

---

## Task 11: Dev-API Three-Way `api` Split

**Files:**
- Modify: `apps/api/src/modules/dev/create-job.ts` (import, `createDevJobCore` typed `source` param, `createDevTryonJob` call site)
- Modify: `apps/api/src/modules/dev/create-saree-mannequin-job.ts` (import, call site)
- Modify: `apps/api/src/modules/dev/catalog.routes.ts` (import, `inArray`, writer call site, read filter)
- Modify: `apps/api/src/modules/dev/routes.ts` (import, `inArray`, read filter)
- Modify: `apps/api/src/modules/merchant/api-keys.routes.ts` (import, `inArray`, read filter)
- Modify: `apps/api/test/merchant-api-keys.test.ts` (import, 2 fixture seeds)
- Modify: `apps/api/test/dev-read-routes.test.ts` (import, 1 fixture seed)

**Interfaces:**
- Consumes: `JOB_SOURCE`, `LEGACY_JOB_SOURCE`, `JobSource` (Task 1)

This is the tightly-coupled writer+reader change described in the design spec §5-6: the three dev-API job creators stop writing `'api'` and start writing one of `api_tryon`/`api_saree_mannequin`/`api_catalog`; the three "any dev-API job" read filters permanently accept `LEGACY_JOB_SOURCE.API` alongside the three new values (not a temporary shim — see spec §6, once every writer is converted here, no code path can ever produce the legacy value again).

- [ ] **Step 1: Run the existing suites to confirm the baseline passes**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Run: `pnpm --filter @tryme/api test -- dev-catalog`
Expected: all PASS (baseline).

- [ ] **Step 2: `dev/create-job.ts` — typed `source`, remove the hardcoded default**

Add to the top imports (after `import { AppError } from '../../lib/errors.js';`):

```ts
import { JOB_SOURCE, type JobSource } from '@tryme/types';
```

Change `createDevJobCore`'s `params` type — find:

```ts
export async function createDevJobCore(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    cost: number;
    watermark: boolean;
    metricKind: string;
    buildJobInputs: () => Omit<typeof schema.jobInputs.$inferInsert, 'jobId'>;
  },
): Promise<{ jobId: string }> {
```

and add `source: JobSource;` to the object type:

```ts
export async function createDevJobCore(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    cost: number;
    watermark: boolean;
    metricKind: string;
    source: JobSource;
    buildJobInputs: () => Omit<typeof schema.jobInputs.$inferInsert, 'jobId'>;
  },
): Promise<{ jobId: string }> {
```

Change the hardcoded insert — find:

```ts
        creditsCharged: params.cost,
        source: 'api',
      })
```

replace with:

```ts
        creditsCharged: params.cost,
        source: params.source,
      })
```

Change `createDevTryonJob`'s own `createDevJobCore` call — find:

```ts
  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    metricKind: 'tryon',
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      params: { personKey: params.personKey, workflowTemplateId: category.workflowTemplateId },
    }),
  });
```

replace with:

```ts
  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    metricKind: 'tryon',
    source: JOB_SOURCE.API_TRYON,
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      params: { personKey: params.personKey, workflowTemplateId: category.workflowTemplateId },
    }),
  });
```

- [ ] **Step 3: `dev/create-saree-mannequin-job.ts` — pass the split value**

Add to the top imports (after `import { getSareeMannequinDevCreditCost } from '../../lib/resolution-config.js';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change the `createDevJobCore` call — find:

```ts
  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    metricKind: 'saree_mannequin',
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      garmentTypeId: null,
      faceId: null,
      // Snapshot the workflow so the dispatcher routes off params, not internal tables.
      params: { kind: 'saree_mannequin', workflowTemplateId: config.workflowTemplateId },
    }),
  });
```

replace with:

```ts
  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    metricKind: 'saree_mannequin',
    source: JOB_SOURCE.API_SAREE_MANNEQUIN,
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      garmentTypeId: null,
      faceId: null,
      // Snapshot the workflow so the dispatcher routes off params, not internal tables.
      params: { kind: 'saree_mannequin', workflowTemplateId: config.workflowTemplateId },
    }),
  });
```

- [ ] **Step 4: `dev/catalog.routes.ts` — writer split value + permanent-legacy read filter**

Add `JOB_SOURCE, LEGACY_JOB_SOURCE` to the existing `@tryme/types` import block, and `inArray` to the existing `drizzle-orm` import:

```ts
import {
  DevCatalogGenerateJsonBody,
  DevCatalogGenerateResponse,
  DevCatalogOptionsQuery,
  DevCatalogOptionsResponse,
  DevCatalogueParams,
  DevCatalogueResponse,
  DevErrorResponse,
  JOB_SOURCE,
  LEGACY_JOB_SOURCE,
} from '@tryme/types';
import { and, eq, inArray } from 'drizzle-orm';
```

Change the writer call site — find:

```ts
            apiKeyId,
            source: 'api',
          },
```

replace with:

```ts
            apiKeyId,
            source: JOB_SOURCE.API_CATALOG,
          },
```

Change the read filter — find:

```ts
        .where(and(eq(schema.jobs.catalogueId, id), eq(schema.jobs.source, 'api')))
```

replace with:

```ts
        .where(
          and(
            eq(schema.jobs.catalogueId, id),
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              LEGACY_JOB_SOURCE.API,
            ]),
          ),
        )
```

- [ ] **Step 5: `dev/routes.ts` — permanent-legacy read filter**

Add the import (after `import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';`):

```ts
import { JOB_SOURCE, LEGACY_JOB_SOURCE } from '@tryme/types';
```

Add `inArray` to the existing `drizzle-orm` import:

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
```

Change the read filter — find:

```ts
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.source, 'api')))
```

replace with:

```ts
        .where(
          and(
            eq(schema.jobs.id, id),
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              LEGACY_JOB_SOURCE.API,
            ]),
          ),
        )
```

- [ ] **Step 6: `merchant/api-keys.routes.ts` — permanent-legacy read filter**

Add `JOB_SOURCE, LEGACY_JOB_SOURCE` to the existing `@tryme/types` import:

```ts
import { ApiKeyCreateBody, JOB_SOURCE, LEGACY_JOB_SOURCE } from '@tryme/types';
```

Add `inArray` to the existing `drizzle-orm` import:

```ts
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
```

Change the read filter — find:

```ts
      .where(
        and(
          eq(schema.apiKeys.merchantId, req.merchantClientId as string),
          eq(schema.jobs.source, 'api'),
        ),
      )
```

replace with:

```ts
      .where(
        and(
          eq(schema.apiKeys.merchantId, req.merchantClientId as string),
          inArray(schema.jobs.source, [
            JOB_SOURCE.API_TRYON,
            JOB_SOURCE.API_SAREE_MANNEQUIN,
            JOB_SOURCE.API_CATALOG,
            LEGACY_JOB_SOURCE.API,
          ]),
        ),
      )
```

- [ ] **Step 7: Update the two test fixtures to state intent explicitly**

In `apps/api/test/merchant-api-keys.test.ts`, add the import (after `import { eq } from 'drizzle-orm';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change both occurrences of:

```ts
        source: 'api',
```

to:

```ts
        source: JOB_SOURCE.API_TRYON,
```

(There are two, at the two separate `app.db.insert(schema.jobs).values({...})` calls in this file — both become `JOB_SOURCE.API_TRYON`.)

In `apps/api/test/dev-read-routes.test.ts`, add the import (after `import { schema } from '@tryme/db';`):

```ts
import { JOB_SOURCE } from '@tryme/types';
```

Change:

```ts
      source: 'api',
```

to:

```ts
      source: JOB_SOURCE.API_TRYON,
```

- [ ] **Step 8: Run the suites again to verify no regression, plus the new permanent-legacy behavior**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Run: `pnpm --filter @tryme/api test -- dev-catalog`
Expected: all PASS — these tests seed `JOB_SOURCE.API_TRYON` now (not the legacy literal), and the read filters find them via the `inArray` (which includes `API_TRYON` as one of its four values) — proving both the new split values AND the filter change work correctly.

Add one more explicit regression test to `apps/api/test/integration/admin-job-taxonomy.test.ts` proving the permanent-legacy-inclusion behavior itself (not just that new values are found) — append a new `describe`:

```ts
describe('dev-API read filters — permanent legacy source compatibility', () => {
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

  it('GET /v1/dev/jobs/:id still finds a job seeded with the raw legacy source value', async () => {
    const { merchantId } = await createTestMerchant(app);
    const { id: apiKeyId, key } = await createTestApiKey(app, merchantId);
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        apiKeyId,
        status: 'COMPLETED',
        source: LEGACY_JOB_SOURCE.API,
        creditsCharged: 1,
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/dev/jobs/${job.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

Add the needed imports to `apps/api/test/integration/admin-job-taxonomy.test.ts` at the top of the file (verified against `apps/api/test/dev-read-routes.test.ts`, which uses the identical pattern: `createTestMerchant(app)` returns `{ merchantId, userId, credits }`; `createTestApiKey(app, merchantId)` returns `{ id, key }`; the dev-API auth header is the raw `key`, not `id`):

```ts
import { schema } from '@tryme/db';
import { LEGACY_JOB_SOURCE } from '@tryme/types';
import { createTestApiKey, createTestMerchant } from '../helpers/merchant.js';
```

Run: `pnpm --filter @tryme/api test -- admin-job-taxonomy`
Expected: PASS, including the new legacy-compatibility test.

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/dev/create-job.ts apps/api/src/modules/dev/create-saree-mannequin-job.ts apps/api/src/modules/dev/catalog.routes.ts apps/api/src/modules/dev/routes.ts apps/api/src/modules/merchant/api-keys.routes.ts apps/api/test/merchant-api-keys.test.ts apps/api/test/dev-read-routes.test.ts apps/api/test/integration/admin-job-taxonomy.test.ts
git commit -m "feat(api): split dev-API source into api_tryon/api_saree_mannequin/api_catalog, permanently accept legacy 'api' in read filters"
```

---

## Task 12: Backfill Migration + Classification Test

**Files:**
- Create: `packages/db/src/migrations/0133_backfill_api_source_split.sql`
- Test: `apps/api/test/integration/api-source-migration.test.ts` (create)

**Interfaces:**
- Consumes: `LEGACY_JOB_SOURCE`, `JOB_SOURCE` (Task 1)

The standard test harness (`apps/api/test/helpers/containers.ts`) always applies every migration in the folder before any test starts, so there's no way to seed rows "as of migration N-1" through it. Instead, this test seeds legacy-shaped rows into an already-fully-migrated DB (the `source` column is unconstrained `text`, so inserting the legacy literal post-migration is legal) and executes the real migration `.sql` file's statements directly against them, read from disk — not a hand-copied duplicate that could drift from what actually ships.

- [ ] **Step 1: Generate the migration file**

Run: `pnpm --filter @tryme/db generate -- --custom --name=backfill_api_source_split`
Expected: creates `packages/db/src/migrations/0133_backfill_api_source_split.sql` (empty, with a placeholder comment) and registers it in `packages/db/src/migrations/meta/_journal.json` at `idx: 133`.

- [ ] **Step 2: Fill in the migration SQL**

Replace the generated file's contents with:

```sql
-- Backfill jobs.source = 'api' rows written before the three-way dev-API split
-- (api_tryon / api_saree_mannequin / api_catalog — see
-- docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md §5-6).
-- Idempotent: each UPDATE's WHERE clause only matches remaining 'api' rows, so
-- re-running after the first pass is a no-op. Applied in specificity order so a
-- row matching an earlier, more specific signal is never reclassified by a later
-- one.

-- 1. Most specific: dev saree-mannequin jobs carry a distinctive params.kind.
UPDATE jobs SET source = 'api_saree_mannequin'
WHERE source = 'api'
  AND id IN (SELECT job_id FROM job_inputs WHERE params->>'kind' = 'saree_mannequin');

-- 2. Dev catalog jobs are the only remaining api-sourced shape with a resolved face.
UPDATE jobs SET source = 'api_catalog'
WHERE source = 'api'
  AND id IN (SELECT job_id FROM job_inputs WHERE face_id IS NOT NULL);

-- 3. Everything else was dev tryon-direct (personKey-shaped, or a job with no
--    job_inputs row at all).
UPDATE jobs SET source = 'api_tryon'
WHERE source = 'api';
```

- [ ] **Step 3: Write the failing classification test**

Create `apps/api/test/integration/api-source-migration.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@tryme/db';
import { LEGACY_JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

const MIGRATION_PATH = fileURLToPath(
  new URL('../../../../packages/db/src/migrations/0133_backfill_api_source_split.sql', import.meta.url),
);

describe('0133_backfill_api_source_split.sql — classification', () => {
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

  it('classifies legacy api rows into api_saree_mannequin / api_catalog / api_tryon', async () => {
    // Row A: saree-mannequin shape (params.kind)
    const [jobA] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: jobA.id,
      params: { kind: 'saree_mannequin' },
    });

    // Row B: catalog shape (resolved face)
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'test face',
        r2Key: 'test/face.jpg',
        thumbnailKey: 'test/face-thumb.jpg',
      })
      .returning();
    const [jobB] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: jobB.id,
      faceId: face.id,
    });

    // Row C: tryon-direct shape (neither signal — no job_inputs row at all,
    // matching the two real test fixtures updated in Task 11)
    const [jobC] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();

    const sql = postgres(c.pgUrl, { max: 1 });
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    await sql.unsafe(migrationSql);
    await sql.end();

    const [rowA] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobA.id));
    const [rowB] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobB.id));
    const [rowC] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobC.id));

    expect(rowA.source).toBe('api_saree_mannequin');
    expect(rowB.source).toBe('api_catalog');
    expect(rowC.source).toBe('api_tryon');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- api-source-migration`
Expected: FAIL — `rowA.source`/`rowB.source`/`rowC.source` are still `'api'` (the migration file exists and is applied by `startContainers()` at DB-creation time, but at that point no `source = 'api'` rows exist yet to backfill — the migration runs once as a no-op during setup, then the test seeds its own `'api'` rows *after* setup and must explicitly re-run the SQL itself, which Step 3's `sql.unsafe(migrationSql)` call does — if this step is failing for a different reason than a source-value mismatch, check that `c.pgUrl` and the `MIGRATION_PATH` resolution are correct before proceeding).

- [ ] **Step 5: Confirm the migration file itself is correct (it already should be, from Step 2 — this step just confirms the test now passes)**

Run: `pnpm --filter @tryme/api test -- api-source-migration`
Expected: PASS.

- [ ] **Step 6: Verify the migration is registered correctly and the full local migration set still applies cleanly**

Run: `pnpm --filter @tryme/api test` (the full suite — every test file's `startContainers()` call applies all migrations, including the new one, to a fresh DB; this confirms `0133` doesn't break migration application for any other test)
Expected: PASS, full suite green, no regression anywhere in this plan's earlier tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/0133_backfill_api_source_split.sql packages/db/src/migrations/meta/_journal.json apps/api/test/integration/api-source-migration.test.ts
git commit -m "feat(db): backfill legacy source='api' rows into the three-way split"
```

---

## Final Verification

After all 12 tasks:

- [ ] Run `pnpm typecheck` from the repo root — full monorepo typecheck, PASS.
- [ ] Run `pnpm --filter @tryme/api test` — full suite, PASS.
- [ ] Run `pnpm --filter @tryme/dispatcher test` — full suite, PASS.
- [ ] Run `pnpm lint` — PASS on all touched files.
- [ ] Manual: with `pnpm docker:up`, `pnpm --filter @tryme/api dev`, `pnpm --filter @tryme/dispatcher dev`, and `pnpm --filter @tryme/admin dev` all running — open the admin Workers page, add a worker with the `Merchant` job type checked, confirm it saves; open the admin Jobs page, confirm no `jobTypeBadge: unrecognized job source` warnings in the browser console for any existing job.
- [ ] Update `docs/progress.md` with a new dated entry per the repo's convention (`CLAUDE.md`'s Progress Tracking section): what was done (registry created, 8 drifted vocabularies consolidated, `merchant` worker-pool bug fixed, `catalog`/`catalogue` metric mismatch fixed, dev-API `api` source split three ways with a backfill migration), anything not done, and any open questions.
