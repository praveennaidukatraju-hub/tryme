# Saree Mannequin Style Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the merchant catalogue Android app (`apps/saree_catalogue_android`) offer a "Style 1 / Style 2" choice before generating a draped-saree preview, where each style runs a different mannequin (step-1) ComfyUI workflow (different prompt/LoRA weights). Style is orthogonal to the existing product-category ("subcategory") dropdown — any subcategory can be generated in any style.

**Architecture:** A new global (not per-subcategory) table `saree_mannequin_styles`, each row pointing at a `workflow_templates` row. The merchant app fetches the active style list, the user picks one, and `POST /v1/merchant/catalog/generate` carries an optional `sareeStyleId`. The API snapshots that style's workflow template ID into `job_inputs.params.workflowTemplateId` — reusing the exact override mechanism the regular (non-saree) job path already has (`processor.ts`'s `snapshottedWorkflowTemplateId`). The dispatcher's `processSareeMannequinJob` gets one added fallback check: prefer the snapshotted override, else fall back to `garmentSubcategories.mannequinWorkflowTemplateId` exactly as today. Every change is additive and optional — an app build that never sends `sareeStyleId` keeps generating exactly as it does today.

**Tech Stack:** TypeScript, Fastify 5 (API), Drizzle ORM, Redis Streams, Vitest (real Postgres/Redis/MinIO integration tests), React + Vite (admin-web), Kotlin/Gradle (Android).

**Full design reference:** `docs/superpowers/specs/2026-07-21-saree-mannequin-style-selection-design.md` — read it once before starting; this plan implements it task-by-task and repeats every code detail needed, but the design doc has the "why" behind each decision.

---

## Context for the engineer (read this before starting)

- **What already exists, unmodified by this plan:** The merchant app's generate flow already runs mannequin-only generation (`createMerchantSareeMannequinJob` in `apps/api/src/modules/merchant/create-job.ts:192-252`, dispatched by `processSareeMannequinJob` in `apps/dispatcher/src/job/processor.ts:851-1106`). It currently always resolves its workflow from `garmentSubcategories.mannequinWorkflowTemplateId` — one workflow per garment type, no style concept. This plan adds a *second*, independent way to pick that workflow (a style), without touching how garment-type resolution itself works.
- **The existing override precedent this plan reuses:** The *regular* (non-saree-mannequin) job path in `processor.ts` (around line 228) already has a `snapshottedWorkflowTemplateId` mechanism — a caller can pre-resolve and snapshot a specific workflow template ID into `job_inputs.params.workflowTemplateId`, and the dispatcher prefers that over resolving one itself. This plan does the exact same thing for the saree-mannequin path, which today has no such override at all.
- **Existing merchant catalog subcategory route family** (`GET`/`POST`/`PATCH` `/v1/merchant/catalog/subcategories`) was just fixed (commit `c2611245`) to only allow `garmentSubcategories.requiresMannequinStep = true` rows. Nothing in this plan touches that filter or those routes — the new `saree-styles` endpoints are a completely separate, parallel route family.
- **Admin asset CRUD convention** to mirror: `apps/api/src/modules/admin/models.routes.ts`'s pose-assets section (`GET /admin/assets/pose-assets`, `POST .../presign`, `POST /admin/assets/pose-assets`, `PATCH /admin/assets/pose-assets/:id`). This plan's new saree-styles admin routes are simpler (single image, no bulk operations, no thumbnail variant) since there will only ever be a handful of style rows.
- **No dedicated integration test file exists today for admin asset CRUD routes** (confirmed — no test file references `pose-assets`). This plan follows that established convention: admin CRUD gets typecheck + manual verification, not a new integration test suite. Merchant-facing and dispatcher-facing behavior (where actual generation correctness matters) does get integration tests.

---

### Task 1: Add the `saree_mannequin_styles` table

**Files:**
- Modify: `packages/db/src/schema/models.ts`

- [ ] **Step 1: Add the table definition**

Open `packages/db/src/schema/models.ts`. Find the closing of the `workflowTemplates` table definition:

```ts
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Centralised pose image asset — single source of truth for poses, filtered by genderSlug.
// Replaces model_poses: no longer tied to garment type mappings.
export const modelPoseAssets = pgTable('model_pose_assets', {
```

Replace with (adds the new table between `workflowTemplates` and `modelPoseAssets`):

```ts
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Merchant-catalogue mannequin drape styles — orthogonal to garment_subcategories.
// Any style can generate any saree-eligible garment subcategory; each style just
// points at a different step-1 (mannequin) workflow template (different prompt/
// LoRA weights). See docs/superpowers/specs/2026-07-21-saree-mannequin-style-selection-design.md.
export const sareeMannequinStyles = pgTable('saree_mannequin_styles', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  previewImageKey: text('preview_image_key'),
  mannequinWorkflowTemplateId: uuid('mannequin_workflow_template_id')
    .notNull()
    .references(() => workflowTemplates.id),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Centralised pose image asset — single source of truth for poses, filtered by genderSlug.
// Replaces model_poses: no longer tied to garment type mappings.
export const modelPoseAssets = pgTable('model_pose_assets', {
```

- [ ] **Step 2: Typecheck the db package**

Run: `pnpm --filter @tryme/db exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 3: Generate the schema migration**

Run (from repo root, requires `DATABASE_URL` set / `pnpm docker:up` running):

```bash
pnpm --filter @tryme/db run generate
```

Expected: a new file `packages/db/src/migrations/0117_<name>.sql` containing a `CREATE TABLE "saree_mannequin_styles"` statement, and `packages/db/src/migrations/meta/_journal.json` gains an `idx: 117` entry.

- [ ] **Step 4: Generate the seed-data migration**

Run:

```bash
pnpm --filter @tryme/db run generate -- --custom --name=seed_saree_mannequin_style
```

Expected: an empty `packages/db/src/migrations/0118_seed_saree_mannequin_style.sql` file, journal gains an `idx: 118` entry.

- [ ] **Step 5: Write the seed SQL**

Open the new `0118_seed_saree_mannequin_style.sql` file (it will be empty) and write:

```sql
-- Seed one "Style 1" row matching whatever mannequin workflow saree garment
-- types already use in production, so existing merchants see one pre-selected
-- style and nothing changes for them until an admin adds "Style 2". No-op on
-- a fresh/empty database (nothing to seed from yet).
INSERT INTO saree_mannequin_styles (label, mannequin_workflow_template_id, sort_order, is_active)
SELECT 'Style 1', gs.mannequin_workflow_template_id, 0, true
FROM garment_subcategories gs
WHERE gs.requires_mannequin_step = true AND gs.mannequin_workflow_template_id IS NOT NULL
LIMIT 1;
```

- [ ] **Step 6: Apply the migrations locally**

Run: `pnpm db:migrate`
Expected: both new migrations apply without error (NOTICE-level output, if any, is fine).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/0117_*.sql packages/db/src/migrations/0118_seed_saree_mannequin_style.sql packages/db/src/migrations/meta/_journal.json packages/db/src/migrations/meta/0117_snapshot.json packages/db/src/migrations/meta/0118_snapshot.json
git commit -m "feat(db): add saree_mannequin_styles table"
```

---

### Task 2: Add the R2 key builder for style preview images

**Files:**
- Modify: `packages/storage/src/keys.ts`

- [ ] **Step 1: Add the key builder**

Open `packages/storage/src/keys.ts`. Find:

```ts
  supportAttachment: (id: string, ext: string) => `support/${id}.${ext}`,
};
```

Replace with:

```ts
  sareeStyle: (id: string) => `saree-styles/${id}.jpg`,
  supportAttachment: (id: string, ext: string) => `support/${id}.${ext}`,
};
```

- [ ] **Step 2: Typecheck the storage package**

Run: `pnpm --filter @tryme/storage exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add R2 key builder for saree style preview images"
```

---

### Task 3: Extend shared Zod types

**Files:**
- Modify: `packages/types/src/widget.ts`

- [ ] **Step 1: Add `sareeStyleId` to the generate body**

Find:

```ts
export const MerchantCatalogGenerateBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKey: z.string().min(1),
  // When true, skip the normal pose/background/face compositing (step 2) and
  // finalize the job with the mannequin-drape (step 1) output directly. Only
  // valid for garment types with requires_mannequin_step = true.
  mannequinOnly: z.boolean().optional(),
});
export type MerchantCatalogGenerateBody = z.infer<typeof MerchantCatalogGenerateBody>;
```

Replace with:

```ts
export const MerchantCatalogGenerateBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKey: z.string().min(1),
  // When true, skip the normal pose/background/face compositing (step 2) and
  // finalize the job with the mannequin-drape (step 1) output directly. Only
  // valid for garment types with requires_mannequin_step = true.
  mannequinOnly: z.boolean().optional(),
  // Selects which mannequin (step-1) workflow template generates this job.
  // Omitted = falls back to the garment type's own mannequinWorkflowTemplateId
  // (unchanged behavior). See saree_mannequin_styles.
  sareeStyleId: z.string().uuid().optional(),
});
export type MerchantCatalogGenerateBody = z.infer<typeof MerchantCatalogGenerateBody>;
```

- [ ] **Step 2: Add the merchant-facing style list schemas**

Find the end of the file (after `MerchantCatalogGenerateStatus`'s block) — locate:

```ts
export const MerchantCatalogGenerateStatus = z.object({
  jobId: z.string().uuid(),
  status: z.string(),
  resultUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
```

Read a few lines further to find where that object's definition ends (its closing `});` and `export type` line), then add immediately after that block:

```ts
export const MerchantSareeStyle = z.object({
  id: z.string().uuid(),
  label: z.string(),
  previewUrl: z.string().url().nullable(),
  sortOrder: z.number().int(),
});
export type MerchantSareeStyle = z.infer<typeof MerchantSareeStyle>;

export const MerchantSareeStyleListResponse = z.object({
  items: z.array(MerchantSareeStyle),
});
export type MerchantSareeStyleListResponse = z.infer<typeof MerchantSareeStyleListResponse>;
```

- [ ] **Step 3: Typecheck the types package**

Run: `pnpm --filter @tryme/types exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/widget.ts
git commit -m "feat(types): add sareeStyleId and merchant saree style schemas"
```

---

### Task 4: Accept `sareeStyleId` in `createMerchantSareeMannequinJob`

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts`

- [ ] **Step 1: Add the style lookup and param override**

Find (the full current function, `apps/api/src/modules/merchant/create-job.ts:192-252`):

```ts
export async function createMerchantSareeMannequinJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    flatImageKey: string;
    merchantId: string;
  },
): Promise<{ jobId: string }> {
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      isActive: schema.garmentSubcategories.isActive,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, params.garmentSubcategoryId))
    .limit(1);
  if (!garmentType?.isActive) {
    throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  }
  if (!garmentType.requiresMannequinStep || !garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('VALIDATION', 400, 'this garment type does not use the mannequin step');
  }

  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');

  const cost = await getTryonCreditCost(app);

  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: 'QUEUED',
      watermark: false,
      queueStream: 'normal',
      creditsCharged: cost,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: null,
      garmentTypeId: params.garmentSubcategoryId,
      params: { kind: 'saree_mannequin' },
    });
  });
```

Replace with:

```ts
export async function createMerchantSareeMannequinJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    flatImageKey: string;
    merchantId: string;
    sareeStyleId?: string;
  },
): Promise<{ jobId: string }> {
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      isActive: schema.garmentSubcategories.isActive,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, params.garmentSubcategoryId))
    .limit(1);
  if (!garmentType?.isActive) {
    throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  }
  if (!garmentType.requiresMannequinStep || !garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('VALIDATION', 400, 'this garment type does not use the mannequin step');
  }

  let styleWorkflowTemplateId: string | undefined;
  if (params.sareeStyleId) {
    const [style] = await app.db
      .select({
        isActive: schema.sareeMannequinStyles.isActive,
        mannequinWorkflowTemplateId: schema.sareeMannequinStyles.mannequinWorkflowTemplateId,
      })
      .from(schema.sareeMannequinStyles)
      .where(eq(schema.sareeMannequinStyles.id, params.sareeStyleId))
      .limit(1);
    if (!style?.isActive) {
      throw new AppError('BAD_STYLE', 400, 'saree style not found or inactive');
    }
    styleWorkflowTemplateId = style.mannequinWorkflowTemplateId;
  }

  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');

  const cost = await getTryonCreditCost(app);

  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: 'QUEUED',
      watermark: false,
      queueStream: 'normal',
      creditsCharged: cost,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: null,
      garmentTypeId: params.garmentSubcategoryId,
      params: {
        kind: 'saree_mannequin',
        ...(styleWorkflowTemplateId ? { workflowTemplateId: styleWorkflowTemplateId } : {}),
      },
    });
  });
```

(The `await app.redis.xadd(...)` and `return { jobId };` lines immediately after stay unchanged.)

- [ ] **Step 2: Typecheck the API package**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts
git commit -m "feat(api): accept sareeStyleId override in createMerchantSareeMannequinJob"
```

---

### Task 5: Wire `sareeStyleId` into the generate route, add the styles list route

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`

- [ ] **Step 1: Pass `sareeStyleId` through the generate handler**

Find:

```ts
      const { subcategoryId, flatImageKey, mannequinOnly } = req.body as z.infer<
        typeof MerchantCatalogGenerateBody
      >;
```

Replace with:

```ts
      const { subcategoryId, flatImageKey, mannequinOnly, sareeStyleId } = req.body as z.infer<
        typeof MerchantCatalogGenerateBody
      >;
```

Then find:

```ts
      const { jobId } = mannequinOnly
        ? await createMerchantSareeMannequinJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            flatImageKey,
            merchantId,
          })
        : await createMerchantCatalogJob(app, {
```

Replace with:

```ts
      const { jobId } = mannequinOnly
        ? await createMerchantSareeMannequinJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            flatImageKey,
            merchantId,
            sareeStyleId,
          })
        : await createMerchantCatalogJob(app, {
```

- [ ] **Step 2: Add the styles list route**

Find the start of the generate route:

```ts
  app.post(
    '/v1/merchant/catalog/generate',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBody } },
```

Insert immediately before it (still inside `merchantCatalogRoutes`):

```ts
  app.get(
    '/v1/merchant/catalog/saree-styles',
    { preHandler: app.requireMerchant },
    async () => {
      const rows = await app.db
        .select({
          id: schema.sareeMannequinStyles.id,
          label: schema.sareeMannequinStyles.label,
          previewImageKey: schema.sareeMannequinStyles.previewImageKey,
          sortOrder: schema.sareeMannequinStyles.sortOrder,
        })
        .from(schema.sareeMannequinStyles)
        .where(eq(schema.sareeMannequinStyles.isActive, true))
        .orderBy(schema.sareeMannequinStyles.sortOrder, schema.sareeMannequinStyles.label);

      const items = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          label: row.label,
          previewUrl: row.previewImageKey
            ? await app.storage
                .presignGet(row.previewImageKey, 3600)
                .then((result) => result.url)
                .catch(() => null)
            : null,
          sortOrder: row.sortOrder,
        })),
      );
      return { items };
    },
  );

  app.post(
    '/v1/merchant/catalog/generate',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBody } },
```

- [ ] **Step 3: Typecheck the API package**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts
git commit -m "feat(api): add GET /v1/merchant/catalog/saree-styles, wire sareeStyleId into generate"
```

---

### Task 6: Integration tests for `sareeStyleId`

**Files:**
- Modify: `apps/api/test/integration/merchant-catalog-generate.test.ts`

This file already has `seedFullDefaults`/`seedGarmentType` helpers and a `describe('merchant catalog generate (single, Path B)', ...)` block (the mannequin-only / Path B behavior lives here). Add a nested `describe` for style selection.

- [ ] **Step 1: Add a style-seeding helper**

Find:

```ts
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
```

Add immediately after it:

```ts
async function seedSareeStyle(
  app: TestApp,
  mannequinWorkflowTemplateId: string,
  isActive = true,
) {
  const [style] = await app.db
    .insert(schema.sareeMannequinStyles)
    .values({
      label: `Style ${randomUUID()}`,
      mannequinWorkflowTemplateId,
      isActive,
    })
    .returning();
  return style;
}

async function seedMannequinWorkflowTemplate(app: TestApp) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `saree-step1-${randomUUID()}`,
      label: 'Saree Step1',
      jsonContent: {
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
      },
      workflowType: 'saree_step1',
      faceNodeId: '',
      poseNodeId: '',
      bgNodeId: '',
      upperNodeIds: [],
      facePhasePromptNode: '',
      garmentPhasePromptNode: '',
      tryonPersonNodeId: '1',
      tryonGarmentNodeId: '2',
      tryonOutputNodeId: '10',
    })
    .returning();
  return wf;
}

async function seedMannequinOnlyGarmentType(app: TestApp, genderSlug: string) {
  const wf = await seedMannequinWorkflowTemplate(app);
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug,
      slug: `mannequin-type-${randomUUID()}`,
      label: 'Mannequin Type',
      requiresMannequinStep: true,
      mannequinWorkflowTemplateId: wf.id,
    })
    .returning();
  return { garmentType: row, defaultWorkflowTemplate: wf };
}
```

- [ ] **Step 2: Add the test block**

Find the end of the `bulk generate` nested `describe` block — the file's very last lines:

```ts
      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: unownedKeys },
      });
      expect(bulk.statusCode).toBe(400);
    });
  });
});
```

Replace the final `});\n});` (closing the `bulk generate` describe, then the outer describe) with a new `describe('sareeStyleId', ...)` block inserted between them:

```ts
      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: unownedKeys },
      });
      expect(bulk.statusCode).toBe(400);
    });
  });

  describe('sareeStyleId', () => {
    it('snapshots the style workflow template into job_inputs.params when provided', async () => {
      const { userId } = await createMerchant(app, 'style-happy@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, defaultWorkflowTemplate } = await seedMannequinOnlyGarmentType(
        app,
        'women',
      );
      const styleTemplate = await seedMannequinWorkflowTemplate(app);
      const style = await seedSareeStyle(app, styleTemplate.id);

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
        payload: { subcategoryId, flatImageKey, mannequinOnly: true, sareeStyleId: style.id },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(styleTemplate.id);
      expect(params.workflowTemplateId).not.toBe(defaultWorkflowTemplate.id);
    });

    it('falls back to the garment type default when sareeStyleId is omitted', async () => {
      const { userId } = await createMerchant(app, 'style-omitted@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');

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
        payload: { subcategoryId, flatImageKey, mannequinOnly: true },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBeUndefined();
    });

    it('rejects with 400 when sareeStyleId is inactive', async () => {
      const { userId } = await createMerchant(app, 'style-inactive@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');
      const styleTemplate = await seedMannequinWorkflowTemplate(app);
      const inactiveStyle = await seedSareeStyle(app, styleTemplate.id, false);

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg',
          mannequinOnly: true,
          sareeStyleId: inactiveStyle.id,
        },
      });
      expect(generate.statusCode).toBe(400);
    });
  });

  describe('GET /v1/merchant/catalog/saree-styles', () => {
    it('returns only active styles, ordered by sortOrder', async () => {
      const { userId } = await createMerchant(app, 'style-list@example.com');
      const auth = await authHeader(userId);
      const wf = await seedMannequinWorkflowTemplate(app);
      await app.db
        .insert(schema.sareeMannequinStyles)
        .values({ label: 'Zeta Style', mannequinWorkflowTemplateId: wf.id, sortOrder: 1 });
      await app.db
        .insert(schema.sareeMannequinStyles)
        .values({ label: 'Alpha Style', mannequinWorkflowTemplateId: wf.id, sortOrder: 0 });
      await app.db.insert(schema.sareeMannequinStyles).values({
        label: 'Hidden Style',
        mannequinWorkflowTemplateId: wf.id,
        isActive: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/merchant/catalog/saree-styles',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ label: string }> };
      expect(body.items.map((i) => i.label)).toEqual(['Alpha Style', 'Zeta Style']);
    });
  });
});
```

- [ ] **Step 3: Run the tests**

From `apps/api/`, temporarily lift the integration exclude to run this file directly (per this repo's `vitest.config.ts` gotcha — the `exclude: ['test/integration/**', ...]` in the base config blocks even explicit file args):

Run: `cd apps/api && node -e "const fs=require('fs');const p='vitest.config.ts';const s=fs.readFileSync(p,'utf8');fs.writeFileSync(p+'.bak',s);fs.writeFileSync(p,s.replace(\"'test/integration/**', \",''))"`

Then: `npx vitest run test/integration/merchant-catalog-generate.test.ts`
Expected: all tests in the file PASS, including the 4 new ones.

- [ ] **Step 4: Revert the temporary config edit**

Run: `mv vitest.config.ts.bak vitest.config.ts` (from `apps/api/`)
Then verify: `git diff --stat vitest.config.ts` from repo root — expect no output (clean).

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "test(api): cover sareeStyleId override and GET saree-styles"
```

---

### Task 7: Dispatcher — prefer the snapshotted workflow template override

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`

- [ ] **Step 1: Pass `rawParams` into `processSareeMannequinJob`**

Find the call site (inside `processJob`):

```ts
  if (!inputs.backgroundId && !inputs.poseId && rawParams.kind === 'saree_mannequin') {
    await processSareeMannequinJob(cfg, job, inputs, userId, stream, messageId, jobLog, startedAt);
    return;
  }
```

Replace with:

```ts
  if (!inputs.backgroundId && !inputs.poseId && rawParams.kind === 'saree_mannequin') {
    await processSareeMannequinJob(
      cfg,
      job,
      inputs,
      rawParams,
      userId,
      stream,
      messageId,
      jobLog,
      startedAt,
    );
    return;
  }
```

- [ ] **Step 2: Update the function signature and resolution logic**

Find:

```ts
async function processSareeMannequinJob(
  cfg: ProcessorConfig,
  job: SareeMannequinJob,
  inputs: typeof schema.jobInputs.$inferSelect,
  userId: string,
  stream: string,
  messageId: string,
  jobLog: Logger,
  startedAt: number,
): Promise<void> {
  const { db, redis, pub, s3, r2Bucket } = cfg;
  const jobId = job.id;

  const garmentKey = inputs.upperGarmentKey;
  const faceId = inputs.faceId;
  const garmentTypeId = inputs.garmentTypeId;

  if (!garmentKey || !garmentTypeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }

  const [garmentType] = await db
    .select({
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, garmentTypeId));
  const workflowTemplateId = garmentType?.mannequinWorkflowTemplateId;
  if (!workflowTemplateId) {
```

Replace with:

```ts
async function processSareeMannequinJob(
  cfg: ProcessorConfig,
  job: SareeMannequinJob,
  inputs: typeof schema.jobInputs.$inferSelect,
  rawParams: Record<string, unknown>,
  userId: string,
  stream: string,
  messageId: string,
  jobLog: Logger,
  startedAt: number,
): Promise<void> {
  const { db, redis, pub, s3, r2Bucket } = cfg;
  const jobId = job.id;

  const garmentKey = inputs.upperGarmentKey;
  const faceId = inputs.faceId;
  const garmentTypeId = inputs.garmentTypeId;

  if (!garmentKey || !garmentTypeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }

  // A saree style, if the merchant picked one, snapshots its own mannequin
  // workflow template ID directly into params — takes precedence over the
  // garment type's default. See createMerchantSareeMannequinJob.
  const snapshottedWorkflowTemplateId =
    typeof rawParams.workflowTemplateId === 'string' ? rawParams.workflowTemplateId : null;

  let workflowTemplateId = snapshottedWorkflowTemplateId;
  if (!workflowTemplateId) {
    const [garmentType] = await db
      .select({
        mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    workflowTemplateId = garmentType?.mannequinWorkflowTemplateId ?? null;
  }
  if (!workflowTemplateId) {
```

- [ ] **Step 3: Typecheck the dispatcher package**

Run: `pnpm --filter @tryme/dispatcher exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): prefer snapshotted workflow template override for saree mannequin jobs"
```

---

### Task 8: Dispatcher integration test for the override

**Files:**
- Modify: `apps/dispatcher/test/integration/saree-mannequin.test.ts`

- [ ] **Step 1: Add the test**

Find the end of the file:

```ts
    const prompt = comfy.lastPrompt();
    // Garment node was patched with the uploaded file; no person node exists to patch.
    expect(prompt?.prompt['2']?.inputs?.image).toBeTruthy();
  });
});
```

Replace with:

```ts
    const prompt = comfy.lastPrompt();
    // Garment node was patched with the uploaded file; no person node exists to patch.
    expect(prompt?.prompt['2']?.inputs?.image).toBeTruthy();
  });

  it('uses the snapshotted style workflow template instead of the garment type default', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-style-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [defaultTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-default-${Date.now()}`,
        label: 'Step1 Default',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [styleTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-style-${Date.now()}`,
        label: 'Step1 Style',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-style-${Date.now()}`,
        label: 'Flat Saree Style',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: defaultTemplate.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'F', r2Key: 'face/fstyle.jpg', thumbnailKey: 'face/fstyle.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      faceId: face.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin', workflowTemplateId: styleTemplate.id },
    });

    for (const key of [`inputs/${job.id}/garment.jpg`, 'face/fstyle.jpg']) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-3',
    );

    const [completedJob] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(completedJob?.status).toBe('COMPLETED');

    const [dispatchEvent] = await env.db
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id));
    expect((dispatchEvent?.payload as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      styleTemplate.id,
    );
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @tryme/dispatcher test -- saree-mannequin`
Expected: all tests in `saree-mannequin.test.ts` PASS, including the new one.

- [ ] **Step 3: Commit**

```bash
git add apps/dispatcher/test/integration/saree-mannequin.test.ts
git commit -m "test(dispatcher): cover saree mannequin style workflow override"
```

---

### Task 9: Admin CRUD for saree styles

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts`

- [ ] **Step 1: Add the routes**

Find the end of the file:

```ts
    emit({
      done: true,
      created: { faces: createdFaces, backgrounds: createdBackgrounds, poses: createdPoses },
      errors,
    });
    reply.raw.end();
  });
}
```

Replace with (adds the new routes right before the function's closing brace):

```ts
    emit({
      done: true,
      created: { faces: createdFaces, backgrounds: createdBackgrounds, poses: createdPoses },
      errors,
    });
    reply.raw.end();
  });

  // ── Saree Mannequin Styles ──────────────────────────────────────────────

  app.get('/admin/assets/saree-styles', { preHandler: RW }, async () => {
    const rows = await app.db
      .select()
      .from(schema.sareeMannequinStyles)
      .orderBy(schema.sareeMannequinStyles.sortOrder, schema.sareeMannequinStyles.label);
    return { items: rows };
  });

  app.post(
    '/admin/assets/saree-styles/presign',
    { preHandler: RW, schema: { body: z.object({ contentType: AssetContentType }) } },
    async (req) => {
      const { contentType } = req.body as { contentType: string };
      const r2Key = keys.sareeStyle(randomUUID());
      const presign = await app.storage.presignPut(r2Key, contentType, 5_000_000, 300);
      return { r2Key, uploadUrl: presign.url };
    },
  );

  app.post(
    '/admin/assets/saree-styles',
    {
      preHandler: RW,
      schema: {
        body: z.object({
          label: z.string().min(1),
          previewImageKey: z.string().optional(),
          mannequinWorkflowTemplateId: z.string().uuid(),
          sortOrder: z.number().int().optional(),
          isActive: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        label: string;
        previewImageKey?: string;
        mannequinWorkflowTemplateId: string;
        sortOrder?: number;
        isActive?: boolean;
      };
      const [inserted] = await app.db
        .insert(schema.sareeMannequinStyles)
        .values({
          label: body.label,
          previewImageKey: body.previewImageKey ?? null,
          mannequinWorkflowTemplateId: body.mannequinWorkflowTemplateId,
          sortOrder: body.sortOrder ?? 0,
          isActive: body.isActive ?? true,
        })
        .returning();
      reply.code(201);
      return inserted;
    },
  );

  app.patch(
    '/admin/assets/saree-styles/:id',
    {
      preHandler: RW,
      schema: {
        params: uuidParam,
        body: z.object({
          label: z.string().min(1).optional(),
          previewImageKey: z.string().optional(),
          mannequinWorkflowTemplateId: z.string().uuid().optional(),
          sortOrder: z.number().int().optional(),
          isActive: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        label?: string;
        previewImageKey?: string;
        mannequinWorkflowTemplateId?: string;
        sortOrder?: number;
        isActive?: boolean;
      };
      const [updated] = await app.db
        .update(schema.sareeMannequinStyles)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.sareeMannequinStyles.id, id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', 404, 'saree style not found');
      return updated;
    },
  );
}
```

- [ ] **Step 2: Typecheck the API package**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts
git commit -m "feat(admin): add saree-styles CRUD routes"
```

---

### Task 10: Admin-web — types and the Saree Styles tab

**Files:**
- Modify: `apps/admin-web/src/types.ts`
- Create: `apps/admin-web/src/pages/assets/SareeStylesTab.tsx`
- Modify: `apps/admin-web/src/pages/AssetsPage.tsx`

- [ ] **Step 1: Add the type**

Open `apps/admin-web/src/types.ts`. Find the `ModelPoseAsset` interface's closing brace:

```ts
export interface ModelPoseAsset {
  id: string;
  label: string;
  displayName: string | null;
  r2Key: string;
  thumbnailKey: string;
  genderSlug: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  promptFacePhase: string | null;
  poseVariant: string | null;
  shotType: 'full' | 'half' | 'closeup' | null;
  scope: 'general' | 'template';
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
}
```

Add immediately after it:

```ts
export interface SareeMannequinStyle {
  id: string;
  label: string;
  previewImageKey: string | null;
  mannequinWorkflowTemplateId: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the tab component**

Create `apps/admin-web/src/pages/assets/SareeStylesTab.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { AssetThumb } from '../../components/AssetThumb';
import { Icon } from '../../components/Icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch, UPLOAD_NETWORK_ERROR, uploadErrorMessage } from '../../lib/data';
import type { SareeMannequinStyle, WorkflowOption } from '../../types';
import { useAssetsContext } from './AssetsContext';

interface PresignResult {
  r2Key: string;
  uploadUrl: string;
}

function putFile(url: string, file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(uploadErrorMessage(xhr.status)));
    xhr.onerror = () => reject(new Error(UPLOAD_NETWORK_ERROR));
    xhr.send(file);
  });
}

function StyleModal({
  existing,
  workflows,
  storagePublicUrl,
  onSaved,
  onClose,
  toast,
}: {
  existing: SareeMannequinStyle | null;
  workflows: WorkflowOption[];
  storagePublicUrl: string | null;
  onSaved: (style: SareeMannequinStyle) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [workflowTemplateId, setWorkflowTemplateId] = useState(
    existing?.mannequinWorkflowTemplateId ?? workflows[0]?.id ?? '',
  );
  const [sortOrder, setSortOrder] = useState(existing?.sortOrder ?? 0);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const save = async () => {
    if (!label.trim() || !workflowTemplateId) return;
    setSaving(true);
    try {
      let previewImageKey = existing?.previewImageKey ?? undefined;
      if (file) {
        const presign = await apiFetch<PresignResult>('/admin/assets/saree-styles/presign', {
          method: 'POST',
          body: JSON.stringify({ contentType: file.type }),
        });
        await putFile(presign.uploadUrl, file);
        previewImageKey = presign.r2Key;
      }
      const body = {
        label: label.trim(),
        previewImageKey,
        mannequinWorkflowTemplateId: workflowTemplateId,
        sortOrder,
        isActive,
      };
      const saved = existing
        ? await apiFetch<SareeMannequinStyle>(`/admin/assets/saree-styles/${existing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiFetch<SareeMannequinStyle>('/admin/assets/saree-styles', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      toast({ title: existing ? 'Style updated' : 'Style created' });
      onSaved(saved);
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: existing ? 'Failed to update style' : 'Failed to create style',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3>{existing ? 'Edit style' : 'New saree style'}</h3>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            Label
            <input
              className="input"
              value={label}
              disabled={saving}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Style 1"
            />
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {previewUrl ? (
              // biome-ignore lint/performance/noImgElement: admin panel
              <img
                src={previewUrl}
                alt=""
                style={{ width: 72, height: 92, objectFit: 'cover', borderRadius: 8 }}
              />
            ) : (
              <AssetThumb
                thumbnailKey={existing?.previewImageKey ?? undefined}
                r2Key={existing?.previewImageKey ?? undefined}
                label={label || 'Style'}
                storageBase={storagePublicUrl}
                w={72}
                h={92}
              />
            )}
            <button
              type="button"
              className="btn sm"
              disabled={saving}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon.Upload /> {existing?.previewImageKey || file ? 'Replace image' : 'Upload image'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            Mannequin workflow
            <SearchableSelect
              options={workflows}
              value={workflowTemplateId}
              disabled={saving}
              onChange={setWorkflowTemplateId}
              placeholder="— search workflow —"
            />
          </label>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              Sort order
              <input
                type="number"
                className="input"
                style={{ width: 90 }}
                value={sortOrder}
                disabled={saving}
                onChange={(e) => setSortOrder(Number(e.target.value))}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              Active
              <Switch checked={isActive} onChange={() => setIsActive((v) => !v)} />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={saving || !label.trim() || !workflowTemplateId} onClick={save}>
            {saving ? 'Saving…' : existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SareeStylesTab() {
  const { storagePublicUrl, toast } = useAssetsContext();
  const [styles, setStyles] = useState<SareeMannequinStyle[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SareeMannequinStyle | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [stylesRes, wfRes] = await Promise.all([
        apiFetch<{ items: SareeMannequinStyle[] }>('/admin/assets/saree-styles'),
        apiFetch<WorkflowOption[]>('/admin/workflows'),
      ]);
      setStyles(stylesRes.items);
      setWorkflows(wfRes.filter((w) => w.workflowType === 'saree_step1' && w.isActive));
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to load saree styles',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // biome-ignore lint/correctness/useExhaustiveDependencies: load on mount only
  }, []);

  const toggleActive = async (style: SareeMannequinStyle) => {
    const next = !style.isActive;
    setStyles((prev) => prev.map((s) => (s.id === style.id ? { ...s, isActive: next } : s)));
    try {
      await apiFetch(`/admin/assets/saree-styles/${style.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
    } catch (e) {
      setStyles((prev) => prev.map((s) => (s.id === style.id ? style : s)));
      toast({
        kind: 'error',
        title: 'Failed to update style',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Saree Mannequin Styles</h1>
          <p className="lede">
            Draping styles the merchant catalogue app lets merchants pick before generating —
            each one runs a different mannequin (step-1) workflow.
          </p>
        </div>
        <div className="head-tools">
          <button
            className="btn"
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
          >
            <Icon.Add /> New style
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)', marginTop: 24 }}>Loading…</p>
      ) : styles.length === 0 ? (
        <p style={{ color: 'var(--muted)', marginTop: 24 }}>No saree styles yet.</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          {styles.map((s) => (
            <div
              key={s.id}
              className="card"
              style={{ padding: 12, opacity: s.isActive ? 1 : 0.55 }}
            >
              <AssetThumb
                thumbnailKey={s.previewImageKey ?? undefined}
                r2Key={s.previewImageKey ?? undefined}
                label={s.label}
                storageBase={storagePublicUrl}
                w={160}
                h={200}
              />
              <p style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{s.label}</p>
              <p style={{ fontSize: 10, color: 'var(--muted)' }}>
                {workflows.find((w) => w.id === s.mannequinWorkflowTemplateId)?.label ?? '—'}
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 8,
                }}
              >
                <Switch checked={s.isActive} onChange={() => void toggleActive(s)} />
                <button
                  className="btn ghost"
                  style={{ fontSize: 10, padding: '3px 8px' }}
                  onClick={() => {
                    setEditing(s);
                    setShowModal(true);
                  }}
                >
                  <Icon.Edit /> Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <StyleModal
          existing={editing}
          workflows={workflows}
          storagePublicUrl={storagePublicUrl}
          onSaved={(saved) => {
            setStyles((prev) => {
              const exists = prev.some((s) => s.id === saved.id);
              return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [...prev, saved];
            });
          }}
          onClose={() => setShowModal(false)}
          toast={toast}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Register the tab**

Open `apps/admin-web/src/pages/AssetsPage.tsx`. Find:

```tsx
import { GarmentTypesTab } from './assets/GarmentTypesTab';
import { PoseAssetsTab } from './assets/PoseAssetsTab';
```

Replace with:

```tsx
import { GarmentTypesTab } from './assets/GarmentTypesTab';
import { PoseAssetsTab } from './assets/PoseAssetsTab';
import { SareeStylesTab } from './assets/SareeStylesTab';
```

Find:

```tsx
const TABS = [
  { k: 'garment-types' as const, l: 'Garment Types' },
  { k: 'faces' as const, l: 'Model Faces' },
  { k: 'backgrounds' as const, l: 'Backgrounds' },
  { k: 'pose-assets' as const, l: 'Pose Assets' },
  { k: 'lower' as const, l: 'Lower garments' },
  { k: 'shoe' as const, l: 'Shoes' },
  { k: 'catalogue-templates' as const, l: 'Templates' },
];
```

Replace with:

```tsx
const TABS = [
  { k: 'garment-types' as const, l: 'Garment Types' },
  { k: 'faces' as const, l: 'Model Faces' },
  { k: 'backgrounds' as const, l: 'Backgrounds' },
  { k: 'pose-assets' as const, l: 'Pose Assets' },
  { k: 'lower' as const, l: 'Lower garments' },
  { k: 'shoe' as const, l: 'Shoes' },
  { k: 'catalogue-templates' as const, l: 'Templates' },
  { k: 'saree-styles' as const, l: 'Saree Styles' },
];
```

Find:

```tsx
      {activeTab === 'catalogue-templates' && <CatalogueTemplatesTab />}
```

Replace with:

```tsx
      {activeTab === 'catalogue-templates' && <CatalogueTemplatesTab />}
      {activeTab === 'saree-styles' && <SareeStylesTab />}
```

- [ ] **Step 4: Typecheck the admin-web package**

Run: `pnpm --filter @tryme/admin exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/assets/SareeStylesTab.tsx apps/admin-web/src/pages/AssetsPage.tsx
git commit -m "feat(admin-web): add Saree Styles asset tab"
```

---

### Task 11: Android — endpoint constant, models, repository

**Files:**
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIConstant.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogModels.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogRepository.kt`

- [ ] **Step 1: Add the endpoint constant**

Open `APIConstant.kt`. Find:

```kotlin
        const val MERCHANT_CATALOG_SUBCATEGORIES = "v1/merchant/catalog/subcategories"
```

Replace with:

```kotlin
        const val MERCHANT_CATALOG_SUBCATEGORIES = "v1/merchant/catalog/subcategories"
        const val MERCHANT_CATALOG_SAREE_STYLES = "v1/merchant/catalog/saree-styles"
```

- [ ] **Step 2: Add the data models**

Open `MerchantCatalogModels.kt`. Find:

```kotlin
@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogPresignResponse(@JsonProperty("assetId") val assetId: String = "", @JsonProperty("uploadUrl") val uploadUrl: String = "", @JsonProperty("r2Key") val r2Key: String = "")
```

Replace with:

```kotlin
@JsonIgnoreProperties(ignoreUnknown = true)
data class SareeStyle(@JsonProperty("id") val id: String = "", @JsonProperty("label") val label: String = "", @JsonProperty("previewUrl") val previewUrl: String? = null, @JsonProperty("sortOrder") val sortOrder: Int = 0) : Serializable
@JsonIgnoreProperties(ignoreUnknown = true)
data class SareeStyleListResponse(@JsonProperty("items") val items: List<SareeStyle> = emptyList())

@JsonIgnoreProperties(ignoreUnknown = true)
data class MerchantCatalogPresignResponse(@JsonProperty("assetId") val assetId: String = "", @JsonProperty("uploadUrl") val uploadUrl: String = "", @JsonProperty("r2Key") val r2Key: String = "")
```

- [ ] **Step 3: Add `fetchSareeStyles` and update `generate`**

Open `MerchantCatalogRepository.kt`. Find:

```kotlin
    suspend fun generate(subcategoryId: String, flatImageKey: String): String {
        // This app only ever generates saree catalog images — skip the normal pose/
        // background/face compositing step and finalize with the mannequin-drape
        // output directly (see createMerchantSareeMannequinJob on the API side).
        val body = org.json.JSONObject().apply {
            put("subcategoryId", subcategoryId)
            put("flatImageKey", flatImageKey)
            put("mannequinOnly", true)
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_GENERATE, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateResponse::class.java).jobId
    }
```

Replace with:

```kotlin
    suspend fun fetchSareeStyles(): List<SareeStyle> {
        val response = APICaller.getJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_SAREE_STYLES, PrefsManager.getAccessToken())
        return mapper.readValue(response, SareeStyleListResponse::class.java).items
    }

    suspend fun generate(subcategoryId: String, flatImageKey: String, sareeStyleId: String?): String {
        // This app only ever generates saree catalog images — skip the normal pose/
        // background/face compositing step and finalize with the mannequin-drape
        // output directly (see createMerchantSareeMannequinJob on the API side).
        val body = org.json.JSONObject().apply {
            put("subcategoryId", subcategoryId)
            put("flatImageKey", flatImageKey)
            put("mannequinOnly", true)
            if (sareeStyleId != null) put("sareeStyleId", sareeStyleId)
        }.toString()
        val response = APICaller.postJsonAuthed(APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_GENERATE, body, PrefsManager.getAccessToken())
        return mapper.readValue(response, MerchantCatalogGenerateResponse::class.java).jobId
    }
```

- [ ] **Step 4: Compile**

Run (from `apps/saree_catalogue_android/`): `./gradlew compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`. (This will fail until Task 12 updates the only caller of `generate()` — if so, proceed to Task 12 first, then come back and run this check at the end of Task 12 instead.)

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/tryme/nice/trymeadmin/ApiUtils/APIConstant.kt app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogModels.kt app/src/main/java/tryme/nice/trymeadmin/viewmodels/MerchantCatalogRepository.kt
git commit -m "feat(saree-android): add saree style endpoint, models, repository methods"
```

(Run this `git add`/`git commit` from `apps/saree_catalogue_android/` — it is its own git checkout, same remote as the monorepo root, per this repo's sparse-checkout setup for Android collaborators.)

---

### Task 12: Android — ViewModel and dialog wiring

**Files:**
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/dialog/UploadPhotoDialog.kt`

- [ ] **Step 1: Add `sareeStyles` LiveData and fetch method**

Open `ProductUploadViewModel.kt`. Find:

```kotlin
    private val _subcategories = MutableLiveData<List<MerchantCatalogSubcategory>>()
    val subcategories: LiveData<List<MerchantCatalogSubcategory>> get() = _subcategories
```

Replace with:

```kotlin
    private val _subcategories = MutableLiveData<List<MerchantCatalogSubcategory>>()
    val subcategories: LiveData<List<MerchantCatalogSubcategory>> get() = _subcategories
    private val _sareeStyles = MutableLiveData<List<SareeStyle>>()
    val sareeStyles: LiveData<List<SareeStyle>> get() = _sareeStyles
    fun fetchSareeStyles() { viewModelScope.launch { try { _sareeStyles.postValue(MerchantCatalogRepository.fetchSareeStyles()) } catch (e: Exception) { _error.postValue(AuthRepository.errorMessage(e)) } } }
```

- [ ] **Step 2: Thread `sareeStyleId` through `generateProduct`**

Find:

```kotlin
    fun generateProduct(file: java.io.File, subcategoryId: String) {
        viewModelScope.launch {
            try {
                _generateState.postValue(GenerateState.Uploading)
                val contentType = "image/jpeg"
                val presign = MerchantCatalogRepository.presignFlatImage(contentType, file.length())
                MerchantCatalogRepository.uploadFlatImage(presign.uploadUrl, file, contentType)

                _generateState.postValue(GenerateState.Generating)
                val jobId = MerchantCatalogRepository.generate(subcategoryId, presign.r2Key)
```

Replace with:

```kotlin
    fun generateProduct(file: java.io.File, subcategoryId: String, sareeStyleId: String?) {
        viewModelScope.launch {
            try {
                _generateState.postValue(GenerateState.Uploading)
                val contentType = "image/jpeg"
                val presign = MerchantCatalogRepository.presignFlatImage(contentType, file.length())
                MerchantCatalogRepository.uploadFlatImage(presign.uploadUrl, file, contentType)

                _generateState.postValue(GenerateState.Generating)
                val jobId = MerchantCatalogRepository.generate(subcategoryId, presign.r2Key, sareeStyleId)
```

- [ ] **Step 3: Update `UploadPhotoDialog` to accept and pass through the style id**

Open `UploadPhotoDialog.kt`. Find:

```kotlin
class UploadPhotoDialog(private  val selectedPhotoPath:String,
                        private  val subcategoryId:String,
                        private val onCompleted:(String)->Unit) : BottomSheetDialogFragment() {
```

Replace with:

```kotlin
class UploadPhotoDialog(private  val selectedPhotoPath:String,
                        private  val subcategoryId:String,
                        private  val sareeStyleId:String?,
                        private val onCompleted:(String)->Unit) : BottomSheetDialogFragment() {
```

Find:

```kotlin
        productUploadViewmodel.generateProduct(File(selectedPhotoPath), subcategoryId)
```

Replace with:

```kotlin
        productUploadViewmodel.generateProduct(File(selectedPhotoPath), subcategoryId, sareeStyleId)
```

- [ ] **Step 4: Compile**

Run (from `apps/saree_catalogue_android/`): `./gradlew compileDebugKotlin`
Expected: build fails only on `UploadVastraFragment.kt`'s `UploadPhotoDialog(...)` construction (missing the new `sareeStyleId` argument) — that's fixed in Task 13. If any other error appears, stop and re-check this task's edits.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/tryme/nice/trymeadmin/viewmodels/ProductUploadViewModel.kt app/src/main/java/tryme/nice/trymeadmin/dialog/UploadPhotoDialog.kt
git commit -m "feat(saree-android): thread sareeStyleId through ViewModel and upload dialog"
```

---

### Task 13: Android — style card layout resources

**Files:**
- Create: `apps/saree_catalogue_android/app/src/main/res/drawable/bg_style_card_selected.xml`
- Create: `apps/saree_catalogue_android/app/src/main/res/drawable/bg_style_card_unselected.xml`
- Create: `apps/saree_catalogue_android/app/src/main/res/layout/item_saree_style.xml`

- [ ] **Step 1: Selected-state card background**

Create `apps/saree_catalogue_android/app/src/main/res/drawable/bg_style_card_selected.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="@color/white" />
    <corners android:radius="8dp" />
    <stroke android:width="2dp" android:color="@color/gradient_center" />
</shape>
```

- [ ] **Step 2: Unselected-state card background**

Create `apps/saree_catalogue_android/app/src/main/res/drawable/bg_style_card_unselected.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="@color/white" />
    <corners android:radius="8dp" />
    <stroke android:width="1dp" android:color="@color/light_gray" />
</shape>
```

- [ ] **Step 3: Style card item layout**

Create `apps/saree_catalogue_android/app/src/main/res/layout/item_saree_style.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    android:id="@+id/ll_style_card"
    android:layout_width="@dimen/_70sdp"
    android:layout_height="wrap_content"
    android:orientation="vertical"
    android:gravity="center"
    android:padding="@dimen/_4sdp"
    android:background="@drawable/bg_style_card_unselected">

    <ImageView
        android:id="@+id/img_style_preview"
        android:layout_width="@dimen/_60sdp"
        android:layout_height="@dimen/_70sdp"
        android:scaleType="centerCrop"
        android:background="@color/light_gray" />

    <TextView
        android:id="@+id/tv_style_label"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_marginTop="@dimen/_4sdp"
        android:textColor="@color/black"
        android:fontFamily="@font/popins_medium"
        android:textSize="@dimen/_10ssp"
        android:maxLines="1"
        android:ellipsize="end"
        tools:text="Style 1" />

</LinearLayout>
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/res/drawable/bg_style_card_selected.xml app/src/main/res/drawable/bg_style_card_unselected.xml app/src/main/res/layout/item_saree_style.xml
git commit -m "feat(saree-android): add saree style card layout resources"
```

---

### Task 14: Android — add the style row to the upload screen and wire selection

**Files:**
- Modify: `apps/saree_catalogue_android/app/src/main/res/layout/fragment_upload_vastra.xml`
- Modify: `apps/saree_catalogue_android/app/src/main/java/tryme/nice/trymeadmin/fragment/UploadVastraFragment.kt`

- [ ] **Step 1: Insert the style-card row above the subcategory dropdown**

Open `fragment_upload_vastra.xml`. Find:

```xml
            <com.google.android.material.textfield.TextInputLayout
                android:id="@+id/spinnerLayoutPalluType"
```

Replace with (adds a new `HorizontalScrollView` immediately before it):

```xml
            <HorizontalScrollView
                android:id="@+id/hsv_saree_styles"
                android:layout_width="@dimen/_220sdp"
                android:layout_height="wrap_content"
                android:layout_gravity="center"
                android:layout_marginTop="@dimen/_10sdp"
                android:scrollbars="none">

                <LinearLayout
                    android:id="@+id/ll_saree_styles"
                    android:layout_width="wrap_content"
                    android:layout_height="wrap_content"
                    android:orientation="horizontal" />

            </HorizontalScrollView>

            <com.google.android.material.textfield.TextInputLayout
                android:id="@+id/spinnerLayoutPalluType"
```

- [ ] **Step 2: Add imports and the selection field**

Open `UploadVastraFragment.kt`. Find:

```kotlin
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
```

Replace with:

```kotlin
import tryme.nice.trymeadmin.viewmodels.MerchantCatalogSubcategory
import tryme.nice.trymeadmin.viewmodels.ProductUploadViewModel
import tryme.nice.trymeadmin.viewmodels.SareeStyle
```

Find:

```kotlin
    private var selectedSubcategoryId: String? = null
```

Replace with:

```kotlin
    private var selectedSubcategoryId: String? = null
    private var selectedStyleId: String? = null
```

- [ ] **Step 3: Fetch styles on init**

Find:

```kotlin
        binding.llSamplePhoto.post {
            val h = binding.llSamplePhoto.height
            val params = binding.llTitle.layoutParams
            params.height = h
            binding.llTitle.layoutParams = params
        }
        getSubcategoryData()
    }
```

Replace with:

```kotlin
        binding.llSamplePhoto.post {
            val h = binding.llSamplePhoto.height
            val params = binding.llTitle.layoutParams
            params.height = h
            binding.llTitle.layoutParams = params
        }
        getSubcategoryData()
        getSareeStyleData()
    }
```

- [ ] **Step 4: Add the fetch + card-building methods**

Find:

```kotlin
    private fun getSubcategoryData(){
        productUploadViewmodel.fetchSubcategories("women")
        productUploadViewmodel.subcategories.observe(viewLifecycleOwner){subcategoryList->
            if(subcategoryList!=null && subcategoryList.isNotEmpty()){
                setSubcategorySpinner(subcategoryList)
            }
        }
        productUploadViewmodel.error.observe(viewLifecycleOwner){errorMsg->
            if(errorMsg!=null){
                ViewControll.showSnackErrorMsg(requireActivity(),errorMsg)
            }
        }
    }
```

Replace with:

```kotlin
    private fun getSubcategoryData(){
        productUploadViewmodel.fetchSubcategories("women")
        productUploadViewmodel.subcategories.observe(viewLifecycleOwner){subcategoryList->
            if(subcategoryList!=null && subcategoryList.isNotEmpty()){
                setSubcategorySpinner(subcategoryList)
            }
        }
        productUploadViewmodel.error.observe(viewLifecycleOwner){errorMsg->
            if(errorMsg!=null){
                ViewControll.showSnackErrorMsg(requireActivity(),errorMsg)
            }
        }
    }

    private fun getSareeStyleData(){
        productUploadViewmodel.fetchSareeStyles()
        productUploadViewmodel.sareeStyles.observe(viewLifecycleOwner){styleList->
            if(styleList!=null){
                setSareeStyleCards(styleList)
            }
        }
    }

    // No styles configured yet (admin hasn't added any) is a valid state — the
    // merchant app keeps working, generate() just omits sareeStyleId and the
    // backend falls back to the garment type's own mannequin workflow.
    private fun setSareeStyleCards(styleList: List<SareeStyle>) {
        binding.llSareeStyles.removeAllViews()
        if (styleList.size <= 1) {
            binding.hsvSareeStyles.isVisible = false
            selectedStyleId = styleList.firstOrNull()?.id
            return
        }
        binding.hsvSareeStyles.isVisible = true
        val inflater = LayoutInflater.from(requireActivity())
        val cardViews = mutableListOf<View>()
        styleList.forEachIndexed { index, style ->
            val card = inflater.inflate(R.layout.item_saree_style, binding.llSareeStyles, false)
            val img = card.findViewById<ImageView>(R.id.img_style_preview)
            val label = card.findViewById<TextView>(R.id.tv_style_label)
            label.text = style.label
            if (style.previewUrl != null) {
                Glide.with(requireActivity()).load(style.previewUrl).into(img)
            }
            card.setOnClickListener {
                selectedStyleId = style.id
                cardViews.forEach { c -> c.setBackgroundResource(R.drawable.bg_style_card_unselected) }
                card.setBackgroundResource(R.drawable.bg_style_card_selected)
            }
            if (index == 0) {
                selectedStyleId = style.id
                card.setBackgroundResource(R.drawable.bg_style_card_selected)
            }
            (card.layoutParams as? ViewGroup.MarginLayoutParams)?.marginEnd =
                resources.getDimensionPixelSize(R.dimen._8sdp)
            cardViews.add(card)
            binding.llSareeStyles.addView(card)
        }
    }
```

- [ ] **Step 5: Add the `ImageView`/`TextView` imports**

Find:

```kotlin
import android.util.Log
import android.widget.ArrayAdapter
import android.widget.Toast
```

Replace with:

```kotlin
import android.util.Log
import android.widget.ArrayAdapter
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
```

- [ ] **Step 6: Pass the selected style into the upload dialog**

Find:

```kotlin
        val uploadPhotoDialog = UploadPhotoDialog(capturePhotoFilePath, subcategoryId) { resultUrl ->
```

Replace with:

```kotlin
        val uploadPhotoDialog = UploadPhotoDialog(capturePhotoFilePath, subcategoryId, selectedStyleId) { resultUrl ->
```

- [ ] **Step 7: Compile**

Run (from `apps/saree_catalogue_android/`): `./gradlew compileDebugKotlin`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 8: Assemble the debug APK**

Run: `./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 9: Commit**

```bash
git add app/src/main/res/layout/fragment_upload_vastra.xml app/src/main/java/tryme/nice/trymeadmin/fragment/UploadVastraFragment.kt
git commit -m "feat(saree-android): add style picker to the upload screen"
```

---

### Task 15: Full verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full typecheck**

Run (from repo root): `pnpm typecheck`
Expected: all packages report success, no errors.

- [ ] **Step 2: Full lint**

Run: `pnpm biome check . --diagnostic-level=error`
Expected: no errors.

- [ ] **Step 3: Full API test suite (unit + the touched integration files)**

Run: `pnpm --filter @tryme/api test:unit`
Expected: all pass.

Then re-run the full integration pass for the touched file (same temporary-config-lift procedure as Task 6, Steps 3–4):

```bash
cd apps/api
node -e "const fs=require('fs');const p='vitest.config.ts';const s=fs.readFileSync(p,'utf8');fs.writeFileSync(p+'.bak',s);fs.writeFileSync(p,s.replace(\"'test/integration/**', \",''))"
npx vitest run test/integration/merchant-catalog-generate.test.ts test/integration/merchant-catalog-subcategories.test.ts test/integration/merchant-catalog.test.ts
mv vitest.config.ts.bak vitest.config.ts
cd ../..
git status --short apps/api/vitest.config.ts
```

Expected: all tests pass; final `git status --short` line prints nothing (config reverted cleanly).

- [ ] **Step 4: Full dispatcher test suite**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: all tests pass, no regressions elsewhere in the suite.

- [ ] **Step 5: Android release-mode compile sanity check**

Run (from `apps/saree_catalogue_android/`): `./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL` (re-confirms Task 14's build after all other Android edits are in place).

- [ ] **Step 6: Confirm both working trees are clean**

Run: `git status --short` (repo root)
Run: `git status --short` (from `apps/saree_catalogue_android/`)
Expected: no output from either — everything committed.

---

## Manual walkthrough (after merging/deploying, not part of this plan's automated tasks)

1. In the admin panel → Assets → Saree Styles, create at least 2 styles, each pointing at a different `saree_step1` workflow template, with a preview image.
2. On the merchant Android app: open the upload screen, confirm the new style-card row appears above the subcategory dropdown (only if 2+ active styles exist), confirm one is pre-selected.
3. Pick a subcategory, pick Style 2, generate — confirm in `job_events` (or admin job inspector) that `COMFY_DISPATCH`'s `payload.workflowTemplateId` matches Style 2's workflow, not the garment type's default.
4. Repeat with Style 1 — confirm a visibly different pallu drape between the two results.
5. Deactivate a style in the admin panel, confirm it disappears from the app's picker on next load.

## Explicitly out of scope (accepted trade-offs, not gaps to fix here)

- Per-subcategory style restriction (styles are global, offered for every saree-eligible subcategory) — see Non-goals in the design doc.
- Studio/web wizard flat-saree flow style selection — untouched.
- Hard "you must pick a style" validation gate in the Android app — intentionally skipped; the auto-select-first behavior already guarantees `selectedStyleId` is set whenever styles exist, and omitting it entirely is a valid, already-supported fallback for when no styles are configured yet.
- Admin delete route for styles — deactivate via the `isActive` toggle instead; no hard-delete UI, matching this plan's YAGNI stance (nothing currently requires permanently removing a style row).
