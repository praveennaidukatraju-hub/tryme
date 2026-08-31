# Merchant Catalogue Manager — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built catalogue-manager UI prototype (`apps/catalogues-web`) to a real backend: merchant-owned dynamic subcategories under fixed categories, products with SKU/prices, and a constrained "flat garment → catalogue image" generation flow that reuses the existing studio pipeline unchanged.

**Architecture:** A merchant is a `users` row with a `merchants` profile (already unified). Generating a catalogue image from a flat garment is an ordinary `jobs.userId`-owned studio job with admin-fixed face/background/pose — **not** a new pipeline, **not** dispatcher work. A dedicated `createMerchantCatalogJob` function (not a refactor of the security-sensitive `createJob`) builds that job directly from server-resolved inputs. The catalogue image (studio output) is the single image used for both kiosk display and ComfyUI try-on input — the flat upload is provenance-only.

**Tech Stack:** Fastify 5 + Zod (`fastify-type-provider-zod`), Drizzle ORM / PostgreSQL, Redis (queue + `config:system` key-value config), Vitest integration tests against a real Postgres/Redis/MinIO (`pnpm docker:up`), React admin panel (Vite).

---

## Context for the implementer

Read `docs/multi-app-ecosystem/phase-6-merchant-catalogue-manager.md` first — it has the full product framing (two fixed products: catalogue creation + virtual try-on; a merchant is a converted user; two ways an image enters a product). This plan is the literal, file-by-file execution of that doc, with the open questions from review resolved:

- **Image role (resolved):** the generated catalogue image is used for **both** kiosk display (`r2Key`) **and** as the ComfyUI try-on input. The flat upload (`flatSourceKey`) is provenance-only, never sent to ComfyUI. This means the existing `/v1/merchant/catalog/import` route must change what it copies into `r2Key` — today it copies the job's *source garment* (`job.upperGarmentKey`) into `r2Key` and the job's *output* into `thumbnailKey`; after this plan it must copy the job's **output** into both `r2Key` and `thumbnailKey`.
- **`createJob` reuse (resolved):** do **not** extract a shared core from `apps/api/src/modules/jobs/create.ts::createJob`. That function is long, has documented security invariants (S1/S6/H2 comments inline), and handles multi-pose/lower/shoe/Amazon-override cases the merchant flow never needs. Instead, write a small dedicated `createMerchantCatalogJob` in `apps/api/src/modules/merchant/create-job.ts` that follows the same *pattern* (same active-asset checks, same `getMaxOutputPx` clamp, same `getResolutionCreditCost` + `atomicDeduct`, same jobs/job_inputs insert + `XADD jobs:normal` shape) with only what the constrained single-pose case needs. This is a deliberate scope-reduction from the doc's hedge ("prefer extracting... if extraction is heavy, synthesize a body — decide at implementation") — decided: dedicated function.
- **`apps/merchant-web` (resolved, no task needed):** verified its `CatalogContent.tsx` declares fully local TypeScript types (`MerchantCatalogGender`, `MerchantCatalogItem`) and never imports from `@tryme/types`. The schema/type changes in this plan do **not** break its build. It stays functionally sidelined (already-broken merchant login, pre-existing and unrelated to this plan) but keeps compiling. No file in `apps/merchant-web` is touched by this plan.
- **`sourceKind` computed-value bug (new finding, must fix):** both `apps/api/src/modules/merchant/catalog.routes.ts::serializeCatalogItem` and `apps/api/src/modules/admin/merchant-catalog.routes.ts::serializeCatalogItem` currently compute `sourceKind: item.sourceJobId ? 'imported' : 'uploaded'`. Once `sourceKind` becomes a real stored column (this plan), a `generated` item (which also has `sourceJobId` set, since it comes from a real job) would be silently mis-reported as `'imported'` by this stale computed override. Fix: delete the computed override in both places; return the stored column via the `...item` spread.
- **Zod strip-on-parse landmine (new finding, must fix):** `PATCH /admin/config` is gated by `SystemConfigBody` (`packages/types/src/admin.ts`), a plain (non-strict) `z.object({...})`. Zod's default behavior **strips unrecognized keys** during `.parse()`, and `fastify-type-provider-zod` parses the body before the handler runs. If `merchantCatalogDefaults`/`merchantCatalogAspectRatio` are added to the PATCH payload without also being declared in `SystemConfigBody`, they will silently vanish before ever reaching the handler — no error, just data loss. `SystemConfigBody` must be extended.
- **Presign key collision avoided:** the flat-garment upload must NOT reuse `keys.merchantCatalogItem()` (that key is for the final product's stored image/thumbnail). A new key builder `keys.merchantCatalogFlatGarment(merchantId, id)` is added under the **same** `merchant-catalog/{merchantId}/` prefix (nested one level deeper: `merchant-catalog/{merchantId}/flat/{id}/garment.jpg`) so the existing `assertMerchantUploadKey` ownership-check helper (which does a `key.startsWith('merchant-catalog/${merchantId}/')` prefix check) keeps working unmodified.
- **Gender vocabulary:** standardize on `men | women | boys | girls` (plural) everywhere new code touches gender/category — confirmed this is what `garmentSubcategories.genderSlug`, `modelPoseAssets.genderSlug`, `modelFaces.gender`, and the admin-web `GenderSlug` type all already use. The existing singular `MerchantCatalogGender` (`men | women | boy | girl`) zod enum in `packages/types/src/widget.ts` stays exported unchanged (kept only so `apps/merchant-web`'s dead-but-compiling code has nothing broken to point at) but is never used by any new schema in this plan.
  > **2026-07-10 addendum:** `apps/merchant-web` has since been deleted entirely, and `MerchantCatalogGender` was removed from `packages/types/src/widget.ts` as dead code (its only reason for staying exported no longer applies). Noted here for anyone reading this plan as historical reference — this line and the "kept only so..." rationale above no longer hold.

**Environment for running tests:** `pnpm docker:up` must be running (Postgres on the port in `.env`'s `POSTGRES_PORT`, Redis, MinIO). Integration tests live in `apps/api/test/integration/*.test.ts`, run via `pnpm exec vitest run --config vitest.integration.config.ts <file>` from `apps/api/`, with `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/`POSTGRES_PORT` exported from the repo-root `.env` first (see Task 1 Step 2 for the exact command — reuse it for every subsequent test run in this plan).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/merchant.ts` | Modify: add `merchantCatalogSubcategories` table; add/remove columns on `merchantCatalogItems`. |
| `packages/db/src/schema/models.ts` | Modify: add `defaultPoseId` to `garmentSubcategories`. |
| `packages/db/src/migrations/0096_merchant_catalog_subcategories.sql` | Create: the migration for the above (truncates `merchant_catalog_items` — test data only, stated explicitly). |
| `packages/storage/src/keys.ts` | Modify: add `merchantCatalogFlatGarment` key builder. |
| `packages/types/src/widget.ts` | Modify: subcategory schemas; item/create/update schema field changes; generate request/response schemas. |
| `packages/types/src/admin.ts` | Modify: extend `SystemConfigBody` with `merchantCatalogDefaults` + `merchantCatalogAspectRatio`; extend `PatchGarmentTypeBody` with `defaultPoseId`. |
| `apps/api/src/modules/merchant/catalog.routes.ts` | Modify: subcategory CRUD; product CRUD updated for `subcategoryId`/prices; fix `sourceKind` bug; `/import` copies job output into `r2Key`+`thumbnailKey`; extract shared copy-job-output-into-product helper. |
| `apps/api/src/modules/merchant/create-job.ts` | Create: `createMerchantCatalogJob` — the constrained single-pose studio job builder. |
| `apps/api/src/modules/admin/merchant-catalog.routes.ts` | Modify: fix the same `sourceKind` bug. |
| `apps/api/src/modules/kiosk/catalog.routes.ts` | Modify: join through `merchantCatalogSubcategories` to recover `gender`/`category` for the kiosk response contract. |
| `apps/api/src/modules/admin/subcategories.routes.ts` | Modify: accept/return `defaultPoseId` on garment-type PATCH. |
| `apps/api/src/modules/admin/config.routes.ts` | No change needed — `GET`/`PATCH /admin/config` already pass through arbitrary keys once the zod schema allows them. |
| `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx` | Modify: add "Default pose (merchant catalogue generation)" selector inside the existing `PoseConfigsPanel` subview. |
| `apps/admin-web/src/pages/SettingsPage.tsx` | Modify: add a "Merchant Catalogue Defaults" card (face+background per category, aspect ratio). |
| `apps/admin-web/src/types.ts` | Modify: add `defaultPoseId` to the `GarmentType` interface. |
| `apps/api/test/integration/merchant-catalog.test.ts` | Modify: update seed helpers for the new `subcategoryId`/prices product shape. |
| `apps/api/test/integration/merchant-catalog-subcategories.test.ts` | Create: subcategory CRUD tests. |
| `apps/api/test/integration/merchant-catalog-generate.test.ts` | Create: single + bulk generate tests. |

---

## Task 1: Database schema — subcategories table + product column changes

**Files:**
- Modify: `packages/db/src/schema/merchant.ts`
- Modify: `packages/db/src/schema/models.ts`
- Create: `packages/db/src/migrations/0096_merchant_catalog_subcategories.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Edit `packages/db/src/schema/merchant.ts`**

Add the import and the new table right after the `merchants` table definition (before `merchantCredits`):

```ts
import { garmentSubcategories } from './models.js';
```

Add near the top imports (alongside the existing `import { jobs } from './jobs.js';` and `import { users } from './users.js';`).

Insert this new table definition after `merchants` and before `merchantCredits`:

```ts
export const merchantCatalogSubcategories = pgTable(
  'merchant_catalog_subcategories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    category: text('category').notNull(), // 'men' | 'women' | 'boys' | 'girls'
    name: text('name').notNull(),
    garmentSubcategoryId: uuid('garment_subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id), // admin garment type — drives the try-on workflow; many subcats -> one type
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_catalog_subcategories_merchant_idx').on(t.merchantId, t.category)],
);
```

Then modify `merchantCatalogItems` — replace the whole table definition with:

```ts
export const merchantCatalogItems = pgTable(
  'merchant_catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => merchantCatalogSubcategories.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    sku: text('sku'),
    actualPricePaise: integer('actual_price_paise').notNull(),
    offerPricePaise: integer('offer_price_paise').notNull(),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    sourceJobId: uuid('source_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    sourceKind: text('source_kind').notNull().default('uploaded'), // 'uploaded' | 'generated' | 'imported'
    flatSourceKey: text('flat_source_key'), // provenance only for sourceKind='generated' — never sent to ComfyUI
    isActive: boolean('is_active').notNull().default(true),
    moderationStatus: text('moderation_status').notNull().default('approved'),
    moderationNote: text('moderation_note'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('merchant_catalog_items_merchant_idx').on(t.merchantId, t.isActive),
    index('merchant_catalog_items_subcategory_idx').on(t.subcategoryId),
    uniqueIndex('merchant_catalog_items_merchant_source_job_unique')
      .on(t.merchantId, t.sourceJobId)
      .where(sql`${t.sourceJobId} is not null`),
  ],
);
```

(Removed: `gender`, `category` columns. Added: `subcategoryId`, `actualPricePaise`, `offerPricePaise`, `sourceKind`, `flatSourceKey`, plus the new `subcategoryId` index.)

- [ ] **Step 2: Edit `packages/db/src/schema/models.ts` — add `defaultPoseId` to `garmentSubcategories`**

The table imports `modelPoseAssets`, but `modelPoseAssets` is defined *after* `garmentSubcategories` in the same file (drizzle allows this via the file's own forward-reference pattern already used for `workflowTemplates`/`modelPoseAssets` — same file, so no circular-import issue). Add the column to the existing `garmentSubcategories` definition, right after `tryonCategoryId`:

```ts
  // FK to tryon_categories.id enforced in SQL only — see migration 0074. Not a
  // typed drizzle reference to avoid a circular import with schema/tryon.ts.
  tryonCategoryId: uuid('tryon_category_id'),
  // Admin-fixed pose used by merchant catalogue-manager's constrained "flat garment
  // -> catalogue image" generation. Null = generation unavailable for this type.
  defaultPoseId: uuid('default_pose_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

Note: declared as a plain `uuid` column with **no typed `.references()`** here, matching the existing `tryonCategoryId` pattern in this same table (the comment above explains why — `modelPoseAssets` is defined later in the file, and even though same-file forward references usually work in drizzle, follow the established local convention exactly and add the real FK constraint in raw SQL in the migration, enforced at the DB level, consistent with how `tryonCategoryId`'s migration 0074 pattern works). The FK is added in the migration SQL in Step 3 below.

- [ ] **Step 3: Write the migration SQL**

First, check the real current DB state so the migration's `ALTER` statements target real column/constraint names (do not guess — the codebase's `CLAUDE.md` explicitly documents past incidents from guessed constraint names):

```bash
docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\d merchant_catalog_items"
```

Run: the above command.
Expected: a column listing showing `gender`, `category` as nullable text columns, `merchant_catalog_items_merchant_idx` and `merchant_catalog_items_merchant_source_job_unique` as existing index names (confirm they match what Step 1 assumes — if names differ, adjust the migration below to match reality, not this plan).

Create `packages/db/src/migrations/0096_merchant_catalog_subcategories.sql`:

```sql
-- merchant_catalog_items currently holds only test/seed data from this session's
-- development — truncate rather than backfill so the new NOT NULL columns
-- (subcategory_id, actual_price_paise, offer_price_paise) can be added directly.
TRUNCATE TABLE "merchant_catalog_items";--> statement-breakpoint

CREATE TABLE "merchant_catalog_subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"garment_subcategory_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "merchant_catalog_subcategories" ADD CONSTRAINT "merchant_catalog_subcategories_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_catalog_subcategories" ADD CONSTRAINT "merchant_catalog_subcategories_garment_subcategory_id_garment_subcategories_id_fk" FOREIGN KEY ("garment_subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_catalog_subcategories_merchant_idx" ON "merchant_catalog_subcategories" USING btree ("merchant_id","category");--> statement-breakpoint

ALTER TABLE "garment_subcategories" ADD COLUMN "default_pose_id" uuid;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_default_pose_id_model_pose_assets_id_fk" FOREIGN KEY ("default_pose_id") REFERENCES "public"."model_pose_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "merchant_catalog_items" DROP COLUMN "gender";--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "subcategory_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "actual_price_paise" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "offer_price_paise" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "source_kind" text DEFAULT 'uploaded' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "flat_source_key" text;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD CONSTRAINT "merchant_catalog_items_subcategory_id_merchant_catalog_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."merchant_catalog_subcategories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_catalog_items_subcategory_idx" ON "merchant_catalog_items" USING btree ("subcategory_id");
```

- [ ] **Step 4: Add the journal entry**

Read the tail of `packages/db/src/migrations/meta/_journal.json` to confirm `0095` is still the highest entry (this plan assumes it is, per the current repo state — reconfirm at execution time per this repo's own documented "Migration Index Conflicts" policy in `CLAUDE.md`):

```bash
tail -12 packages/db/src/migrations/meta/_journal.json
```

Run: the above command.
Expected: last entry shows `"idx": 95, "tag": "0095_drop_widget_embed_columns"`.

Edit the file, replacing the closing of the array:

```json
    {
      "idx": 95,
      "version": "7",
      "when": 1783512362369,
      "tag": "0095_drop_widget_embed_columns",
      "breakpoints": true
    },
    {
      "idx": 96,
      "version": "7",
      "when": 1783600000000,
      "tag": "0096_merchant_catalog_subcategories",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 5: Build the db package and generate the snapshot**

```bash
cd packages/db && pnpm build
```

Run: the above command.
Expected: exits 0, no TypeScript errors.

```bash
cd packages/db && DATABASE_URL="postgres://placeholder" pnpm exec drizzle-kit generate --name=verify-0096-no-drift
```

Run: the above command.
Expected: output ends with `No schema changes, nothing to migrate 😴` — this confirms the hand-written migration SQL in Step 3 exactly matches what drizzle-kit would generate from the Step 1/2 schema edits. **If drizzle-kit instead proposes new SQL statements, that means Step 3's SQL has a mistake (wrong column/constraint name, missed statement) — read what drizzle-kit generated, fix Step 3's SQL and the schema files to agree, delete the extra generated migration file drizzle-kit just created, and re-run this step until it reports no drift.**

- [ ] **Step 6: Apply the migration**

```bash
cd ../.. && pnpm db:migrate
```

Run: the above command (from repo root).
Expected: `Applied  0096_merchant_catalog_subcategories` then `Done: 1 applied, 0 reconciled.`

- [ ] **Step 7: Verify against the live database**

```bash
docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\d merchant_catalog_items" && docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\d merchant_catalog_subcategories" && docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\d garment_subcategories" | grep default_pose_id
```

Run: the above command.
Expected: `merchant_catalog_items` has no `gender`/`category` columns, has `subcategory_id`/`actual_price_paise`/`offer_price_paise`/`source_kind`/`flat_source_key`; `merchant_catalog_subcategories` exists with the expected columns; `garment_subcategories` shows a `default_pose_id | uuid` row.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/merchant.ts packages/db/src/schema/models.ts packages/db/src/migrations/0096_merchant_catalog_subcategories.sql packages/db/src/migrations/meta/_journal.json packages/db/src/migrations/meta/0096_snapshot.json
git commit -m "feat(db): add merchant catalog subcategories table and product pricing columns"
```

---

## Task 2: Types — subcategory schemas, product schema changes, admin config schemas

**Files:**
- Modify: `packages/types/src/widget.ts`
- Modify: `packages/types/src/admin.ts`

- [ ] **Step 1: Edit `packages/types/src/widget.ts` — replace the product body/item schemas**

Replace `MerchantCatalogCreateBody` (currently uses `gender`/`category`) with:

```ts
export const MerchantCatalogCreateBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(200),
  sku: z.string().max(120).optional(),
  actualPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  offerPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
});
export type MerchantCatalogCreateBody = z.infer<typeof MerchantCatalogCreateBody>;
```

Replace `MerchantCatalogUpdateBody` with:

```ts
export const MerchantCatalogUpdateBody = z
  .object({
    subcategoryId: z.string().uuid().optional(),
    label: z.string().min(1).max(200).optional(),
    sku: z.string().max(120).nullable().optional(),
    actualPrice: z.number().int().min(0).optional(),
    offerPrice: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine(
    (body) =>
      body.subcategoryId !== undefined ||
      body.label !== undefined ||
      body.sku !== undefined ||
      body.actualPrice !== undefined ||
      body.offerPrice !== undefined ||
      body.isActive !== undefined ||
      body.sortOrder !== undefined,
    { message: 'at least one field is required' },
  );
export type MerchantCatalogUpdateBody = z.infer<typeof MerchantCatalogUpdateBody>;
```

Replace `MerchantCatalogItem` with:

```ts
export const MerchantCatalogSourceKind = z.enum(['uploaded', 'generated', 'imported']);
export type MerchantCatalogSourceKind = z.infer<typeof MerchantCatalogSourceKind>;

export const MerchantCatalogItem = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  subcategoryId: z.string().uuid(),
  label: z.string(),
  sku: z.string().nullable(),
  actualPrice: z.number().int(), // rupees — converted from paise by the route layer
  offerPrice: z.number().int(),
  r2Key: z.string(),
  thumbnailKey: z.string(),
  imageUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  sourceJobId: z.string().uuid().nullable(),
  sourceKind: MerchantCatalogSourceKind,
  flatSourceKey: z.string().nullable(),
  isActive: z.boolean(),
  moderationStatus: MerchantCatalogModerationStatus,
  moderationNote: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MerchantCatalogItem = z.infer<typeof MerchantCatalogItem>;
```

Leave `MerchantCatalogGender` exactly as-is (unused by the new schemas, kept only so nothing else that still imports it breaks — see plan Context).

- [ ] **Step 2: Add subcategory schemas**

Add these directly after the `MerchantCatalogItem`/`MerchantCatalogListResponse` block:

```ts
export const MerchantCatalogCategory = z.enum(['men', 'women', 'boys', 'girls']);
export type MerchantCatalogCategory = z.infer<typeof MerchantCatalogCategory>;

export const MerchantCatalogSubcategoryCreateBody = z.object({
  category: MerchantCatalogCategory,
  name: z.string().min(1).max(160),
  garmentSubcategoryId: z.string().uuid(),
});
export type MerchantCatalogSubcategoryCreateBody = z.infer<
  typeof MerchantCatalogSubcategoryCreateBody
>;

export const MerchantCatalogSubcategoryUpdateBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    garmentSubcategoryId: z.string().uuid().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.garmentSubcategoryId !== undefined || body.sortOrder !== undefined,
    { message: 'at least one field is required' },
  );
export type MerchantCatalogSubcategoryUpdateBody = z.infer<
  typeof MerchantCatalogSubcategoryUpdateBody
>;

export const MerchantCatalogSubcategory = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  category: MerchantCatalogCategory,
  name: z.string(),
  garmentSubcategoryId: z.string().uuid(),
  sortOrder: z.number().int(),
  productCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MerchantCatalogSubcategory = z.infer<typeof MerchantCatalogSubcategory>;

export const MerchantCatalogSubcategoryListResponse = z.object({
  items: z.array(MerchantCatalogSubcategory),
});
export type MerchantCatalogSubcategoryListResponse = z.infer<
  typeof MerchantCatalogSubcategoryListResponse
>;
```

- [ ] **Step 3: Add generate request/response schemas**

Add after the subcategory schemas:

```ts
export const MerchantCatalogGenerateBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKey: z.string().min(1),
});
export type MerchantCatalogGenerateBody = z.infer<typeof MerchantCatalogGenerateBody>;

export const MerchantCatalogGenerateBulkBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKeys: z.array(z.string().min(1)).min(1).max(50),
});
export type MerchantCatalogGenerateBulkBody = z.infer<typeof MerchantCatalogGenerateBulkBody>;

export const MerchantCatalogGenerateStatus = z.object({
  jobId: z.string().uuid(),
  status: z.string(),
  resultUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
});
export type MerchantCatalogGenerateStatus = z.infer<typeof MerchantCatalogGenerateStatus>;

export const MerchantCatalogGenerateBulkStatusResponse = z.object({
  items: z.array(MerchantCatalogGenerateStatus),
});
export type MerchantCatalogGenerateBulkStatusResponse = z.infer<
  typeof MerchantCatalogGenerateBulkStatusResponse
>;
```

- [ ] **Step 4: Extend `MerchantCatalogPresignBody.kind`**

Change:
```ts
  kind: z.enum(['image', 'thumbnail']),
```
to:
```ts
  kind: z.enum(['image', 'thumbnail', 'flat']),
```

- [ ] **Step 5: Edit `packages/types/src/admin.ts` — extend `SystemConfigBody`**

Find `SystemConfigBody` and add the two new optional fields (this is the fix for the zod-strip landmine documented in Context):

```ts
export const SystemConfigBody = z.object({
  resolutions: z
    .object({
      HD: ResolutionConfig.optional(),
      '2K': ResolutionConfig.optional(),
      '4K': ResolutionConfig.optional(),
    })
    .optional(),
  maxOutputPx: z.number().int().min(512).max(4096).optional(),
  // Admin-fixed inputs for merchant catalogue-manager's constrained "flat garment
  // -> catalogue image" generation. Keyed by category so studio-style face/background
  // variety per gender is preserved without per-merchant or per-item picking.
  merchantCatalogDefaults: z
    .record(
      z.enum(['men', 'women', 'boys', 'girls']),
      z.object({ faceId: z.string().uuid(), backgroundId: z.string().uuid() }),
    )
    .optional(),
  merchantCatalogAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
});
```

- [ ] **Step 6: Extend `PatchGarmentTypeBody` with `defaultPoseId`**

Find `PatchGarmentTypeBody` and add:

```ts
export const PatchGarmentTypeBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  thumbnailKey: z.string().nullable().optional(),
  requiresLowerUpload: z.boolean().optional(),
  defaultLowerCatalogId: z.string().uuid().nullable().optional(),
  defaultShoeCatalogId: z.string().uuid().nullable().optional(),
  tryonCategoryId: z.string().uuid().nullable().optional(),
  instructionImageKey: z.string().nullable().optional(),
  defaultPoseId: z.string().uuid().nullable().optional(),
});
```

- [ ] **Step 7: Build and typecheck**

```bash
cd packages/types && pnpm build
```

Run: the above command.
Expected: exits 0, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/widget.ts packages/types/src/admin.ts
git commit -m "feat(types): add merchant catalog subcategory, pricing, and generate schemas"
```

---

## Task 3: Storage key builder for flat garment uploads

**Files:**
- Modify: `packages/storage/src/keys.ts`

- [ ] **Step 1: Add the key builder**

In `packages/storage/src/keys.ts`, add directly after `merchantCatalogItemThumb`:

```ts
  merchantCatalogItem: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/${id}/image.jpg`,
  merchantCatalogItemThumb: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/${id}/thumb.jpg`,
  // Provenance-only flat garment upload for the merchant catalogue-manager's
  // constrained generate flow. Nested under the same merchant-catalog/{merchantId}/
  // prefix so assertMerchantUploadKey's ownership check works unmodified.
  merchantCatalogFlatGarment: (merchantId: string, id: string) =>
    `merchant-catalog/${merchantId}/flat/${id}/garment.jpg`,
```

- [ ] **Step 2: Build**

```bash
cd packages/storage && pnpm build
```

Run: the above command.
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add merchant catalogue flat-garment key builder"
```

---

## Task 4: Merchant subcategory CRUD

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`
- Create: `apps/api/test/integration/merchant-catalog-subcategories.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/api/test/integration/merchant-catalog-subcategories.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      websiteUrl: 'https://example.com',
      companySize: '1-10',
      purpose: 'merchant tests',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: 0 });
  return merchant;
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedGarmentType(app: TestApp, genderSlug: string) {
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({ genderSlug, slug: `shirt-${randomUUID()}`, label: 'Shirt' })
    .returning();
  return row;
}

describe('merchant catalog subcategories', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('creates, lists, updates, and isolates subcategories per merchant', async () => {
    const merchantA = await createMerchant(app, 'subcat-a@example.com');
    const merchantB = await createMerchant(app, 'subcat-b@example.com');
    const authA = await authHeader(merchantA.userId);
    const authB = await authHeader(merchantB.userId);
    const garmentType = await seedGarmentType(app, 'men');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: authA,
      payload: { category: 'men', name: 'Casual Shirts', garmentSubcategoryId: garmentType.id },
    });
    expect(created.statusCode).toBe(201);
    const subcat = created.json() as { id: string; name: string; productCount: number };
    expect(subcat.name).toBe('Casual Shirts');
    expect(subcat.productCount).toBe(0);

    const listedA = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: authA,
    });
    expect(listedA.statusCode).toBe(200);
    expect((listedA.json() as { items: unknown[] }).items).toHaveLength(1);

    const listedB = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: authB,
    });
    expect((listedB.json() as { items: unknown[] }).items).toHaveLength(0);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/subcategories/${subcat.id}`,
      headers: authA,
      payload: { name: 'Party Shirts' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { name: string }).name).toBe('Party Shirts');

    const crossMerchantPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/subcategories/${subcat.id}`,
      headers: authB,
      payload: { name: 'Should not work' },
    });
    expect(crossMerchantPatch.statusCode).toBe(404);
  });

  it('allows two subcategories to point at the same garment type (many-to-one)', async () => {
    const merchant = await createMerchant(app, 'subcat-manytoone@example.com');
    const auth = await authHeader(merchant.userId);
    const garmentType = await seedGarmentType(app, 'women');

    const first = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Casual', garmentSubcategoryId: garmentType.id },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Party', garmentSubcategoryId: garmentType.id },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
  });

  it('deletes a subcategory and cascades its products, cleaning up R2 objects', async () => {
    const merchant = await createMerchant(app, 'subcat-delete@example.com');
    const auth = await authHeader(merchant.userId);
    const garmentType = await seedGarmentType(app, 'men');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'To Delete', garmentSubcategoryId: garmentType.id },
    });
    const subcatId = (created.json() as { id: string }).id;

    const imageKey = `merchant-catalog/${merchant.id}/delete-test/image.jpg`;
    const thumbKey = `merchant-catalog/${merchant.id}/delete-test/thumb.jpg`;
    await app.storage.putObject(imageKey, Buffer.from('img'), 'image/jpeg');
    await app.storage.putObject(thumbKey, Buffer.from('thumb'), 'image/jpeg');
    await app.db.insert(schema.merchantCatalogItems).values({
      merchantId: merchant.id,
      subcategoryId: subcatId,
      label: 'Product',
      actualPricePaise: 100000,
      offerPricePaise: 90000,
      r2Key: imageKey,
      thumbnailKey: thumbKey,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/subcategories/${subcatId}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);

    const remainingProducts = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.subcategoryId, subcatId));
    expect(remainingProducts).toHaveLength(0);

    await expect(app.storage.headObject(imageKey)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export $(grep -E "^POSTGRES_(USER|PASSWORD|DB|PORT)=" ../../.env | xargs) 2>/dev/null
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-subcategories.test.ts
```

Run: the above (from repo root; the `export` line reads the repo-root `.env` — adjust the relative path if your shell's cwd differs).
Expected: FAIL — routes `/v1/merchant/catalog/subcategories*` don't exist yet (404s), or a TypeScript compile error since `schema.merchantCatalogItems` values in the test already assume the new columns (this is expected to fail at this point — Task 1 already landed the schema, so the compile should succeed but the routes will 404).

- [ ] **Step 3: Implement the subcategory routes**

Edit `apps/api/src/modules/merchant/catalog.routes.ts`. Update the import block at the top:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  MerchantCatalogCreateBody,
  MerchantCatalogGenerateBody,
  MerchantCatalogGenerateBulkBody,
  MerchantCatalogImportBody,
  MerchantCatalogPresignBody,
  MerchantCatalogSubcategoryCreateBody,
  MerchantCatalogSubcategoryUpdateBody,
  MerchantCatalogUpdateBody,
} from '@tryme/types';
import { and, count, desc, eq, ilike, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
```

(`MerchantCatalogGenerateBody`/`MerchantCatalogGenerateBulkBody` are imported now for Tasks 8/9 later in this plan — harmless unused-import-free since they'll be used within this same file by the end of this plan; if your linter complains before Task 8 lands, that's expected mid-plan and resolves once those routes are added.)

Add the `count` import to the existing `drizzle-orm` import (already shown above — `count` was not previously imported).

Add a subcategory serializer function near the top, after `catalogueLabel`:

```ts
async function serializeSubcategory(
  app: FastifyInstance,
  row: typeof schema.merchantCatalogSubcategories.$inferSelect,
) {
  const [{ n }] = await app.db
    .select({ n: count() })
    .from(schema.merchantCatalogItems)
    .where(eq(schema.merchantCatalogItems.subcategoryId, row.id));
  return { ...row, productCount: n };
}
```

Add the subcategory routes at the top of `merchantCatalogRoutes`, before the existing `/v1/merchant/catalog/presign` route:

```ts
  app.get('/v1/merchant/catalog/subcategories', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const { category } = req.query as { category?: string };
    const where = category
      ? and(
          eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          eq(schema.merchantCatalogSubcategories.category, category),
        )
      : eq(schema.merchantCatalogSubcategories.merchantId, merchantId);

    const rows = await app.db
      .select()
      .from(schema.merchantCatalogSubcategories)
      .where(where)
      .orderBy(
        schema.merchantCatalogSubcategories.sortOrder,
        desc(schema.merchantCatalogSubcategories.createdAt),
      );

    return { items: await Promise.all(rows.map((row) => serializeSubcategory(app, row))) };
  });

  app.post(
    '/v1/merchant/catalog/subcategories',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogSubcategoryCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const body = req.body as z.infer<typeof MerchantCatalogSubcategoryCreateBody>;
      const [garmentType] = await app.db
        .select({ id: schema.garmentSubcategories.id })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.id, body.garmentSubcategoryId),
            eq(schema.garmentSubcategories.isActive, true),
          ),
        )
        .limit(1);
      if (!garmentType) throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');

      const [row] = await app.db
        .insert(schema.merchantCatalogSubcategories)
        .values({
          merchantId,
          category: body.category,
          name: body.name,
          garmentSubcategoryId: body.garmentSubcategoryId,
        })
        .returning();

      reply.code(201);
      return await serializeSubcategory(app, row);
    },
  );

  app.patch(
    '/v1/merchant/catalog/subcategories/:id',
    {
      preHandler: app.requireMerchant,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MerchantCatalogSubcategoryUpdateBody,
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof MerchantCatalogSubcategoryUpdateBody>;

      if (body.garmentSubcategoryId !== undefined) {
        const [garmentType] = await app.db
          .select({ id: schema.garmentSubcategories.id })
          .from(schema.garmentSubcategories)
          .where(
            and(
              eq(schema.garmentSubcategories.id, body.garmentSubcategoryId),
              eq(schema.garmentSubcategories.isActive, true),
            ),
          )
          .limit(1);
        if (!garmentType)
          throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
      }

      const [updated] = await app.db
        .update(schema.merchantCatalogSubcategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.garmentSubcategoryId !== undefined
            ? { garmentSubcategoryId: body.garmentSubcategoryId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, id),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .returning();

      if (!updated) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
      return await serializeSubcategory(app, updated);
    },
  );

  app.delete(
    '/v1/merchant/catalog/subcategories/:id',
    {
      preHandler: app.requireMerchant,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };

      // Select children before the cascading delete so their R2 objects can be
      // cleaned up — the DB FK cascade removes the rows but knows nothing about R2.
      const children = await app.db
        .select({
          r2Key: schema.merchantCatalogItems.r2Key,
          thumbnailKey: schema.merchantCatalogItems.thumbnailKey,
          flatSourceKey: schema.merchantCatalogItems.flatSourceKey,
        })
        .from(schema.merchantCatalogItems)
        .where(
          and(
            eq(schema.merchantCatalogItems.subcategoryId, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        );

      const [deleted] = await app.db
        .delete(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, id),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .returning();

      if (!deleted) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      await Promise.allSettled(
        children.flatMap((c) => [
          app.storage.deleteObject(c.r2Key),
          app.storage.deleteObject(c.thumbnailKey),
          ...(c.flatSourceKey ? [app.storage.deleteObject(c.flatSourceKey)] : []),
        ]),
      );

      reply.code(204);
      return reply.send();
    },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-subcategories.test.ts
```

Run: the above command.
Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-subcategories.test.ts
git commit -m "feat(api): add merchant catalog subcategory CRUD"
```

---

## Task 5: Update product CRUD for subcategoryId/prices; fix `sourceKind` bug

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`
- Modify: `apps/api/src/modules/admin/merchant-catalog.routes.ts`
- Modify: `apps/api/test/integration/merchant-catalog.test.ts`

- [ ] **Step 1: Update the existing test file's seed/assertion shape**

Open `apps/api/test/integration/merchant-catalog.test.ts`. Find the test `'presigns, uploads, creates, lists, and isolates merchant-private items'`. It currently POSTs `{ label, sku, gender, category, r2Key, thumbnailKey }` to `/v1/merchant/catalog`. Update the payload and assertions:

Find this block (the `POST /v1/merchant/catalog` call):
```ts
    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog',
      headers: authA,
      payload: {
        label: 'Red Saree',
        sku: 'SKU-1',
        gender: 'women',
        category: 'Sarees',
        r2Key: imageUpload.r2Key,
        thumbnailKey: thumbUpload.r2Key,
      },
    });
```

Replace with (needs a seeded subcategory first — add this immediately before the `const created = ...` line):
```ts
    const garmentType = await seedGarmentType(app, 'women');
    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: authA,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog',
      headers: authA,
      payload: {
        subcategoryId,
        label: 'Red Saree',
        sku: 'SKU-1',
        actualPrice: 2000,
        offerPrice: 1800,
        r2Key: imageUpload.r2Key,
        thumbnailKey: thumbUpload.r2Key,
      },
    });
```

Add the `seedGarmentType` helper near the top of the file, alongside `createMerchant`/`createUser`:
```ts
async function seedGarmentType(app: TestApp, genderSlug: string) {
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({ genderSlug, slug: `type-${randomUUID()}`, label: 'Type' })
    .returning();
  return row;
}
```

Find the response-shape assertion block:
```ts
    const item = created.json() as {
      id: string;
      merchantId: string;
      r2Key: string;
      thumbnailKey: string;
      sourceKind: 'uploaded' | 'imported';
    };
    expect(item.merchantId).toBe(merchantA.id);
    expect(item.sourceKind).toBe('uploaded');
```

Replace with:
```ts
    const item = created.json() as {
      id: string;
      merchantId: string;
      subcategoryId: string;
      actualPrice: number;
      offerPrice: number;
      r2Key: string;
      thumbnailKey: string;
      sourceKind: 'uploaded' | 'generated' | 'imported';
    };
    expect(item.merchantId).toBe(merchantA.id);
    expect(item.subcategoryId).toBe(subcategoryId);
    expect(item.actualPrice).toBe(2000);
    expect(item.offerPrice).toBe(1800);
    expect(item.sourceKind).toBe('uploaded');
```

Find the second test, `'imports linked studio jobs by copy, survives source-job deletion, and rejects invalid imports'`. The `POST /v1/merchant/catalog/import` assertions need updating for the "catalogue image for both roles" decision (Task 6 changes what `/import` copies). Find:
```ts
    expect(imported.json().sourceKind).toBe('imported');
```
(or similar — locate the actual assertion on the imported item's `r2Key`/`thumbnailKey` in this test and update per Step 3 below, once Task 6's copy-helper behavior is known.) Leave a placeholder comment for now:
```ts
    // NOTE: r2Key/thumbnailKey assertions for imported items are updated in Task 6,
    // which changes /import to copy the job's OUTPUT (not upperGarmentKey) into r2Key.
```
Do not skip fixing this — Task 6 Step 1 below gives the exact final assertion; apply it there, not here, since it depends on Task 6's route change landing first.

- [ ] **Step 2: Run the existing test to see the current failure shape**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog.test.ts
```

Run: the above command.
Expected: FAIL — `POST /v1/merchant/catalog` still expects `gender`/`category` and the DB insert still writes those (route not yet updated).

- [ ] **Step 3: Update the product routes and fix the `sourceKind` bug**

Edit `apps/api/src/modules/merchant/catalog.routes.ts`.

Replace the `serializeCatalogItem` function:
```ts
async function serializeCatalogItem(app: FastifyInstance, item: MerchantCatalogRow) {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((result) => result.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((result) => result.url)
      .catch(() => null),
  ]);

  return {
    ...item,
    actualPrice: Math.round(item.actualPricePaise / 100),
    offerPrice: Math.round(item.offerPricePaise / 100),
    imageUrl,
    thumbnailUrl,
  };
}
```

(Removed the stale computed `sourceKind: item.sourceJobId ? 'imported' : 'uploaded'` override — `...item` now carries the real stored `sourceKind` column. Added rupee conversion for the wire response.)

Replace the `POST /v1/merchant/catalog` handler body (inside the existing route registration):
```ts
  app.post(
    '/v1/merchant/catalog',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const body = req.body as z.infer<typeof MerchantCatalogCreateBody>;

      const [subcategory] = await app.db
        .select({ id: schema.merchantCatalogSubcategories.id })
        .from(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, body.subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      await Promise.all([
        assertMerchantUploadKey(app, merchantId, body.r2Key, 'image'),
        assertMerchantUploadKey(app, merchantId, body.thumbnailKey, 'thumbnail'),
      ]);

      const [item] = await app.db
        .insert(schema.merchantCatalogItems)
        .values({
          merchantId,
          subcategoryId: body.subcategoryId,
          label: body.label,
          sku: body.sku?.trim() || null,
          actualPricePaise: body.actualPrice * 100,
          offerPricePaise: body.offerPrice * 100,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
        })
        .returning();

      reply.code(201);
      return await serializeCatalogItem(app, item);
    },
  );
```

Replace the `PATCH /v1/merchant/catalog/:id` handler body:
```ts
  app.patch(
    '/v1/merchant/catalog/:id',
    {
      preHandler: app.requireMerchant,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MerchantCatalogUpdateBody,
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof MerchantCatalogUpdateBody>;

      if (body.subcategoryId !== undefined) {
        const [subcategory] = await app.db
          .select({ id: schema.merchantCatalogSubcategories.id })
          .from(schema.merchantCatalogSubcategories)
          .where(
            and(
              eq(schema.merchantCatalogSubcategories.id, body.subcategoryId),
              eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
            ),
          )
          .limit(1);
        if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
      }

      const [updated] = await app.db
        .update(schema.merchantCatalogItems)
        .set({
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sku !== undefined ? { sku: body.sku?.trim() || null } : {}),
          ...(body.actualPrice !== undefined ? { actualPricePaise: body.actualPrice * 100 } : {}),
          ...(body.offerPrice !== undefined ? { offerPricePaise: body.offerPrice * 100 } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.merchantCatalogItems.id, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        )
        .returning();

      if (!updated) throw new AppError('NOT_FOUND', 404, 'catalog item not found');
      return serializeCatalogItem(app, updated);
    },
  );
```

The `GET /v1/merchant/catalog` list route stays structurally the same (still filters by `merchantId` + optional `search` on `label`) — no change needed there since it doesn't reference `gender`/`category`. Optionally add a `subcategoryId` query filter — add it now since the UI's per-subcategory product grid needs it:

Find the `GET /v1/merchant/catalog` handler and replace its `where` construction:
```ts
  app.get('/v1/merchant/catalog', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const { search = '', subcategoryId } = req.query as { search?: string; subcategoryId?: string };
    const conditions = [eq(schema.merchantCatalogItems.merchantId, merchantId)];
    if (search.trim()) conditions.push(ilike(schema.merchantCatalogItems.label, `%${search.trim()}%`));
    if (subcategoryId) conditions.push(eq(schema.merchantCatalogItems.subcategoryId, subcategoryId));

    const items = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(and(...conditions))
      .orderBy(schema.merchantCatalogItems.sortOrder, desc(schema.merchantCatalogItems.createdAt));

    return { items: await Promise.all(items.map((item) => serializeCatalogItem(app, item))) };
  });
```

- [ ] **Step 4: Fix the same `sourceKind` bug in the admin route**

Edit `apps/api/src/modules/admin/merchant-catalog.routes.ts`. Replace `serializeCatalogItem`:

```ts
async function serializeCatalogItem(app: FastifyInstance, item: MerchantCatalogRow) {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((result) => result.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((result) => result.url)
      .catch(() => null),
  ]);

  return { ...item, imageUrl, thumbnailUrl };
}
```

(Removed the stale computed `sourceKind` override here too — same bug, same fix.)

- [ ] **Step 5: Run the test**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog.test.ts
```

Run: the above command.
Expected: the first test (`presigns, uploads, creates, lists, and isolates`) passes. The second test (`imports linked studio jobs`) still fails — that's expected, it's fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/src/modules/admin/merchant-catalog.routes.ts apps/api/test/integration/merchant-catalog.test.ts
git commit -m "feat(api): wire merchant catalog products to subcategories and prices; fix sourceKind serialization bug"
```

---

## Task 6: Fix `/import` to copy job output (not source garment) into `r2Key`; add shared copy helper; fix kiosk serializer

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`
- Modify: `apps/api/src/modules/kiosk/catalog.routes.ts`
- Modify: `apps/api/test/integration/merchant-catalog.test.ts`

- [ ] **Step 1: Update the `/import` test assertions**

In `apps/api/test/integration/merchant-catalog.test.ts`, find the second test (`'imports linked studio jobs by copy...'`). Locate where it builds the seeded job — it uses `createCompletedJob(app, linkedUser.id, { catalogueId, garmentBody, resultBody, thumbnailBody })`, which (per the existing helper already in this file) writes `garmentBody` under `studio/{jobId}/garment.jpg` (stored as `jobInputs.upperGarmentKey`) and `resultBody` under `keys.output(jobId)` (stored as `jobOutputs.resultKey`). Find the assertion following the `POST /v1/merchant/catalog/import` call — it currently checks the imported item's copied bytes came from the garment. Update the fetched-content assertion to expect the **result** bytes, not the garment bytes:

Find (locate the actual current line — it downloads the imported item's `imageUrl` and compares body bytes):
```ts
    // (existing assertion comparing downloaded bytes to garmentBody)
```
Change the comparison target from `garmentBody` to `resultBody` — the imported item's `r2Key` (and therefore its `imageUrl`) must now serve the same bytes as the job's completed output, since both display and try-on now use the catalogue (model-wearing) image, never the flat source garment.

If the test does not already fetch and compare bytes (many of these tests only assert status/shape), instead add this assertion right after the successful import response is captured:
```ts
    const importedItem = imported.json() as { id: string; r2Key: string; thumbnailKey: string };
    const [importedRow] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, importedItem.id));
    const copiedBytes = await app.storage.getObject(importedRow.r2Key);
    expect(Buffer.from(copiedBytes).equals(resultBody)).toBe(true);
```
(Adjust variable names to whatever the test's existing scope actually calls the import response and the seeded `resultBody` — read the file's current content at this point in the plan's execution and match its real local names; the assertion's *intent* — imported `r2Key` bytes equal the job's *output* bytes, not the garment bytes — is what must hold.)

- [ ] **Step 2: Run to verify the current (soon-to-be-fixed) behavior fails the new assertion**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog.test.ts
```

Run: the above command.
Expected: FAIL on the new byte-equality assertion — `/import` still copies `job.upperGarmentKey` (garment bytes), not the output.

- [ ] **Step 3: Add the shared copy helper and rewrite `/import` to use it**

Edit `apps/api/src/modules/merchant/catalog.routes.ts`. Add this function after `assertMerchantUploadKey` and before `catalogueLabel`:

```ts
/**
 * Copies a completed job's OUTPUT (never the source garment) into a fresh
 * merchant_catalog_items row. Used by both /import (Path A — merchant hand-picks
 * an existing studio result) and the generate-completion flow (Path B — merchant
 * uploaded a flat garment and the studio pipeline generated a catalogue image).
 * The output image serves BOTH roles: kiosk display AND the ComfyUI try-on input
 * for later virtual try-on jobs — there is no separate "flat garment" stored as
 * r2Key; that would defeat guaranteeing every catalogue item is try-on-suitable.
 */
async function copyJobOutputIntoProduct(
  app: FastifyInstance,
  params: {
    merchantId: string;
    subcategoryId: string;
    job: { id: string; catalogueId: string | null };
    resultKey: string;
    thumbnailKey: string | null;
    sourceKind: 'imported' | 'generated';
    flatSourceKey?: string;
    label?: string;
  },
): Promise<MerchantCatalogRow> {
  const sourceThumbKey = params.thumbnailKey ?? params.resultKey;
  const [imageHead, thumbHead, imageBody, thumbBody] = await Promise.all([
    app.storage.headObject(params.resultKey),
    app.storage.headObject(sourceThumbKey),
    app.storage.getObject(params.resultKey),
    app.storage.getObject(sourceThumbKey),
  ]).catch(() => {
    throw new AppError('BAD_UPLOAD', 400, 'source assets are missing');
  });

  const assetId = randomUUID();
  const imageKey = keys.merchantCatalogItem(params.merchantId, assetId);
  const thumbKey = keys.merchantCatalogItemThumb(params.merchantId, assetId);
  await Promise.all([
    app.storage.putObject(imageKey, imageBody, imageHead.contentType ?? 'image/jpeg'),
    app.storage.putObject(thumbKey, thumbBody, thumbHead.contentType ?? 'image/jpeg'),
  ]);

  try {
    const [item] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        id: assetId,
        merchantId: params.merchantId,
        subcategoryId: params.subcategoryId,
        label: params.label ?? catalogueLabel(params.job.catalogueId, params.job.id),
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: imageKey,
        thumbnailKey: thumbKey,
        sourceJobId: params.job.id,
        sourceKind: params.sourceKind,
        flatSourceKey: params.flatSourceKey ?? null,
      })
      .returning();
    return item;
  } catch (err) {
    await Promise.allSettled([
      app.storage.deleteObject(imageKey),
      app.storage.deleteObject(thumbKey),
    ]);
    if ((err as { code?: string }).code === '23505') {
      throw new AppError('CONFLICT', 409, 'job already imported');
    }
    throw err;
  }
}
```

Note: `actualPricePaise`/`offerPricePaise` default to `0` on creation via this helper — both import and generate produce a *draft* product the merchant still must price via a follow-up `PATCH`, matching the UI's existing "fill in SKU/price after generation" flow already built.

Now rewrite the `/import` route to require a `subcategoryId` (it previously had none — that's a gap the new subcategory model requires closing) and to use the shared helper. Replace the whole `POST /v1/merchant/catalog/import` handler:

```ts
  app.post(
    '/v1/merchant/catalog/import',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogImportBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobId, subcategoryId } = req.body as z.infer<typeof MerchantCatalogImportBody>;

      const [subcategory] = await app.db
        .select({ id: schema.merchantCatalogSubcategories.id })
        .from(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          catalogueId: schema.jobs.catalogueId,
          status: schema.jobs.status,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.userId !== client.userId) {
        throw new AppError('FORBIDDEN', 403, 'job does not belong to the linked studio user');
      }
      if (job.status !== 'COMPLETED') {
        throw new AppError('CONFLICT', 409, 'only completed jobs can be imported');
      }
      if (!job.resultKey) throw new AppError('BAD_UPLOAD', 400, 'job has no output');

      const item = await copyJobOutputIntoProduct(app, {
        merchantId,
        subcategoryId,
        job,
        resultKey: job.resultKey,
        thumbnailKey: job.thumbnailKey,
        sourceKind: 'imported',
      });

      reply.code(201);
      return await serializeCatalogItem(app, item);
    },
  );
```

Add `subcategoryId` to `MerchantCatalogImportBody` in `packages/types/src/widget.ts` (this was missed in Task 2 — add it now):
```ts
export const MerchantCatalogImportBody = z.object({
  jobId: z.string().uuid(),
  subcategoryId: z.string().uuid(),
});
export type MerchantCatalogImportBody = z.infer<typeof MerchantCatalogImportBody>;
```
Rebuild types after this addition: `cd packages/types && pnpm build`.

Update the test's `POST /v1/merchant/catalog/import` payload to include a seeded `subcategoryId` (mirror the pattern from Task 5 Step 1 — seed a garment type, create a subcategory, pass its id) if the test doesn't already do so.

- [ ] **Step 4: Fix the kiosk catalog serializer**

The kiosk gender/category navigation still needs those fields — they now live on `merchant_catalog_subcategories`, not `merchant_catalog_items`. Edit `apps/api/src/modules/kiosk/catalog.routes.ts`:

```ts
import { schema } from '@tryme/db';
import type { KioskCatalogListResponse } from '@tryme/types';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

type MerchantCatalogRow = typeof schema.merchantCatalogItems.$inferSelect;
type SubcategoryRow = Pick<
  typeof schema.merchantCatalogSubcategories.$inferSelect,
  'category' | 'name'
>;

async function serializeCatalogItem(
  app: FastifyInstance,
  item: MerchantCatalogRow,
  subcategory: SubcategoryRow,
) {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 86_400)
      .then((result) => result.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 86_400)
      .then((result) => result.url)
      .catch(() => null),
  ]);

  return {
    id: item.id,
    label: item.label,
    sku: item.sku,
    gender: subcategory.category as KioskCatalogListResponse['items'][number]['gender'],
    category: subcategory.name,
    imageUrl,
    thumbnailUrl,
  } satisfies KioskCatalogListResponse['items'][number];
}

export async function kioskCatalogRoutes(app: FastifyInstance) {
  app.get('/v1/kiosk/catalog', { preHandler: app.requireKioskDevice }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const rows = await app.db
      .select({
        item: schema.merchantCatalogItems,
        subcategory: {
          category: schema.merchantCatalogSubcategories.category,
          name: schema.merchantCatalogSubcategories.name,
        },
      })
      .from(schema.merchantCatalogItems)
      .innerJoin(
        schema.merchantCatalogSubcategories,
        eq(schema.merchantCatalogItems.subcategoryId, schema.merchantCatalogSubcategories.id),
      )
      .where(
        and(
          eq(schema.merchantCatalogItems.merchantId, merchantId),
          eq(schema.merchantCatalogItems.isActive, true),
          eq(schema.merchantCatalogItems.moderationStatus, 'approved'),
        ),
      )
      .orderBy(
        schema.merchantCatalogItems.sortOrder,
        desc(schema.merchantCatalogItems.createdAt),
      );

    return {
      items: await Promise.all(
        rows.map((row) => serializeCatalogItem(app, row.item, row.subcategory)),
      ),
    };
  });
}
```

Note: `KioskCatalogItem.gender` is typed via `MerchantCatalogGender` (the old singular `boy | girl` enum) in `packages/types/src/widget.ts` — `subcategory.category` is now the plural `men | women | boys | girls`. This is exactly the gender-vocabulary inconsistency flagged in Context. Fix it now while touching this file: in `packages/types/src/widget.ts`, change `KioskCatalogItem`'s `gender` field:
```ts
export const KioskCatalogItem = z.object({
  id: z.string().uuid(),
  label: z.string(),
  sku: z.string().nullable(),
  gender: MerchantCatalogCategory.nullable(),
  category: z.string().nullable(),
  imageUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
});
```
(References `MerchantCatalogCategory`, the plural enum added in Task 2 Step 2 — must appear *after* that definition in the file, or be moved above; place `KioskCatalogItem` after `MerchantCatalogCategory`'s definition in the file, reordering if necessary.) Also update the same field on `MerchantCatalogItem` if it still references the old enum anywhere (it doesn't, per Task 2 Step 1 — `MerchantCatalogItem` no longer has a `gender` field at all, confirmed).

Rebuild: `cd packages/types && pnpm build`.

- [ ] **Step 5: Run the full merchant-catalog test file**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog.test.ts
```

Run: the above command.
Expected: all tests in the file pass.

- [ ] **Step 6: Typecheck the whole API package to catch anything else touching the changed columns**

```bash
cd apps/api && pnpm typecheck
```

Run: the above command.
Expected: exits 0. If it doesn't, the error output names the file and line — fix it there before proceeding (do not skip; a compile error here means some other file besides the ones already touched reads `merchant_catalog_items.gender`/`.category` and was missed).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/src/modules/kiosk/catalog.routes.ts apps/api/test/integration/merchant-catalog.test.ts packages/types/src/widget.ts
git commit -m "fix(api): import copies job output not source garment; kiosk catalog reads gender/category via subcategory join"
```

---

## Task 7: Admin config — merchant catalogue defaults (face/background per category + aspect ratio)

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Locate the existing resolution-config card and its load/save wiring**

Read the surrounding context of the `maxOutputPx` state/effect/save function in `apps/admin-web/src/pages/SettingsPage.tsx` (already located: lines ~370-415 for state/load/save, ~1029-1045 for the input JSX) to mirror its exact pattern.

- [ ] **Step 2: Add state**

Add near the existing `const [maxOutputPx, setMaxOutputPx] = useState(2048);` line:

```ts
  const [merchantCatalogDefaults, setMerchantCatalogDefaults] = useState<
    Record<string, { faceId: string; backgroundId: string }>
  >({});
  const [merchantCatalogAspectRatio, setMerchantCatalogAspectRatio] = useState('2:3');
  const [modelFacesList, setModelFacesList] = useState<
    Array<{ id: string; label: string; gender: string }>
  >([]);
  const [modelBackgroundsList, setModelBackgroundsList] = useState<
    Array<{ id: string; label: string }>
  >([]);
```

- [ ] **Step 3: Extend the config load effect**

Find:
```ts
  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      maxOutputPx?: number;
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
      })
      .catch(() => toast({ kind: 'error', title: 'Failed to load system config' }))
      .finally(() => setSysLoading(false));
  }, [toast]);
```

Replace with:
```ts
  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      maxOutputPx?: number;
      merchantCatalogDefaults?: Record<string, { faceId: string; backgroundId: string }>;
      merchantCatalogAspectRatio?: string;
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
      })
      .catch(() => toast({ kind: 'error', title: 'Failed to load system config' }))
      .finally(() => setSysLoading(false));
  }, [toast]);

  useEffect(() => {
    apiFetch<{ items: Array<{ id: string; label: string; gender: string }> }>(
      '/admin/assets/model-faces',
    )
      .then((res) => setModelFacesList(res.items))
      .catch(() => {});
    apiFetch<{ items: Array<{ id: string; label: string }> }>('/admin/assets/model-backgrounds')
      .then((res) => setModelBackgroundsList(res.items))
      .catch(() => {});
  }, []);
```

Before writing this step's final form, verify the real admin list endpoints and response shape for model faces/backgrounds:

```bash
grep -n "app.get('/admin/assets/model-faces'\|app.get('/admin/assets/model-backgrounds'\|app.get('/admin/assets/faces'\|app.get('/admin/assets/backgrounds'" apps/api/src/modules/admin/models.routes.ts
```

Run: the above command.
Expected: shows the actual route paths and their handler's return shape (e.g. does it return `{ items: [...] }` or a bare array?). **Adjust the two `apiFetch<...>` calls above to match whatever this command reveals — do not assume the path/shape guessed here is exactly right; confirm before writing the final code.**

- [ ] **Step 4: Extend the save function**

Find:
```ts
  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({ resolutions, maxOutputPx }),
      });
      toast({ title: 'System config saved' });
    } catch {
      toast({ kind: 'error', title: 'Failed to save system config' });
    } finally {
      setSysSaving(false);
    }
  };
```

Replace with:
```ts
  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          resolutions,
          maxOutputPx,
          merchantCatalogDefaults,
          merchantCatalogAspectRatio,
        }),
      });
      toast({ title: 'System config saved' });
    } catch {
      toast({ kind: 'error', title: 'Failed to save system config' });
    } finally {
      setSysSaving(false);
    }
  };
```

- [ ] **Step 5: Add the card JSX**

Find the existing Max Output Resolution card (around line 1029, inside whatever `<Card>`-equivalent wrapper the resolution section uses — read that block's exact surrounding JSX structure first to match indentation/wrapper components exactly). Add a new card directly after it:

```tsx
              <div className="card" style={{ padding: 20, marginTop: 16 }}>
                <h3 style={{ margin: '0 0 4px' }}>Merchant Catalogue Defaults</h3>
                <p className="sub" style={{ margin: '0 0 16px' }}>
                  Fixed model/background used when a merchant generates a catalogue image from a
                  flat garment photo — guarantees every generated image is try-on-suitable.
                </p>
                {(['men', 'women', 'boys', 'girls'] as const).map((cat) => (
                  <div
                    key={cat}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '80px 1fr 1fr',
                      gap: 12,
                      alignItems: 'center',
                      marginBottom: 10,
                    }}
                  >
                    <label style={{ textTransform: 'capitalize' }}>{cat}</label>
                    <select
                      className="select"
                      value={merchantCatalogDefaults[cat]?.faceId ?? ''}
                      onChange={(e) =>
                        setMerchantCatalogDefaults((prev) => ({
                          ...prev,
                          [cat]: { ...prev[cat], faceId: e.target.value, backgroundId: prev[cat]?.backgroundId ?? '' },
                        }))
                      }
                    >
                      <option value="">— select face —</option>
                      {modelFacesList
                        .filter((f) => f.gender === cat)
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                    </select>
                    <select
                      className="select"
                      value={merchantCatalogDefaults[cat]?.backgroundId ?? ''}
                      onChange={(e) =>
                        setMerchantCatalogDefaults((prev) => ({
                          ...prev,
                          [cat]: { faceId: prev[cat]?.faceId ?? '', backgroundId: e.target.value },
                        }))
                      }
                    >
                      <option value="">— select background —</option>
                      {modelBackgroundsList.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div className="field" style={{ maxWidth: 200 }}>
                  <label>Aspect ratio</label>
                  <select
                    className="select"
                    value={merchantCatalogAspectRatio}
                    onChange={(e) => setMerchantCatalogAspectRatio(e.target.value)}
                  >
                    <option value="1:1">1:1</option>
                    <option value="2:3">2:3</option>
                    <option value="3:4">3:4</option>
                    <option value="4:5">4:5</option>
                  </select>
                </div>
              </div>
```

Note: this card shares the existing `saveSysConfig`/save button that already exists for the resolution section — do not add a separate save button; confirm this section sits inside the same save-button scope as `maxOutputPx` (it does, per the existing single `saveSysConfig` handler covering the whole system-config block).

- [ ] **Step 6: Manual verification**

```bash
cd apps/admin-web && pnpm build
```

Run: the above command.
Expected: exits 0, no TypeScript errors.

Start the admin dev server and the API, log in as a super admin, navigate to Settings, confirm the new card renders with 4 rows + aspect ratio select, pick values, save, reload the page, confirm the picked values persist (round-trip through `GET /admin/config`).

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add merchant catalogue generation defaults settings card"
```

---

## Task 8: Admin config — default pose per garment type

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts`
- Modify: `apps/admin-web/src/types.ts`
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`

- [ ] **Step 1: The API route already supports this via the generic PATCH — verify**

`app.patch('/admin/assets/garment-types/:id', ...)` in `apps/api/src/modules/admin/subcategories.routes.ts` already does `.set({ ...body, updatedAt: new Date() })` with `body: PatchGarmentTypeBody` — since Task 2 Step 6 already added `defaultPoseId` to `PatchGarmentTypeBody`, this route needs **no code change**, only confirm it by grep:

```bash
grep -n "PatchGarmentTypeBody" apps/api/src/modules/admin/subcategories.routes.ts
```

Run: the above command.
Expected: shows the import and the `.set({ ...body, ... })` spread pattern already read earlier in this plan — confirms `defaultPoseId` flows through automatically once the zod schema (Task 2) allows it.

- [ ] **Step 2: Add `defaultPoseId` to the admin-web `GarmentType` interface**

Edit `apps/admin-web/src/types.ts`. Find the `GarmentType` interface (around line 35, confirmed earlier) and add the field:

```ts
export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  // ...(existing fields, do not remove any)
  defaultPoseId: string | null;
}
```

(Read the file's current full `GarmentType` interface first and add only the one new field, preserving every existing field exactly as-is.)

- [ ] **Step 3: Add the "Default pose" selector to `PoseConfigsPanel`**

Edit `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`. This subview (`PoseConfigsPanel`, rendered when `subView.kind === 'configs'`) already loads every active pose for the garment type's gender into its `items` prop — exactly the picker options needed. Add local state and a save handler for this one field.

In the `GarmentTypesTab` component, add state near the other subcat-editing state:
```ts
  const [savingDefaultPose, setSavingDefaultPose] = useState(false);
```

Add a handler function near `saveConfig`:
```ts
  const saveDefaultPose = async (garmentTypeId: string, poseAssetId: string | null) => {
    setSavingDefaultPose(true);
    try {
      await apiFetch(`/admin/assets/garment-types/${garmentTypeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ defaultPoseId: poseAssetId }),
      });
      setGarmentTypes((prev) =>
        prev.map((s) => (s.id === garmentTypeId ? { ...s, defaultPoseId: poseAssetId } : s)),
      );
      toast({ title: 'Default pose updated' });
    } catch {
      toast({ kind: 'error', title: 'Failed to update default pose' });
    } finally {
      setSavingDefaultPose(false);
    }
  };
```

Pass `sub` (already available — it's `subView.sub`, a `GarmentType`) and the new handler into `PoseConfigsPanel`'s props. Find the `<PoseConfigsPanel ... />` invocation:
```tsx
        <PoseConfigsPanel
          sub={subView.sub}
          items={poseConfigs}
          loading={configsLoading}
          savingId={savingConfigId}
          workflows={workflows}
          storagePublicUrl={storagePublicUrl}
          onBack={() => setSubView({ kind: 'list' })}
          onSave={saveConfig}
          onToggleActive={togglePoseActive}
        />
```
Add two props:
```tsx
        <PoseConfigsPanel
          sub={subView.sub}
          items={poseConfigs}
          loading={configsLoading}
          savingId={savingConfigId}
          workflows={workflows}
          storagePublicUrl={storagePublicUrl}
          onBack={() => setSubView({ kind: 'list' })}
          onSave={saveConfig}
          onToggleActive={togglePoseActive}
          onSaveDefaultPose={saveDefaultPose}
          savingDefaultPose={savingDefaultPose}
        />
```

Update `PoseConfigsPanelProps` and the function signature to accept the two new props:
```ts
interface PoseConfigsPanelProps {
  sub: GarmentType;
  items: PoseGarmentConfig[];
  loading: boolean;
  savingId: string | null;
  workflows: WorkflowOption[];
  storagePublicUrl: string | null;
  onBack: () => void;
  onSave: (
    garmentTypeId: string,
    poseAssetId: string,
    patch: {
      workflowTemplateId: string | null;
      promptGarmentPhase: string | null;
      promptFacePhase: string | null;
    },
  ) => Promise<void>;
  onToggleActive: (poseAssetId: string, isActive: boolean) => Promise<void>;
  onSaveDefaultPose: (garmentTypeId: string, poseAssetId: string | null) => Promise<void>;
  savingDefaultPose: boolean;
}

function PoseConfigsPanel({
  sub,
  items,
  loading,
  savingId,
  workflows,
  storagePublicUrl,
  onBack,
  onSave,
  onToggleActive,
  onSaveDefaultPose,
  savingDefaultPose,
}: PoseConfigsPanelProps) {
```

Add the selector JSX right after the bulk-action bar's closing `</div>` and before the pose grid `<div style={{ display: 'grid', ...`:

```tsx
      <div
        className="field"
        style={{ maxWidth: 360, margin: '12px 0' }}
      >
        <label>Default pose (merchant catalogue generation)</label>
        <select
          className="select"
          value={sub.defaultPoseId ?? ''}
          disabled={savingDefaultPose}
          onChange={(e) => void onSaveDefaultPose(sub.id, e.target.value || null)}
        >
          <option value="">— none (generation disabled for this type) —</option>
          {items
            .filter((i) => i.isActive)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.displayName ?? i.label}
              </option>
            ))}
        </select>
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
          Used when a merchant uploads a flat garment for this type — the pose (and its
          workflow) is fixed so every generated image is try-on-suitable.
        </span>
      </div>
```

- [ ] **Step 4: Build and manually verify**

```bash
cd apps/admin-web && pnpm build
```

Run: the above command.
Expected: exits 0.

Start admin-web + api dev servers, open a garment type's pose-configs view, pick a default pose, confirm it saves and persists on reload.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin): add default-pose selector for merchant catalogue generation"
```

---

## Task 9: Single flat-image generation (Path B)

**Files:**
- Create: `apps/api/src/modules/merchant/create-job.ts`
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`
- Create: `apps/api/test/integration/merchant-catalog-generate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/merchant-catalog-generate.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      websiteUrl: 'https://example.com',
      companySize: '1-10',
      purpose: 'merchant tests',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: 0 });
  return { merchant, userId: merchantUser.id };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function grantUserCredits(app: TestApp, userId: string, amount: number) {
  await app.db
    .insert(schema.userCredits)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
}

async function seedWorkflowTemplate(app: TestApp) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `regular-wf-${randomUUID()}`,
      label: 'Regular workflow',
      jsonContent: {},
      faceNodeId: '1',
      poseNodeId: '1',
      bgNodeId: '1',
      upperNodeIds: ['2'],
      facePhasePromptNode: '1',
      garmentPhasePromptNode: '1',
    })
    .returning();
  return wf;
}

async function seedPose(app: TestApp, genderSlug: string, workflowTemplateId: string) {
  const [pose] = await app.db
    .insert(schema.modelPoseAssets)
    .values({
      label: `Pose ${randomUUID()}`,
      r2Key: 'poses/seed/pose.jpg',
      thumbnailKey: 'poses/seed/pose.thumb.jpg',
      genderSlug,
      workflowTemplateId,
    })
    .returning();
  return pose;
}

async function seedFace(app: TestApp, gender: string) {
  const [face] = await app.db
    .insert(schema.modelFaces)
    .values({
      gender,
      label: `Face ${randomUUID()}`,
      r2Key: 'faces/seed/face.jpg',
      thumbnailKey: 'faces/seed/face.thumb.jpg',
    })
    .returning();
  return face;
}

async function seedBackground(app: TestApp) {
  const [bg] = await app.db
    .insert(schema.modelBackgrounds)
    .values({
      label: `Background ${randomUUID()}`,
      r2Key: 'backgrounds/seed/bg.jpg',
      thumbnailKey: 'backgrounds/seed/bg.thumb.jpg',
    })
    .returning();
  return bg;
}

async function seedGarmentType(
  app: TestApp,
  genderSlug: string,
  defaultPoseId: string | null,
) {
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({ genderSlug, slug: `type-${randomUUID()}`, label: 'Type', defaultPoseId })
    .returning();
  return row;
}

describe('merchant catalog generate (single, Path B)', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  beforeEach(async () => {
    await app.redis.del('jobs:normal');
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  async function seedFullDefaults(genderSlug: string) {
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, genderSlug, wf.id);
    const face = await seedFace(app, genderSlug);
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, genderSlug, pose.id);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { [genderSlug]: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );
    return { garmentType, pose, face, bg, workflowTemplate: wf };
  }

  it('creates a userId-owned studio job (not merchantId-owned) with the admin-fixed inputs, and deducts user credits', async () => {
    const { merchant, userId } = await createMerchant(app, 'gen-happy@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType } = await seedFullDefaults('men');

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    expect(presign.statusCode).toBe(200);
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });
    expect(put.ok).toBe(true);

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBe(userId);
    expect(job.merchantId).toBeNull();
    expect(job.status).toBe('QUEUED');

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.faceId).toBeTruthy();
    expect(inputs.backgroundId).toBeTruthy();
    expect(inputs.poseId).toBeTruthy();
    expect(inputs.garmentTypeId).toBe(garmentType.id);
    expect(inputs.upperGarmentKey).toBe(flatImageKey);
    const params = inputs.params as Record<string, unknown>;
    expect(params.kind).toBe('merchant_catalog');
    expect(params.subcategoryId).toBe(subcategoryId);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBeLessThan(100);

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);

    void merchant; // referenced only for setup symmetry with other tests in this file
  });

  it('rejects with 400 when the garment type has no default pose configured', async () => {
    const { userId } = await createMerchant(app, 'gen-nopose@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const garmentType = await seedGarmentType(app, 'men', null);

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
  });

  it('rejects with 400 when no merchantCatalogDefaults are configured for the category', async () => {
    const { userId } = await createMerchant(app, 'gen-nodefaults@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, 'men', wf.id);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    // deliberately do not set config:system

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
  });

  it('marks a completed job COMPLETED via the status poll and creates a product on client confirmation', async () => {
    const { userId } = await createMerchant(app, 'gen-complete@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType } = await seedFullDefaults('women');

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    const { jobId } = generate.json() as { jobId: string };

    // Simulate the dispatcher completing the job (dispatcher is not running in
    // this integration test — write the terminal state directly, exactly as
    // simple-tryon.test.ts / regenerate.test.ts already do for the same reason).
    const resultKey = `outputs/${jobId}/result.png`;
    await app.storage.putObject(resultKey, Buffer.from('generated-catalogue-image'), 'image/png');
    await app.db.update(schema.jobs).set({ status: 'COMPLETED' }).where(eq(schema.jobs.id, jobId));
    await app.db.insert(schema.jobOutputs).values({ jobId, resultKey });

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/catalog/generate/${jobId}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as { status: string; resultUrl: string | null };
    expect(statusBody.status).toBe('COMPLETED');
    expect(statusBody.resultUrl).toBeTruthy();

    const imported = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/import',
      headers: auth,
      payload: { jobId, subcategoryId },
    });
    expect(imported.statusCode).toBe(201);
    const product = imported.json() as { sourceKind: string; sourceJobId: string };
    expect(product.sourceKind).toBe('imported');
    expect(product.sourceJobId).toBe(jobId);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export $(grep -E "^POSTGRES_(USER|PASSWORD|DB|PORT)=" ../../.env | xargs) 2>/dev/null
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts
```

Run: the above command.
Expected: FAIL — `POST /v1/merchant/catalog/generate` and `GET .../generate/:jobId` don't exist yet (404), and `kind: 'flat'` presign isn't accepted yet by the route handler logic even though the zod enum was widened in Task 2 (the route's switch statement doesn't handle it).

- [ ] **Step 3: Implement `createMerchantCatalogJob`**

Create `apps/api/src/modules/merchant/create-job.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import {
  ASPECT_DIMENSIONS,
  type Resolution,
  resolutionFromDims,
} from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { atomicDeduct } from '../credits/ledger.js';
import { getMaxOutputPx, getResolutionCreditCost } from '../../lib/resolution-config.js';

const CONFIG_KEY = 'config:system';

interface MerchantCatalogDefaults {
  merchantCatalogDefaults?: Partial<
    Record<'men' | 'women' | 'boys' | 'girls', { faceId: string; backgroundId: string }>
  >;
  merchantCatalogAspectRatio?: string;
}

/**
 * Builds an ordinary `jobs.userId`-owned studio job from admin-fixed inputs —
 * NOT a merchantId-owned job, NOT a new pipeline. This is the constrained
 * "Path B" generate: the merchant supplies only a flat garment image; face,
 * background, and pose are all server-resolved so every output is guaranteed
 * try-on-suitable. Deliberately NOT a refactor of jobs/create.ts::createJob
 * (that function is long, security-load-bearing — see its S1/S6/H2 comments —
 * and handles multi-pose/lower/shoe/Amazon cases this flow never needs).
 */
export async function createMerchantCatalogJob(
  app: FastifyInstance,
  params: { userId: string; garmentSubcategoryId: string; category: string; flatImageKey: string; subcategoryId: string },
): Promise<{ jobId: string }> {
  const [garmentType] = await app.db
    .select({ defaultPoseId: schema.garmentSubcategories.defaultPoseId })
    .from(schema.garmentSubcategories)
    .where(
      and(
        eq(schema.garmentSubcategories.id, params.garmentSubcategoryId),
        eq(schema.garmentSubcategories.isActive, true),
      ),
    )
    .limit(1);
  if (!garmentType) throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  if (!garmentType.defaultPoseId) {
    throw new AppError(
      'VALIDATION',
      400,
      'admin has not configured a default pose for this garment type',
    );
  }

  const raw = await app.redis.get(CONFIG_KEY);
  const cfg = (raw ? JSON.parse(raw) : {}) as MerchantCatalogDefaults;
  const categoryDefaults =
    cfg.merchantCatalogDefaults?.[params.category as 'men' | 'women' | 'boys' | 'girls'];
  if (!categoryDefaults?.faceId || !categoryDefaults?.backgroundId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured default face/background for category "${params.category}"`,
    );
  }
  const aspectRatio = cfg.merchantCatalogAspectRatio ?? '2:3';

  const [face] = await app.db
    .select({ id: schema.modelFaces.id })
    .from(schema.modelFaces)
    .where(
      and(eq(schema.modelFaces.id, categoryDefaults.faceId), eq(schema.modelFaces.isActive, true)),
    );
  const [background] = await app.db
    .select({ id: schema.modelBackgrounds.id })
    .from(schema.modelBackgrounds)
    .where(
      and(
        eq(schema.modelBackgrounds.id, categoryDefaults.backgroundId),
        eq(schema.modelBackgrounds.isActive, true),
      ),
    );
  const [pose] = await app.db
    .select({ id: schema.modelPoseAssets.id })
    .from(schema.modelPoseAssets)
    .where(
      and(
        eq(schema.modelPoseAssets.id, garmentType.defaultPoseId),
        eq(schema.modelPoseAssets.isActive, true),
      ),
    );
  if (!face) throw new AppError('BAD_CATALOG', 400, 'configured default face not found or inactive');
  if (!background)
    throw new AppError('BAD_CATALOG', 400, 'configured default background not found or inactive');
  if (!pose) throw new AppError('BAD_CATALOG', 400, 'configured default pose not found or inactive');

  const requestedDims = ASPECT_DIMENSIONS[aspectRatio] ?? ASPECT_DIMENSIONS['2:3'];
  const maxOutputPx = await getMaxOutputPx(app);
  const requestedLongEdge = Math.max(requestedDims.width, requestedDims.height);
  const outputDims =
    requestedLongEdge > maxOutputPx
      ? requestedDims.width >= requestedDims.height
        ? {
            width: maxOutputPx,
            height: Math.round(maxOutputPx * (requestedDims.height / requestedDims.width)),
          }
        : {
            width: Math.round(maxOutputPx * (requestedDims.width / requestedDims.height)),
            height: maxOutputPx,
          }
      : requestedDims;
  const resolution: Resolution = resolutionFromDims(outputDims.width, outputDims.height);
  const cost = await getResolutionCreditCost(app, resolution);

  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: 'QUEUED',
      // Merchant-generated catalogue images are never watermarked, regardless of
      // the user's plan tier — merchants are paying customers of a distinct product.
      watermark: false,
      queueStream: 'normal',
      creditsCharged: cost,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
      },
    });
  });

  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    params.userId,
  );

  return { jobId };
}
```

- [ ] **Step 4: Add the presign `flat` kind, generate route, and status-poll route**

Edit `apps/api/src/modules/merchant/catalog.routes.ts`. Add the import at the top:

```ts
import { createMerchantCatalogJob } from './create-job.js';
```

Find the `/v1/merchant/catalog/presign` handler and update the key-selection switch:

```ts
      const key =
        kind === 'thumbnail'
          ? keys.merchantCatalogItemThumb(merchantId, assetId)
          : kind === 'flat'
            ? keys.merchantCatalogFlatGarment(merchantId, assetId)
            : keys.merchantCatalogItem(merchantId, assetId);
```

Add the generate routes at the end of `merchantCatalogRoutes`, just before the closing `}` of the function (after the `/import` route):

```ts
  app.post(
    '/v1/merchant/catalog/generate',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { subcategoryId, flatImageKey } = req.body as z.infer<
        typeof MerchantCatalogGenerateBody
      >;

      const [row] = await app.db
        .select({
          userId: schema.merchants.userId,
          category: schema.merchantCatalogSubcategories.category,
          garmentSubcategoryId: schema.merchantCatalogSubcategories.garmentSubcategoryId,
        })
        .from(schema.merchantCatalogSubcategories)
        .innerJoin(schema.merchants, eq(schema.merchants.id, schema.merchantCatalogSubcategories.merchantId))
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      await assertMerchantUploadKey(app, merchantId, flatImageKey, 'flat garment');

      const { jobId } = await createMerchantCatalogJob(app, {
        userId: row.userId,
        garmentSubcategoryId: row.garmentSubcategoryId,
        category: row.category,
        flatImageKey,
        subcategoryId,
      });

      reply.code(201);
      return { jobId };
    },
  );

  app.get(
    '/v1/merchant/catalog/generate/:jobId',
    { preHandler: app.requireMerchant, schema: { params: z.object({ jobId: z.string().uuid() }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobId } = req.params as { jobId: string };

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);
      if (!job || job.userId !== client.userId) {
        throw new AppError('NOT_FOUND', 404, 'job not found');
      }

      const resultUrl = job.resultKey
        ? await app.storage
            .presignGet(job.resultKey, 3600)
            .then((r) => r.url)
            .catch(() => null)
        : null;

      return { jobId: job.id, status: job.status, resultUrl, errorCode: job.errorCode };
    },
  );
```

- [ ] **Step 5: Run the test**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts
```

Run: the above command.
Expected: `4 passed`.

- [ ] **Step 6: Run the full existing merchant + kiosk suites to check nothing regressed**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog.test.ts test/integration/merchant-catalog-subcategories.test.ts test/integration/merchant-kiosk-admin.test.ts test/integration/kiosk-auth.test.ts test/integration/kiosk-jobs.test.ts test/integration/simple-tryon.test.ts
```

Run: the above command.
Expected: all pass.

- [ ] **Step 7: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Run: the above command.
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "feat(api): merchant catalogue single flat-image generation (Path B)"
```

---

## Task 10: Bulk flat-image generation (Path B, many)

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`
- Modify: `apps/api/test/integration/merchant-catalog-generate.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `apps/api/test/integration/merchant-catalog-generate.test.ts`, before the final closing of the outer `describe`:

```ts
  describe('bulk generate', () => {
    it('creates one job per flat image, tolerates partial failure, and reports batch status', async () => {
      const { userId } = await createMerchant(app, 'gen-bulk@example.com');
      await grantUserCredits(app, userId, 1000);
      const auth = await authHeader(userId);
      const { garmentType } = await seedFullDefaults('boys');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'boys', name: 'T-Shirts', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatKeys: string[] = [];
      for (let i = 0; i < 3; i++) {
        const presign = await app.inject({
          method: 'POST',
          url: '/v1/merchant/catalog/presign',
          headers: auth,
          payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
        });
        const { r2Key, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
        await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: Buffer.from(`flat-${i}`),
        });
        flatKeys.push(r2Key);
      }

      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: flatKeys },
      });
      expect(bulk.statusCode).toBe(201);
      const { jobIds } = bulk.json() as { jobIds: string[] };
      expect(jobIds).toHaveLength(3);

      const status = await app.inject({
        method: 'GET',
        url: `/v1/merchant/catalog/generate/status?jobIds=${jobIds.join(',')}`,
        headers: auth,
      });
      expect(status.statusCode).toBe(200);
      const body = status.json() as { items: Array<{ jobId: string; status: string }> };
      expect(body.items).toHaveLength(3);
      expect(body.items.every((i) => i.status === 'QUEUED')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts -t "bulk generate"
```

Run: the above command.
Expected: FAIL — `/generate-bulk` and `/generate/status` don't exist yet.

- [ ] **Step 3: Implement the bulk routes**

Add to `apps/api/src/modules/merchant/catalog.routes.ts`, after the `GET /v1/merchant/catalog/generate/:jobId` route:

```ts
  app.post(
    '/v1/merchant/catalog/generate-bulk',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBulkBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { subcategoryId, flatImageKeys } = req.body as z.infer<
        typeof MerchantCatalogGenerateBulkBody
      >;

      const [row] = await app.db
        .select({
          userId: schema.merchants.userId,
          category: schema.merchantCatalogSubcategories.category,
          garmentSubcategoryId: schema.merchantCatalogSubcategories.garmentSubcategoryId,
        })
        .from(schema.merchantCatalogSubcategories)
        .innerJoin(schema.merchants, eq(schema.merchants.id, schema.merchantCatalogSubcategories.merchantId))
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      const jobIds: string[] = [];
      const failures: Array<{ flatImageKey: string; error: string }> = [];
      for (const flatImageKey of flatImageKeys) {
        try {
          await assertMerchantUploadKey(app, merchantId, flatImageKey, 'flat garment');
          const { jobId } = await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
          });
          jobIds.push(jobId);
        } catch (err) {
          failures.push({
            flatImageKey,
            error: err instanceof AppError ? err.message : 'unknown error',
          });
        }
      }

      if (jobIds.length === 0) {
        throw new AppError('VALIDATION', 400, 'all images in the batch failed to enqueue');
      }

      reply.code(201);
      return { jobIds, failures };
    },
  );

  app.get(
    '/v1/merchant/catalog/generate/status',
    { preHandler: app.requireMerchant },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobIds: jobIdsParam } = req.query as { jobIds?: string };
      const jobIds = (jobIdsParam ?? '').split(',').filter(Boolean);
      if (jobIds.length === 0) return { items: [] };

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const rows = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(inArray(schema.jobs.id, jobIds));

      const items = await Promise.all(
        rows
          .filter((row) => row.userId === client.userId)
          .map(async (row) => ({
            jobId: row.id,
            status: row.status,
            resultUrl: row.resultKey
              ? await app.storage
                  .presignGet(row.resultKey, 3600)
                  .then((r) => r.url)
                  .catch(() => null)
              : null,
            errorCode: row.errorCode,
          })),
      );

      return { items };
    },
  );
```

(`inArray` is already imported in this file from an earlier task — confirm; it was imported in Task 4 Step 3's updated import block.)

- [ ] **Step 4: Run the test**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts
```

Run: the above command.
Expected: all tests in the file pass (single + bulk).

- [ ] **Step 5: Full regression pass**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts
```

Run: the above command.
Expected: all integration test files pass (this repo's suite includes pre-existing unrelated files — confirm none of them newly fail; if any pre-existing failure is unrelated to this plan's changes, verify via `git stash` that it also fails on `master` before assuming it's fine to ignore).

- [ ] **Step 6: Typecheck the whole API package one final time**

```bash
cd apps/api && pnpm typecheck
```

Run: the above command.
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "feat(api): merchant catalogue bulk flat-image generation (Path B)"
```

---

## Self-Review

**Spec coverage against `docs/multi-app-ecosystem/phase-6-merchant-catalogue-manager.md`:**
- §4 data model (subcategories table, item column changes, `defaultPoseId`) → Task 1. ✓
- §5 admin config (pose per type, face/bg per category, aspect ratio) → Tasks 7, 8. ✓
- §6 API surface (subcategory CRUD, product CRUD, generate single/bulk, status polls) → Tasks 4, 5, 9, 10. ✓
- §7 generate handler design (dedicated function decision, copy-into-product on completion) → Task 9, 6. ✓
- §2 Path A / Path B both kept → Task 6 (Path A fixed to copy output) + Task 9 (Path B). ✓
- §9 verification (zero-drift migration, new integration tests, existing tests updated, manual run) → Task 1 Step 5, every task's test steps. ✓
- Review-corrections plan items (image-role decision, kiosk serializer, admin serializer bug, ownership check before deduct, migration truncate note, watermark statement, typo) → all folded into Tasks 1, 5, 6, 9 and the Context section above. ✓

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate" phrases remain except two explicitly-flagged verification steps (Task 7 Step 3, admin model-faces/backgrounds endpoint path) where the plan requires the implementer to run a `grep` and confirm real values before writing code that depends on an unverified external route shape — this is a deliberate verification gate, not an unresolved placeholder, and the exact command to resolve it is given.

**Type consistency check:** `createMerchantCatalogJob` returns `{ jobId }`, matched by the generate route's response. `MerchantCatalogGenerateBody`/`MerchantCatalogGenerateBulkBody`/`MerchantCatalogGenerateStatus` field names (`subcategoryId`, `flatImageKey`, `flatImageKeys`, `jobId`, `status`, `resultUrl`, `errorCode`) are used identically across Task 2 (schema), Task 9 (single route + test), Task 10 (bulk route + test). `sourceKind` values (`'uploaded' | 'generated' | 'imported'`) are consistent across Task 1 (column default), Task 2 (`MerchantCatalogSourceKind` enum), Task 5/6 (serializer, copy helper). `merchantCatalogDefaults` key names (`men|women|boys|girls`) consistent across Task 2 (`SystemConfigBody`), Task 7 (admin-web UI), Task 9 (`createMerchantCatalogJob`'s `MerchantCatalogDefaults` type).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-09-merchant-catalogue-manager-backend.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
