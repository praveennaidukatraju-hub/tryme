# Tryon Page: Garment-From-Catalog Picker — Design

**Date:** 2026-07-02
**Status:** Approved, pending spec review

## Summary

On the simple-tryon page (`apps/web/src/app/(app)/tryon/page.tsx`), replace manual
garment-image upload with a "Browse from Catalog" picker that shows the user's own
recently generated catalog images (Studio outputs). Selecting one supplies both the
garment image **and** the tryon workflow category — the client-visible category
selector is removed entirely. The admin defines the garment-type → tryon-category
mapping once, on the Assets > Garment Types page; every studio-generated image
already carries a garment-type reference, so that mapping resolves automatically for
any image the user picks.

This also incidentally fixes an existing gap: `job_inputs.garmentTypeId` was never
populated for simple-tryon jobs, so tryon-generated images had no garment-type
observability. This design closes that.

## Problem

- Manual garment upload + manual tryon-category selection are two extra steps that
  can be set inconsistently (wrong category picked for a garment → generation
  failure).
- Users who already generated a garment via Studio have to re-upload it as a raw
  file to try it on a different person, with no link back to its known garment type.

## Data model changes

### `garment_subcategories` (extend existing, `packages/db/src/schema/models.ts`)

- New column: `tryon_category_id uuid references tryon_categories(id) on delete set null`
  — nullable. Admin sets this per garment type on Assets > Garment Types. A garment
  type with `tryonCategoryId = null` is not eligible for the tryon picker.

No other schema changes. `job_inputs.garmentTypeId` (already exists, already
populated by `createJob` for every studio-generated catalog job) is the link from a
generated image back to its garment type — no new per-image tag needed.

### Migration

New migration file, next available index after checking current server-canonical
index at merge time per CLAUDE.md's "Migration Index Conflicts" process (was 73 as
of last check — confirm before creating).

## Resolution chain

```
picked catalog image (job_outputs.resultKey, via jobs.id)
  → job_inputs.garmentTypeId
  → garment_subcategories.tryonCategoryId
  → tryon_categories.workflowTemplateId
```

## API changes

### Admin (`apps/api` garment-types admin routes + `apps/admin` Assets > Garment Types)

- Add `tryonCategoryId` to the garment-type create/update payload and response.
- Admin UI: edit/add garment-type modal gets a "Tryon Category" select (options
  from `tryon_categories`, includes "— none —"). List card shows a small badge with
  the mapped category name when set.

### `GET /v1/tryon/garment-images` (new, `requireUser`)

Returns the caller's completed catalog images eligible for tryon reuse:

```
jobs (userId = self, status = COMPLETED)
  join job_outputs (resultKey, thumbnailKey)
  join job_inputs (garmentTypeId)
  join garment_subcategories (tryonCategoryId not null)
  join tryon_categories (name)
```

Response: `{jobId, thumbnailUrl, garmentTypeName, tryonCategoryName}[]`, newest
first, limited (e.g. 50).

### `POST /v1/jobs/simple-tryon` (modify `createSimpleTryonJob`)

- Request body: drop `garmentKey`, drop `categoryId`; add `sourceJobId` (uuid,
  required). `personKey` unchanged.
- Handler:
  1. Fetch `jobs` + `job_outputs` + `job_inputs` for `sourceJobId`.
  2. Verify `jobs.userId === req.user.id` and `status === 'COMPLETED'` — 403/404
     otherwise.
  3. Verify the resolution chain above resolves to a non-null
     `workflowTemplateId` — 400 otherwise.
  4. Use `job_outputs.resultKey` as `upperGarmentKey`.
  5. Persist `garmentTypeId` onto the new job's `job_inputs` row (closes the
     observability gap).
  6. Rest of the transactional credit-deduct + insert flow unchanged.

### `packages/types`

Update `CreateSimpleTryonRequest` zod schema: remove `garmentKey`/`categoryId`, add
`sourceJobId`.

### `GET /v1/tryon/categories`

Left as-is (no longer called from the tryon page, but not removed — may still be
used elsewhere).

## Frontend changes (`apps/web/src/app/(app)/tryon/page.tsx`)

### Removed

- Category-selector radio-pill row.
- Garment `UploadZone` card and its presign/upload logic in `handleGenerate`.
- `selectedCategoryId` state, `tryon-categories` query, category-default effect.
- Garment-side sample-preview hover button (tied to the old `garmentSampleUrl`).

### Added

- State: `selectedGarmentJob: {jobId, thumbnailUrl, garmentTypeName} | null`.
- New left-panel card, placed **first** (left of the person upload card): empty
  state = dashed box with "Browse from Catalog" button; selected state = thumbnail
  + garment-type name + "Change" button.
- Person `UploadZone` stays functionally unchanged, now positioned **second**
  (right of the garment card) — position swap only.
- New `GarmentCatalogModal` component: on open, queries
  `GET /v1/tryon/garment-images`; renders a grid of thumbnails with garment-type
  name; click selects and closes. Empty state: "No eligible catalog images yet —
  generate one in Studio first."
- `handleGenerate`: only presigns/uploads `personFile`; POSTs
  `{personKey, sourceJobId: selectedGarmentJob.jobId}`.
- `canGenerate = personFile && selectedGarmentJob` (was `personFile && garmentFile`).

## Out of scope / deferred

- Exposing `garmentTypeId`/tryon-category on the `/v1/catalogues` list/detail APIs
  for general display purposes (separate, smaller follow-up if wanted later).
- Any change to the Studio wizard flow itself.
- Any change to the saree-specific job flow.
