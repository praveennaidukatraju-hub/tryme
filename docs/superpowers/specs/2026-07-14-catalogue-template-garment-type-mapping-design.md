# Catalogue Template ↔ Garment Type Mapping — Design

## Problem

Catalogue templates (`catalogue_templates` + `catalogue_template_looks`) are gender-scoped only. Every active template for a gender shows for **every** garment type within that gender, regardless of whether its looks actually make sense for that type. There's no way to say "this template is only offered for Kurta, not for Saree."

## What does NOT need to change

Investigated and confirmed already fully working, end-to-end, for both the regular pose picker and template looks:

- **Per-pose, per-garment-type workflow resolution** already exists via `pose_garment_configs` (`poseAssetId`, `subcategoryId`, optional `workflowTemplateId`/prompt overrides, optional `isActive` override).
- **Job creation** (`apps/api/src/modules/jobs/create.ts:236-297`) already resolves the effective workflow per (pose, garmentType) at validation time and rejects a pose the admin has disabled for that garment type.
- **The dispatcher** (`apps/dispatcher/src/job/processor.ts:196-227`) independently re-resolves the same effective workflow at generation time.
- Every job created from a template's `looks[]` array already carries the wizard's selected `garmentTypeId` on its own `job_inputs` row (`create.ts:354`), so this resolution already applies correctly per-look.

**Conclusion:** a template's *looks* don't need any new garment-type-scoping — a look's workflow already varies correctly by garment type through the existing pose mechanism. The only real gap is template-level: **which garment types is a template even offered for at all.**

## Design

### Data model

New table `catalogue_template_subcategories` — pure many-to-many, no override columns (there's nothing to override — see above). Modeled directly on the existing `catalog_item_subcategories` table (`packages/db/src/schema/models.ts:186-198`), which answers the exact same kind of question ("which garment subcategories does X apply to") for catalog items:

```ts
export const catalogueTemplateSubcategories = pgTable(
  'catalogue_template_subcategories',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.templateId, table.subcategoryId] }),
  }),
);
```

### Fallback behavior: strict, no backfill

A template with **zero** mapping rows is offered for **no** garment types (invisible), not "all" — deliberately strict, matching how an admin should have to opt a template *into* being shown rather than opting it out. No migration backfill needed: zero production templates exist today; the 2-3 local test templates are throwaway.

### Public API

`GET /v1/models/catalogue-templates?gender=&garmentTypeId=` (`apps/api/src/modules/models/routes.ts`) — requires a `catalogue_template_subcategories` row matching the given `garmentTypeId` for a template to be included. If `garmentTypeId` is omitted from the request entirely, return an empty list — there's no way to know which templates apply without it, so fail closed rather than fail open (returning "everything").

### Admin API

Mirrors the existing per-garment-type pose-config pattern (`apps/api/src/modules/admin/subcategories.routes.ts:157-293`) exactly, rather than an inline `subcategoryIds` field on the template's own create/patch body (which was considered and rejected — see below):

- `GET /admin/assets/garment-types/:id/templates` → every template for that garment type's gender, each with a `mapped: boolean`.
- `PATCH /admin/assets/garment-types/:id/templates/:templateId` with `{ mapped: boolean }` → `true` inserts the mapping row (no-op if already present), `false` deletes it.

### Admin UI

Lives inside the **existing** "Catalogue Templates" admin tab (`CatalogueTemplatesTab.tsx`), as a second internal sub-view alongside the existing template grid — **not** merged into the separate "Garment Types" tab, and **not** a new top-level AssetsPage tab. Rationale (explicit product decision): the "Garment Types" tab already has its own per-garment-type sub-view for pose overrides; adding a second, differently-scoped concept (template mapping) into that same navigational area would confuse the admin about what they're configuring. Keeping it inside "Catalogue Templates" instead keeps template-related configuration in one place.

Interaction: garment-type-first master-detail (matches the existing Pose Configs precedent's interaction model, but implemented as its own state within `CatalogueTemplatesTab.tsx`, not by reusing `GarmentTypesTab.tsx`) — pick a garment type from a list, see a checklist of every template for that gender, toggle checkboxes, each toggle fires the PATCH immediately (no batch Save, matching the Pose Configs `Switch`-per-item pattern).

### Rejected alternative: inline `subcategoryIds` on the template

Initially considered mirroring `catalog_item_subcategories`'s *usage* pattern too (an optional `subcategoryIds: string[]` array folded into the template's own POST/PATCH body, full-replace on save) — this is simpler on the backend, but doesn't fit the chosen garment-type-first UI (pick a garment type, see templates), which needs a query keyed by garment type, not by template. The dedicated per-garment-type endpoint pair is the correct fit for that UI direction.
