# Free-Tier Watermarking & Regenerate-Without-Watermark

**Date:** 2026-07-02
**Status:** approved

## Problem

All generated images are currently delivered identically regardless of the user's plan. Free-tier
users receive the same full-quality, unbranded asset as paid users, with no incentive tied to the
image itself to upgrade.

## Goal

Free-tier generations are watermarked; paid-tier generations are not. The decision is made once,
deterministically, at job creation, and never re-evaluated. Users who upgrade after generating a
watermarked image do not get it unlocked retroactively — they regenerate it as a new, fully-billed
job.

## Non-goals (explicitly deferred)

- No storage/schema redesign of `job_outputs` beyond one additive column.
- No retention of the pre-watermark original for free-tier jobs (deleted immediately after
  compositing — never persisted, never a separate "keep for N days" config).
- No generic multi-tier entitlement/capability engine (trial, beta, partner, enterprise policies).
  `credit_plans` remains the single entitlement source, same as `queueStream` today.
- No worker-host-side cleanup of ComfyUI intermediate output (workers are private, no inbound
  ports, per existing tunnel architecture — out of scope here).
- No invisible/steganographic watermarking, no multiple watermark variants.

If any of these become real requirements later, they are additive changes on top of this design,
not blockers to shipping it.

## Design

### Database

**Migration: add `watermark` capability to `credit_plans`**

```sql
ALTER TABLE credit_plans ADD COLUMN watermark boolean NOT NULL DEFAULT false;
UPDATE credit_plans SET watermark = true WHERE slug = 'free';
```

Mirrors the existing `queue_stream` column exactly — a plan-level capability flag, admin-editable
through the existing `creditPlans.routes.ts` CRUD guards, no new abstraction.

**Migration: snapshot column on `jobs`**

```sql
ALTER TABLE jobs ADD COLUMN watermark boolean NOT NULL DEFAULT false;
```

Same shape and lifecycle as the existing `jobs.queue_stream` column (`packages/db/src/schema/jobs.ts:14`)
— resolved once at creation, read by the dispatcher, never re-derived.

**Migration: asset metadata on `job_outputs`**

```sql
ALTER TABLE job_outputs ADD COLUMN asset_kind text NOT NULL DEFAULT 'ORIGINAL';
-- values: 'ORIGINAL' | 'WATERMARKED'
ALTER TABLE job_outputs ADD COLUMN watermark_version smallint;
-- null when asset_kind = 'ORIGINAL'; the WatermarkService algorithm/pattern version
-- used, so a future tweak to the watermark design doesn't retroactively confuse
-- which historical jobs used which look.
```

`asset_kind` deliberately stays `text`, not a Postgres enum, matching every sibling
status/type column in this schema (`jobs.status`, `jobs.queue_stream`,
`workflow_templates.workflow_type`) — none of them use `pgEnum`, and this repo has none
anywhere. Validate at the app layer (zod), same as `status` already is; Postgres enums
are painful to alter later (`ALTER TYPE ... ADD VALUE` has transactional restrictions,
renaming/removing a value is a real migration) for no benefit this column needs.

Purely observational — admin UI, analytics, regenerate-CTA logic. Delivery routes and R2 keys are
unchanged (`outputs/{jobId}/result.png`, `outputs/{jobId}/result.thumb.jpg` per
`packages/storage/src/keys.ts`).

**`asset_kind` is derived, not independently set.** `jobs.watermark` is the *decision*
(resolved once at creation); `job_outputs.asset_kind` is the *observed outcome*, written
only by `finalizeOutput()` after a successful upload, as
`watermarkApplied ? 'WATERMARKED' : 'ORIGINAL'`. `watermarkApplied` reflects what actually
ran — see the kill-switch note below for why these can legitimately differ from
`jobs.watermark`. Nothing else writes this column, so it can never drift out of sync with
what was actually delivered.

**Migration: `parentJobId` on `jobs`**

```sql
ALTER TABLE jobs ADD COLUMN parent_job_id uuid REFERENCES jobs(id);
```

Nullable self-FK, set only by the regenerate endpoint. Traceability for support/analytics; no
entitlement logic depends on it.

### Precedence rule (document explicitly, this is the whole point of the design)

> `credit_plans.watermark` is consulted **only once**, during job creation, alongside the existing
> `queueStream` join. The resolved value is snapshotted onto `jobs.watermark`. After the job row is
> persisted, the snapshot is the sole source of truth — the dispatcher never queries `credit_plans`
> and never inspects `users.tier`. Subsequent changes to the user's plan, or to a credit plan's
> `watermark` setting, must never affect already-created jobs. This is what makes behavior
> deterministic for jobs that are queued when a user upgrades mid-wait.

### API Changes

#### Job creation (`apps/api/src/modules/jobs/create.ts`)

Extend the existing plan join (currently resolving `queueStream` at ~lines 239–246 / 344–346) to
also select `watermark`:

```ts
const [planRow] = await tx
  .select({ queueStream: schema.creditPlans.queueStream, watermark: schema.creditPlans.watermark })
  .from(schema.users)
  .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
  .where(eq(schema.users.id, userId));
```

Set `watermark: planRow?.watermark ?? false` on the `jobs` insert, same fallback pattern already
used for `queueStream` falling back to `'normal'`.

Apply this to every job-creation path that currently resolves `queueStream` (regular tryon, saree,
widget — check all call sites, not just the primary one).

#### Regenerate endpoint (new)

`POST /v1/jobs/:id/regenerate`

1. Load the original job + its `job_inputs` row. 404 if not found or not owned by the caller.
   Reject with 409 if `job.status !== 'COMPLETED'` — never regenerate a failed, cancelled,
   queued, or in-progress job.
2. Re-validate every referenced ID exactly as `jobs/create.ts` does today (garment key still
   present, faceId/backgroundId/poseId/lowerCatalogId/shoeCatalogId still active) — do not
   silently substitute or drop a stale reference; fail with a clear message
   ("one of the original selections is no longer available") if anything fails validation.
3. Resolve current pricing and current `watermark` entitlement exactly as a normal job creation
   would (i.e. call through the same creation path/helper — do not special-case pricing for
   regenerate).
4. Deduct credits atomically, insert new `jobs` row with `parentJobId = original.id`, copy
   `job_inputs` from the original job's inputs.
5. Enqueue normally (`XADD`) — regenerated jobs are ordinary jobs from the dispatcher's
   perspective in every respect except `parentJobId`.

No changes needed to `apps/api/src/modules/jobs/routes.ts` (result delivery) — it already serves
one signed URL per job; that's unaffected by any of this.

### Dispatcher Changes (`apps/dispatcher/src/job/processor.ts`)

Three near-identical blocks currently repeat: download output → upload result → generate
thumbnail → transition COMPLETED (in `processJob`, `processTryonDirectJob`, `processSareeJob`).
Extract a shared helper, e.g. `finalizeOutput()` in `apps/dispatcher/src/workflow/finalize.ts`:

```
download output
  ↓
watermarkApplied = job.watermark && ENABLE_WATERMARKING
if (watermarkApplied) → WatermarkService.apply({ image: buffer, jobId })
  ↓
upload to keys.output(jobId)          [watermarked or original — same key either way]
  ↓
generate thumbnail FROM THE FINAL UPLOADED BUFFER (not the pre-watermark original)
  ↓
upload to keys.outputThumb(jobId)
  ↓
write job_outputs.asset_kind = watermarkApplied ? 'WATERMARKED' : 'ORIGINAL'
      job_outputs.watermark_version = watermarkApplied ? WATERMARK_VERSION : null
      (WATERMARK_VERSION imported from watermark.ts — see WatermarkService section)
  ↓
transitionJob(..., 'COMPLETED', { resultKey, thumbnailKey })
```

Call this helper from all three existing branches instead of the duplicated inline logic.

**Fail-closed requirement:** if `WatermarkService.apply()` throws for a `watermark: true` job, the
job must fail (existing retry/refund logic applies) — it must never fall through to uploading the
un-watermarked buffer. This is a security property, not just error handling; write a test for it.

The pre-watermark original buffer is held only in memory during this step and is never written to
R2 for a `watermark: true` job — no temp key, no cleanup step needed, because it's never persisted
in the first place.

**Kill switch:** `ENABLE_WATERMARKING` env var (default `true`), read by the dispatcher only.
Setting it `false` in production disables watermark compositing globally without a redeploy.
`jobs.watermark` (the entitlement snapshot) is untouched by this — it's a dispatcher-side
execution override, not a change to what any job was entitled to. `job_outputs.asset_kind` still
records what actually happened (`'ORIGINAL'` while the switch is off), per the derivation rule
above, so there's no discrepancy between recorded and delivered assets.

Whenever `job.watermark` is `true` but the kill switch makes `watermarkApplied` come out `false`,
log it at **WARN**, not INFO — this divergence should only ever happen during an intentional
incident override, and WARN makes that visible in production instead of looking like a silent bug:
```ts
logger.warn({
  stage: 'watermark',
  jobId,
  expectedWatermark: job.watermark,
  appliedWatermark: watermarkApplied,
  reason: 'ENABLE_WATERMARKING_DISABLED',
});
```

**Idempotency:** no new mechanism needed. `keys.output(jobId)` is a fixed, deterministic key — an
R2 `PUT` to a fixed key is naturally idempotent (overwrite), and `WatermarkService.apply()` is a
pure function with no side effects before upload. Re-running `finalizeOutput()` on a dispatcher
retry (existing `XPENDING` recovery / max-2-attempts model) reproduces the same bytes at the same
key; there's nothing to dedupe that isn't already handled by the existing job-status/credit-refund
transaction boundaries, which this feature doesn't add to or change.

**Logging:** `finalizeOutput()` should log (via the existing pino child logger, `jobId`/`userId`
bindings already required) on completion:
```ts
{
  stage: 'watermark',
  jobId,
  watermarkApplied,
  watermarkVersion,
  processingTimeMs,
  imageWidth,
  imageHeight,
  imageSizeBytes,
  outputFormat,
}
```
Cheap now, and the only way to answer questions like "do 4K images slow the dispatcher down" or
"what's the average watermark time" later as a log query instead of a code change.

### `WatermarkService` (new, `apps/dispatcher/src/workflow/watermark.ts`)

- Sharp-based compositing.
- `export const WATERMARK_VERSION = 1;` — the constant `finalizeOutput()` writes to
  `job_outputs.watermark_version`. Bump it whenever the tile/logo/opacity/rotation design changes,
  so historical jobs stay attributable to the look they actually got.
- **What's cached is the tile, not a final overlay.** Pre-render the small repeating unit once —
  logo + wordmark, ~35° rotation, ~10–12% opacity, baked into one tile-sized buffer — at module
  load. This is cheap because a tile's dimensions are fixed regardless of the source image. Do
  *not* pre-render a full-canvas overlay: every job's image has different dimensions, so there is
  no single "the overlay" to cache.
- Per job: take the cached tile, compute a `jobId`-seeded offset, tile it across the actual image's
  canvas, composite. This offset calculation + composite is the only per-job work — the tile
  geometry itself is never rebuilt.
- Cache lifecycle is explicit: on dispatcher startup, load the logo once, build the tile buffer
  once, hold it in module-level memory for the process lifetime.
- **Startup validation:** if `ENABLE_WATERMARKING=true`, the dispatcher must load the logo and
  build the tile buffer during startup, before accepting jobs, and **exit non-zero if that fails**
  (missing/corrupt logo asset, Sharp init error). Failing closed at startup — not on the first free
  job — turns a silent mid-traffic crash into an obvious deploy-time failure.
- Signature is an options object, not positional args, so a future addition (opacity override,
  named variant) doesn't become a breaking change:
  ```ts
  function apply(opts: { image: Buffer; jobId: string }): Promise<Buffer>
  ```
  (`watermark: true`/`false` is decided by the caller — `finalizeOutput()` only calls `apply()`
  when it's already decided to; the service itself has no notion of entitlement.)
- Pure function otherwise: no R2/DB access inside the service — keeps it unit-testable in
  isolation.

### Admin UI (`apps/admin-web/src/pages/SettingsPage.tsx`)

Add a `watermark` toggle to `PlanModal`, alongside the existing `isActive`/`isHighlighted` toggles.
No special-casing needed for the free plan beyond what already exists (its row simply defaults to
`watermark: true`).

### Job history / catalogue UI

- Add `assetKind` to the job/catalogue detail payload (`apps/api/src/modules/jobs/routes.ts`
  response shape) so the frontend can render the regenerate CTA.
- When `assetKind === 'WATERMARKED'` and the viewing user's current plan has `watermark: false`,
  show: *"This image was generated while your account was on the Free plan and will remain
  watermarked."* with a **"Regenerate without Watermark"** button calling the new endpoint.
- Regenerated jobs appear as ordinary new entries in catalogue/history — no special grouping
  required beyond optionally showing `parentJobId` in admin views for support traceability.

## Rollout order

Deliberately split into a behavior-preserving refactor step (2) before the new feature lands (3+),
so a regression in the dispatcher's long-standing triplicated logic is never conflated with a bug
in brand-new watermarking code.

1. Migrations: `credit_plans.watermark`, `jobs.watermark`, `jobs.parent_job_id`,
   `job_outputs.asset_kind`, `job_outputs.watermark_version`.
2. `finalizeOutput()` shared helper wired into all three dispatcher branches, **with no
   watermarking behavior yet** — pure refactor of the existing download → upload → thumbnail →
   transition logic. Deploy and verify all three job types (regular, tryon-direct, saree) still
   produce identical output to before. This isolates refactor risk from feature risk.
3. `jobs/create.ts` (and other job-creation call sites): resolve + snapshot `watermark`.
4. `WatermarkService`, wired into `finalizeOutput()` behind `ENABLE_WATERMARKING`.
5. Admin UI: `watermark` toggle in `PlanModal`.
6. `POST /v1/jobs/:id/regenerate`.
7. Catalogue/history UI: `assetKind` in response, "Regenerate without Watermark" CTA.

## Tests

- `jobs/create.ts`: watermark snapshot resolves correctly from the user's current plan; a plan
  change or user upgrade after job creation does not retroactively change an existing job's
  snapshot.
- End-to-end snapshot regression: free user creates a job (`jobs.watermark = true`), user upgrades
  to a paid plan *while the job is still queued/processing*, job completes — assert
  `job_outputs.asset_kind === 'WATERMARKED'` regardless of the user's plan at completion time. This
  is the core business rule the whole snapshot-at-creation design exists to guarantee; test it
  directly rather than only inferring it from the creation-time unit test above.
- Dispatcher: `WatermarkService` unit tests (pure function, deterministic given a jobId seed).
  `finalizeOutput()` fails the job (does not upload) when watermarking throws for a
  `watermark: true` job.
- Regenerate endpoint: rejects stale/deactivated referenced assets; charges current pricing;
  creates a new job with `parentJobId` set; original job/asset is untouched.
- Thumbnail: for a `watermark: true` job, assert the thumbnail is generated from the watermarked
  buffer, not the pre-watermark original (regression guard for the leak this design explicitly
  closes).
