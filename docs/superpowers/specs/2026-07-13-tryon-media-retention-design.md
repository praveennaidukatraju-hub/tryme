# Tryon Media Retention — Design

## Problem

The "AI Virtual Try-On (Beta)" flow (`apps/catalogues-web/src/app/(app)/tryon/page.tsx`, jobs with `jobs.source = 'tryon'`) lets a customer upload a photo of themselves and generates a result showing them wearing a garment. Both images — the uploaded person photo and the generated result — are real photos of a real customer's face/body, and today they're kept in R2 forever. That's a privacy liability with no product justification: nothing else in the app needs to keep them around.

This is **not** the same as the studio/catalogue flow (`jobs.source = 'catalog'`), saree flow (`'saree'`), or Shopify flow (`'shopify'`) — those outputs are the paid product a merchant/user builds their catalogue from and must never be touched by this feature.

## Scope

Only `jobs.source = 'tryon'` jobs are in scope. Nothing else.

## What gets deleted, and what doesn't

A `tryon` job has three image references, and they are not equally safe to delete:

| Field | What it actually is | Action |
|---|---|---|
| `job_outputs.resultKey` / `thumbnailKey` | The generated image showing the customer's face/body wearing the garment. This job's own private output. | **Delete** the R2 object, null the column. |
| `job_inputs.params.personKey` | The customer's uploaded photo of themselves. Not a catalogue image — the actual privacy-sensitive item. | **Delete** the R2 object, remove the key from `params`. |
| `job_inputs.upperGarmentKey` | **Not this job's own upload.** `createSimpleTryonJob` sets it to `keys.output(sourceJobId)` — literally the *same* R2 key as another (usually `catalog`) job's real, retained output (`create.ts:486,523`). | **Never delete.** Deleting it would destroy a different, retained job's product photo. |

Confirmed safe: a `tryon` job's own output can never become another job's `sourceJobId` input (`GET /v1/tryon/garment-images` explicitly filters on `poseId IS NOT NULL`, which `tryon` jobs never set — see the comment at `jobs/routes.ts:171-177`). So deleting a `tryon` job's result can never orphan another job's reference.

**The job row itself is never deleted** — `jobs`/`job_inputs`/`job_outputs` rows stay for credit-ledger/audit history. Only the R2 objects and the key columns pointing at them are cleared.

**Failed jobs are in scope too.** A `tryon` job's person photo is uploaded (and bound in Redis via `assertOwnsUploadKey`) *before* the job runs, so a `FAILED` job still has a real customer photo sitting in R2 even though it never produced a `job_outputs` row. The purge targets `status IN ('COMPLETED', 'FAILED')`, using `COALESCE(completed_at, created_at)` as the age reference (failed jobs may never get `completedAt` set).

## Data model

New column: `jobs.mediaPurgedAt` (nullable `timestamptz`). Marks a job as swept — makes the sweeper idempotent and lets read paths distinguish "purged" from "still processing."

## Retention setting

One admin-configurable value: **`tryonMediaRetentionMinutes`**, integer, bounded **5 ≤ n ≤ 10080** (1 week), default **1440** (24h). Stored in the existing `config:system` Redis blob under the existing `tryon` sub-object (alongside `tryon.creditCost`), edited via the existing `GET`/`PATCH /admin/config` routes — no new endpoint.

There is no separate "disable" state. 5 minutes is a hard floor, not a sentinel — this is a privacy feature; it shouldn't have a silent permanent-off switch.

This single number is both "how old a job's media must be before it's eligible for deletion" and effectively how promptly deletion happens, since the sweeper polls far more often than the minimum allowed value (below).

## Deletion mechanism

A new sweeper, `apps/dispatcher/src/stream/media-retention-sweeper.ts`, wired into `apps/dispatcher/src/index.ts` next to the existing `sweeperInterval` (stuck-job SLA cleanup, `stream/sweeper.ts`) — same process, same idiom, no new deployment surface.

- Runs on a **fixed internal 1-minute tick** (well under the 5-minute configurable floor), independent of the admin-configured value.
- Every tick, it re-reads `tryonMediaRetentionMinutes` fresh from `config:system` (clamped to `[5, 10080]`, default `1440` if unset/malformed) and purges whatever is currently eligible. This means an admin's config change takes effect on the very next tick — no dispatcher restart needed.
- Query: `jobs.source = 'tryon' AND jobs.mediaPurgedAt IS NULL AND jobs.status IN ('COMPLETED','FAILED') AND COALESCE(completed_at, created_at) <= now() - retentionMinutes`, batched (`LIMIT 50` per tick, mirroring the existing stuck-job sweeper) to avoid one tick doing unbounded work against a large historical backlog.
- For each eligible job: best-effort delete `resultKey`, `thumbnailKey`, `personKey` from R2 (each independently try/caught — R2/S3 `DeleteObject` is idempotent, a missing key is not an error). **Only if every attempted delete for a job succeeds** does the sweeper clear the DB columns (`job_outputs.resultKey`/`thumbnailKey` → `NULL`, `job_inputs.params` → `params - 'personKey'`) and set `jobs.mediaPurgedAt = now()`, all in one transaction. If any delete fails (transient R2/network error), the job is left untouched and retried on the next tick — this avoids ever losing track of an object that failed to delete.
- This also means: on first deploy, any pre-existing historical `tryon` jobs older than the configured window get swept too (a handful of ticks, 50 at a time) — intentional, not a bug; the whole point is not to have old customer photos sitting around.

## Consuming-endpoint safety

`GET /v1/jobs/:id/result` and `GET /v1/jobs/:id/thumbnail` (`apps/api/src/modules/jobs/routes.ts`) currently presign a key derived from the job id regardless of whether the underlying object still exists — after a purge, that would silently hand back a presigned URL for a deleted object (browser shows a broken image). Both routes already load the `jobs` row; add a check on `job.mediaPurgedAt` and return `410 Gone` (`MEDIA_PURGED`) instead of presigning. In practice the live `/tryon` flow fetches the result within seconds of completion (`useJobStream` → immediate fetch, `tryon/page.tsx:520-533`), well inside even the 5-minute floor, so this is a defensive guard for stale links / admin viewing, not a fix for an observed live bug.

## Out of scope (explicitly)

- Kiosk jobs' `jobs.customerPhotoKey` — also a real customer photo, also arguably privacy-sensitive, but a different flow with `source IS NULL`, not covered by this design. Worth a follow-up, not bundled here.
- Any UI change to the `/tryon` page's error copy for the (effectively unreachable in normal use) purged-media case.
