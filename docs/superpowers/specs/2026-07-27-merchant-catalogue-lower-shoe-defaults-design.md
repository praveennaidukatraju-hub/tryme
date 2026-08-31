# Merchant Catalogue Defaults — Lower Garment & Shoe

Date: 2026-07-27

## Problem

`createMerchantCatalogJob` (`apps/api/src/modules/merchant/create-job.ts`) builds the constrained
"flat garment → catalogue image" job that merchants use. It resolves an admin-fixed face,
background, and pose per gender category (`config:system.merchantCatalogDefaults`, keyed by
`men`/`women`/`boys`/`girls`), but it never resolves a lower garment or shoe — even when the
admin-assigned pose's workflow requires one.

Studio (`apps/api/src/modules/jobs/create.ts`), the Shopify wizard, and the embed wizard all
already fall back to `garmentSubcategories.defaultLowerCatalogId`/`defaultShoeCatalogId` when a
pose needs a lower/shoe. The merchant-catalogue path has no equivalent, so a merchant catalogue
job for a pose that needs, say, a lower garment currently generates with `lowerCatalogId: null`,
silently missing an input the workflow expects.

This spec adds **per-category** (not per-merchant) default lower garment and shoe selections to
the existing "Merchant Catalogue Defaults" admin section, applied only when the fixed pose's
workflow actually needs them.

## Non-goals

- No per-merchant or per-item overrides — same category-keyed scope as the existing face/background
  defaults.
- No DB schema changes or migration — `catalogItems`, `garmentSubcategories`,
  `poseGarmentConfigs`, and `workflowTemplates` already carry everything needed.
- No dispatcher changes — `jobInputs.lowerCatalogId`/`shoeCatalogId` are resolved to R2 keys
  downstream through the exact same path Studio jobs already use.

## Current state (verified)

- `packages/types/src/admin.ts:85-90` — `merchantCatalogDefaults` Zod schema, per category:
  `z.object({ faceId: z.string().uuid(), backgroundId: z.string().uuid() })`.
- `apps/api/src/modules/merchant/create-job.ts:17-22` — local `MerchantCatalogDefaults` interface
  mirrors the same shape; `createMerchantCatalogJob` reads it at lines 66-77, resolves face (79-84),
  background (85-93), and the fixed pose from `garmentType.defaultPoseId` (94-102) — no lower/shoe
  resolution exists anywhere in this function.
- `jobInputs` is inserted at lines 143-163 with `upperGarmentKey`, `faceId`, `backgroundId`,
  `poseId`, `garmentTypeId` — no `lowerCatalogId`/`shoeCatalogId` fields set.
- `apps/api/src/modules/jobs/create.ts:486-518` — the existing pattern for computing whether a
  pose+garment-type combo needs a lower/shoe: left-join `modelPoseAssets.workflowTemplateId` for
  the pose's default workflow, left-join `poseGarmentConfigs` for a per-(pose, subcategory)
  override, left-join that override's `workflowTemplateId` — the override's `lowerNodeId`/
  `shoeNodeId` win when a `poseGarmentConfigs` row exists for this subcategory, else the pose's
  default workflow's node IDs apply (lines 550-552).
- `apps/api/src/modules/jobs/create.ts:352-388` — the S6 catalog-ID validation pattern: if an ID is
  provided, look it up in `catalogItems` and require `isActive: true`; throw
  `AppError('BAD_CATALOG', 400, '<field> not found or inactive')` if missing. (Existing code does
  not check `catalogItems.type` matches the field's role — this spec keeps that same, established
  looseness rather than introducing a new stricter check.)
- `apps/admin-web/src/pages/SettingsPage.tsx:1360-1426` — "Merchant Catalogue Defaults" section:
  per-category (`men`/`women`/`boys`/`girls`) grid, each row has a `SearchableSelect` for face and
  one for background (lines 1368-1409), fed by `modelFacesList`/`modelBackgroundsList` state
  populated from `/admin/assets/faces` and `/admin/assets/backgrounds` (lines 476-483).
- `apps/admin-web/src/pages/assets/AssetsContext.tsx:152-153` and `CatalogTab.tsx:125-126` —
  existing precedent for fetching all catalog items via `GET /admin/catalog/items`, returning
  `CatalogItem[]` (`apps/api/src/modules/jobs/create.ts:174-187` for the shape mirrored in
  admin-web's own `CatalogItem` type: `id`, `type: 'lower' | 'shoe'`, `genderSlug`, `label`,
  `isActive`, ...).

## Design

### 1. Config schema (`packages/types/src/admin.ts:85-90`)

Extend the per-category object with two new **optional** UUID fields:

```ts
merchantCatalogDefaults: z
  .record(
    z.enum(['men', 'women', 'boys', 'girls']),
    z.object({
      faceId: z.string().uuid(),
      backgroundId: z.string().uuid(),
      lowerCatalogId: z.string().uuid().optional(),
      shoeCatalogId: z.string().uuid().optional(),
    }),
  )
  .optional(),
```

`faceId`/`backgroundId` stay mandatory (unchanged behavior); the two new fields are optional
because most categories/poses won't need them.

### 2. Job creation (`apps/api/src/modules/merchant/create-job.ts`)

**a. Extend the local interface** (lines 17-22) to match the Zod schema above (add
`lowerCatalogId?: string; shoeCatalogId?: string` to the per-category record type).

**b. Determine hasLower/hasShoes for the fixed pose.** After the existing pose lookup (lines
94-102), add a query that mirrors `jobs/create.ts:486-518` but scoped to the single
`(garmentType.defaultPoseId, params.garmentSubcategoryId)` pair — no `distinctPoseIds` array, no
`inArray`, just one row:

```ts
const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');
const [poseWorkflow] = await app.db
  .select({
    defaultLowerNodeId: defaultWorkflow.lowerNodeId,
    defaultShoeNodeId: defaultWorkflow.shoeNodeId,
    configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
    overrideLowerNodeId: overrideWorkflow.lowerNodeId,
    overrideShoeNodeId: overrideWorkflow.shoeNodeId,
  })
  .from(schema.modelPoseAssets)
  .leftJoin(defaultWorkflow, eq(schema.modelPoseAssets.workflowTemplateId, defaultWorkflow.id))
  .leftJoin(
    schema.poseGarmentConfigs,
    and(
      eq(schema.poseGarmentConfigs.poseAssetId, schema.modelPoseAssets.id),
      eq(schema.poseGarmentConfigs.subcategoryId, params.garmentSubcategoryId),
    ),
  )
  .leftJoin(overrideWorkflow, eq(schema.poseGarmentConfigs.workflowTemplateId, overrideWorkflow.id))
  .where(eq(schema.modelPoseAssets.id, garmentType.defaultPoseId))
  .limit(1);

const needsLower =
  (poseWorkflow?.configWorkflowTemplateId != null
    ? poseWorkflow.overrideLowerNodeId
    : poseWorkflow?.defaultLowerNodeId) != null;
const needsShoes =
  (poseWorkflow?.configWorkflowTemplateId != null
    ? poseWorkflow.overrideShoeNodeId
    : poseWorkflow?.defaultShoeNodeId) != null;
```

Import `aliasedTable` from `drizzle-orm` (same as `jobs/create.ts`).

**c. Require + validate the configured defaults only when needed.** Directly after the existing
face/background config check (lines 70-76):

```ts
if (needsLower && !categoryDefaults.lowerCatalogId) {
  throw new AppError(
    'VALIDATION',
    400,
    `admin has not configured a default lower garment for category "${params.category}"`,
  );
}
if (needsShoes && !categoryDefaults.shoeCatalogId) {
  throw new AppError(
    'VALIDATION',
    400,
    `admin has not configured a default shoe for category "${params.category}"`,
  );
}
```

Then, alongside the existing face/background/pose active-row lookups (lines 79-102), resolve and
validate the two new IDs the same way (only queried when `needsLower`/`needsShoes` is true):

```ts
const [lowerItem] = needsLower
  ? await app.db
      .select({ id: schema.catalogItems.id })
      .from(schema.catalogItems)
      .where(
        and(
          eq(schema.catalogItems.id, categoryDefaults.lowerCatalogId!),
          eq(schema.catalogItems.isActive, true),
        ),
      )
  : [];
const [shoeItem] = needsShoes
  ? await app.db
      .select({ id: schema.catalogItems.id })
      .from(schema.catalogItems)
      .where(
        and(
          eq(schema.catalogItems.id, categoryDefaults.shoeCatalogId!),
          eq(schema.catalogItems.isActive, true),
        ),
      )
  : [];
if (needsLower && !lowerItem)
  throw new AppError('BAD_CATALOG', 400, 'configured default lower garment not found or inactive');
if (needsShoes && !shoeItem)
  throw new AppError('BAD_CATALOG', 400, 'configured default shoe not found or inactive');
```

**d. Store on the job.** In the `jobInputs` insert (lines 143-163), add:

```ts
lowerCatalogId: needsLower ? lowerItem.id : null,
shoeCatalogId: needsShoes ? shoeItem.id : null,
```

This guarantees the "only used if the workflow needs them" requirement — the fields are `null`
whenever `needsLower`/`needsShoes` is false, regardless of what the admin configured for that
category.

### 3. Admin UI (`apps/admin-web/src/pages/SettingsPage.tsx`)

**a. State** (lines 378-380): widen the `merchantCatalogDefaults` type to
`Record<string, { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }>`.

**b. Fetch catalog items once**, alongside the existing faces/backgrounds fetch (lines 476-483):

```ts
const [catalogItemsList, setCatalogItemsList] = useState<
  Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>
>([]);
// ...
useEffect(() => {
  apiFetch<Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>>(
    '/admin/catalog/items',
  )
    .then(setCatalogItemsList)
    .catch(() => {});
}, []);
```

**c. Extend the per-category grid** (lines 1368-1409): change `gridTemplateColumns` from
`'80px 1fr 1fr'` to `'80px 1fr 1fr 1fr 1fr'` and add two more `SearchableSelect` dropdowns per
row, filtered the same way the face dropdown already filters by gender
(`.filter((f) => f.gender === cat)` at line 1381) — here filtering by `type` and, when the item
has a non-null `genderSlug`, by category match:

```tsx
<SearchableSelect
  options={catalogItemsList.filter(
    (c) => c.type === 'lower' && (c.genderSlug == null || c.genderSlug === cat),
  )}
  value={merchantCatalogDefaults[cat]?.lowerCatalogId ?? ''}
  disabled={sysSaving}
  placeholder="— search lower garment —"
  emptyLabel="— none / not needed —"
  onChange={(lowerCatalogId) =>
    setMerchantCatalogDefaults((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], faceId: prev[cat]?.faceId ?? '', backgroundId: prev[cat]?.backgroundId ?? '', lowerCatalogId },
    }))
  }
/>
<SearchableSelect
  options={catalogItemsList.filter(
    (c) => c.type === 'shoe' && (c.genderSlug == null || c.genderSlug === cat),
  )}
  value={merchantCatalogDefaults[cat]?.shoeCatalogId ?? ''}
  disabled={sysSaving}
  placeholder="— search shoe —"
  emptyLabel="— none / not needed —"
  onChange={(shoeCatalogId) =>
    setMerchantCatalogDefaults((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], faceId: prev[cat]?.faceId ?? '', backgroundId: prev[cat]?.backgroundId ?? '', shoeCatalogId },
    }))
  }
/>
```

Unlike face/background, an empty selection is valid here — `SearchableSelect`'s `emptyLabel` prop
already prepends a clearable "— none —"-style option that calls `onChange('')` (see
`apps/admin-web/src/components/SearchableSelect.tsx:16,26,70`). That empty string must be
translated to omitting the key, not sending an empty string, when the save payload is built.

**d. Save payload**: when building the PATCH body, strip empty-string `lowerCatalogId`/
`shoeCatalogId` per category (send `undefined`/omit rather than `''`, since the Zod schema
requires `.uuid()` when present).

**e. Update the section description** (line 1364-1367) to mention the new optional fields, e.g.
"...guarantees every generated image is try-on-suitable. Lower garment and shoe defaults are only
applied when the assigned pose's workflow needs one."

### 4. Testing

Add coverage in `apps/api/test/` (existing merchant-catalogue job creation test file, or a new one
following the harness pattern in `apps/api/test/helpers/`):

1. Pose's workflow needs both lower and shoe; category has both defaults configured → job's
   `jobInputs` row has both `lowerCatalogId`/`shoeCatalogId` set to the configured items.
2. Pose's workflow needs a lower garment; category default for `lowerCatalogId` is unset →
   `createMerchantCatalogJob` throws `VALIDATION` 400 with the "admin has not configured..."
   message.
3. Pose's workflow needs neither lower nor shoe; category has both defaults configured anyway →
   job's `jobInputs` row has `lowerCatalogId: null` and `shoeCatalogId: null` (proves defaults are
   never applied when unneeded).
4. Configured `lowerCatalogId` points to an inactive catalog item → throws `BAD_CATALOG` 400.

## Open questions

None — all details were confirmed during brainstorming (per-category keying, hard-error on missing
required default, reuse of existing Redis-config + job-creation infrastructure with no DB
migration).
