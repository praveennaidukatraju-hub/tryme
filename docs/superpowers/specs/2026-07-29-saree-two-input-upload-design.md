# Saree Two-Input (Body + Pallu) Upload Design

## Summary

The "Flat Saree" garment type (see `2026-07-14-flat-saree-two-step-workflow-design.md`)
today accepts exactly one uploaded image for its step-1 "mannequin" pass: a single
flat-lay saree photo, patched into a 2-image ComfyUI workflow (person + garment).

This adds a second upload mode for Flat Saree only: **Body & Pallu**, where the
user uploads two separate flat-lay images (the draped body and the pallu piece)
instead of one combined photo. Which mode is used is a per-submission choice
made via a dropdown, not a fixed garment-type setting — admin configures a
second ("two-input") step-1 workflow for Flat Saree, and the dropdown only
appears once that second workflow exists. Everything downstream of step 1
(face/background/pose selection, step 2 drape+compose, credits) is unaffected.

## Non-goals

- No change to any garment type other than Flat Saree — the dropdown is gated
  specifically on the Flat Saree garment type, not a generic capability flag.
- No change to step 2 (drape + pose + background) — it continues to consume
  the step-1 mannequin output image exactly as today, regardless of which
  upload mode produced it.
- No change to the widget/dev-API inline mannequin path (`runMannequinPhase`
  in `apps/dispatcher/src/job/mannequin-phase.ts`) — that path is unrelated to
  the studio wizard's dedicated step-1 job flow this feature extends.

## User-facing behavior

In the studio wizard (`apps/catalogues-web/src/app/(app)/studio/page.tsx`),
Step 0's "Upload Garment Image" card:

- When the selected garment type is Flat Saree **and**
  `garmentType.mannequinTwoInputWorkflowTemplateId` is non-null (returned by
  `/v1/models/garment-types`), a dropdown appears at the top of the upload
  card: **"Full Saree"** (default) / **"Body & Pallu"**.
- If the two-input workflow isn't configured, the dropdown never renders —
  upload behaves exactly as it does today. Zero visible change for any
  garment type until admin explicitly opts Flat Saree into it.
- **Full Saree** — unchanged: single upload box, same `handleGarmentUpload`
  flow, same `garmentKey` state.
- **Body & Pallu** — the single box is replaced by two boxes, labeled
  **"Body"** and **"Pallu"**, each independently presigned and uploaded to R2
  (same drag/drop, 10MB limit, JPEG/PNG/WebP validation, and progress UI as
  the existing upload boxes). "Body" reuses the existing `garmentFile`/
  `garmentKey`/`handleGarmentUpload` (just relabeled when in this mode); a new
  `palluGarmentFile`/`palluGarmentKey`/`handlePalluGarmentUpload` triple is
  added, mirroring `handleLowerGarmentUpload`.
- Submit is disabled until both images are uploaded (two-input mode) or the
  single image is uploaded (full-saree mode) — same gating pattern as the
  existing `hasMultipleUploadBoxes` validation for other multi-upload garment
  types.

## Data model changes

### `workflow_templates` (packages/db/src/schema/models.ts)

New nullable column:

| Column | Type | Purpose |
|---|---|---|
| `tryonGarmentNodeId2` | `text`, nullable | The pallu LoadImage node, for `workflowType: 'saree_step1_two_input'` templates. The body image continues to use the existing `tryonGarmentNodeId`; `tryonPersonNodeId` is unchanged (person/face). |

### `garment_subcategories` (packages/db/src/schema/models.ts)

New nullable column:

| Column | Type | Purpose |
|---|---|---|
| `mannequinTwoInputWorkflowTemplateId` | `uuid → workflow_templates.id`, nullable | The two-input (body+pallu) step-1 workflow. Parallel to the existing `mannequinWorkflowTemplateId`. Presence of this column (non-null) is what gates the frontend dropdown. |

### `job_inputs` — no new column

The step-1 (mannequin) job's `thirdGarmentKey` column is never populated today
(it's only meaningful on step-2 rows, for that garment type's own third-upload
slot). It's reused to carry the pallu image key on two-input mannequin jobs:
`upperGarmentKey` = body image key, `thirdGarmentKey` = pallu image key.

### `workflow_templates.workflowType` — new convention value

New value: `'saree_step1_two_input'`. Structurally: 3 image inputs (person,
body, pallu) + 1 output, reusing `tryonPersonNodeId` / `tryonGarmentNodeId` /
the new `tryonGarmentNodeId2` / `tryonOutputNodeId`.

## Admin UI changes

### Workflow upload / auto-detection

`apps/api/src/modules/admin/saree-detect.ts` gets a sibling detector,
`detectSareeTwoInputMappings`, for the 3-image shape. Title normalization
follows the existing pattern (`isSareeTitle`, `isModelTitle`): adds
`isBodyTitle` (`"body"`) and `isPalluTitle` (`"pallu"`, `"palu"`). Wired into
the same admin workflow upload/parse route
(`apps/api/src/modules/admin/workflows.routes.ts`) that already special-cases
`'tryon'` and `'saree_step1'`, alongside them.

`CreateWorkflowBody`'s `workflowType` zod enum (`packages/types/src/admin.ts`)
widens to include `'saree_step1_two_input'`.

`WorkflowsPage.tsx` (apps/admin-web) gets a fourth type badge/label for
`'saree_step1_two_input'`.

### `EditGarmentTypeModal.tsx`

A second workflow `<select>` alongside the existing "Mannequin (Step 1)
Workflow" dropdown: **"Two-Input Mannequin (Body + Pallu) Workflow"**,
options = active `workflowType: 'saree_step1_two_input'` templates, allowing
"— none —". Save goes through the existing `PATCH
/admin/assets/garment-types/:id`; `PatchGarmentTypeBody` zod schema
(packages/types/src/admin.ts) widens to accept
`mannequinTwoInputWorkflowTemplateId`.

## API changes

### `packages/types/src/jobs.ts`

`CreateSareeMannequinJobRequest` gains a new optional field:
`secondGarmentKey: z.string().optional()`.

### `apps/api/src/modules/jobs/createSareeMannequin.ts`

- Destructure `secondGarmentKey` from the request body.
- When present: also run it through `assertOwnsUploadKey`.
- Look up `mannequinTwoInputWorkflowTemplateId` alongside the existing
  `mannequinWorkflowTemplateId` in the garment-type query.
- If `secondGarmentKey` is present but `mannequinTwoInputWorkflowTemplateId`
  is null, throw `AppError('CONFIG', 400, ...)` — same shape as the existing
  missing-step-1-workflow check.
- When `secondGarmentKey` is present, snapshot the two-input workflow ID into
  the step-1 job's `params.workflowTemplateId`. This reuses the *existing*
  snapshot-precedence mechanism the dispatcher already honors (merchant saree
  styles already snapshot their own workflow ID into `params.workflowTemplateId`,
  and `processSareeMannequinJob` already prefers it over the garment-type
  default) — no new dispatcher-side discriminator field is introduced.
- `job_inputs` insert for the step-1 job: `upperGarmentKey: garmentKey`,
  `thirdGarmentKey: secondGarmentKey ?? null`.

### `apps/api/src/modules/models/routes.ts`

`/v1/models/garment-types` select gains
`mannequinTwoInputWorkflowTemplateId: schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId`
— a raw passthrough column, same treatment as the existing
`requiresMannequinStep`. The frontend gates the dropdown on this being
non-null; the actual workflow ID value is otherwise unused client-side.

## Dispatcher changes

### `processSareeMannequinJob` (apps/dispatcher/src/job/processor.ts)

- Template select gains `tryonGarmentNodeId2: schema.workflowTemplates.tryonGarmentNodeId2`.
- After the existing body/garment upload+patch (`garmentKey` → `garmentNodeId`):
  when `inputs.thirdGarmentKey` and `template.tryonGarmentNodeId2` are both
  present, upload the pallu image to ComfyUI the same way (`uploadToComfy(inputs.thirdGarmentKey, 'mannequin_pallu')`)
  and patch `workflow[tryonGarmentNodeId2].inputs.image`.
- Consistency guard: if exactly one of (`inputs.thirdGarmentKey`,
  `template.tryonGarmentNodeId2`) is present without the other, fail with the
  existing `MANNEQUIN_INPUTS_MISSING` (key present, node not configured) or
  `MANNEQUIN_NODES_NOT_CONFIGURED` (node configured, key missing) error codes
  — no new error codes needed.
- `COMFY_DISPATCH` job event payload's `inputs` gains `palluKey`/`palluFile`
  when applicable, for debugging parity with `garmentKey`/`garmentFile`.

No other dispatcher code path changes — `runMannequinPhase`, step-2
processing, and every other job kind are untouched.

## Testing

- **API integration** (`apps/api/test/integration/saree-mannequin-job.test.ts`
  or a new file): two-input mannequin job creation with both keys succeeds and
  snapshots `params.workflowTemplateId` to the two-input template; rejects
  when `secondGarmentKey` is present but the garment type has no
  `mannequinTwoInputWorkflowTemplateId` configured (400 `CONFIG`); rejects
  when `secondGarmentKey` fails ownership check; existing single-input
  (`garmentKey`-only) behavior is unchanged (regression).
- **Dispatcher integration** (`apps/dispatcher/test/integration/saree-mannequin.test.ts`
  or similar): `processSareeMannequinJob` patches both garment nodes when
  `thirdGarmentKey` + `tryonGarmentNodeId2` are present and produces one
  mannequin output; fails with `MANNEQUIN_NODES_NOT_CONFIGURED` when
  `thirdGarmentKey` is set but the resolved template has no
  `tryonGarmentNodeId2`; existing single-input tests pass unchanged.
- **Admin**: `/admin/workflows` upload/parse accepts
  `workflowType: 'saree_step1_two_input'` and returns 3 detected image node
  candidates; `PATCH /admin/assets/garment-types/:id` persists
  `mannequinTwoInputWorkflowTemplateId`.
- **Frontend** (manual, per project conventions — dev server + browser):
  dropdown hidden when garment type has no two-input workflow configured;
  visible and defaulting to "Full Saree" once configured; switching to "Body
  & Pallu" swaps in two upload boxes; submit blocked until both are uploaded;
  full end-to-end job creation for both modes.

## Open implementation details (for the plan, not blocking design approval)

- Exact wording/copy for the dropdown options and the two upload box labels
  beyond "Full Saree" / "Body & Pallu" / "Body" / "Pallu" (final copy can be
  adjusted at implementation time without changing the design).
- Migration index — pick the next free index per `CLAUDE.md`'s migration
  conflict rules at plan/implementation time.
