# Dev API — Saree Mannequin Endpoint — Design

**Date:** 2026-07-20
**Status:** Approved, ready for implementation plan

## Problem

The Flat Saree garment type's "step 1" (mannequin generation) flow was just wired up in-repo
(new `sdrapewithpalluapi.json` template, face now baked into the workflow via a fixed URL node
instead of an admin-curated `model_faces` selection — see `saree_step1` workflow template,
id `1ad50c69-...`). It currently only runs through the Studio wizard
(`POST /v1/jobs/saree-mannequin`, `app.requireUser` cookie auth) as step 1 of a two-step
per-pose pipeline.

We want to test/expose this over the developer API (`sk_live_...` bearer key), the same way
`/v1/dev/tryon` exposes the regular tryon pipeline. Two constraints drove the shape:

- `/v1/dev/tryon` is a **documented public contract** (`apps/api/dev-api-quickstart.md`) with
  real merchant traffic. Its `category: 'saree'` already resolves to a *different* template
  (`saree_tryon`, id `5e11bc13-...`) — reusing or repurposing it risks a silent regression for
  existing integrators.
- The mannequin step's output is currently an internal, disposable, 0-credit intermediate
  (`jobWatermark: false`, never surfaced to the end user) — consumed only as raw material by
  step 2. Exposing it as a public API product is a distinct decision from wiring it internally.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Endpoint | New, separate route: `POST /v1/dev/saree-mannequin` | Zero risk to `/v1/dev/tryon`'s existing contract/behavior. |
| Output | Raw step-1 image, as-is | Simplest to ship now. No pose/background composition — that's step 2, not in scope. |
| Category param | None — hardcoded lookup | Only one `garment_subcategories` row has `requires_mannequin_step = true` today (Flat Saree). No `category`/`garmentType` param until a second one exists (YAGNI). |
| Person image | None — not accepted | Face is baked into the workflow template via a fixed-URL node; there is nothing for a caller to supply. |
| Credits | Charged, reusing `getTryonCreditCost(app)` | Real GPU compute, real deliverable (unlike the free internal step-1 call, which is always followed by a paid step-2). No new pricing config for v1 — revisit if a distinct price is wanted later. |
| Shared internals | Refactor `createDevTryonJob`'s transaction/enqueue/refund boilerplate into a small shared helper; both job-creation functions call it | Avoids duplicating the credit-deduct/insert/xadd/refund-on-fail pattern, without touching `/v1/dev/tryon`'s route, schema, or behavior at all. |
| Polling | Reuse existing `GET /v1/dev/jobs/:id` | Already generic over `jobs.source = 'api'` — no changes needed. |
| Dispatcher | Fix `processSareeMannequinJob`'s early input guard | Currently hard-requires `faceId` truthy unconditionally; must only require it when the resolved template has a `tryonPersonNodeId` set (see below). |

## What already exists

- `apps/dispatcher/src/job/processor.ts:152` — routes to `processSareeMannequinJob` when
  `job_inputs.params.kind === 'saree_mannequin'` and `backgroundId`/`poseId` are both null. This
  condition does **not** check `faceId` — only the function's own internal guard does.
- `apps/dispatcher/src/job/processor.ts:~808-824` (`processSareeMannequinJob`) — currently:
  ```ts
  if (!garmentKey || !faceId || !garmentTypeId) { ... markFailed(MANNEQUIN_INPUTS_MISSING) }
  ```
  This must become: `garmentKey`/`garmentTypeId` always required; `faceId` required (and the
  `modelFaces` lookup performed) **only if** the resolved template's `tryonPersonNodeId` is set.
  This requires reordering — resolve garment type → workflow template *before* validating
  `faceId`'s presence, instead of the current all-up-front check.
- `job_inputs.face_id` — confirmed nullable in the DB (`\d job_inputs`), no migration needed.
- `apps/api/src/modules/dev/create-job.ts::createDevTryonJob` — the pattern to mirror: resolve
  cost → validate category/template active → check user not banned → transaction (insert `jobs`,
  `atomicDeduct`, insert `job_inputs`, `xadd`) → refund + fail on enqueue error.
- `apps/api/src/modules/dev/routes.ts` — the dual multipart/JSON-base64 request handling,
  `sniffImageMime` validation, and rate-limit config to reuse verbatim for the new route.
- `GET /v1/dev/jobs/:id` — already scopes by `apiKeys.merchantId` and `jobs.source = 'api'`
  generically; no changes needed for the new job kind to be pollable.

## Architecture

```
Dev server ──sk_live_…──> POST /v1/dev/saree-mannequin (multipart or JSON-base64: garment)
                             │ 1. requireApiKey (existing plugin, unchanged)
                             │ 2. per-key rate limit (existing config, reused)
                             │ 3. look up garment_subcategories WHERE requires_mannequin_step = true
                             │    AND is_active → mannequinWorkflowTemplateId; verify template active
                             │ 4. upload garment image → R2
                             │ 5. shared TX helper: insert job (source: 'api', watermark: false) +
                             │    atomicDeduct(cost) + insert job_inputs (upperGarmentKey,
                             │    garmentTypeId, faceId: null, params: {kind:'saree_mannequin'})
                             │ 6. XADD jobs:normal (refund + FAILED on enqueue error)
                             ▼
                           202 { jobId, status: 'QUEUED' }

Dev server ──sk_live_…──> GET /v1/dev/jobs/:id   (existing route, unchanged)
                             └─ COMPLETED → presigned imageUrl (15 min)

Dispatcher: processor.ts:152 routes on params.kind === 'saree_mannequin' (unchanged condition)
              └─ processSareeMannequinJob: guard relaxed to only require faceId when
                 template.tryonPersonNodeId is set → skips face resolution/upload/patch
                 entirely for this template (already true for the Studio-triggered path,
                 now also true when faceId arrives as null from the dev API)
```

## New/changed files

| File | Change |
|---|---|
| `apps/api/src/modules/dev/routes.ts` | Add `POST /v1/dev/saree-mannequin` (multipart + JSON-base64, single `garment` field, `requireApiKey`, reused rate-limit config). |
| `apps/api/src/modules/dev/create-saree-mannequin-job.ts` | New. Mirrors `createDevTryonJob`, built on the shared transaction helper. |
| `apps/api/src/modules/dev/create-job.ts` | Extract shared transaction/enqueue/refund logic into a reusable helper; `createDevTryonJob` calls it, behavior unchanged. |
| `packages/types/src/jobs.ts` (or `dev.ts`) | New `DevSareeMannequinJsonBody = z.object({ garment: z.string() })` for the JSON-base64 path. Response reuses the existing `DevTryonResponse`/`DevJobResponse` shape. |
| `apps/dispatcher/src/job/processor.ts` | Reorder `processSareeMannequinJob`'s input guard: require `garmentKey`/`garmentTypeId` up front; resolve template first; require `faceId` (and do the `modelFaces` lookup) only when `template.tryonPersonNodeId` is set. |
| `apps/api/dev-api-quickstart.md` | Document the new endpoint (request/response shape, credits, errors) alongside the existing `/v1/dev/tryon` docs. |

## Error handling

Mirrors `/v1/dev/tryon`'s existing error envelope and codes where applicable:

- `VALIDATION` (400) — missing/oversized/invalid `garment` file.
- `BAD_CATEGORY`-equivalent (400) — no active `requires_mannequin_step` garment type configured,
  or its workflow template is inactive/missing. No credits charged.
- `INSUFFICIENT_CREDITS` (402) — same atomic-deduct-first pattern as `/v1/dev/tryon`.
- `ENQUEUE_FAIL` (503) — credits auto-refunded, same as `/v1/dev/tryon`.
- `FORBIDDEN` (403) — merchant account suspended.

## Out of scope (this design)

- No `category`/`garmentType` request param — single hardcoded lookup only, until a second
  mannequin-step garment type exists.
- No pose/background composition (step 2) exposed via the dev API — raw step-1 output only.
- No API versioning (`/v1/dev/v2/*`) — this is additive, not a migration of existing routes.
- No new admin-configurable pricing for this endpoint — reuses the existing tryon credit cost.
- No changes to `/v1/dev/tryon`'s route, request/response contract, or the `saree` category's
  existing `saree_tryon` template.
