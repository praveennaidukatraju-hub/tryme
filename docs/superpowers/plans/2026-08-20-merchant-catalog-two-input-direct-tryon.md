# Merchant Catalog Two-Input (Body + Pallu) Direct Try-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let a merchant upload a saree's body + pallu photos directly (no AI-generated
catalogue image) in the "Catalogue Image" mode of Add Product, and have customer try-on
consume both images directly in one ComfyUI pass — no mannequin-generation step involved.

**Architecture:** `merchant_catalog_items` gains a second, optional image (`secondR2Key` /
`secondThumbnailKey`) alongside the existing primary one. `garment_subcategories` gains a
second, independent workflow-template pointer (`twoInputTryonWorkflowTemplateId`) — distinct
from the existing `mannequinTwoInputWorkflowTemplateId`, which stays wired to its own,
already-shipped consumer (Studio's/merchant-catalog-generate's mannequin-drape step; see
"Do not touch" below). When a customer tries on a catalog item that has a `secondR2Key`,
`resolveTryonGarment` selects the two-input template instead of the normal
tryon-category template, and the dispatcher's merchant-widget processor patches the
customer's own photo plus both garment images into the SAME already-uploaded ComfyUI
workflow (id `3042bd53-3714-4d38-9642-6b46a995781c` locally, slug
`flat_body_and_pallu_saree_tryon_api_1_`) — one pass, no intermediate job.

**Tech Stack:** Fastify 5 + Zod (api), Drizzle/Postgres (db), Next.js/React (catalogues-web),
dispatcher's existing `processWidgetJob` ComfyUI patch/submit/poll pipeline.

---

## Context worth internalizing before touching code

**The workflow template already exists in the local dev DB and is correct as-is.** Verified
directly:

```
$ docker exec tryme-postgres psql -U <user> -d <db> -t -c \
  "select id, slug, workflow_type, tryon_person_node_id, tryon_garment_node_id, \
   tryon_garment_node_id_2, tryon_output_node_id from workflow_templates \
   where tryon_garment_node_id_2 is not null;"

 3042bd53-3714-4d38-9642-6b46a995781c | flat_body_and_pallu_saree_tryon_api_1_ | \
 saree_step1_two_input | 26 | 30 | 27 | 25
```

This is the exact ComfyUI graph the user supplied (`flat-body-and-pallu-saree-tryon-api
(1).json`): node 26 = person, node 30 = body, node 27 = pallu, node 25 = SaveImage — a
**single KSampler pass**, no separate mannequin-drape step. Feed it a real customer photo
in node 26 and it produces that customer wearing the saree directly. This is what "we are
able to do the tryon with the person image and the body and pallu directly without the
catalogue image" (the user's own words) refers to.

**Why not reuse `mannequinTwoInputWorkflowTemplateId`, which already points at this same
row?** That column is actively consumed today by `createSareeMannequin.ts` and
`create-job.ts` with a **model-gallery face** patched into node 26 (not a customer photo) —
it produces a catalogue mannequin photo, a completely different job semantically (0-credit,
step 1 of 2, feeds into a further per-pose composite). Overloading that column's meaning for
a second, structurally different consumer (a full-credit, one-shot, real-customer tryon job)
would make it ambiguous to any future reader and risks the two consumers drifting into
conflicting assumptions. A second, independently-nullable column costs one migration line
and keeps both capabilities toggleable independently — a garment type could have one without
the other.

**`job_inputs.third_garment_key` already exists and already means "pallu" by convention** —
`createSareeMannequin.ts`, `create-job.ts`, and `shopify/catalog-job.ts` all pair
`upperGarmentKey` (body) with `thirdGarmentKey` (pallu). This plan's job-creation change
follows that exact precedent — no new job_inputs column needed.

**`tryon_categories` is empty in the local DB and `garment_subcategories.tryon_category_id`
is null for saree** — verified directly. That means `resolveTryonGarment`'s existing
single-image path would currently fail validation for saree regardless of this plan. This
plan's two-input path bypasses `tryon_categories` entirely (it resolves
`twoInputTryonWorkflowTemplateId` directly), so it does **not** depend on `tryon_categories`
being configured. Fixing the single-image tryon-category gap for saree is out of scope here.

## Do not touch — existing, already-shipped, out of scope

- `mannequinTwoInputWorkflowTemplateId` and its consumers (`createSareeMannequin.ts`,
  `create-job.ts`'s mannequin-drape branch, the Studio wizard's Full Saree/Body & Pallu
  dropdown gating). Separate capability, separate column, do not repurpose or "clean up."
- `demoCatalogItems` / the demo-catalog try-on path in `resolveTryonGarment.ts`. Demo items
  are admin-authored; this plan is scoped to a merchant's own catalog items only.
- `tryon_categories` seeding, or the single-image tryon path's `MANNEQUIN_WORKFLOW_NOT_CONFIGURED`
  gap for saree. Unrelated, pre-existing gap.
- Studio's own saree upload flow (`apps/catalogues-web/.../studio/page.tsx`) — already fixed
  in a prior session (defaults to Body & Pallu, Full Saree option removed).
- `ProductModal.tsx`'s "Flat Image" mode Pallu upload box (Task 4 of the prior
  `2026-08-20-merchant-catalog-saree-two-input.md` plan, shipped) and the mode-toggle
  hidden-for-two-input logic (`!supportsTwoInputMannequin` guard around the tab switcher,
  defaulting to `'catalogue'`) — both already implemented in the working tree as of this
  plan's writing, but **not yet committed**. Commit that pending diff as its own commit
  before starting Task 8 below (same pattern as the prior handoff's "commit the pending
  diff first" step) — don't fold it into Task 8's commit, it's unrelated scope. Task 8 only
  adds a second upload box *inside* Catalogue Image mode; it does not touch the toggle logic.

---

### Task 1: DB migration — second image on catalog items, two-input tryon template pointer

**Files:**
- Create: `packages/db/src/migrations/0159_merchant_catalog_two_input_tryon.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/merchant.ts:98-131` (`merchantCatalogItems`)
- Modify: `packages/db/src/schema/models.ts:146-149` (`garmentSubcategories`, right after
  `mannequinTwoInputWorkflowTemplateId`)

- [x] **Step 1: Write the migration SQL**

```sql
ALTER TABLE "merchant_catalog_items" ADD COLUMN "second_r2_key" text;--> statement-breakpoint
ALTER TABLE "merchant_catalog_items" ADD COLUMN "second_thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "garment_subcategories" ADD COLUMN "two_input_tryon_workflow_template_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garment_subcategories" ADD CONSTRAINT "garment_subcategories_two_input_tryon_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("two_input_tryon_workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
```

- [x] **Step 2: Append the journal entry**

Edit `packages/db/src/migrations/meta/_journal.json`, append to the `entries` array (use the
actual current Unix-ms timestamp at implementation time, not the literal value below):

```json
{"idx":159,"version":"7","when":1787000000000,"tag":"0159_merchant_catalog_two_input_tryon","breakpoints":true}
```

- [x] **Step 3: Add the Drizzle columns**

In `packages/db/src/schema/merchant.ts`, inside `merchantCatalogItems` right after
`thumbnailKey: text('thumbnail_key').notNull(),` (merchant.ts:113):

```ts
    // Second garment image (pallu) for a two-input (body+pallu) saree product uploaded
    // directly via "Catalogue Image" mode — nullable because most catalog items are
    // single-image. Both r2Key (body) and secondR2Key (pallu) are patched directly into
    // ComfyUI at try-on time; see garmentSubcategories.twoInputTryonWorkflowTemplateId.
    secondR2Key: text('second_r2_key'),
    secondThumbnailKey: text('second_thumbnail_key'),
```

In `packages/db/src/schema/models.ts`, inside `garmentSubcategories` right after the
`mannequinTwoInputWorkflowTemplateId` field (models.ts:146-149):

```ts
  // Independent of mannequinTwoInputWorkflowTemplateId above (that one drives catalogue-
  // image GENERATION from a model-gallery face; this one drives DIRECT customer try-on
  // from a merchant catalog item that has a second/pallu image, patching the real
  // customer photo — not a model face — into the same person-node role). See
  // resolveTryonGarment.ts and docs/superpowers/plans/
  // 2026-08-20-merchant-catalog-two-input-direct-tryon.md.
  twoInputTryonWorkflowTemplateId: uuid('two_input_tryon_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
```

- [x] **Step 4: Apply the migration locally**

Run: `pnpm db:migrate` (from repo root; requires `pnpm docker:up` already running)
Expected: no errors; `packages/db/src/migrations/meta/_journal.json` entry now applied.

- [x] **Step 5: Verify columns landed**

Run:
```bash
docker exec tryme-postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> -t -c \
  "select column_name from information_schema.columns where table_name='merchant_catalog_items' and column_name like 'second%';"
docker exec tryme-postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> -t -c \
  "select column_name from information_schema.columns where table_name='garment_subcategories' and column_name='two_input_tryon_workflow_template_id';"
```
Expected: `second_r2_key`, `second_thumbnail_key` in the first result; the FK column present
in the second.

- [x] **Step 6: Commit**

```bash
git add packages/db/src/migrations/0159_merchant_catalog_two_input_tryon.sql \
        packages/db/src/migrations/meta/_journal.json \
        packages/db/src/schema/merchant.ts \
        packages/db/src/schema/models.ts
git commit -m "feat(db): add second-image and two-input-tryon-template columns for merchant catalog"
```

---

### Task 2: Types — second image and capability flag

**Files:**
- Modify: `packages/types/src/widget.ts:70-79,113-139,175-195`
- Modify: `packages/types/src/admin.ts:591-611`

- [x] **Step 1: Extend `MerchantCatalogCreateBody`**

In `packages/types/src/widget.ts`, `MerchantCatalogCreateBody` (widget.ts:70-79):

```ts
export const MerchantCatalogCreateBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(200),
  sku: z.string().max(120).optional(),
  actualPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  offerPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  // Pallu image for a two-input saree product uploaded directly — both optional and
  // present together, or both absent. Route-layer validates that pairing.
  secondR2Key: z.string().min(1).optional(),
  secondThumbnailKey: z.string().min(1).optional(),
});
export type MerchantCatalogCreateBody = z.infer<typeof MerchantCatalogCreateBody>;
```

- [x] **Step 2: Extend `MerchantCatalogItem`**

In `packages/types/src/widget.ts`, `MerchantCatalogItem` (widget.ts:113-139), add right after
`thumbnailUrl: z.string().url().nullable(),`:

```ts
  secondR2Key: z.string().nullable(),
  secondThumbnailKey: z.string().nullable(),
  secondImageUrl: z.string().url().nullable(),
```

- [x] **Step 3: Add the capability flag to `MerchantCatalogSubcategory`**

In `packages/types/src/widget.ts`, `MerchantCatalogSubcategory` (widget.ts:175-195), add
right after the existing `supportsTwoInputMannequin` field:

```ts
  // True only when garmentSubcategories.twoInputTryonWorkflowTemplateId is set — gates
  // whether ProductModal's "Catalogue Image" (direct upload) mode shows a second Pallu
  // upload box. Independent of supportsTwoInputMannequin (that one gates the "Flat Image"
  // AI-generate mode's Pallu box instead) — a garment type can have either, both, or
  // neither configured.
  supportsTwoInputDirectTryon: z.boolean(),
```

- [x] **Step 4: Add the admin patch field**

In `packages/types/src/admin.ts`, `PatchGarmentTypeBody` (admin.ts:591-611), add right after
`mannequinTwoInputWorkflowTemplateId: z.string().uuid().nullable().optional(),`:

```ts
  twoInputTryonWorkflowTemplateId: z.string().uuid().nullable().optional(),
```

- [x] **Step 5: Typecheck the types package**

Run: `pnpm --filter @tryme/types typecheck` (or `pnpm typecheck` from root if that package
has no dedicated script — check `packages/types/package.json` first)
Expected: clean.

- [x] **Step 6: Commit**

```bash
git add packages/types/src/widget.ts packages/types/src/admin.ts
git commit -m "feat(types): add second-image and two-input-tryon fields for merchant catalog"
```

---

### Task 3: API — store, serve, and clean up the second image

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:24-43` (`serializeCatalogItem`)
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:131-157` (`serializeSubcategory`)
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:529-572` (create route)
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts:658-689` (delete route)
- Test: `apps/api/test/integration/merchant-catalog.test.ts` (extend existing file — read it
  first to match its existing setup/auth helpers before adding new tests)

- [x] **Step 1: Presign the second image in `serializeCatalogItem`**

Replace `catalog.routes.ts:24-43`:

```ts
async function serializeCatalogItem(app: FastifyInstance, item: MerchantCatalogRow) {
  const [imageUrl, thumbnailUrl, secondImageUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((result) => result.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((result) => result.url)
      .catch(() => null),
    item.secondR2Key
      ? app.storage
          .presignGet(item.secondR2Key, 3600)
          .then((result) => result.url)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    ...item,
    actualPrice: Math.round(item.actualPricePaise / 100),
    offerPrice: Math.round(item.offerPricePaise / 100),
    imageUrl,
    thumbnailUrl,
    secondImageUrl,
  };
}
```

- [x] **Step 2: Add the capability flag to `serializeSubcategory`**

Replace `catalog.routes.ts:131-157`:

```ts
async function serializeSubcategory(
  app: FastifyInstance,
  row: typeof schema.merchantCatalogSubcategories.$inferSelect,
) {
  const [{ n }] = await app.db
    .select({ n: count() })
    .from(schema.merchantCatalogItems)
    .where(eq(schema.merchantCatalogItems.subcategoryId, row.id));
  // Mirrors the existing per-row productCount lookup above — same N+1-per-row shape this
  // function already has, not a new performance concern for a merchant's subcategory list
  // (bounded by how many subcategories one merchant creates, never paginated at scale).
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
      twoInputTryonWorkflowTemplateId:
        schema.garmentSubcategories.twoInputTryonWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, row.garmentSubcategoryId));
  return {
    ...row,
    productCount: n,
    supportsTwoInputMannequin: Boolean(
      garmentType?.requiresMannequinStep && garmentType?.mannequinTwoInputWorkflowTemplateId,
    ),
    supportsTwoInputDirectTryon: Boolean(garmentType?.twoInputTryonWorkflowTemplateId),
  };
}
```

- [x] **Step 3: Accept and validate the second image on create**

Replace the create route body (`catalog.routes.ts:529-572`) — the `Promise.all` validation
block and the insert `.values`:

```ts
      await Promise.all([
        assertMerchantUploadKey(app, merchantId, body.r2Key, 'image'),
        assertMerchantUploadKey(app, merchantId, body.thumbnailKey, 'thumbnail'),
        ...(body.secondR2Key
          ? [assertMerchantUploadKey(app, merchantId, body.secondR2Key, 'second image')]
          : []),
        ...(body.secondThumbnailKey
          ? [assertMerchantUploadKey(app, merchantId, body.secondThumbnailKey, 'second thumbnail')]
          : []),
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
          secondR2Key: body.secondR2Key ?? null,
          secondThumbnailKey: body.secondThumbnailKey ?? null,
        })
        .returning();

      reply.code(201);
      return await serializeCatalogItem(app, item);
```

- [x] **Step 4: Clean up the second image on delete**

Replace `catalog.routes.ts:681-684`:

```ts
      await Promise.allSettled([
        app.storage.deleteObject(deleted.r2Key),
        app.storage.deleteObject(deleted.thumbnailKey),
        ...(deleted.secondR2Key ? [app.storage.deleteObject(deleted.secondR2Key)] : []),
        ...(deleted.secondThumbnailKey
          ? [app.storage.deleteObject(deleted.secondThumbnailKey)]
          : []),
      ]);
```

- [x] **Step 5: Write the integration test**

Read `apps/api/test/integration/merchant-catalog.test.ts` first for its existing
merchant-auth/seed helpers, then add:

```ts
it('stores and serves a second image when provided', async () => {
  const { app, merchantToken, subcategoryId } = await setupMerchantWithSubcategory();
  const primary = await presignAndPutTestImage(app, merchantToken, 'image');
  const primaryThumb = await presignAndPutTestImage(app, merchantToken, 'thumbnail');
  const second = await presignAndPutTestImage(app, merchantToken, 'image');
  const secondThumb = await presignAndPutTestImage(app, merchantToken, 'thumbnail');

  const res = await app.inject({
    method: 'POST',
    url: '/v1/merchant/catalog',
    headers: { authorization: `Bearer ${merchantToken}` },
    payload: {
      subcategoryId,
      label: 'Two-Input Saree',
      sku: 'SKU-2IN',
      actualPrice: 2000,
      offerPrice: 1500,
      r2Key: primary.r2Key,
      thumbnailKey: primaryThumb.r2Key,
      secondR2Key: second.r2Key,
      secondThumbnailKey: secondThumb.r2Key,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.secondR2Key).toBe(second.r2Key);
  expect(body.secondImageUrl).toBeTruthy();

  const deleteRes = await app.inject({
    method: 'DELETE',
    url: `/v1/merchant/catalog/${body.id}`,
    headers: { authorization: `Bearer ${merchantToken}` },
  });
  expect(deleteRes.statusCode).toBe(204);
  await expect(app.storage.headObject(second.r2Key)).rejects.toThrow();
});
```

Adjust the setup helper names to whatever this test file's existing helpers are actually
called — read the file first, don't invent new helper names that don't match its patterns.

- [x] **Step 6: Run the integration test**

Run: `npx vitest run --config vitest.integration.config.ts merchant-catalog.test.ts` (from
`apps/api`, with `pnpm docker:up` running)
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog.test.ts
git commit -m "feat(merchant-catalog): store, serve, and clean up a second (pallu) catalog image"
```

---

### Task 4: Admin UI — wire the two-input tryon template onto a garment type

**Files:**
- Modify: `apps/admin-web/src/components/EditGarmentTypeModal.tsx:355-478` (state + diff +
  submit)
- Modify: `apps/admin-web/src/types.ts` (garment type shape — find the existing
  `mannequinTwoInputWorkflowTemplateId` field and add the new one beside it)
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts` — no code change needed here;
  the PATCH route at `subcategories.routes.ts:151-260` already spreads the validated body
  generically via `.set({ ...body, updatedAt: new Date() })`, so it picks up the new field
  automatically once `PatchGarmentTypeBody` (Task 2, Step 4) includes it. Confirm this by
  reading the route, don't skip verifying it.

- [x] **Step 1: Add the field to `EditGarmentTypeModal.tsx`**

Mirror the existing `mannequinTwoInputWorkflowTemplateId` state/diff/submit exactly. Add
right after each existing `mannequinTwoInputWorkflowTemplateId` occurrence:

State (near line 361-363):
```ts
  const [twoInputTryonWorkflowTemplateId, setTwoInputTryonWorkflowTemplateId] = useState(
    garmentType.twoInputTryonWorkflowTemplateId ?? '',
  );
```

Dirty-check (near line 403):
```ts
    twoInputTryonWorkflowTemplateId !== (garmentType.twoInputTryonWorkflowTemplateId ?? '');
```

Submit diff (near line 473-478):
```ts
      if (
        twoInputTryonWorkflowTemplateId !== (garmentType.twoInputTryonWorkflowTemplateId ?? '')
      ) {
        patchBody.twoInputTryonWorkflowTemplateId = twoInputTryonWorkflowTemplateId || null;
      }
```

Field UI (near line 683, copy the existing `mannequinTwoInputWorkflowTemplateId` `<select>`
or text input verbatim, renamed, with a label of "Two-Input Direct Try-On Workflow" and
helper text: "Used when a customer tries on a merchant catalog item that has a second
(pallu) image — patches the customer's own photo directly, no mannequin step.").

- [x] **Step 2: Add the field to the admin-web garment-type type**

In `apps/admin-web/src/types.ts`, find the interface/type containing
`mannequinTwoInputWorkflowTemplateId` and add `twoInputTryonWorkflowTemplateId: string |
null;` beside it.

- [x] **Step 3: Typecheck admin-web**

Run (from `apps/admin-web`, per this repo's known `pnpm -r typecheck` gap for this package):
`npx tsc -b --force`
Expected: clean.

- [x] **Step 4: Manual verification**

Run `pnpm --filter @tryme/admin dev`, open Assets → Garment Types → "saree" → Edit, set
"Two-Input Direct Try-On Workflow" to `3042bd53-3714-4d38-9642-6b46a995781c` (the workflow
template already present in the local dev DB — confirm the exact id in your own environment
via the query in Task 1's context section before pasting it, ids are not portable across
environments), save, reopen the modal, confirm the value persisted.

- [x] **Step 5: Commit**

```bash
git add apps/admin-web/src/components/EditGarmentTypeModal.tsx apps/admin-web/src/types.ts
git commit -m "feat(admin-web): add Two-Input Direct Try-On Workflow field to garment type editor"
```

---

### Task 5: `resolveTryonGarment` — resolve the second image and the two-input template

**Files:**
- Modify: `apps/api/src/modules/merchant/resolve-tryon-garment.ts` (full file — small, shown
  below with exact diff)
- Test: `apps/api/test/integration/merchant-tryon.test.ts` (create if it doesn't exist yet —
  check first; if a similar file exists under a different name, extend that one instead)

- [x] **Step 1: Extend the interface and the "own" query**

In `resolve-tryon-garment.ts`, change:

```ts
export interface ResolvedTryonGarment {
  r2Key: string;
  workflowTemplateId: string;
  isDemo: boolean;
}
```

to:

```ts
export interface ResolvedTryonGarment {
  r2Key: string;
  secondR2Key?: string;
  workflowTemplateId: string;
  isDemo: boolean;
}
```

Then extend the "own" select (currently `resolve-tryon-garment.ts:24-52`) to also pull
`secondR2Key` and `twoInputTryonWorkflowTemplateId`:

```ts
  const [own] = await app.db
    .select({
      merchantId: schema.merchantCatalogItems.merchantId,
      r2Key: schema.merchantCatalogItems.r2Key,
      secondR2Key: schema.merchantCatalogItems.secondR2Key,
      isActive: schema.merchantCatalogItems.isActive,
      moderationStatus: schema.merchantCatalogItems.moderationStatus,
      twoInputTryonWorkflowTemplateId: schema.garmentSubcategories.twoInputTryonWorkflowTemplateId,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.merchantCatalogItems)
    .innerJoin(
      schema.merchantCatalogSubcategories,
      eq(schema.merchantCatalogSubcategories.id, schema.merchantCatalogItems.subcategoryId),
    )
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.merchantCatalogSubcategories.garmentSubcategoryId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.merchantCatalogItems.id, itemId))
    .limit(1);
```

(Only the new `secondR2Key` and `twoInputTryonWorkflowTemplateId` selected columns are new;
the joins are unchanged.)

- [x] **Step 2: Branch on `secondR2Key` before the existing single-image path**

Replace the current:

```ts
  if (own) {
    if (own.merchantId !== merchantId) {
      throw new AppError('NOT_FOUND', 404, 'catalog item not found');
    }
    if (!own.isActive || own.moderationStatus !== 'approved') {
      throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
    }
    assertWorkflow(own);
    return { r2Key: own.r2Key, workflowTemplateId: own.workflowTemplateId, isDemo: false };
  }
```

with:

```ts
  if (own) {
    if (own.merchantId !== merchantId) {
      throw new AppError('NOT_FOUND', 404, 'catalog item not found');
    }
    if (!own.isActive || own.moderationStatus !== 'approved') {
      throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
    }

    // A catalog item with a second (pallu) image bypasses the normal tryon-category
    // lookup entirely and goes through the garment type's dedicated two-input template —
    // see garmentSubcategories.twoInputTryonWorkflowTemplateId. Falling back to the
    // single-image template here would silently ignore the pallu image rather than fail
    // loud, so this is a hard config error, not a soft fallback.
    if (own.secondR2Key) {
      if (!own.twoInputTryonWorkflowTemplateId) {
        throw new AppError(
          'VALIDATION',
          400,
          'garment type has no two-input tryon workflow configured',
        );
      }
      const [twoInputTemplate] = await app.db
        .select({ isActive: schema.workflowTemplates.isActive })
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.id, own.twoInputTryonWorkflowTemplateId))
        .limit(1);
      if (!twoInputTemplate?.isActive) {
        throw new AppError('VALIDATION', 400, 'two-input tryon workflow is inactive');
      }
      return {
        r2Key: own.r2Key,
        secondR2Key: own.secondR2Key,
        workflowTemplateId: own.twoInputTryonWorkflowTemplateId,
        isDemo: false,
      };
    }

    assertWorkflow(own);
    return { r2Key: own.r2Key, workflowTemplateId: own.workflowTemplateId, isDemo: false };
  }
```

The demo-items branch below this (`resolve-tryon-garment.ts:65-115`) is unchanged — demo
items never have a second image, out of scope per this plan's "Do not touch" section.

- [x] **Step 3: Typecheck**

Run (from `apps/api`): `npx tsc --noEmit` (or the package's `typecheck` script — check
`apps/api/package.json`)
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/resolve-tryon-garment.ts
git commit -m "feat(merchant-tryon): resolve the two-input template when a catalog item has a second image"
```

---

### Task 6: Job creation — carry the second garment key through as `thirdGarmentKey`

**Files:**
- Modify: `apps/api/src/modules/merchant/create-tryon-job.ts` (full file — small)
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts:173-179`

- [x] **Step 1: Accept the second garment key**

In `create-tryon-job.ts`, change the interface:

```ts
interface CreateMerchantTryonJobInput {
  merchantId: string;
  merchantUserId: string;
  upperGarmentKey: string;
  secondGarmentKey?: string;
  customerPhotoKey: string;
  workflowTemplateId: string;
}
```

And in the `jobInputs` insert:

```ts
    // biome-ignore lint/suspicious/noExplicitAny: nullable widget inputs are wider than Drizzle's inferred insert type.
    await (tx.insert(schema.jobInputs).values as any)({
      jobId,
      upperGarmentKey: input.upperGarmentKey,
      thirdGarmentKey: input.secondGarmentKey ?? null,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { workflowTemplateId: input.workflowTemplateId },
    });
```

- [x] **Step 2: Pass it through from the route**

In `tryon.routes.ts:173-179`, change:

```ts
          const jobId = await createMerchantTryonJob(app, {
            merchantId,
            merchantUserId: merchant.userId,
            upperGarmentKey: garment.r2Key,
            secondGarmentKey: garment.secondR2Key,
            customerPhotoKey,
            workflowTemplateId: garment.workflowTemplateId,
          });
```

- [x] **Step 3: Typecheck**

Run (from `apps/api`): `npx tsc --noEmit`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/create-tryon-job.ts apps/api/src/modules/merchant/tryon.routes.ts
git commit -m "feat(merchant-tryon): carry the second garment key into the tryon job as thirdGarmentKey"
```

---

### Task 7: Dispatcher — patch the second garment image into the ComfyUI workflow

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1838-1892` (templateRow select + node id
  extraction, inside `processWidgetJob`)
- Modify: `apps/dispatcher/src/job/processor.ts:1953-1969` (upload + patch)

- [x] **Step 1: Select `tryonGarmentNodeId2`**

Replace the `templateRow` select at `processor.ts:1838-1852`:

```ts
  const [templateRow] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonGarmentNodeId2: schema.workflowTemplates.tryonGarmentNodeId2,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.id, workflowTemplateId),
        eq(schema.workflowTemplates.isActive, true),
      ),
    )
    .limit(1);
```

Right after `const outputNodeId = templateRow.tryonOutputNodeId;` (processor.ts:1872), add:

```ts
  const garmentNodeId2 = templateRow.tryonGarmentNodeId2;
```

- [x] **Step 2: Validate the pairing before dispatch**

Right after the existing `if (!garmentNodeId || !customerPhotoNodeId || !outputNodeId)` guard
block (processor.ts:1874-1892), add:

```ts
  // A template with a second garment node requires a second garment key on the job, and
  // vice versa — a mismatch means resolveTryonGarment and this template disagree about
  // whether this is a two-input job, which should never happen if Task 5's config
  // validation ran correctly. Fail loud rather than silently dropping the pallu image.
  if (garmentNodeId2 && !inputs.thirdGarmentKey) {
    jobLog.error({ workflowTemplateId }, 'two-input template but job has no thirdGarmentKey');
    await markWidgetFailed(
      cfg,
      jobId,
      merchantId,
      creditsCharged,
      stream,
      messageId,
      'TRYON_NODES_NOT_CONFIGURED',
      jobLog,
      startedAt,
      job.source,
    );
    return;
  }
```

- [x] **Step 3: Upload and patch the second garment image**

Replace `processor.ts:1953-1969`:

```ts
    jobLog.info('uploading merchant widget inputs to ComfyUI');
    const uploads = await Promise.all([
      uploadToComfy(upperGarmentKey, 'merchant_garment'),
      uploadToComfy(customerPhotoKey, 'merchant_customer'),
      ...(garmentNodeId2 && inputs.thirdGarmentKey
        ? [uploadToComfy(inputs.thirdGarmentKey, 'merchant_garment2')]
        : []),
    ]);
    const [garmentFilename, customerPhotoFilename, secondGarmentFilename] = uploads;
    jobLog.info(
      { garmentFilename, customerPhotoFilename, secondGarmentFilename },
      'merchant widget inputs uploaded',
    );

    // Clone and patch workflow using node IDs from DB
    const workflow = structuredClone(templateRow.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
    if (workflow[garmentNodeId]?.inputs) workflow[garmentNodeId].inputs!.image = garmentFilename;
    if (workflow[customerPhotoNodeId]?.inputs)
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[customerPhotoNodeId].inputs!.image = customerPhotoFilename;
    if (garmentNodeId2 && secondGarmentFilename && workflow[garmentNodeId2]?.inputs)
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[garmentNodeId2].inputs!.image = secondGarmentFilename;
```

Also extend the `job_events` audit payload a few lines below (processor.ts:1977-1987) to
include the second key for debuggability:

```ts
        inputs: {
          customerPhotoKey,
          upperGarmentKey,
          thirdGarmentKey: inputs.thirdGarmentKey ?? null,
          customerPhotoFilename,
          garmentFilename,
          secondGarmentFilename: secondGarmentFilename ?? null,
        },
```

- [x] **Step 4: Typecheck the dispatcher**

Run (from `apps/dispatcher`): `npx tsc --noEmit` (check `apps/dispatcher/package.json` for
the actual script name first)
Expected: clean.

- [x] **Step 5: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): patch a second garment image into two-input merchant tryon jobs"
```

---

### Task 8: `ProductModal.tsx` — Pallu upload box in Catalogue Image mode

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx`

This mirrors the already-shipped "Flat Image" mode Pallu box (lines ~511-547 in the current
file) but for direct upload — no generate step, so both files upload straight to their
'image'/'thumbnail' presign kinds and both keys go straight into the create-product POST
body, same as the existing single-image Catalogue Image path already does.

- [x] **Step 0: Commit the pending uncommitted diff first, as its own commit**

`git status` on this file will show it already modified before Task 8 starts — the
mode-toggle hidden-for-two-input logic described in "Do not touch" above. Commit it
separately:
```bash
git add "apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx"
git commit -m "fix(catalogues-web): hide Flat Image mode and default to Catalogue Image for two-input-capable saree types"
```
Then start Step 1 below on a clean diff so Task 8's own commit (Step 9) only contains the
new Pallu box.

- [x] **Step 1: Add second-image state usage — none needed**

`palluFile` / `palluPreviewUrl` / `handlePalluFileChange` / `palluInputRef` already exist
(added by the prior Flat Image plan) and are mode-agnostic — reuse them as-is, do not add
parallel state.

- [x] **Step 2: Compute a Catalogue-Image-mode pallu requirement**

Near the existing `const requiresPallu = imageMode === 'flat' && supportsTwoInputMannequin;`
line, add a second, independently-named constant (do not conflate the two — Flat Image mode
gates on the mannequin-generation capability, Catalogue Image mode gates on the direct-tryon
capability, and a garment type can have one without the other per Task 2):

```ts
  const requiresCataloguePallu =
    imageMode === 'catalogue' && supportsTwoInputDirectTryon;
```

This requires threading a new `supportsTwoInputDirectTryon: boolean` prop into
`ProductModalProps` (mirroring the existing `supportsTwoInputMannequin` prop) — add it next
to that prop in the interface, and pass it from every call site of `<ProductModal>` (find
them via `grep -rn "supportsTwoInputMannequin" apps/catalogues-web/src` — the parent
component already has `subcategory.supportsTwoInputMannequin` available from the
`/v1/merchant/catalog/subcategories` response per Task 3's `serializeSubcategory` change, so
`subcategory.supportsTwoInputDirectTryon` is available the same way).

- [x] **Step 3: Replace the Catalogue Image upload box**

Replace the current single-box catalogue-mode render (`ProductModal.tsx:367-423`) with a
version that stacks a Pallu box below the primary box exactly like Flat Image mode does:

```tsx
              {imageMode === 'catalogue' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    // biome-ignore lint/a11y/useKeyWithClickEvents: simple click trigger
                    onClick={() => !busy && fileInputRef.current?.click()}
                    style={{
                      height: 140,
                      borderRadius: 8,
                      border: `1px dashed ${C.border2}`,
                      background: 'transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      overflow: 'hidden',
                      position: 'relative',
                      gap: 8,
                    }}
                    className="hover-surface"
                  >
                    {previewUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {/* biome-ignore lint/performance/noImgElement: local preview */}
                        <img
                          src={previewUrl}
                          alt="Preview"
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            background: 'rgba(0,0,0,0.6)',
                            color: '#fff',
                            fontSize: 12,
                            textAlign: 'center',
                            padding: '6px 0',
                            fontWeight: 500,
                          }}
                        >
                          Click to change image
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ color: C.mid }}>
                          <UploadIcon size={28} />
                        </div>
                        <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                          {requiresCataloguePallu
                            ? 'Click to upload the body (front) photo'
                            : 'Click to upload product image'}
                        </div>
                      </>
                    )}
                  </div>
                  {requiresCataloguePallu && (
                    <div
                      // biome-ignore lint/a11y/useKeyWithClickEvents: simple click trigger
                      onClick={() => !busy && palluInputRef.current?.click()}
                      style={{
                        height: 140,
                        borderRadius: 8,
                        border: `1px dashed ${C.border2}`,
                        background: palluPreviewUrl ? C.field : 'transparent',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: busy ? 'not-allowed' : 'pointer',
                        overflow: 'hidden',
                        position: 'relative',
                        gap: 8,
                      }}
                      className="hover-surface"
                    >
                      {palluPreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        // biome-ignore lint/performance/noImgElement: local preview
                        <img
                          src={palluPreviewUrl}
                          alt="Pallu Preview"
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                      ) : (
                        <>
                          <div style={{ color: C.mid }}>
                            <UploadIcon size={28} />
                          </div>
                          <div style={{ fontSize: 13, color: C.mid, fontWeight: 500 }}>
                            Click to upload the pallu photo
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
```

(The `) : (` at the end reconnects to the existing Flat Image branch immediately below —
verify against the live file, don't guess the exact brace nesting; read the surrounding
~10 lines before editing.)

- [x] **Step 4: Extend `missingImage` and the save handler**

Update the `missingImage` computation (`ProductModal.tsx:199-202`):

```ts
  const missingImage =
    !isEditing &&
    ((imageMode === 'catalogue' &&
      (!selectedFile || (requiresCataloguePallu && !palluFile))) ||
      (imageMode === 'flat' && !generatedItem && (!selectedFile || (requiresPallu && !palluFile))));
```

Update the catalogue-mode branch of `handleSubmit` (`ProductModal.tsx:225-236`):

```ts
      } else {
        if (!selectedFile) throw new Error('Upload a product image first.');
        if (requiresCataloguePallu && !palluFile) throw new Error('Upload the pallu photo first.');
        const uploads = [
          presignAndUpload(selectedFile, 'image'),
          presignAndUpload(selectedFile, 'thumbnail'),
          ...(requiresCataloguePallu
            ? [
                presignAndUpload(palluFile as File, 'image'),
                presignAndUpload(palluFile as File, 'thumbnail'),
              ]
            : []),
        ];
        const [{ r2Key }, { r2Key: thumbnailKey }, second, secondThumb] = await Promise.all(
          uploads,
        );
        await api.post('/v1/merchant/catalog', {
          subcategoryId,
          r2Key,
          thumbnailKey,
          ...(second ? { secondR2Key: second.r2Key } : {}),
          ...(secondThumb ? { secondThumbnailKey: secondThumb.r2Key } : {}),
          ...priceFields,
        });
      }
```

- [x] **Step 5: Reset pallu state when switching modes or opening the modal**

Confirm the existing "Reset state" effect (`ProductModal.tsx:57-81`) already clears
`palluFile`/`palluPreviewUrl` on open — it does (`setPalluFile(undefined)` /
`setPalluPreviewUrl(undefined)` are already there from the Flat Image plan). No change
needed; just verify by reading, don't skip this check.

- [x] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: clean.

- [x] **Step 7: Lint**

Run: `npx biome check "apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx"`
Expected: no new errors (this file has pre-existing warnings from before this plan — compare
counts before/after, don't chase pre-existing ones).

- [x] **Step 8: Manual browser verification**

Run `pnpm --filter @tryme/web dev`, open Tryon → a two-input-capable subcategory (saree,
once Task 4's admin config is in place) → Add Product → confirm only "Catalogue Image" mode
is visible (Flat Image already hidden from the prior plan) → confirm it shows two upload
boxes (body, then pallu) → upload both → fill label/SKU/price → Save → confirm the product
appears in the list. Also verify a non-two-input subcategory (any non-saree type) still
shows the original single-image, both-modes-visible flow unchanged.

- [x] **Step 9: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx"
git commit -m "feat(catalogues-web): add Pallu upload to Catalogue Image mode for two-input-capable saree types"
```

---

## Definition of done

- Every `- [x]` checkbox above checked to `- [x]`.
- `pnpm --filter @tryme/api test:integration` green, including the new test from Task 3
  and any added in Task 5 — re-run the full suite, not just new files, since Task 5 touches
  `resolveTryonGarment` which the existing merchant-tryon-jobs test file already covers for
  the single-image path.
- `pnpm typecheck` and `pnpm lint` clean repo-wide (remember `admin-web`'s typecheck script
  gap — run `npx tsc -b --force` in `apps/admin-web` directly, `pnpm -r typecheck` silently
  skips it).
- `pnpm --filter @tryme/web typecheck` and the Task 8 manual browser walk both done.
- `docs/progress.md` updated with a new dated entry (`## YYYY-MM-DD — <title>`, `**Done**`
  bullets), matching the existing entries' style. Read the last entry first — this plan is
  implemented on the same branch as the prior saree-two-input plan
  (`feat/merchant-catalog-saree-two-input`), whose completion entry already sits at the top;
  add this as a new entry above it, don't merge into it.
- Report back: which commits landed for each task, whether the local admin UI walk (Task 4
  Step 4) actually found and used workflow template id
  `3042bd53-3714-4d38-9642-6b46a995781c` in your environment (confirm via the query in the
  plan's context section — don't assume the id is portable), and call out anywhere the live
  codebase disagreed with this plan's literal snippets (line numbers drift — this repo's
  other handoffs have hit this repeatedly; grep/read the actual current file before editing
  against a snippet's line reference).
