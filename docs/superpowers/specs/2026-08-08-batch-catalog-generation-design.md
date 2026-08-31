# Batch Catalog Generation — Design

**Date:** 2026-08-08
**Branch:** `feature/batch-catalog-generation`
**Status:** Approved design, not yet implemented

## Problem

Studio generates one garment at a time. A merchant onboarding a 30-product drop
runs the four-step wizard 30 times, re-picking the same face, background, and
poses on every pass. There is no way to queue a catalog's worth of work in one
action, and no way to guarantee that a run either fully succeeds or fully backs
out.

## Solution Overview

A **batch** is a list of rows. One row is exactly one of today's Studio
submissions: one garment, one face, one background, one or more poses, and the
optional lower/shoe inputs those poses require. A row with N poses produces N
jobs under one `catalogueId` — identical to what `POST /v1/jobs/tryon` does now
with the `backgroundId + poseIds[]` form.

Gender, garment type, platform, aspect ratio, and output resolution are chosen
once for the whole batch. Every garment in a batch is therefore the same garment
type, which keeps pose/lower/shoe availability constant across rows.

Submission is all-or-nothing: either every job in the batch is created and
charged, or none is.

```
Batch (batchId)
├─ Row 0  garment A · face 1 · studio bg   · poses [front, side]  → catalogue X → 2 jobs
├─ Row 1  garment A · face 1 · outdoor bg  · poses [front]        → catalogue Y → 1 job
└─ Row 2  garment B · face 2 · studio bg   · poses [front, back]  → catalogue Z → 2 jobs
                                                          total: 5 jobs, 5 × cost credits
```

The same garment may appear on several rows with different backgrounds or poses.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Grid semantics | Row builder — each row is an explicit combination | Cross-product explodes job counts unpredictably; the user wants control over which combinations run |
| Poses per row | Multi-select | A row maps 1:1 onto a Studio submission, which already takes `poseIds[]` |
| Garment source | Multi-upload in the flow, plus reuse of `/v1/assets` | The common case is a fresh product drop; past uploads cover re-runs |
| Face | Per row, defaulted from a batch-level pick | Consistent model by default, per-row override when a product needs a different one |
| Garment type | Batch-level, one per batch | Pose/lower/shoe availability is garment-type-scoped; mixing types would make columns row-dependent |
| Result grouping | One catalogue per row | `/catalogues/{id}` already renders "one garment, many looks" — zero rework |
| Credits | All-or-nothing | A half-charged, half-generated catalog has no clean recovery |
| Batch size | Cap on total jobs (`Σ poseIds`), admin-configurable, default 200 | Bounds the transaction; a row cap alone still allows 50 rows × 10 poses |
| Persistence | `jobs.batch_id` column, no `job_batches` table | Every batch-level field (total, completed, failed, createdAt) is derivable by `GROUP BY batch_id` |
| UI location | Mode toggle inside the existing Studio page | Batch shares the batch-level header inputs with single mode; new code lives in separate files |

### Rejected alternatives

**Client loops `POST /v1/jobs/tryon` per row.** Zero backend work, but all-or-nothing
credits become impossible (row 40 failing leaves rows 1–39 charged), the cap is
unenforceable server-side, and 30 rows means 30 round trips.

**A `job_batches` table.** Buys a batch status row and admin visibility, but every
field it would hold is derivable from `jobs.batch_id`, and it adds a state machine
that must stay in sync with every job transition. Revisit only if a batch page
needs metadata that cannot be derived.

**Extending `POST /v1/merchant/catalog/generate-bulk`.** That route exists and loops
with per-item failures, parking jobs at `HELD` for admin release. It serves a
different domain (merchant flat images, admin-gated) and is deliberately not
all-or-nothing. Batch is a separate user-facing flow.

## Scope

**In scope (v1):** the row grid, multi-upload, batch submit endpoint, batch
progress read endpoint, `jobs.batch_id`.

**Out of scope (v1):**

- `mannequinJobId` — the saree two-pass flow. Each garment would need its own
  mannequin job to complete before its step-2 jobs could be planned, which breaks
  the single-transaction model.
- `catalogueTemplateMappingId` — catalogue templates. Templates already carry
  their own per-look backgrounds; layering them onto per-row backgrounds needs its
  own design.
- `thirdGarmentKey` — used only by the saree two-input path.

Rejecting these three at the schema level (they are absent from `BatchRowInputs`)
keeps the validation path linear.

## Backend

### Schema

One migration, `0146_jobs_batch_id.sql` (0145 is the current head):

```sql
ALTER TABLE jobs ADD COLUMN batch_id uuid;
CREATE INDEX jobs_batch_idx ON jobs (batch_id);
```

Nullable — every existing job and every single-job submission has `batch_id IS NULL`.

### Types

In `packages/types/src/jobs.ts`:

```ts
export const BatchRowInputs = z.object({
  upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY),
  faceId: z.string().uuid(),
  backgroundId: z.string().uuid(),
  poseIds: z.array(z.string().uuid()).min(1),
  lowerCatalogId: z.string().uuid().optional(),
  lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  shoeCatalogId: z.string().uuid().optional(),
});

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
```

`MAX_BATCH_ROWS` is a schema-level backstop (100). The real limit is the job cap
below, which is admin-configurable and counts poses, not rows.

`garmentTypeId` is required here although it is optional on `CreateTryOnJobRequest`.
Batch resolves pose/lower/shoe availability once for the whole grid, which is only
possible with a known garment type.

### Shared validation rule

The "does this selection require a lower garment or shoes" rule currently exists
twice: server-side in `resolveTryonPlan`'s node-ID loop, client-side in Studio's
`hasLower`/`hasShoes` checks. Batch would be the third copy. Extract one pure
function into `@tryme/types`:

```ts
export function requiredInputsForPoses(
  poses: Array<{ hasLower: boolean; hasShoes: boolean }>,
): { needsLower: boolean; needsShoes: boolean };
```

The web app imports it to enable/disable the lower and shoe cells; the API imports
it for validation. It is a pure function, so it gets real test coverage in the API
suite even though the web app has no test runner.

### Endpoint

`POST /v1/jobs/batch`, registered in `apps/api/src/modules/jobs/routes.ts`,
implemented in a new `apps/api/src/modules/jobs/createBatch.ts`. Order is
load-bearing:

1. Load the user and their credit plan (`queueStream`, `watermark`); reject if banned.
2. Cap check: `Σ row.poseIds.length <= maxBatchJobs`, read from the `config:system`
   Redis key following the `getMaxOutputPx` pattern in
   `apps/api/src/lib/resolution-config.ts`. Default 200.
3. Verify each **distinct** `upperGarmentKey` and `lowerGarmentKey` once via
   `verifyGarmentKey`. Deduplicating first matters: a garment used on three rows
   is one ownership check, not three. Because the check is per key rather than per
   row, a failure reports the index of the first row using that key.
4. Build a shared lookup cache and call `resolveTryonPlan()` once per row through
   it. A row that fails validation throws with its index attached.
5. `cost = Σ(plan.cost × plan.looks.length)`.
6. Preflight balance read. Short → 402 with `{ required, available }`.
7. One transaction, per row: insert the `jobs` rows (`batchId`, `catalogueId` from
   the row's plan), `atomicDeduct`, insert `job_inputs`. `atomicDeduct` throwing
   mid-loop rolls the whole transaction back, so all-or-nothing holds even when a
   concurrent spend races past the preflight.
8. After commit, `XADD` per job. Per-job enqueue failure refunds and marks the job
   `FAILED`, matching `createJob`'s existing behaviour.

Response:

```json
{
  "batchId": "…",
  "totalJobs": 5,
  "creditsCharged": 5,
  "catalogues": [{ "rowIndex": 0, "catalogueId": "…", "jobIds": ["…", "…"] }],
  "failedJobIds": []
}
```

### Lookup cache

`resolveTryonPlan` currently issues roughly six queries per call — face,
backgrounds, poses, catalog items, pose workflows, garment type — plus
`getMaxOutputPx` and `getResolutionCreditCost`. Thirty rows would be about 180
queries.

It grows an optional `cache` parameter: a plain object of maps keyed by ID, filled
on first miss and reused for the rest of the batch. Callers that pass nothing
behave exactly as they do today, so the single-job path, the saree step-2 path, and
the regenerate path are unaffected. A 30-row batch drops to roughly 8 queries.

This refactor touches shared job-creation code, so test 9 below (batch/single
parity) is the guard on it.

### Batch progress read

`GET /v1/batches/:id` returns per-catalogue status counts derived from
`GROUP BY batch_id, catalogue_id`, scoped to `jobs.user_id = req.userId`. Another
user's batch is a 404, not a 403 — the ID's existence is not disclosed.

The batch view polls this endpoint every 4s until every catalogue is terminal,
then stops. The existing per-user SSE stream (`userStreamHandler` in
`apps/api/src/modules/jobs/sse.ts`) continues to drive the individual catalogue
pages as it does today — one connection, never one per job. Polling the batch
endpoint rather than deriving batch totals from SSE events keeps the batch view's
counts correct even if the connection drops mid-run.

## Frontend

`apps/catalogues-web/src/app/(app)/studio/page.tsx` is 4590 lines. It gains a
`mode: 'single' | 'batch'` state and a segmented control; batch mode renders one
component and nothing else in that file changes. New files under `studio/batch/`:

| File | Purpose |
|---|---|
| `batch-mode.tsx` | Shell — batch-level header, grid, summary bar |
| `garment-tray.tsx` | Multi-upload dropzone + past-assets picker |
| `batch-grid.tsx` | Header row, row list, add/duplicate/delete |
| `batch-row.tsx` | One row's six cells and its validity state |
| `use-batch-state.ts` | Rows reducer, derived counts, validation |

Pickers reuse the existing `SelectGridModal` (`studio/select-modal.tsx`, already
tag-filtered) and `studio/shared-cards.tsx`. No new picker UI.

**Batch-level header:** gender → garment type → default face → platform → aspect
ratio → resolution. Changing the garment type invalidates every row's pose
selection, since pose availability is garment-type-scoped; the UI warns before
clearing.

**Garment tray.** Dropping N files presigns and uploads them in parallel, each tile
showing its own progress. A failed upload retries individually without blocking the
others. A "Past uploads" tab lists `/v1/assets`. Tiles are assigned to a row's
garment cell and may feed several rows.

**Row.** Six cells: `garment | face | background | poses | lower | shoes`. Face is
pre-filled from the batch default and overridable. Poses is multi-select, the cell
summarising as `3 poses` with thumbnails. Lower and shoes are disabled until the
row's selected poses report `hasLower`/`hasShoes` via `requiredInputsForPoses`;
deselecting the last pose that needed them clears the stale value rather than
submitting it.

**Summary bar** (sticky): `12 rows · 34 images · 34 credits · balance 500`. Submit
is disabled with a specific reason — over cap, over balance, or `3 rows incomplete`
with the offending rows scrolled into view and highlighted. The client mirrors
server validation so a 400 is an exception rather than part of the flow.

**After submit.** Redirect to `/catalogues?batch=<batchId>`. With that query param
present, the catalogues page sources its list from `GET /v1/batches/:id` instead of
the unfiltered catalogues endpoint, so no batch filter is added to the existing
list route.

**Mobile.** Below `md`, rows render as stacked label/value cards instead of a
six-column table. Same state, different layout.

## Error Handling

Every failure is attributable to a row.

| Case | Status | Body |
|---|---|---|
| Row references inactive pose/background/face | 400 | `{ error: 'BAD_CATALOG', rowIndex, message }` |
| Row missing a required lower/shoe input | 400 | `{ error: 'VALIDATION', rowIndex, message }` |
| Garment key not owned by caller | 403 | `{ error: 'FORBIDDEN', rowIndex }` |
| `Σ poseIds` over cap | 400 | `{ error: 'VALIDATION', totalJobs, maxBatchJobs }` |
| Balance short at preflight | 402 | `{ error: 'INSUFFICIENT_CREDITS', required, available }` |
| `atomicDeduct` fails mid-transaction | 402 | full rollback, nothing created |
| Some `XADD`s fail | 201 | `{ …, failedJobIds }` — those refunded and `FAILED` |
| All `XADD`s fail | 503 | all refunded and `FAILED` |

The invariant: nothing partial reaches the queue with credits taken and no job, or
a job created with no deduct.

## Testing

`apps/api/test/integration/batch-jobs.test.ts`, using the existing harness (fresh
Postgres database and MinIO bucket per file):

1. **Happy path** — 3 rows × 2 poses → 6 jobs, one `batchId`, 3 distinct
   `catalogueId`s, ledger totalling 6 × cost, 6 stream entries.
2. **Insufficient balance** — 402, zero jobs, zero ledger rows, balance unchanged.
3. **Over cap** — 400, nothing created.
4. **Invalid row** — inactive pose in row 2 → 400 with `rowIndex: 1`, nothing created.
5. **Foreign garment key** — 403, nothing created.
6. **Missing required lower** — pose requires it, row omits it → 400 with `rowIndex`.
7. **Same garment on two rows** — 201, two catalogues.
8. **Duplicate pose within a row** — 400 (existing dedupe in `resolveTryonPlan`).
9. **Batch/single parity** — a 2-row batch and two equivalent `POST /v1/jobs/tryon`
   calls produce identical `job_inputs` rows. This is the guard on the lookup-cache
   refactor; without it a cache bug silently changes what the dispatcher receives.
10. **Enqueue failure** — `XADD` stubbed to fail; jobs end `FAILED` and refunded,
    with the correct status for all-fail versus some-fail.
11. **`GET /v1/batches/:id`** — correct counts; 404 for another user's batch.
12. **`requiredInputsForPoses`** — unit tests for the pure rule.

The existing single-job suite is the regression guard for the `resolveTryonPlan`
cache parameter.

**Frontend verification** is `pnpm typecheck` plus a manual run.
`apps/catalogues-web` has no test runner and no `test` script, and this feature is
not the right moment to introduce one — which is precisely why the row-requirement
rule was extracted into `@tryme/types`, where it can be tested.

## Invariants

- Credit deduct and job insert stay in one Postgres transaction, now spanning the
  whole batch rather than a single job.
- Catalog ID → R2 key resolution still happens in the API before enqueue; the
  dispatcher is unchanged and does not know batches exist.
- `jobs.batch_id` is nullable and unused by every pre-existing flow.
