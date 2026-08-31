# Tryon Feature — Design

**Date:** 2026-06-26
**Status:** Approved for Increment 1 + 2

## Summary

A self-contained "tryon" subsystem for the admin panel, isolated from the existing
`models` and `catalog` modules. Admins upload tryon ComfyUI workflows (a new
`workflowType: 'tryon'` on `workflow_templates`), then manage **tryon categories**
(upper, lower, dress, suit, saree, …) in a dedicated sidebar section — each category
assigns exactly one tryon workflow and carries reference/guidance sample images shown
to end-users before they upload their own garment photo.

The tryon ComfyUI workflow takes **two image inputs** (a person photo + a garment
image) and produces one output image. Sample JSON of reference shape:
`templates/tryonupper25062026 (2).json`.

This spec covers **Increment 1 (parser)** and **Increment 2 (tryon admin tab +
categories)**, both built now. Runtime execution (dispatcher, job creation, end-user
web flow) is deferred and described at the end.

## Reference: sample workflow JSON structure

From `templates/tryonupper25062026 (2).json`:

| Role | Node ID | `class_type` | Where text/value lives |
|------|---------|--------------|------------------------|
| person photo input | `1000` | `LoadImage` | `_meta.title = "person"` |
| garment image input | `1006` | `LoadImage` | `_meta.title = "garment"` |
| output | `994` | `Save Image With Callback` | — |
| positive prompt | `1001:111` | `TextEncodeQwenImageEditPlus` | `inputs.prompt` (string) |
| negative prompt | `1117` | `CLIPTextEncode` | `inputs.text` (string) |

Why the existing regular detector (`detectMappings`) cannot parse this:
- Output node is `Save Image With Callback`, not `SaveImage`.
- Prompt nodes feed `ControlNetInpaintingAliMamaApply.positive/.negative`, not
  `KSampler.positive/.negative` directly — the regular Pass-2 connection fallback
  requires the consumer to be a Sampler and so misses these.
- Input titles are `person` / `garment`, not `face` / `upper_garment`.

Therefore tryon gets its own detector in a new file.

## Data model

### `workflow_templates` (extend existing)

- `workflowType` text — gains allowed value `'tryon'` (currently `'regular' | 'widget'`).
- New nullable columns (mirror the `widget_*` convention):
  - `tryon_person_node_id text`
  - `tryon_garment_node_id text`
  - `tryon_output_node_id text`
- Positive/negative prompts **reuse existing columns** (no new prompt columns):
  - `garment_phase_prompt_node` = positive prompt node ID
  - `face_phase_prompt_node` = negative prompt node ID
  - `default_garment_phase_prompt` = positive default text
  - `default_face_phase_prompt` = negative default text

  Rationale: the regular path already uses garment=positive, face=negative; reusing
  keeps semantics consistent and avoids redundant columns (YAGNI).

### `tryon_categories` (NEW table)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `name` | text not null | e.g. "Upper", "Saree" |
| `slug` | text not null unique | |
| `workflow_template_id` | uuid FK → `workflow_templates.id` | `on delete set null`; should reference a `workflowType:'tryon'` row |
| `sort_order` | integer not null default 0 | |
| `is_active` | boolean not null default true | |
| `created_at` / `updated_at` | timestamptz | |

One workflow per category (1:1 link via the FK).

### `tryon_category_samples` (NEW table)

Reference/guidance images, separate table (one-to-many), NOT workflow inputs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `category_id` | uuid FK → `tryon_categories.id` | `on delete cascade` |
| `r2_key` | text not null | full-size reference image |
| `thumbnail_key` | text | optional thumbnail |
| `sort_order` | integer not null default 0 | |
| `created_at` | timestamptz | |

## Increment 1 — Parser

### New file: `apps/api/src/modules/admin/tryon-detect.ts`

`detectTryonMappings(json)` — independent of `detectMappings`, imports the shared
helpers `normaliseTitle`, `classifyNode` (and `extractPromptText` for defaults) so no
logic is duplicated. The regular detector is left untouched.

Detection rules:
- **person node** — `LoadImage` whose normalised title is `person`. Fallback: first
  `LoadImage` that is not the garment node.
- **garment node** — `LoadImage` whose normalised title is `garment`.
- **output node** — node whose `class_type` contains `"Save Image"` (matches
  `Save Image With Callback`); fallback to any `SaveImage`.
- **positive prompt** — Pass-1: prompt node titled `positive_prompt`. Pass-2
  (generalised): a TextEncode-category node whose output feeds an input named
  `positive` on ANY consumer (not just Samplers — also ControlNet).
- **negative prompt** — same, input named `negative`.
- **default prompts** — `extractPromptText(node)` (tries `inputs.prompt` then
  `inputs.text`): positive ← `1001:111.prompt`, negative ← `1117.text`.

Returns: `{ personNodeId?, garmentNodeId?, outputNodeId?, positivePromptNode?,
negativePromptNode?, defaultPositivePrompt, defaultNegativePrompt }` plus the list of
all image/prompt nodes (so the UI can offer manual override dropdowns, matching the
regular parse UX).

### DB migration `0063_tryon_workflow_nodes.sql`

Adds `tryon_person_node_id`, `tryon_garment_node_id`, `tryon_output_node_id` to
`workflow_templates`. Schema (`packages/db/src/schema/models.ts`) + zod types updated;
`workflowType` enum gains `'tryon'`.

### API

- `POST /admin/workflows/parse` — add optional `workflowType` to the body. When
  `'tryon'`, run `detectTryonMappings` and return tryon fields + default prompts.
  Regular behaviour unchanged when omitted/`'regular'`.
- `POST /admin/workflows` — add a `tryon` branch (parallel to the `widget` branch):
  validate the 3 node IDs exist in the JSON, extract default prompts, insert with
  `workflowType:'tryon'`, the 3 `tryon_*` columns, and positive/negative prompt node
  IDs + defaults in the reused columns. Blank the regular-only fields
  (`faceNodeId:''`, `upperNodeIds:[]`, etc.) like the widget branch does.
- zod schema (`packages/types`): extend the workflow-create shape with
  `tryonPersonNodeId` / `tryonGarmentNodeId` / `tryonOutputNodeId` and the new enum value.

### Admin UI — `WorkflowUploadModal.tsx`

- Add `'tryon'` to the existing type toggle (`'regular' | 'widget' | 'tryon'`).
- Tryon branch: a **Parse** button (like regular) that POSTs to
  `/admin/workflows/parse` with `workflowType:'tryon'`, pre-fills person/garment/output
  node-ID fields plus editable positive/negative prompt textareas, admin confirms → submit.

### Tests — `apps/api/.../tryon-detect.test.ts`

Assert against the sample JSON: person=`1000`, garment=`1006`, output=`994`,
positive=`1001:111`, negative=`1117`, and both extracted default-prompt strings.

## Increment 2 — Tryon admin tab

### Sidebar + routing

- `apps/admin-web/src/components/Sidebar.tsx` — add nav item
  `{ k: 'tryon', label: 'Tryon', icon: Icon.Workflow, roles: ['SUPER_ADMIN', 'MODERATOR'] }`
  (peer of Assets / Workflows / Users; reuse an existing `Icon.*`, or add a new one to `Icons.tsx`).
- `apps/admin-web/src/App.tsx` — add `<Route path="/tryon" element={<TryonPage {...pageProps} />} />`.
- New page `apps/admin-web/src/pages/TryonPage.tsx`.

### DB migration `0064_tryon_categories.sql`

Creates `tryon_categories` + `tryon_category_samples` tables. Schema added in a new
file `packages/db/src/schema/tryon.ts` and re-exported.

### API — `apps/api/src/modules/admin/tryon.routes.ts`

- `GET /admin/tryon-categories` — list with their workflow + sample images.
- `POST /admin/tryon-categories` — create (name, slug, workflowTemplateId, sortOrder).
- `PATCH /admin/tryon-categories/:id` — update.
- `DELETE /admin/tryon-categories/:id` — delete (cascades samples).
- `POST /admin/tryon-categories/:id/samples/presign` — presigned direct-to-R2 upload
  for a sample image (mirrors existing admin asset presign), returns `{ r2Key,
  uploadUrl, thumbnailKey, thumbnailUploadUrl }`.
- `POST /admin/tryon-categories/:id/samples` — record an uploaded sample row.
- `DELETE /admin/tryon-categories/:id/samples/:sampleId` — remove a sample.

All routes behind `requireAdmin(['SUPER_ADMIN','MODERATOR'])`, double-checked per the
project's admin-route invariant.

### Page UI — `TryonPage.tsx`

- Grid of category cards (name, assigned workflow label, sample-image thumbnails,
  active toggle, sort order).
- Create/Edit modal: name, slug (auto from name), workflow dropdown populated from
  `workflowType:'tryon'` templates only, multi-image sample uploader (presign →
  PUT → record), sort order, active toggle.
- All components use `C` design tokens; no raw hex.

## Deferred (NOT built in this spec)

Written here so later increments have context:

- **Dispatcher** — `processTryonJob` in `apps/dispatcher/src/job/processor.ts`:
  clone the tryon template JSON, patch person + garment image filenames into the stored
  `tryon_*` node IDs, optionally apply prompt overrides, read the output node from
  ComfyUI history, upload result to R2.
- **Job creation** — a tryon job-creation API route + Redis enqueue, credit deduct,
  refund-on-failure — mirroring the existing tryon/widget job invariants.
- **End-user web flow** — the tryon upload/run UI in `apps/catalogues-web`: pick a tryon category
  (sees its sample/guidance images), upload person photo + garment, submit, watch SSE.
- **Routing** — decide which worker pool / VPS tryon jobs run on (main pool vs a
  dedicated VPS like widget).

## Invariants honoured

- ComfyUI template versioned in `templates/`; clone-and-patch only (deferred dispatcher).
- All `/admin/*` routes double-check admin role.
- New tables in their own schema file; `@tryme/db` keeps single `* as schema` export.
- Tryon detector isolated; regular `detectMappings` untouched.
