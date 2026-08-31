# Flat Saree: Two-Step Workflow (Mannequin + Drape) Design

## Summary

The temporary standalone Saree Try-On feature (`/saree` page, `saree_settings` table,
`createSareeJob`/`processSareeJob`) is retired and replaced by a new garment type,
**"Flat Saree"**, inside the standard studio wizard. Users pick it exactly like any
other garment type (gender → garment type → upload → face → background → poses →
submit). The only special behavior: this garment type runs generation in two
ComfyUI passes instead of one.

- **Step 1 (mannequin, once per job, 0 credits).** Drapes the user's uploaded flat
  saree cloth onto the selected model face/identity, producing one internal
  "mannequin" image. Never shown to the user, not counted in `/v1/catalogues`.
- **Step 2 (per pose, standard credit each).** Takes the step-1 mannequin image as
  the garment input, plus the user's selected face/background/pose, and produces
  the final result — identical in shape to how every other garment type's per-look
  job already works today.

One mannequin is generated per job regardless of how many poses are selected: a
job with 1 pose produces 1 mannequin + 1 result image; a job with 4 poses produces
1 mannequin + 4 result images. Credits are only charged for the result images —
the mannequin step is free and invisible.

## Why two steps

Draping the saree cloth onto a body (step 1) is the expensive, identity-defining
part of generation. Today's single-workflow saree feature reruns that work for
every pose in a batch. Splitting it lets the expensive part run exactly once per
job and be reused across every pose the user picks, while pose/background/final
compositing (step 2) — which is cheap and needs to vary per look — runs once per
selected pose, same as it already does for every other garment type.

## Non-goals

- No new dispatcher-side job coordination/synchronization primitive. Step 1 and
  every step-2 job are ordinary, independent `jobs` rows processed one at a time
  off the Redis stream exactly like today. Sequencing (wait for step 1 before
  creating step-2 jobs) lives entirely in the API/frontend layer.
- No change to how face/background/pose selection works for any *other* garment
  type — this is purely additive, gated behind a per-garment-type flag.

## Data model changes

### `garment_subcategories` (packages/db/src/schema/models.ts)

Three new columns:

| Column | Type | Purpose |
|---|---|---|
| `requiresMannequinStep` | `boolean not null default false` | Gates the two-step behavior for this garment type. |
| `mannequinWorkflowTemplateId` | `uuid → workflow_templates.id`, nullable | The step-1 workflow (mannequin generation) for this garment type. |
| `sareeStep2WorkflowTemplateId` | `uuid → workflow_templates.id`, nullable | The step-2 workflow (drape + pose + background) for this garment type. Overrides the normal per-pose workflow resolution — see below. |

Migration adds these columns. `requiresMannequinStep` defaults `false` so every
existing garment type is unaffected.

### `workflow_templates.workflowType` (no schema change — free-text column)

New convention value: `'saree_step1'`. Structurally identical to the existing
`'tryon'` shape (2 image inputs — person, garment — 1 output), reusing the
`tryonPersonNodeId` / `tryonGarmentNodeId` / `tryonOutputNodeId` columns unchanged.

Step 2 workflows need **no new tag** — they're plain `workflowType: 'regular'`,
using the existing `faceNodeId` / `poseNodeId` / `bgNodeId` / `upperNodeIds`
columns exactly as any other pose-based garment type would. `saree-step2.json`'s
four inputs (face, pose, background, garment) map onto those four columns
directly; `upperNodeIds` carries the mannequin image in as the "garment" input.

### Retired

- `saree_settings` table — dropped via migration.
- No replacement table needed; the two new `garment_subcategories` columns above
  fully replace its role (single admin-fixed model image goes away entirely —
  face is now user-selected, same as every other garment type).

### `/v1/catalogues` exclusion (apps/api/src/modules/jobs/routes.ts)

The three existing query sites already filter
`params->>'sourceJobId' is null` to hide tryon-direct derivative jobs. Add
`params->>'kind' != 'saree_mannequin'` (or equivalent `is distinct from`) alongside
it, so mannequin jobs never appear in the user-facing catalogue.

## Job creation flow (apps/api/src/modules/jobs/create.ts)

`createJob()` gains a branch keyed on the selected garment type's
`requiresMannequinStep`:

**If false (every existing garment type):** unchanged — today's exact code path.

**If true (Flat Saree):**

1. **Create the step-1 job.** A single job row: `job_inputs.params.kind =
   'saree_mannequin'`, `creditsCharged = 0` (no `atomicDeduct` call), inputs =
   the user's uploaded flat-saree photo (`upperGarmentKey`) + the selected face's
   `r2Key`. Workflow = `garmentSubcategories.mannequinWorkflowTemplateId`. Enqueued
   through the normal Redis stream like any job.
2. **Wait for completion.** The frontend subscribes to this job via the existing
   SSE job-stream (`useJobStream`, already used elsewhere) and shows a "preparing
   garment…" state. No backend polling/blocking — this is the same
   subscribe-and-wait pattern the app already uses everywhere.
3. **Create the step-2 jobs.** Once step 1 reaches `COMPLETED`, a second API call
   (carrying the same face/background/poses selections plus the step-1 job id)
   creates N jobs — one per selected `{poseId, backgroundId}` look — via the
   *same* per-look insert loop `createJob()` already runs today, except:
   - `upperGarmentKey` is set to **step 1's output image key** (not a fresh
     upload).
   - The workflow used for every look is
     `garmentSubcategories.sareeStep2WorkflowTemplateId`, bypassing the normal
     `pose_garment_configs` / `model_pose_assets.workflowTemplateId` lookup
     entirely (a saree pose's own workflow assignment, if any, is ignored).
   - Credits are charged normally, per job, exactly like any other garment type.

If step 1 fails, no step-2 jobs are ever created and no credits beyond the
(zero) step-1 charge were ever spent. The user sees the failure and can resubmit
from scratch.

### New ownership-check helper

Parallel to `assertOwnsUploadKey`: given the step-1 job id and the caller's
`userId`, verify the job belongs to the caller, is `COMPLETED`, and has
`params.kind === 'saree_mannequin'`, then read its `job_outputs.imageKey`. This
bypasses the presigned-upload Redis ownership check (`upload:owner:<key>`) since
this key was never a raw upload — it's a job's own output.

## Dispatcher changes (apps/dispatcher/src/job/processor.ts)

- **Step-1 jobs** route through what is today `processSareeJob`, renamed/adjusted:
  same 2-image-in/1-image-out patch-and-submit logic, now keyed off
  `params.kind === 'saree_mannequin'` instead of `'saree'`, reading the workflow
  template via `garmentSubcategories.mannequinWorkflowTemplateId` (looked up
  through `job_inputs.garmentTypeId`) rather than the old global
  `saree_settings.workflowTemplateId`.
- **Step-2 jobs** are indistinguishable from any other garment type's per-look
  job at the dispatcher level — `faceId`/`backgroundId`/`poseId` are all present,
  so they fall straight into the existing regular-job code path, completely
  unmodified. The only difference is that `upperGarmentKey` happens to point at
  a machine-generated image instead of a user upload — the dispatcher doesn't
  need to know or care.
- `processSareeJob`'s old routing condition
  (`!inputs.faceId && !inputs.backgroundId && !inputs.poseId && rawParams.kind === 'saree'`)
  is replaced with a condition for the new step-1 shape (still no face/background/
  pose — the mannequin step doesn't have those columns set on its own job row).

## Admin UI changes

### `EditGarmentTypeModal.tsx`

One new Switch: **"Two-step generation (mannequin + drape)"**, bound to
`requiresMannequinStep`. When on, reveals two new `<select>` dropdowns (same
pattern as the existing `tryonCategoryId` select):

- **"Mannequin (Step 1) Workflow"** — options = active `workflowType:
  'saree_step1'` templates.
- **"Draping (Step 2) Workflow"** — options = active `workflowType: 'regular'`
  templates.

Both lists come from the existing `GET /admin/workflows` endpoint.
`GarmentTypesTab.tsx` fetches/passes this list down as a new prop (or reuses
whatever fetch `WorkflowsPage.tsx` already does, hoisted up). Save goes through
the existing `PATCH /admin/assets/garment-types/:id`, which already spreads
arbitrary body fields onto the row — only `PatchGarmentTypeBody`'s zod schema
needs widening to accept the 3 new fields (`requiresMannequinStep`,
`mannequinWorkflowTemplateId`, `sareeStep2WorkflowTemplateId`). No new admin
routes needed for the garment-type side.

### `/admin/workflows` (apps/api/src/modules/admin/workflows.routes.ts)

Widen the existing `workflowType === 'tryon'` branch (in both `POST
/admin/workflows` and `POST /admin/workflows/parse`) to also accept
`'saree_step1'`, storing the actual passed-in type instead of hardcoding
`'tryon'`. Reuses `detectTryonMappings` and the same person/garment/output
validation unchanged. `CreateWorkflowBody`'s `workflowType` zod enum
(`packages/types`) needs widening to include `'saree_step1'`.

`WorkflowsPage.tsx`'s type badge gets a third label/color for `'saree_step1'`
(currently only distinguishes `'tryon'` vs. everything else as "Catalogue
workflows").

## Frontend studio changes

- "Flat Saree" is added as a normal row in the Garment Type picker (Step 0 of the
  studio wizard) — no new UI surface there.
- Step 0's existing upload slot is reused for the flat-saree cloth photo — same
  `upperGarmentKey` presign flow every garment type already uses.
- Face (Step 1), Background (Step 2), Poses (Step 3, multi-select) are all
  unchanged — the existing wizard already supports everything needed.
- On final submit, if the selected garment type has `requiresMannequinStep`, the
  submit handler:
  1. POSTs to create the step-1 job, shows a "Preparing your garment…" wait
     state, subscribes via the existing SSE hook.
  2. On `COMPLETED`, POSTs the existing job-creation payload (face + looks) with
     the step-1 job id attached, then proceeds through the normal
     multi-job-progress UI exactly as any other multi-pose batch does today.
  3. On step-1 `FAILED`, shows an error and returns the user to the submit step
     — no charges were made.
- The standalone `/saree` page and its sidebar entry are deleted.

## Retirement checklist

- Delete: `apps/catalogues-web/src/app/(app)/saree/page.tsx`, its sidebar entry.
- Delete: `apps/api/src/modules/admin/saree.routes.ts`,
  `apps/api/src/modules/saree/settings.ts`,
  `apps/api/src/modules/jobs/createSaree.ts`.
- Delete: `packages/db/src/schema/saree.ts` (`saree_settings` table) + migration
  to drop the table.
- Rename/repurpose: `processSareeJob` → step-1 mannequin handler;
  `saree-detect.ts` → reused as the step-1 (`saree_step1`) node detector, wired
  into the generic workflow upload route instead of its own dedicated route.
- Remove: the old admin Saree page in `apps/admin-web`.
- Update: any test referencing the old `/v1/jobs/saree`, `/admin/saree-*` routes,
  or `saree_settings`.

## Testing

- Migration test: `garment_subcategories` new columns default correctly; existing
  rows unaffected.
- `createJob()`: new integration tests for a `requiresMannequinStep` garment type
  — step-1 job created with 0 credits and excluded from `/v1/catalogues`; step-2
  jobs created only after step-1 `COMPLETED`; step-2 jobs use
  `sareeStep2WorkflowTemplateId` regardless of the pose's own workflow
  assignment; step-1 failure blocks step-2 creation entirely.
- Dispatcher: unit/integration test that a `saree_mannequin`-kind job routes to
  the renamed step-1 handler and patches person+garment nodes correctly; a
  regular job with a mannequin-sourced `upperGarmentKey` needs no dispatcher
  changes to verify (already covered by existing regular-job tests).
- Admin: `/admin/workflows` accepts `workflowType: 'saree_step1'` and applies the
  same validation as `'tryon'`; `PATCH /admin/assets/garment-types/:id` accepts
  and persists the 3 new fields.
- Ownership helper: rejects a step-1 job id that isn't `COMPLETED`, isn't owned
  by the caller, or isn't `kind: 'saree_mannequin'`.

## Open implementation details (for the plan, not blocking design approval)

- Exact zod schema locations for `CreateWorkflowBody`, `PatchGarmentTypeBody`
  widening (packages/types).
- Whether the two sequential API calls for Flat Saree submission reuse the
  existing `/v1/jobs/tryon`-style endpoint with a discriminating field, or get a
  small dedicated pair of endpoints (e.g. `/v1/jobs/saree-mannequin` +
  the existing batch endpoint) — a plan-level naming decision, not an
  architectural one.
