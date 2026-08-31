# Catalogue Templates (Ready-Made Look Sets)

## Goal

Replace the current placeholder "Ready-Made Catalogue Template" feature (which just shortcuts to a single background, derived from background categories) with real admin-defined templates: a named, curated set of (pose, background) pairs — "looks" — scoped to a gender. On the studio page, choosing "Create your own look" keeps today's flow unchanged (pick background, then poses). Choosing a template skips background/pose selection entirely and instead shows the template's looks as checkable cards; the user picks one or more, and (if any picked look needs it) still picks a lower garment / shoe from the catalog, same as today.

No changes to `model_pose_assets`, `model_backgrounds`, `workflow_templates`, or `pose_garment_configs` — templates only *reference* rows in these tables. Workflow assignment (which ComfyUI template a pose uses, per-garment-type overrides) is untouched.

## Database

**Migration** — two new tables:

```sql
CREATE TABLE catalogue_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gender_slug text NOT NULL,
  label text NOT NULL,
  thumbnail_key text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalogue_template_looks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES catalogue_templates(id) ON DELETE CASCADE,
  pose_asset_id uuid NOT NULL REFERENCES model_pose_assets(id),
  background_id uuid NOT NULL REFERENCES model_backgrounds(id),
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX catalogue_template_looks_template_id_idx ON catalogue_template_looks(template_id);
```

`gender_slug` matches `model_pose_assets.gender_slug` values (`'men'|'women'|'boys'|'girls'`). Not FK-enforced against pose gender — the admin UI is the enforcement point (only lets you pick poses matching the template's gender), same trust model as `garment_subcategories.tryon_category_id`.

The pose/background FKs are `NO ACTION` (default) — poses and backgrounds are **soft**-deleted (`deleted_at` / `is_active=false`), so these rows are never hard-deleted out from under a look. Dangling-but-inactive references are handled at read time (see Public API filtering), not by cascade.

`hasLower`/`hasShoes` for a look are **not** stored here — always computed live from `workflow_templates` + `pose_garment_configs`, overlaid by `garmentTypeId`, exactly like `/v1/models/poses` already does. This is what keeps per-garment-type workflow overrides working unmodified for template looks.

Add corresponding Drizzle schema (`catalogueTemplates`, `catalogueTemplateLooks`) to `packages/db/src/schema/models.ts`.

## Storage

Add to `packages/storage/src/keys.ts`:

```typescript
catalogueTemplateThumb: (id: string) => `models/catalogue-templates/${id}.thumb.jpg`,
```

## API — Admin

New routes in `apps/api/src/modules/admin/models.routes.ts` (mirroring the existing backgrounds/pose-assets admin CRUD shape):

- `GET /admin/assets/catalogue-templates` — list, with look count and thumbnail URL resolved
- `POST /admin/assets/catalogue-templates` — create (label, genderSlug, thumbnailKey, sortOrder)
- `PATCH /admin/assets/catalogue-templates/:id` — update label/thumbnail/active/sortOrder
- `DELETE /admin/assets/catalogue-templates/:id` — soft delete (`deletedAt`)
- `PUT /admin/assets/catalogue-templates/:id/looks` — full-replace: body is the complete ordered list `[{ poseAssetId, backgroundId }]`; handler deletes all existing `catalogue_template_looks` rows for the template and reinserts (sort_order = array index). Templates have a handful of looks and are edited occasionally, not continuously — full-replace avoids building incremental add/remove/reorder endpoints for no real benefit. Validate every `poseAssetId`/`backgroundId` exists and is active before replacing; reject the whole PUT on any bad ID.
- `POST /admin/assets/catalogue-templates/thumbnail/presign` — returns `{ uploadUrl, r2Key }` for the cover image, key = `keys.catalogueTemplateThumb(randomUUID())`. On PATCH replacing/clearing an existing `thumbnailKey`, delete the old object via `app.storage.deleteObject()`.

## API — Public

New route in `apps/api/src/modules/models/routes.ts`:

`GET /v1/models/catalogue-templates?gender=&garmentTypeId=`

Returns active, non-empty templates for the gender, each with **only its resolvable looks** expanded:

```typescript
{
  items: Array<{
    id: string;
    label: string;
    thumbnailUrl: string | null;
    looks: Array<{
      id: string;              // catalogue_template_looks.id
      poseId: string;
      poseLabel: string;
      poseThumbnailUrl: string;
      backgroundId: string;
      backgroundLabel: string;
      backgroundThumbnailUrl: string;
      hasLower: boolean;
      hasShoes: boolean;
    }>;
  }>;
}
```

Query requirements:
- **Filter dead/hidden looks out entirely.** Inner-join pose and background, requiring `is_active = true AND deleted_at IS NULL` on **both**. A look whose pose is hidden for this `garmentTypeId` via `pose_garment_configs.is_active = false` is also excluded (same narrowing rule as `/v1/models/poses` and `createJob`). A look the user cannot actually generate must not be shown.
- **Drop empty templates.** After look filtering, a template with zero looks is omitted from `items` (covers both "admin saved 0 looks" and "all looks became unresolvable").
- `hasLower`/`hasShoes` computed by joining through `workflow_templates` (default) and `pose_garment_configs` (per-`garmentTypeId` override), reusing the same join logic as the existing `/v1/models/poses` handler.
- `thumbnailUrl` falls back to the first look's `poseThumbnailUrl` when `thumbnail_key` is null.

## API — Job creation (atomic multi-background)

**Problem this solves:** a template's looks span multiple backgrounds. The existing `/v1/jobs/tryon` handler creates one job per `poseId` but all share a single `backgroundId` in one transaction (`create.ts:290–339`). Submitting a multi-background template by looping one HTTP call per background is **not atomic** — a mid-sequence failure leaves a partial catalogue and a partial credit charge — and each call is capped at `poseIds.max(6)`. Both problems vanish if one request carries per-look backgrounds.

**Change:** extend `CreateTryOnJobRequest` (`packages/types/src/jobs.ts`) to accept an optional `looks` array as an alternative to `backgroundId` + `poseIds`:

```typescript
// exactly one of the two forms is provided:
//   legacy/custom:  { backgroundId, poseIds: [...] }
//   template:       { looks: [{ poseId, backgroundId }, ...] }
looks: z.array(z.object({
  poseId: z.string().uuid(),
  backgroundId: z.string().uuid(),
})).min(1).max(12).optional(),
```

`createJob` (`apps/api/src/modules/jobs/create.ts`) normalizes to a single internal list of `{ poseId, backgroundId }` at the top (custom form → map each `poseId` to the shared `backgroundId`; template form → use `looks` directly), then:

- Validates the **distinct set** of backgroundIds and poseIds (widen the existing `inArray` checks — already fetches poses in bulk; add a bulk background check keyed by the distinct backgroundIds).
- Runs the existing per-pose workflow/`hasLower`/`hasShoes` validation loop unchanged (it's keyed by pose, background-independent).
- Inserts one `jobs` + `job_inputs` row per look, each with its own `backgroundId`, **all inside the one existing transaction** with per-job `atomicDeduct`. One transaction → all-or-nothing credits. One enqueue batch afterward.

**Amazon white-bg override does NOT apply to templates.** The `platform === 'Amazon'` branch that replaces `backgroundId` with the white-bg asset (`create.ts:108–132`) must be **skipped whenever the request uses the `looks` form** — template per-look backgrounds are authoritative and must never be overridden. Guard it: apply the white-bg override only in the legacy `backgroundId` + `poseIds` form. (Studio already sends `platform: undefined` for Amazon today because `amazonUseWhiteBg` is hardcoded `false`, but this server-side guard makes template backgrounds safe regardless of what the client sends.)

Duplicate `(poseId, backgroundId)` within one request is rejected (would create redundant identical jobs); the admin looks-builder also prevents adding an identical pair.

This removes the need for any per-background client loop, so no partial-failure window exists.

## Admin-Web UI

New tab in `apps/admin-web/src/pages/assets/`: `CatalogueTemplatesTab.tsx`.

- Add `'catalogue-templates'` to `AssetTab` union and `VALID_TABS` in `AssetsContext.tsx`.
- **List view**: cards grouped/filterable by the existing `GenderFilter`, showing cover thumbnail, label, look count, active toggle, sort order — same shell as `BackgroundsTab`/`PoseAssetsTab`.
- **Editor modal**: gender select (locks pose/background pickers below to that gender), label, cover thumbnail upload (presign → R2 → key), active toggle, sort order, and a looks builder — add-row control opens a two-step picker (pose, then background), appends a row showing pose thumb + bg thumb side by side with remove/reorder controls. The builder blocks adding a `(pose, background)` pair that already exists in the list. Save sends the full ordered looks array to the `PUT .../looks` endpoint.
- Deleting/deactivating a pose or background referenced by templates is allowed (looks are filtered at read time); no hard block. A future enhancement could surface "used by N templates" — deferred.

## Studio Page (`apps/catalogues-web/src/app/(app)/studio/page.tsx`)

Fully replaces `readyMadeCatalogueTemplates`/`catalogueTemplates` (currently derived from background categories) — that placeholder mechanism is removed, not kept as a fallback.

- Template section (already positioned right after "Choose your model", before "Select Background") fetches from the new `/v1/models/catalogue-templates?gender=&garmentTypeId=` endpoint. "Custom" card stays first, same as today.
- New state: `selectedLookIds: string[]` (replaces the current "template just sets `backgroundId`" wiring).
- `catalogueTemplateId === 'custom'` → "Select Background" and "Choose Poses" sections render exactly as today, untouched.
- `catalogueTemplateId !== 'custom'` → those two sections are hidden, replaced by a **"Choose Looks"** section: grid of checkable cards (pose thumbnail, background label as caption/badge), multi-select via `selectedLookIds`. Selecting a template resets `selectedLookIds` to `[]` and clears `lowerCatalogId`/`shoeCatalogId`, mirroring `handleFaceSelect`/`handleBackgroundSelect`.
- **Invalidation:** changing face or gender resets `catalogueTemplateId` to `'custom'` and clears `selectedLookIds` (extend the existing `handleFaceSelect` reset and the existing `useEffect` that clears a `catalogueTemplateId` no longer present in the fetched list).
- **Empty state:** if a selected template returns zero looks for the current `garmentTypeId`, show a message ("No looks available for this garment type yet") instead of an empty grid.
- **Shared derivations (custom + template):** a single `selectedPoses` list feeds everything downstream — it comes from either `poseIds` (custom) or the checked looks' pose objects (template). Drive all three off it:
  - `needsLower` / `needsShoes` = `selectedPoses.some(hasLower / hasShoes)`
  - `creditCost` = `RESOLUTION_COSTS[resolution] * selectedCount` where `selectedCount` = `poseIds.length` (custom) or `selectedLookIds.length` (template)
  - submit-enabled guard = `selectedCount > 0` (today's `poseIds.length === 0` check must not gate template mode, or the button never enables)

**Submission** — one atomic request, no client-side per-background loop:

- Custom mode: unchanged — `POST /v1/jobs/tryon` with `{ backgroundId, poseIds }`.
- Template mode: `POST /v1/jobs/tryon` with `{ looks: selectedLooks.map(l => ({ poseId, backgroundId })) }`, plus the shared `lowerCatalogId`/`shoeCatalogId`, `aspectRatio`, `resolution`. **Do not send `platform: 'Amazon'`** (send `effectivePlatform`, i.e. `undefined` for Amazon) — belt-and-suspenders with the server-side guard.
- `activeGeneration.jobs` is built by zipping the returned `jobIds` with the submitted looks (keyed by **`jobId`**, not `poseId`, since the same pose can appear in multiple looks). The response order matches submission order.

## Testing

Integration tests in `apps/api` (fresh-DB-per-test-file harness, per existing convention):

- Admin CRUD for `catalogue_templates` + `PUT .../looks` full-replace behavior (including rejection on inactive pose/background id).
- `GET /v1/models/catalogue-templates`: join correctness; a look with an inactive/soft-deleted pose or background is omitted; a look hidden via `pose_garment_configs` for the `garmentTypeId` is omitted; a template with all looks filtered is dropped from `items`; `hasLower`/`hasShoes` reflect the `garmentTypeId` override.
- `createJob` with the `looks` form: creates one job per look with the correct per-look `backgroundId`; the whole set shares one transaction (insufficient-credit mid-set rolls back all, deducts nothing); the Amazon white-bg override is **not** applied when `looks` is present; duplicate `(pose, background)` is rejected.

No new frontend test infra — verify the studio page changes via typecheck + lint + manual run, consistent with how the earlier template-section reorder was verified.

## Files Changed

| File | Change |
|------|--------|
| `packages/db/src/schema/models.ts` | Add `catalogueTemplates`, `catalogueTemplateLooks` tables |
| `packages/db/src/migrations/` | New migration SQL file |
| `packages/storage/src/keys.ts` | Add `catalogueTemplateThumb()` key builder |
| `packages/types/src/jobs.ts` | Add optional `looks[]` to `CreateTryOnJobRequest`; refine so exactly one of `looks` / (`backgroundId`+`poseIds`) is provided |
| `packages/types/src/admin.ts` | Zod schemas for template create/update/looks-replace/thumbnail-presign bodies |
| `packages/types/src/index.ts` | Re-export new types |
| `apps/api/src/modules/jobs/create.ts` | Normalize to per-look `{poseId, backgroundId}`; per-look background insert; guard Amazon override to legacy form only |
| `apps/api/src/modules/admin/models.routes.ts` | Admin CRUD + looks full-replace + thumbnail presign |
| `apps/api/src/modules/models/routes.ts` | New `GET /v1/models/catalogue-templates` with dead-look filtering + empty-template drop |
| `apps/api/src/modules/**/__tests__/` | Tests for admin routes, public route, and `createJob` looks form |
| `apps/admin-web/src/pages/assets/AssetsContext.tsx` | Add `'catalogue-templates'` tab |
| `apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx` | New tab UI |
| `apps/admin-web/src/types.ts` | Add `CatalogueTemplate`/`CatalogueTemplateLook` interfaces |
| `apps/catalogues-web/src/app/(app)/studio/page.tsx` | Real endpoint; "Choose Looks" section; shared `selectedCount` derivations; atomic `looks[]` submission |

## Order of Implementation

1. Migration + DB schema + storage key
2. Type schemas (Zod) — including `looks[]` on the tryon request
3. `createJob` per-look normalization + Amazon-override guard + tests
4. Admin API routes (CRUD, looks replace, thumbnail presign) + tests
5. Public API route (with filtering) + tests
6. Admin-web UI (`CatalogueTemplatesTab.tsx`)
7. Studio page (template fetch, "Choose Looks" section, shared derivations, atomic submission)
