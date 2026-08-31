# Saree Mannequin Style Selection Design

## Summary

The merchant catalogue Android app (`apps/saree_catalogue_android`) generates one
draped-saree preview per flat photo, using the single mannequin (step-1)
ComfyUI workflow configured on the merchant's chosen `garment_subcategories`
row (`mannequinWorkflowTemplateId`, see
`2026-07-20-saree-catalogue-android-backend-cutover.md`). The team has now
built a second mannequin workflow — same two-step shape (mannequin drape,
then a separate step-2 compositing pass that this app never triggers — see
`2026-07-14-flat-saree-two-step-workflow-design.md`), but a different prompt
and LoRA weights, producing a visibly different pallu-draping style.

This adds a merchant-facing **style** choice (`Style 1` / `Style 2`, shown as
labeled preview cards above the existing "Heavy Transparent Saree"-style
subcategory dropdown — see the mock the product team supplied) that selects
*which* mannequin workflow template runs. Style is orthogonal to subcategory:
subcategory is which merchant catalog bucket the product lands in; style is
which draping workflow generates it. Any subcategory can be generated in
either style.

**Nothing about the two-step shape changes.** The Android app still only
triggers step 1 (mannequin generation, 0 credits) and shows its output
directly — style selection only changes which step-1 workflow template that
call resolves to. Step 2 (per-pose compositing) stays exactly as unused by
this app as it is today.

## Why a new table, not a new `garment_subcategories` column

Style and subcategory are independent dimensions — the same style must be
usable across every saree subcategory a merchant creates, and a new style
must not require duplicating every subcategory row. Adding a second
`mannequinWorkflowTemplateId`-shaped column to `garment_subcategories` (or
worse, a second row per style) would conflate the two, and we already avoided
exactly that conflation when fixing the subcategory dropdown leaking
non-saree types (`c2611245`). A small peer table keyed on nothing but
`workflow_templates` keeps the two concerns separate and lets either grow
independently (a third style needs one INSERT; a new subcategory needs no
style-related change at all).

## Non-goals

- No change to `garment_subcategories`, `merchant_catalog_subcategories`, or
  the subcategory dropdown fixed in `c2611245` — style is additive alongside
  it, not a replacement.
- No dispatcher-side step-2 changes — this app still never creates step-2
  jobs (confirmed unaffected: `processSareeMannequinJob`'s routing condition
  and everything after it is untouched).
- No per-subcategory style restriction (e.g. "Style 2 only available for
  subcategory X"). Every active style is offered for every saree-eligible
  subcategory. Add a scoping FK later if the product actually needs it —
  not built speculatively here.
- No change to the Studio/web wizard's own flat-saree flow
  (`resolveMannequinGarmentKey`, client-side pre-resolution) — it has no
  style concept and isn't part of this ask. Confirm with product before
  extending style there; out of scope for this spec.
- No changes to the dev API (`/v1/dev/saree-mannequin`) — it keeps resolving
  the workflow from `garmentSubcategories.mannequinWorkflowTemplateId`
  exactly as today (no `sareeStyleId` concept added to that route).

## Data model changes

### New table: `saree_mannequin_styles` (`packages/db/src/schema/models.ts`)

| Column | Type | Purpose |
|---|---|---|
| `id` | `uuid primary key default random` | |
| `label` | `text not null` | Merchant-facing name, e.g. "Style 1", "Front Pallu". |
| `previewImageKey` | `text`, nullable | R2 key for the "see how it looks" sample card image. Null = card renders with a placeholder, same convention as `garment_subcategories.thumbnailKey` being optional elsewhere. |
| `mannequinWorkflowTemplateId` | `uuid not null → workflow_templates.id` | The step-1 workflow this style runs. |
| `sortOrder` | `integer not null default 0` | Card display order. |
| `isActive` | `boolean not null default true` | Soft-disable without deleting (same pattern as every other admin-curated asset table). |
| `createdAt` / `updatedAt` | `timestamp with time zone` | |

Migration seeds one row for the existing behavior: label `"Style 1"`,
`mannequinWorkflowTemplateId` = whatever every currently-configured saree
`garment_subcategories.mannequinWorkflowTemplateId` already points at today
(there is currently exactly one such workflow in use — confirm at migration
time there's only one distinct value across active saree garment types; if
so, seed from it directly). This guarantees existing merchants see one
pre-selected style and nothing changes for them until an admin adds "Style
2".

No FK from `saree_mannequin_styles` to `garment_subcategories` — deliberately
global, per Non-goals above.

## API changes

### `GET /v1/merchant/catalog/saree-styles` (new, `apps/api/src/modules/merchant/catalog.routes.ts`)

`requireMerchant`-gated. Returns active styles only:

```ts
{
  items: Array<{
    id: string;
    label: string;
    previewUrl: string | null; // presignGet(previewImageKey) if set, else null
    sortOrder: number;
  }>
}
```

Ordered by `sortOrder, label` — same ordering convention as
`/v1/merchant/catalog/subcategories`.

### `POST /v1/merchant/catalog/generate` (`packages/types/src/widget.ts`)

`MerchantCatalogGenerateBody` gains:

```ts
sareeStyleId: z.string().uuid().optional(),
```

Optional, not required — omitting it preserves exactly today's behavior
(falls back to `garmentSubcategories.mannequinWorkflowTemplateId`), so any
in-flight app build that hasn't picked up the style picker keeps working
unmodified.

### `createMerchantSareeMannequinJob` (`apps/api/src/modules/merchant/create-job.ts`)

Gains `sareeStyleId?: string` in its params object.

- If provided: look up the `saree_mannequin_styles` row, 400
  (`BAD_STYLE`/`VALIDATION`) if missing or `isActive: false`. Store its
  `mannequinWorkflowTemplateId` into the job's params as
  `job_inputs.params.workflowTemplateId` (reusing the existing
  snapshotted-template-override convention already established for regular
  jobs — see `processor.ts`'s `snapshottedWorkflowTemplateId` handling at
  line ~228 — same idea, now extended to the saree-mannequin path).
- If omitted: unchanged — `job_inputs.params` stays `{ kind:
  'saree_mannequin' }` exactly as it is today, and the dispatcher resolves
  the workflow from `garmentSubcategories.mannequinWorkflowTemplateId` as it
  always has.
- The existing `garmentType.requiresMannequinStep` / `isActive` gate is
  unchanged — style selection doesn't bypass garment-type eligibility, it
  only changes which workflow template ID is used once eligibility is
  confirmed.

## Dispatcher changes (`apps/dispatcher/src/job/processor.ts`)

`processSareeMannequinJob` (line 851) currently resolves the workflow
unconditionally from `garmentSubcategories.mannequinWorkflowTemplateId`
(lines 882–889). Add one override check ahead of that lookup, mirroring the
exact pattern already used in the general job path (lines 228–234):

```ts
const rawParams = /* parse inputs.params, same as the top-level rawParams parsing */;
const snapshottedWorkflowTemplateId =
  typeof rawParams.workflowTemplateId === 'string' ? rawParams.workflowTemplateId : null;

const workflowTemplateId =
  snapshottedWorkflowTemplateId ??
  (await db
    .select({ mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, garmentTypeId)))[0]?.mannequinWorkflowTemplateId;
```

Everything downstream (template lookup, node-ID validation, face
resolution, worker selection, ComfyUI patch/dispatch) is unchanged — it
already operates on a resolved `workflowTemplateId`, not on how that ID was
obtained.

## Admin UI changes

New tab/section, following the exact `pose-assets` CRUD pattern
(`apps/api/src/modules/admin/models.routes.ts` lines ~395–520):

- `GET /admin/assets/saree-styles` — list all (including inactive), for the
  admin table.
- `POST /admin/assets/saree-styles/presign` — presign for
  `previewImageKey` upload (`AssetContentType`, single image, no thumbnail
  variant needed — the preview card is the only rendering of it).
- `POST /admin/assets/saree-styles` — create row: `label`,
  `previewImageKey`, `mannequinWorkflowTemplateId` (dropdown of active
  `workflowType: 'saree_step1'` templates — same source list already used by
  `EditGarmentTypeModal.tsx`'s "Mannequin (Step 1) Workflow" select), `isActive`,
  `sortOrder`.
- `PATCH /admin/assets/saree-styles/:id` — update any field.
- New key builder in `packages/storage/src/keys.ts`:
  `sareeStyle: (id: string) => \`saree-styles/${id}.jpg\`` (mirrors
  `modelPose`'s naming).
- New `apps/admin-web` tab, e.g. under Assets → "Saree Styles" — a table +
  create/edit form with a single image upload and the workflow-template
  dropdown. Reuses whatever list/edit-modal scaffolding
  `GarmentTypesTab.tsx`/pose-assets tab already has; no new UI pattern
  needed.

## Android changes (`apps/saree_catalogue_android`)

### `MerchantCatalogModels.kt`

New response model:

```kotlin
data class SareeStyle(val id: String, val label: String, val previewUrl: String?, val sortOrder: Int)
data class SareeStyleListResponse(val items: List<SareeStyle>)
```

### `MerchantCatalogRepository.kt`

- New `fetchSareeStyles(): List<SareeStyle>` — GET
  `/v1/merchant/catalog/saree-styles`, same shape as `fetchSubcategories`.
- `generate(subcategoryId, flatImageKey, sareeStyleId: String?)` — adds
  `sareeStyleId` to the request body only when non-null (mirrors how
  `mannequinOnly` is unconditionally sent today, but this one is genuinely
  optional so it stays out of the JSON body entirely when absent, matching
  the backend's `.optional()` zod field).

### `UploadVastraFragment.kt` / `fragment_upload_vastra.xml`

- New horizontal style-card row inserted above the existing subcategory
  spinner (matching the "Style 1 / Style 2" preview-card mock), each card:
  preview image (Glide-loaded from `previewUrl`, placeholder if null) +
  label, selectable, one highlighted at a time.
- `selectedStyleId: String?` field, same shape as the existing
  `selectedSubcategoryId`. Fetched once in `initView()` via a new
  `getSareeStyleData()` (mirrors `getSubcategoryData()`), auto-selects the
  first style exactly like `setSubcategorySpinner`'s auto-select-first
  behavior (lines 526–529 today).
- Same one-option collapse convention already applied to the subcategory
  spinner: if there's only one active style, don't render the picker row at
  all (or render it non-interactively) — nothing to choose between.
- `isSubcategorySelected()`'s validation gate extends to also require
  `selectedStyleId != null` before enabling Take Photo / Upload Photo,
  consistent with the existing "select a product type before upload" guard.
- `gotoNextScreen()` passes `selectedStyleId` through to `UploadPhotoDialog`
  (new constructor param), which passes it to
  `productUploadViewmodel.generateProduct(file, subcategoryId, styleId)`
  (new param on `ProductUploadViewModel.generateProduct`, threaded straight
  into `MerchantCatalogRepository.generate`).

## Testing

- Migration test: `saree_mannequin_styles` seeds exactly one row on
  migration, matching the currently-live `mannequinWorkflowTemplateId`.
- `createMerchantSareeMannequinJob`: integration tests for (a) no
  `sareeStyleId` → unchanged behavior, `job_inputs.params` has no
  `workflowTemplateId` key; (b) valid `sareeStyleId` → params snapshot
  carries that style's `mannequinWorkflowTemplateId`; (c) inactive/missing
  `sareeStyleId` → 400.
- Dispatcher: unit/integration test that `processSareeMannequinJob` prefers
  `rawParams.workflowTemplateId` over `garmentSubcategories.mannequinWorkflowTemplateId`
  when both are present, and falls back correctly when absent.
- `GET /v1/merchant/catalog/saree-styles`: returns only active styles,
  ordered by `sortOrder`.
- Admin CRUD: presign + create + patch round-trip for `saree-styles`,
  mirroring the existing `pose-assets` test coverage shape.
- Android: no existing JVM test convention to extend (per the 2026-07-20
  cutover spec) — compile/assemble verification plus manual device
  walkthrough (pick each style, confirm the generated preview visibly
  differs between Style 1 and Style 2).

## Open implementation details (for the plan, not blocking design approval)

- Exact admin-web component reuse vs. new component for the Saree Styles
  tab — a plan-level UI-composition decision.
- Whether `previewImageKey` upload also needs a thumbnail variant if the
  card size ends up small enough that the full image is wasteful bandwidth
  — can default to "no thumbnail, single image" and revisit if the admin
  team pushes back on upload size.

## Self-review

- **Placeholders:** none — every endpoint, table, and existing code
  reference above was confirmed against the actual current code
  (`create-job.ts:192-252`, `processor.ts:851-901`, `catalog.routes.ts`,
  `UploadVastraFragment.kt:499-535`), not assumed from memory.
- **Internal consistency:** the "style is orthogonal to subcategory" framing
  is stated once and is the single source of truth the plan should follow;
  confirmed against the existing pallu-type-collapse decision in the
  2026-07-20 cutover doc so this doesn't quietly re-open that question.
- **Scope:** one additive table + one API field + one dispatcher fallback +
  one Android screen addition — no changes to unrelated subsystems (step 2,
  Studio wizard, dev API) — each explicitly called out as untouched in
  Non-goals.
- **Backward compatibility:** every change is additive and optional
  (`sareeStyleId` optional in the body, `workflowTemplateId` override
  optional in dispatcher resolution) — an old APK build that never sends
  `sareeStyleId` continues generating exactly as it does today, with zero
  behavior change, until it's rebuilt against the new picker.
