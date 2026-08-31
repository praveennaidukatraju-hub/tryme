# Third Garment Upload Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins expose a **3rd garment upload box** in the studio wizard for garment types whose ComfyUI workflow already accepts three garment images — today the pipeline hardcodes exactly two upload roles (`upper`, `lower`), gated by a single `garment_subcategories.requiresLowerUpload` boolean, end-to-end from admin toggle through to the dispatcher's workflow patcher.

**Architecture:** Add a third, generically-named upload role (`third`) that mirrors the existing `lower` role byte-for-byte through every layer it touches: DB schema (`garment_subcategories.requiresThirdUpload`/`thirdUploadLabel`, `workflow_templates.thirdNodeId`, `job_inputs.thirdGarmentKey`), shared Zod types, the admin garment-type CRUD route, the admin workflow-template CRUD route (mirrors `shoeNodeId` here — it's a purely additive optional role with no effect on the "at least one garment role" validation), the customer-facing `/v1/models/garment-types` read endpoint, job-creation's three independent pose-workflow-resolution paths (default, catalogue-template-mapping, saree-step-2) plus its per-pose validation and `job_inputs` insert, the dispatcher's `applyWorkflowPatch`/`processor.ts`, the admin-web garment-type and workflow-template editors, and the catalogues-web studio wizard's upload UI. The 3rd slot is **always an upload**, never a catalog pick (like `lower` when it has no `upperNodeIds` fallback; unlike `shoe`, which stays catalog-only and untouched by this plan). Because the studio's upload boxes already stack in a `flexDirection: 'column'` layout once 2 are shown, adding a 3rd box needs no new layout logic — just extending the existing boolean condition.

**Tech Stack:** Drizzle ORM/Postgres, Fastify 5 + Zod, Vitest integration tests (`apps/api`), Vitest unit tests (`apps/dispatcher`), React (admin-web via Vite, catalogues-web via Next.js — neither has a test runner; verified via `tsc --noEmit` + manual walkthrough).

## Global Constraints

- Never use `npm`/`yarn` — this is a pnpm workspace monorepo.
- ESM only, Node 20+, TypeScript 5.6 everywhere.
- `pnpm docker:up` must be running before any `pnpm --filter @tryme/api test` or dispatcher test.
- Never inline-mutate `workflow_templates.jsonContent` — always `structuredClone`/`JSON.parse(JSON.stringify(...))` + patch (already how `patcher.ts` works; do not change that pattern).
- The 3rd garment key is **always an upload** — do not add a `thirdCatalogId` or any catalog-picker path for it.
- Do not touch `apps/admin-mobile` — it's paused, out of scope regardless of what this plan touches elsewhere.
- Follow the migration-index convention: check `packages/db/src/migrations/meta/_journal.json`'s last `idx` before generating (114 at time of writing — the new migration should land as `0115_*`).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/models.ts` | Add `garmentSubcategories.requiresThirdUpload`/`thirdUploadLabel`; add `workflowTemplates.thirdNodeId` |
| `packages/db/src/schema/jobs.ts` | Add `jobInputs.thirdGarmentKey` |
| `packages/db/src/migrations/0115_*.sql` (generated) | Migration for the 3 new columns |
| `packages/types/src/admin.ts` | `CreateGarmentTypeBody`/`PatchGarmentTypeBody` third-upload fields; `CreateWorkflowBody`/`UpdateWorkflowBody` `thirdNodeId` field |
| `packages/types/src/jobs.ts` | `CreateTryOnJobInputs.thirdGarmentKey` |
| `apps/api/src/modules/admin/subcategories.routes.ts` | POST `/admin/assets/garment-types` insert values (PATCH needs no change — generic body spread) |
| `apps/api/test/integration/garment-type-third-upload.test.ts` (new) | Covers create + patch persisting the new garment-type fields |
| `apps/api/src/modules/admin/workflows.routes.ts` | GET list mapper, POST insert+response, PATCH merge+`updateValues` |
| `apps/api/test/integration/admin-workflows.test.ts` | New cases covering `thirdNodeId` create/patch |
| `apps/api/src/modules/models/routes.ts` | `/v1/models/garment-types` explicit column select |
| `apps/api/test/integration/garment-types-sort-order.test.ts` | New case asserting the fields round-trip through the customer-facing endpoint |
| `apps/api/src/modules/jobs/create.ts` | Destructure + ownership check; 3 pose-workflow-resolution paths; validation loop; per-look `job_inputs` insert |
| `apps/api/test/integration/jobs-create-looks.test.ts` | New cases covering third-garment-required validation and persistence |
| `apps/dispatcher/src/workflow/patcher.ts` | `WorkflowInputs.thirdGarmentFile`; `applyWorkflowPatch` third-node patch block |
| `apps/dispatcher/src/workflow/patcher.test.ts` | New "third garment" describe block mirroring "lower garment" |
| `apps/dispatcher/src/job/processor.ts` | Resolve `thirdKey` from `job_inputs.thirdGarmentKey`; conditional ComfyUI upload; pass `thirdGarmentFile` to `patchWorkflow` |
| `apps/admin-web/src/types.ts` | `GarmentType.requiresThirdUpload`/`thirdUploadLabel`; workflow-template type `thirdNodeId` |
| `apps/admin-web/src/components/EditGarmentTypeModal.tsx` | State, dirty-check, save-diff, Switch + label input |
| `apps/admin-web/src/components/WorkflowUploadModal.tsx` | State, submit payload, manual `NodeSelect` field (no auto-detect — see Task 9) |
| `apps/catalogues-web/src/app/(app)/studio/page.tsx` | `GarmentType` interface, upload state + handler, 3rd upload box, submit payloads, `canGenerate` gate |

---

### Task 1: Schema + shared Zod types

**Files:**
- Modify: `packages/db/src/schema/models.ts:63-65` (`garmentSubcategories`), `packages/db/src/schema/models.ts:109-110` (`workflowTemplates`)
- Modify: `packages/db/src/schema/jobs.ts:68` (`jobInputs`)
- Modify: `packages/types/src/admin.ts:384-399` (`CreateGarmentTypeBody`), `:400-416` (`PatchGarmentTypeBody`), `:170-192` (`CreateWorkflowBody`), `:244-276` (`UpdateWorkflowBody`)
- Modify: `packages/types/src/jobs.ts:36-65` (`CreateTryOnJobInputs`)
- Create: `packages/db/src/migrations/0115_*.sql` (generated, do not hand-write)

**Interfaces:**
- Produces: DB columns `garment_subcategories.requires_third_upload boolean not null default false`, `garment_subcategories.third_upload_label text`, `workflow_templates.third_node_id text`, `job_inputs.third_garment_key text`. Drizzle field names: `garmentSubcategories.requiresThirdUpload`, `garmentSubcategories.thirdUploadLabel`, `workflowTemplates.thirdNodeId`, `jobInputs.thirdGarmentKey`.
- Produces: Zod fields `CreateGarmentTypeBody.requiresThirdUpload` (boolean, optional, default false), `PatchGarmentTypeBody.requiresThirdUpload` (boolean, optional), `PatchGarmentTypeBody.thirdUploadLabel` (string, max 80, nullable, optional), `CreateWorkflowBody.thirdNodeId` (string, min 1, optional), `UpdateWorkflowBody.thirdNodeId` (string, min 1, nullable, optional), `CreateTryOnJobInputs.thirdGarmentKey` (string matching `INPUT_GARMENT_KEY`, optional).

- [ ] **Step 1: Add the DB columns**

In `packages/db/src/schema/models.ts`, in the `garmentSubcategories` table (right after `lowerUploadLabel` on line 65):

```ts
  requiresLowerUpload: boolean('requires_lower_upload').notNull().default(false),
  upperUploadLabel: text('upper_upload_label'),
  lowerUploadLabel: text('lower_upload_label'),
  requiresThirdUpload: boolean('requires_third_upload').notNull().default(false),
  thirdUploadLabel: text('third_upload_label'),
```

In the `workflowTemplates` table (right after `shoeNodeId` on line 110):

```ts
  lowerNodeId: text('lower_node_id'), // nullable — some workflows have no lower garment
  shoeNodeId: text('shoe_node_id'), // nullable — some workflows have no shoe garment
  thirdNodeId: text('third_node_id'), // nullable — a 3rd, generically-named uploaded garment role
```

In `packages/db/src/schema/jobs.ts`, in the `jobInputs` table (right after `lowerGarmentKey` on line 68):

```ts
  lowerCatalogId: uuid('lower_catalog_id').references(() => catalogItems.id),
  lowerGarmentKey: text('lower_garment_key'),
  thirdGarmentKey: text('third_garment_key'),
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm docker:up
pnpm db:generate
```

Expected: a new `packages/db/src/migrations/0115_<generated-name>.sql` with exactly these statements (order may vary):

```sql
ALTER TABLE "garment_subcategories" ADD COLUMN "requires_third_upload" boolean DEFAULT false NOT NULL;
ALTER TABLE "garment_subcategories" ADD COLUMN "third_upload_label" text;
ALTER TABLE "workflow_templates" ADD COLUMN "third_node_id" text;
ALTER TABLE "job_inputs" ADD COLUMN "third_garment_key" text;
```

```bash
pnpm db:migrate
```

Expected: `Applied 0115_<name>` in the output, no errors.

- [ ] **Step 3: Add the shared Zod fields**

In `packages/types/src/admin.ts`, in `CreateGarmentTypeBody` (after `requiresLowerUpload` on line 397):

```ts
  requiresLowerUpload: z.boolean().optional().default(false),
  requiresThirdUpload: z.boolean().optional().default(false),
  tryonCategoryId: z.string().uuid().nullable().optional(),
```

In `PatchGarmentTypeBody` (after `lowerUploadLabel` on line 407):

```ts
  requiresLowerUpload: z.boolean().optional(),
  upperUploadLabel: z.string().max(80).nullable().optional(),
  lowerUploadLabel: z.string().max(80).nullable().optional(),
  requiresThirdUpload: z.boolean().optional(),
  thirdUploadLabel: z.string().max(80).nullable().optional(),
```

In `CreateWorkflowBody` (after `shoeNodeId` on line 178 — do **not** touch the `hasUpper`/`hasLower` `superRefine` block at lines 221-229, `thirdNodeId` is purely additive like `shoeNodeId`):

```ts
    lowerNodeId: z.string().min(1).optional(),
    shoeNodeId: z.string().min(1).optional(),
    thirdNodeId: z.string().min(1).optional(),
```

In `UpdateWorkflowBody` (after `shoeNodeId` on line 262):

```ts
  lowerNodeId: z.string().min(1).nullable().optional(),
  shoeNodeId: z.string().min(1).nullable().optional(),
  thirdNodeId: z.string().min(1).nullable().optional(),
```

In `packages/types/src/jobs.ts`, in `CreateTryOnJobInputs` (after `lowerGarmentKey` on line 63 — reuse `INPUT_GARMENT_KEY`, it's path-shaped, not role-specific):

```ts
    lowerCatalogId: z.string().uuid().optional(),
    lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
    thirdGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
    shoeCatalogId: z.string().uuid().optional(),
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors (these are additive optional fields — nothing downstream references them yet, so nothing should break).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/schema/jobs.ts packages/db/src/migrations packages/types/src/admin.ts packages/types/src/jobs.ts
git commit -m "feat(db,types): add third garment upload columns and Zod fields"
```

---

### Task 2: Admin API — garment-type "requires 3rd upload" toggle

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts:67-129` (POST `/admin/assets/garment-types`)
- Create: `apps/api/test/integration/garment-type-third-upload.test.ts`

**Interfaces:**
- Consumes: `CreateGarmentTypeBody.requiresThirdUpload` (Task 1), `PatchGarmentTypeBody.requiresThirdUpload`/`thirdUploadLabel` (Task 1). PATCH needs no route code change — it already does `.set({ ...body, updatedAt: new Date() })`, a generic spread that picks up any Zod-validated field automatically.
- Produces: `garment_subcategories.requires_third_upload`/`third_upload_label` persist through both POST and PATCH.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/garment-type-third-upload.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('garment-type third-upload fields', () => {
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

  it('POST /admin/assets/garment-types persists requiresThirdUpload', async () => {
    const headers = await adminAuthHeader(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/garment-types',
      headers,
      payload: {
        genderSlug: 'women',
        slug: `third-upload-create-${Date.now()}`,
        label: 'Third Upload Create Test',
        requiresThirdUpload: true,
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, res.json().id));
    expect(row?.requiresThirdUpload).toBe(true);
  });

  it('PATCH /admin/assets/garment-types/:id persists requiresThirdUpload + thirdUploadLabel', async () => {
    const headers = await adminAuthHeader(app);
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `third-upload-patch-${Date.now()}`, label: 'Patch Test' })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${gt.id}`,
      headers,
      payload: { requiresThirdUpload: true, thirdUploadLabel: 'Upload Dupatta' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, gt.id));
    expect(row?.requiresThirdUpload).toBe(true);
    expect(row?.thirdUploadLabel).toBe('Upload Dupatta');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- garment-type-third-upload
```

Expected: FAIL — `requiresThirdUpload` isn't accepted by `CreateGarmentTypeBody`'s POST insert values (Zod strips it since Task 1 already added it to the schema, but the route handler doesn't destructure/insert it), so the first test fails with `row?.requiresThirdUpload` being `false` instead of `true`. (If Task 1 wasn't done yet, this would instead fail at the Zod validation layer — confirm Task 1 is merged first.)

- [ ] **Step 3: Wire the POST route**

In `apps/api/src/modules/admin/subcategories.routes.ts`, update the POST handler (lines 67-129):

```ts
    async (req) => {
      const {
        genderSlug,
        slug,
        label,
        sortOrder,
        thumbnailKey,
        requiresLowerUpload,
        requiresThirdUpload,
        tryonCategoryId,
      } = req.body as {
        genderSlug: string;
        slug: string;
        label: string;
        sortOrder?: number;
        thumbnailKey?: string;
        requiresLowerUpload?: boolean;
        requiresThirdUpload?: boolean;
        tryonCategoryId?: string | null;
      };
```

And in the insert `.values()` (mirror `requiresLowerUpload`):

```ts
        const [inserted] = await tx
          .insert(schema.garmentSubcategories)
          .values({
            genderSlug,
            slug,
            label,
            sortOrder: targetSortOrder,
            thumbnailKey,
            requiresLowerUpload: requiresLowerUpload ?? false,
            requiresThirdUpload: requiresThirdUpload ?? false,
            tryonCategoryId: tryonCategoryId ?? null,
          })
          .returning();
```

The PATCH handler needs **no code change** — it already does `.set({ ...body, updatedAt: new Date() })`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- garment-type-third-upload
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/garment-type-third-upload.test.ts
git commit -m "feat(api): let admins toggle a 3rd garment upload on a garment type"
```

---

### Task 3: Admin API — workflow template `thirdNodeId`

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts:100-119` (GET list mapper), `:153-183` (POST body type + insert), `:328-369` (POST response), `:399-429` (PATCH body type), `:457-464` (PATCH node validation), `:514-554` (PATCH `updateValues`)
- Modify: `apps/api/test/integration/admin-workflows.test.ts`

**Interfaces:**
- Consumes: `CreateWorkflowBody.thirdNodeId`, `UpdateWorkflowBody.thirdNodeId` (Task 1).
- Produces: `GET /admin/workflows` items include `thirdNodeId`; `POST /admin/workflows` accepts and persists it; `PATCH /admin/workflows/:id` accepts, validates against the stored JSON, and persists it.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/admin-workflows.test.ts` (reuse the file's existing `jsonContent`/`headers` fixtures — read the top of the file first to match its exact setup):

```ts
  it('creates a regular workflow with thirdNodeId and returns it', async () => {
    const withThird = {
      ...jsonContent,
      third_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'third_garment' } },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `third_node_create_${Date.now()}`,
        label: 'Third node create',
        jsonContent: withThird,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        upperNodeIds: ['upper_node'],
        thirdNodeId: 'third_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(200);

    const [row] = await app.db
      .select({ thirdNodeId: schema.workflowTemplates.thirdNodeId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, response.json().id));
    expect(row?.thirdNodeId).toBe('third_node');
  });

  it('PATCH persists thirdNodeId', async () => {
    const withThird = {
      ...jsonContent,
      third_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'third_garment' } },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `third_node_patch_${Date.now()}`,
        label: 'Third node patch target',
        jsonContent: withThird,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        upperNodeIds: ['upper_node'],
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { thirdNodeId: 'third_node' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ thirdNodeId: schema.workflowTemplates.thirdNodeId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.thirdNodeId).toBe('third_node');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- admin-workflows
```

Expected: FAIL — `thirdNodeId` is accepted by Zod (Task 1) but dropped by the route handler before the insert/update, so both new assertions fail with `undefined`/`null` instead of `'third_node'`.

- [ ] **Step 3: Wire the route**

In `apps/api/src/modules/admin/workflows.routes.ts`:

GET list mapper (after `shoeNodeId` on line 110):

```ts
      lowerNodeId: r.lowerNodeId,
      shoeNodeId: r.shoeNodeId,
      thirdNodeId: r.thirdNodeId,
```

POST body type (after `shoeNodeId?: string;` on line 171):

```ts
        lowerNodeId?: string;
        shoeNodeId?: string;
        thirdNodeId?: string;
```

POST validation, right after the existing shoe checks (lines 302-303 and 312-314):

```ts
      if (body.lowerNodeId) validateNodeExists(body.jsonContent, body.lowerNodeId, 'lower garment');
      if (body.shoeNodeId) validateNodeExists(body.jsonContent, body.shoeNodeId, 'shoes');
      if (body.thirdNodeId) validateNodeExists(body.jsonContent, body.thirdNodeId, 'third garment');
```

```ts
      if (body.lowerNodeId)
        validateNodeType(body.jsonContent, body.lowerNodeId, 'image', 'lower garment');
      if (body.shoeNodeId) validateNodeType(body.jsonContent, body.shoeNodeId, 'image', 'shoes');
      if (body.thirdNodeId)
        validateNodeType(body.jsonContent, body.thirdNodeId, 'image', 'third garment');
```

POST insert `.values()` (after `shoeNodeId` on line 340):

```ts
          lowerNodeId: body.lowerNodeId ?? null,
          shoeNodeId: body.shoeNodeId ?? null,
          thirdNodeId: body.thirdNodeId ?? null,
```

POST response object (after `shoeNodeId` on line 365):

```ts
        lowerNodeId: row?.lowerNodeId,
        shoeNodeId: row?.shoeNodeId,
        thirdNodeId: row?.thirdNodeId,
```

PATCH body type (after `shoeNodeId?: string | null;` on line 417):

```ts
        lowerNodeId?: string | null;
        shoeNodeId?: string | null;
        thirdNodeId?: string | null;
```

PATCH validation, right after the existing shoe check (lines 461-464):

```ts
      if (body.shoeNodeId) {
        validateNodeExists(json, body.shoeNodeId, 'shoes');
        validateNodeType(json, body.shoeNodeId, 'image', 'shoes');
      }
      if (body.thirdNodeId) {
        validateNodeExists(json, body.thirdNodeId, 'third garment');
        validateNodeType(json, body.thirdNodeId, 'image', 'third garment');
      }
```

PATCH `updateValues` (after `shoeNodeId` on line 536 — note `thirdNodeId` does **not** participate in the "at least one garment role" merge check at lines 474-501, mirroring `shoeNodeId`, not `lowerNodeId`):

```ts
      if ('lowerNodeId' in body) updateValues.lowerNodeId = body.lowerNodeId ?? null;
      if ('shoeNodeId' in body) updateValues.shoeNodeId = body.shoeNodeId ?? null;
      if ('thirdNodeId' in body) updateValues.thirdNodeId = body.thirdNodeId ?? null;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- admin-workflows
```

Expected: PASS (all cases in the file, including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/admin-workflows.test.ts
git commit -m "feat(api): support thirdNodeId on workflow templates"
```

---

### Task 4: Customer-facing API — `/v1/models/garment-types`

**Files:**
- Modify: `apps/api/src/modules/models/routes.ts:15-29` (explicit column select)
- Modify: `apps/api/test/integration/garment-types-sort-order.test.ts`

**Interfaces:**
- Consumes: `garmentSubcategories.requiresThirdUpload`/`thirdUploadLabel` (Task 1).
- Produces: `GET /v1/models/garment-types` response items include `requiresThirdUpload`/`thirdUploadLabel` — this is what the studio wizard (Task 10) reads.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/garment-types-sort-order.test.ts` (reuses the file's existing `loginToken`/`seedGarmentTypes` helpers — read the top of the file first, already shown above):

```ts
  it('GET /v1/models/garment-types includes requiresThirdUpload and thirdUploadLabel', async () => {
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `third-fields-${Date.now()}`,
        label: 'Third Fields',
        requiresThirdUpload: true,
        thirdUploadLabel: 'Upload Jacket',
      })
      .returning();
    const token = await loginToken(`third-fields-customer-${Date.now()}@x.com`);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/garment-types?gender=men',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const item = (res.json().items as Array<{ id: string; requiresThirdUpload: boolean; thirdUploadLabel: string | null }>)
      .find((i) => i.id === gt.id);
    expect(item?.requiresThirdUpload).toBe(true);
    expect(item?.thirdUploadLabel).toBe('Upload Jacket');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- garment-types-sort-order
```

Expected: FAIL — `item?.requiresThirdUpload` is `undefined` because the route's explicit `.select({...})` doesn't include the column yet.

- [ ] **Step 3: Add the columns to the select**

In `apps/api/src/modules/models/routes.ts`, in the `GET /v1/models/garment-types` handler's `.select()` (after `lowerUploadLabel` on line 25):

```ts
          requiresLowerUpload: schema.garmentSubcategories.requiresLowerUpload,
          upperUploadLabel: schema.garmentSubcategories.upperUploadLabel,
          lowerUploadLabel: schema.garmentSubcategories.lowerUploadLabel,
          requiresThirdUpload: schema.garmentSubcategories.requiresThirdUpload,
          thirdUploadLabel: schema.garmentSubcategories.thirdUploadLabel,
          defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- garment-types-sort-order
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/models/routes.ts apps/api/test/integration/garment-types-sort-order.test.ts
git commit -m "feat(api): surface third-upload fields on the customer garment-types endpoint"
```

---

### Task 5: Job creation — validate and persist `thirdGarmentKey`

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:66-75` (destructure), `:177` (ownership check), `:322-409` (catalogue-template pose-workflow path), `:414-481` (default pose-workflow path), `:460-465` (saree-step-2 path), `:486-503` (validation loop), `:526-566` (per-look `job_inputs` insert)
- Modify: `apps/api/test/integration/jobs-create-looks.test.ts`

**Interfaces:**
- Consumes: `body.inputs.thirdGarmentKey` (Task 1's `CreateTryOnJobInputs`), `workflowTemplates.thirdNodeId` (Task 1).
- Produces: `job_inputs.thirdGarmentKey` — the field the dispatcher (Task 6/7) reads.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/jobs-create-looks.test.ts` (reuses the file's `registerUser`/`grantCredits`/`bindUploadKey`/`seedCreditPlan`/`seedFaceAndTwoBackgrounds`/`seedTwoPoses` helpers, already shown above):

```ts
  it('rejects a submission missing thirdGarmentKey when the pose workflow maps a third node', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-third-required@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `third-required-${poseAId}`, label: 'Third required' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `third-required-workflow-${poseAId}`,
        label: 'Third required workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        thirdNodeId: '9',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('persists thirdGarmentKey when the pose workflow maps a third node and the key is provided', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-third-provided@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `third-provided-${poseAId}`, label: 'Third provided' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `third-provided-workflow-${poseAId}`,
        label: 'Third provided workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        thirdNodeId: '9',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const upperKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, upperKey);
    const thirdKey = `inputs/${crypto.randomUUID()}/garment.jpg`;
    await bindUploadKey(userId, thirdKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: upperKey,
          thirdGarmentKey: thirdKey,
          faceId,
          garmentTypeId: garmentType.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, response.json().jobIds[0]));
    expect(inputs?.thirdGarmentKey).toBe(thirdKey);
  });
```

If `crypto.randomUUID()` isn't already available in this test file's scope, add `import { randomUUID } from 'node:crypto';` at the top and use `randomUUID()` instead.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: FAIL — the first new test gets `201` instead of `400` (no validation exists yet for a mapped `thirdNodeId`); the second gets `inputs?.thirdGarmentKey` as `undefined`/`null` instead of the expected key (the field isn't destructured, resolved, or inserted yet).

- [ ] **Step 3: Wire `create.ts`**

Destructure (line 66-75, add after `lowerGarmentKey`):

```ts
  const {
    faceId,
    garmentTypeId,
    catalogueTemplateMappingId,
    upperGarmentKey,
    mannequinJobId,
    lowerCatalogId,
    lowerGarmentKey,
    thirdGarmentKey,
    shoeCatalogId,
  } = body.inputs;
```

Ownership check (line 177, add after the existing lower check):

```ts
  if (lowerGarmentKey) await verifyGarmentKey(lowerGarmentKey);
  if (thirdGarmentKey) await verifyGarmentKey(thirdGarmentKey);
```

Catalogue-template pose-workflow path (`mappingPoseWorkflows`, lines 332-379 select + lines 399-408 return): add `thirdNodeId: schema.workflowTemplates.thirdNodeId` to the `.select({...})` right after `lowerNodeId: schema.workflowTemplates.lowerNodeId,` (line 339), and `thirdNodeId: row.thirdNodeId,` to the returned object right after `lowerNodeId: row.lowerNodeId,` (line 404):

```ts
        const rows = await app.db
          .select({
            poseId: schema.catalogueTemplateLooks.poseAssetId,
            backgroundId: schema.catalogueTemplateLooks.backgroundId,
            workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
            promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
            upperNodeIds: schema.workflowTemplates.upperNodeIds,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            thirdNodeId: schema.workflowTemplates.thirdNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
            sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
          })
```

```ts
          return {
            poseId,
            workflowTemplateId: row.workflowTemplateId,
            promptGarmentPhase: row.promptGarmentPhase,
            upperNodeIds: row.upperNodeIds,
            lowerNodeId: row.lowerNodeId,
            thirdNodeId: row.thirdNodeId,
            shoeNodeId: row.shoeNodeId,
            sizeNodeIds: row.sizeNodeIds,
          };
```

Saree-step-2 path (lines 460-465, add `thirdNodeId`):

```ts
        workflowTemplateId: sareeStep2?.workflowTemplateId ?? null,
        promptGarmentPhase: null,
        upperNodeIds: sareeStep2?.upperNodeIds ?? [],
        lowerNodeId: sareeStep2?.lowerNodeId ?? null,
        thirdNodeId: sareeStep2?.thirdNodeId ?? null,
        shoeNodeId: sareeStep2?.shoeNodeId ?? null,
        sizeNodeIds: sareeStep2?.sizeNodeIds ?? null,
```

`sareeStep2` is built from an explicit-column `gtRow` select earlier in the same function (lines 113-146) — it needs `thirdNodeId` threaded through too. Update the `sareeStep2` type declaration:

```ts
  let sareeStep2: {
    workflowTemplateId: string | null;
    upperNodeIds: string[] | null;
    lowerNodeId: string | null;
    thirdNodeId: string | null;
    shoeNodeId: string | null;
    sizeNodeIds: string[] | null;
  } | null = null;
```

Update the `gtRow` select (after `sareeStep2LowerNodeId` on line 126):

```ts
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
        sareeStep2UpperNodeIds: schema.workflowTemplates.upperNodeIds,
        sareeStep2LowerNodeId: schema.workflowTemplates.lowerNodeId,
        sareeStep2ThirdNodeId: schema.workflowTemplates.thirdNodeId,
        sareeStep2ShoeNodeId: schema.workflowTemplates.shoeNodeId,
        sareeStep2SizeNodeIds: schema.workflowTemplates.sizeNodeIds,
      })
```

Update the `sareeStep2 = {...}` construction (after `lowerNodeId` on line 141):

```ts
      sareeStep2 = {
        workflowTemplateId: gtRow?.sareeStep2WorkflowTemplateId ?? null,
        upperNodeIds: gtRow?.sareeStep2UpperNodeIds ?? null,
        lowerNodeId: gtRow?.sareeStep2LowerNodeId ?? null,
        thirdNodeId: gtRow?.sareeStep2ThirdNodeId ?? null,
        shoeNodeId: gtRow?.sareeStep2ShoeNodeId ?? null,
        sizeNodeIds: gtRow?.sareeStep2SizeNodeIds ?? null,
      };
```

Default pose-workflow path (`poseWorkflowRows`, lines 414-481): add `defaultThirdNodeId`/`overrideThirdNodeId` to the select (after `defaultLowerNodeId`/`overrideLowerNodeId` on lines 419/425):

```ts
      defaultUpperNodeIds: defaultWorkflow.upperNodeIds,
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultThirdNodeId: defaultWorkflow.thirdNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      defaultSizeNodeIds: defaultWorkflow.sizeNodeIds,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      configIsActive: schema.poseGarmentConfigs.isActive,
      overrideUpperNodeIds: overrideWorkflow.upperNodeIds,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideThirdNodeId: overrideWorkflow.thirdNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
      overrideSizeNodeIds: overrideWorkflow.sizeNodeIds,
```

And add `thirdNodeId` to the mapped object (after `lowerNodeId` on line 476-477):

```ts
        lowerNodeId:
          r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
        thirdNodeId:
          r.configWorkflowTemplateId != null ? r.overrideThirdNodeId : r.defaultThirdNodeId,
        shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
```

Validation loop (lines 486-503, add after the `lowerNodeId` block — simpler than lower, no catalog fallback exists):

```ts
    if (pw.shoeNodeId && !shoeCatalogId) {
      throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
    }
    if (pw.thirdNodeId && !thirdGarmentKey) {
      throw new AppError('VALIDATION', 400, 'third garment upload required for this pose');
    }
```

Per-look insert (lines 533-566, add `effectiveThirdGarmentKey` and the insert field):

```ts
      const effectiveShoeCatalogId = pw?.shoeNodeId ? (shoeCatalogId ?? null) : null;
      const effectiveThirdGarmentKey = pw?.thirdNodeId ? (thirdGarmentKey ?? null) : null;
```

```ts
      await tx.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey: lookUpperGarmentKey,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId: garmentTypeId ?? null,
        lowerCatalogId: effectiveLowerCatalogId,
        lowerGarmentKey: effectiveLowerGarmentKey,
        thirdGarmentKey: effectiveThirdGarmentKey,
        shoeCatalogId: effectiveShoeCatalogId,
        userHint: promptGuard(body.userHint),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: PASS (all cases in the file, including the 2 new ones).

- [ ] **Step 5: Run the full API suite to check for regressions**

```bash
pnpm --filter @tryme/api test
```

Expected: PASS — in particular, `catalogue-templates-public.test.ts` and `shot-type-workflow-resolve.test.ts` (both matched the `lowerNodeId` grep earlier and touch these same code paths) must still pass unmodified.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/jobs-create-looks.test.ts
git commit -m "feat(api): validate and persist thirdGarmentKey on job creation"
```

---

### Task 6: Dispatcher — `applyWorkflowPatch` third-node support

**Files:**
- Modify: `apps/dispatcher/src/workflow/patcher.ts:49-64` (`WorkflowInputs`), `:74-132` (`applyWorkflowPatch`)
- Modify: `apps/dispatcher/src/workflow/patcher.test.ts`

**Interfaces:**
- Consumes: `WorkflowTemplate.thirdNodeId` (Task 1, already on the Drizzle-inferred type once the schema change lands).
- Produces: `WorkflowInputs.thirdGarmentFile` — the field `processor.ts` (Task 7) must populate.

- [ ] **Step 1: Write the failing tests**

Add a `'third garment'` node to the test fixture and a new describe block. In `apps/dispatcher/src/workflow/patcher.test.ts`, update `makeWorkflow()` (after the `'1352'` shoes node on line 18):

```ts
    '1352': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'shoes' } },
    '1360': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'third_garment' } },
```

Update `makeTemplate()` (after `shoeNodeId: '1352',` on line 59):

```ts
    lowerNodeId: '1331',
    shoeNodeId: '1352',
    thirdNodeId: '1360',
```

Update `BASE_INPUTS` (after `shoeGarmentFile` on line 79):

```ts
  lowerGarmentFile: 'lower_abc123.jpg',
  shoeGarmentFile: 'shoe_abc123.jpg',
  thirdGarmentFile: 'third_abc123.jpg',
```

Update the "no mapped LoadImage node retains an empty string" test's `mappedNodeIds` array (line 190) to include `'1360'`:

```ts
    const mappedNodeIds = ['1332', '1333', '1334', '1340', '1331', '1352', '1360'];
```

Add a new describe block after the existing `describe('shoes', ...)` block (after line 254):

```ts
// ── Third garment ────────────────────────────────────────────────────────

describe('third garment', () => {
  it('patches third garment node with the provided thirdGarmentFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      thirdGarmentFile: 'third_abc123.jpg',
    });
    expect(wf['1360']?.inputs.image).toBe('third_abc123.jpg');
  });

  it('throws when thirdNodeId is mapped but no third garment file is provided', () => {
    const wf = makeWorkflow();
    const { thirdGarmentFile, ...inputsWithoutThird } = BASE_INPUTS;
    expect(() => applyWorkflowPatch(wf, makeTemplate(), inputsWithoutThird)).toThrow(/third/i);
  });

  it('leaves third node completely untouched when thirdNodeId is null', () => {
    const wf = makeWorkflow();
    const tmpl = makeTemplate({ thirdNodeId: null });
    applyWorkflowPatch(wf, tmpl, { ...BASE_INPUTS, thirdGarmentFile: 'third_abc123.jpg' });
    expect(wf['1360']?.inputs.image).toBe('');
  });

  it('warns when a third garment file is provided but no thirdNodeId is mapped — silently skipped', () => {
    const wf = makeWorkflow();
    const warn = vi.fn();
    const tmpl = makeTemplate({ thirdNodeId: null });
    applyWorkflowPatch(
      wf,
      tmpl,
      { ...BASE_INPUTS, thirdGarmentFile: 'third_abc123.jpg' },
      { warn },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no third_node_id'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @tryme/dispatcher test -- patcher
```

Expected: FAIL — `WorkflowTemplate`/`WorkflowInputs` don't have `thirdNodeId`/`thirdGarmentFile` (TypeScript error) and `applyWorkflowPatch` never touches node `'1360'`, so every new assertion fails once the type error is silenced or the test is run with `--no-typecheck`. Confirm the failure is the expected "third garment not patched" behavior, not an unrelated error.

- [ ] **Step 3: Implement the patch block**

In `apps/dispatcher/src/workflow/patcher.ts`, add to `WorkflowInputs` (after `shoeGarmentFile` on line 56):

```ts
export interface WorkflowInputs {
  workflowTemplateId: string;
  poseFile: string;
  upperGarmentFile?: string;
  faceSideFile?: string;
  backgroundFile?: string;
  lowerGarmentFile?: string;
  shoeGarmentFile?: string;
  thirdGarmentFile?: string;
  promptFacePhase?: string;
  promptGarmentPhase?: string;
  aspectRatio?: string;
  outputWidth?: number;
  outputHeight?: number;
}
```

In `applyWorkflowPatch`, add a block mirroring the `lowerNodeId` block exactly, right after the shoe block (after line 132, before the prompt-node comment):

```ts
  if (tmpl.shoeNodeId) {
    if (!inputs.shoeGarmentFile) {
      throw new Error(`Workflow "${tmpl.slug}" maps a shoe node but no shoe image was provided`);
    }
    requireNode(workflow, tmpl.shoeNodeId, 'shoes').inputs.image = inputs.shoeGarmentFile;
  } else if (inputs.shoeGarmentFile) {
    log?.warn(
      `patchWorkflow: shoe garment provided but workflow "${tmpl.slug}" has no shoe_node_id — skipping`,
    );
  }

  if (tmpl.thirdNodeId) {
    if (!inputs.thirdGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a third garment node but no third garment image was provided`,
      );
    }
    requireNode(workflow, tmpl.thirdNodeId, 'third garment').inputs.image = inputs.thirdGarmentFile;
  } else if (inputs.thirdGarmentFile) {
    log?.warn(
      `patchWorkflow: third garment provided but workflow "${tmpl.slug}" has no third_node_id — skipping`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @tryme/dispatcher test -- patcher
```

Expected: PASS — all tests in `patcher.test.ts`, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/workflow/patcher.ts apps/dispatcher/src/workflow/patcher.test.ts
git commit -m "feat(dispatcher): patch a third garment node when the workflow maps one"
```

---

### Task 7: Dispatcher — `processor.ts` third-garment upload/resolution wiring

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:317-347` (key resolution), `:399-429` (ComfyUI upload), `:431+` (patchWorkflow call)

**Interfaces:**
- Consumes: `job_inputs.thirdGarmentKey` (Task 5's insert), `WorkflowInputs.thirdGarmentFile` (Task 6).
- Produces: the `thirdGarmentFile` value passed into `patchWorkflow(...)`.

This task is deliberately **not test-driven with a new integration test**: `apps/dispatcher/test/integration/happy-path.test.ts` (the only dispatcher integration harness that exercises `processJob` against a real ComfyUI mock) currently seeds `job_inputs` with columns (`modelCatalogId`, `poseCatalogId`, `backgroundCatalogId`) that no longer exist on the current `job_inputs` schema — it is already out of sync with the schema read directly from `packages/db/src/schema/jobs.ts` in this repo, and is out of scope to fix here. Task 6's unit tests already prove `applyWorkflowPatch` correctly handles `thirdGarmentFile` in isolation; this task is a small, mechanical mirror of the already-proven `lowerKey`/`lowerGarmentFile` wiring one level up, verified by typecheck + full-suite regression + the manual E2E in Task 10.

**Flag for the plan's reviewer:** before merging, decide whether `happy-path.test.ts` should be fixed/skipped in a separate follow-up — it may already be silently failing or skipped in CI.

- [ ] **Step 1: Resolve `thirdKey`**

In `apps/dispatcher/src/job/processor.ts`, after the shoe-key resolution block (after line 347, before `// 3. Claim a worker`):

```ts
  // Resolve optional shoe catalog ID → R2 key
  let shoeKey: string | null = null;
  if (inputs.shoeCatalogId) {
    const [shoeRow] = await db
      .select({ r2Key: schema.catalogItems.r2Key })
      .from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, inputs.shoeCatalogId));
    if (shoeRow) shoeKey = shoeRow.r2Key;
    else
      jobLog.warn(
        { shoeCatalogId: inputs.shoeCatalogId },
        'shoe catalog item not found — skipping',
      );
  }

  // Third garment is always an upload — no catalog fallback exists for this role.
  const thirdKey: string | null = inputs.thirdGarmentKey ?? null;
```

- [ ] **Step 2: Upload to ComfyUI conditionally**

In the same file, in the upload block (after line 408, mirroring the `lowerKey`/`shoeKey` push):

```ts
    if (lowerKey) baseTasks.push(uploadToComfy(lowerKey, 'lower'));
    if (shoeKey) baseTasks.push(uploadToComfy(shoeKey, 'shoe'));
    if (thirdKey) baseTasks.push(uploadToComfy(thirdKey, 'third'));
    const uploaded = await Promise.all(baseTasks);
```

And extract the filename in the same order as it was pushed (after line 418):

```ts
    const lowerGarmentFile = lowerKey ? uploaded[idx++] : undefined;
    const shoeGarmentFile = shoeKey ? uploaded[idx++] : undefined;
    const thirdGarmentFile = thirdKey ? uploaded[idx++] : undefined;
    jobLog.info(
      {
        upperGarmentFile,
        faceSideFile,
        poseFile,
        backgroundFile,
        lowerGarmentFile,
        shoeGarmentFile,
        thirdGarmentFile,
      },
      'inputs uploaded',
    );
```

- [ ] **Step 3: Pass `thirdGarmentFile` into `patchWorkflow`**

In `apps/dispatcher/src/job/processor.ts`, update the `patchWorkflow(...)` call (lines 439-456):

```ts
    const { prompt, resultNodeId } = await patchWorkflow(
      {
        workflowTemplateId,
        upperGarmentFile,
        faceSideFile,
        poseFile,
        backgroundFile,
        lowerGarmentFile,
        shoeGarmentFile,
        thirdGarmentFile,
        promptFacePhase: effectivePromptFacePhase ?? undefined,
        promptGarmentPhase: effectivePromptGarmentPhase ?? undefined,
        aspectRatio: jobAspectRatio,
        outputWidth: jobOutputWidth,
        outputHeight: jobOutputHeight,
      },
      db,
      jobLog,
    );
```

The `COMFY_DISPATCH` job-event payload built just below (lines 467-499), stored for admin debugging, also needs `thirdGarmentFile` and `thirdKey`:

```ts
    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: w.id,
        workerUrl: w.url,
        workflowTemplateId,
        inputs: {
          upperGarmentFile,
          faceSideFile,
          poseFile,
          backgroundFile,
          lowerGarmentFile,
          shoeGarmentFile,
          thirdGarmentFile,
          promptFacePhase: effectivePromptFacePhase ?? null,
          promptGarmentPhase: effectivePromptGarmentPhase ?? null,
          aspectRatio: jobAspectRatio ?? null,
          outputWidth: jobOutputWidth ?? null,
          outputHeight: jobOutputHeight ?? null,
          _r2Keys: {
            upperGarmentKey: inputs.upperGarmentKey,
            faceSideKey,
            poseKey,
            bgKey,
            bgSource,
            lowerKey,
            shoeKey,
            thirdKey,
          },
        },
        prompt,
      },
    });
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/dispatcher typecheck 2>/dev/null || pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Run the full dispatcher suite to check for regressions**

```bash
pnpm --filter @tryme/dispatcher test
```

Expected: no new failures relative to the pre-existing baseline (note whether `happy-path.test.ts` was already failing before this change — if so, this task must not make it fail differently or for a new reason).

- [ ] **Step 6: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve and upload the third garment key to ComfyUI"
```

---

### Task 8: Admin web — garment-type "requires 3rd upload" editor

**Files:**
- Modify: `apps/admin-web/src/types.ts:46-55` (`GarmentType` type)
- Modify: `apps/admin-web/src/components/EditGarmentTypeModal.tsx:347-401` (state + dirty check), `:403-482` (save diff), `:556-599` (JSX)

**Interfaces:**
- Consumes: `GarmentType.requiresThirdUpload`/`thirdUploadLabel` (new type fields, populated by Task 2's API response).
- Produces: `PATCH /admin/assets/garment-types/:id` calls that include `requiresThirdUpload`/`thirdUploadLabel` when changed.

No test runner exists for `apps/admin-web` (Vite + React, `build`/`preview` scripts only — confirmed via `apps/admin-web/package.json`). This task is verified by typecheck + a manual walkthrough.

- [ ] **Step 1: Add the type fields**

In `apps/admin-web/src/types.ts`, in the `GarmentType` interface (after `lowerUploadLabel` on line 55):

```ts
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  requiresThirdUpload: boolean;
  thirdUploadLabel?: string | null;
```

- [ ] **Step 2: Add state + dirty-check**

In `apps/admin-web/src/components/EditGarmentTypeModal.tsx`, add state (after `lowerUploadLabel` on line 351):

```ts
  const [lowerUploadLabel, setLowerUploadLabel] = useState(garmentType.lowerUploadLabel ?? '');
  const [requiresThirdUpload, setRequiresThirdUpload] = useState(garmentType.requiresThirdUpload);
  const [thirdUploadLabel, setThirdUploadLabel] = useState(garmentType.thirdUploadLabel ?? '');
```

Add to the `dirty` boolean (after `lowerUploadLabel` on line 395):

```ts
    lowerUploadLabel !== (garmentType.lowerUploadLabel ?? '') ||
    requiresThirdUpload !== garmentType.requiresThirdUpload ||
    thirdUploadLabel !== (garmentType.thirdUploadLabel ?? '') ||
```

- [ ] **Step 3: Add to the save diff**

In `save()`, after the `lowerUploadLabel` diff (after line 444):

```ts
      if (lowerUploadLabel !== (garmentType.lowerUploadLabel ?? '')) {
        patchBody.lowerUploadLabel = lowerUploadLabel.trim() || null;
      }
      if (requiresThirdUpload !== garmentType.requiresThirdUpload) {
        patchBody.requiresThirdUpload = requiresThirdUpload;
      }
      if (thirdUploadLabel !== (garmentType.thirdUploadLabel ?? '')) {
        patchBody.thirdUploadLabel = thirdUploadLabel.trim() || null;
      }
```

- [ ] **Step 4: Add the JSX**

After the closing `)}` of the `requiresLowerUpload` conditional block (after line 599):

```tsx
              <div className="setting-row" style={{ padding: 0, border: 0 }}>
                <div>
                  <div className="setting-lbl">Requires 3rd garment upload</div>
                  <div className="setting-desc">
                    Customer uploads a third garment image (e.g. dupatta, jacket) in addition to top
                    and bottom wear.
                  </div>
                </div>
                <Switch
                  checked={requiresThirdUpload}
                  onChange={setRequiresThirdUpload}
                  disabled={saving}
                />
              </div>
              {requiresThirdUpload && (
                <div className="field">
                  <label>3rd garment upload label</label>
                  <input
                    className="input"
                    placeholder="e.g. Upload Dupatta"
                    value={thirdUploadLabel}
                    disabled={saving}
                    onChange={(e) => setThirdUploadLabel(e.target.value)}
                  />
                  <span className="hint">
                    Shown in studio as the title of the third upload box.
                  </span>
                </div>
              )}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/admin-web build
```

Expected: no TypeScript errors (this project's `build` script is `tsc -b && vite build` — it typechecks as part of the build).

- [ ] **Step 6: Manual verification**

```bash
pnpm --filter @tryme/admin-web dev
```

Open the admin panel, navigate to Assets → Garment Types, edit any garment type, confirm the "Requires 3rd garment upload" toggle appears below the existing "Requires lower garment upload" toggle, toggling it reveals the label input, and saving persists (reload the page and confirm the toggle state survived).

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/components/EditGarmentTypeModal.tsx
git commit -m "feat(admin-web): let admins toggle a 3rd garment upload on a garment type"
```

---

### Task 9: Admin web — workflow-template editor `thirdNodeId` field

**Files:**
- Modify: `apps/admin-web/src/types.ts:18-19` (workflow-template type)
- Modify: `apps/admin-web/src/components/WorkflowUploadModal.tsx:13-26` (`DetectedMappings`), `:134-135` (state), `:295-296` (submit payload), `:795-812` (JSX)

**Interfaces:**
- Produces: `POST /admin/workflows` payloads that include `thirdNodeId` when the admin fills it in.

`thirdNodeId` is **manual-entry only** — unlike `lowerNodeId`/`shoeNodeId`, there is no reliable naming convention (`"lower_garment"`, `"shoes"`) to auto-detect a 3rd, arbitrarily-named role from the uploaded JSON's node titles, so this task does not touch the backend `/admin/workflows/parse` auto-detection logic. No test runner exists for `apps/admin-web`; verified by typecheck + manual walkthrough.

- [ ] **Step 1: Add the type field**

In `apps/admin-web/src/types.ts`, in the `WorkflowOption` interface (lines 61-71), add after `shoeNodeId` (line 71):

```ts
export interface WorkflowOption {
  id: string; // UUID from workflow_templates table
  slug: string;
  label: string;
  workflowType: 'regular' | 'tryon' | 'saree_step1';
  isActive: boolean;
  poseCount: number;
  defaultFacePhasePrompt: string;
  defaultGarmentPhasePrompt: string;
  lowerNodeId: string | null;
  shoeNodeId: string | null;
  thirdNodeId: string | null;
  // ...rest of the interface unchanged
```

Note: `WorkflowUploadModal.tsx`'s own local `DetectedMappings` interface (lines 13-26, used only for `/admin/workflows/parse` auto-detect results) is separate from `WorkflowOption` and is intentionally **not** touched — see Step 2.

- [ ] **Step 2: Add component state**

In `apps/admin-web/src/components/WorkflowUploadModal.tsx`, after `shoeNodeId` state (after line 135):

```ts
  const [lowerNodeId, setLowerNodeId] = useState('');
  const [shoeNodeId, setShoeNodeId] = useState('');
  const [thirdNodeId, setThirdNodeId] = useState('');
```

Do **not** add `thirdNodeId` to `DetectedMappings` or to the `handleParse` auto-fill logic (lines 210-222) — it stays empty until the admin types a node ID manually.

- [ ] **Step 3: Include in the submit payload**

In the regular-workflow payload object (after `shoeNodeId` on line 296):

```ts
          lowerNodeId: lowerNodeId || undefined,
          shoeNodeId: shoeNodeId || undefined,
          thirdNodeId: thirdNodeId || undefined,
```

- [ ] **Step 4: Add the JSX field**

Change the "Optional image nodes" grid (lines 795-812) from 2 columns to 3, and add the third `NodeSelect`:

```tsx
              {/* Optional image nodes */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <NodeSelect
                  label="Lower garment node"
                  nodes={nodes.image}
                  value={lowerNodeId}
                  onChange={setLowerNodeId}
                  disabled={saving}
                  hint='Title convention: "lower_garment"'
                />
                <NodeSelect
                  label="Shoes node (optional)"
                  nodes={nodes.image}
                  value={shoeNodeId}
                  onChange={setShoeNodeId}
                  disabled={saving}
                  hint='Title convention: "shoes"'
                />
                <NodeSelect
                  label="3rd garment node (optional)"
                  nodes={nodes.image}
                  value={thirdNodeId}
                  onChange={setThirdNodeId}
                  disabled={saving}
                  hint="No auto-detection — pick the node manually"
                />
              </div>
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/admin-web build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Manual verification**

```bash
pnpm --filter @tryme/admin-web dev
```

Open Workflows → Upload new workflow, parse a JSON with 3 `LoadImage` nodes, confirm the "3rd garment node" dropdown lists all image nodes and is selectable, and confirm creating the workflow succeeds and the value round-trips when you reopen it.

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/components/WorkflowUploadModal.tsx
git commit -m "feat(admin-web): support manually mapping a third garment node on workflow templates"
```

---

### Task 10: Catalogues-web — studio wizard 3rd upload box

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx:18-30` (`GarmentType` interface), `:829-847` (state + refs), `:1214-1249` (upload handler), `:1359-1481` (submit payloads), `:1516-1530` (`requiresLowerUpload`/`canGenerate`), `:1793-2210` (upload box UI)

**Interfaces:**
- Consumes: `GarmentType.requiresThirdUpload`/`thirdUploadLabel` (Task 4's API response), `CreateTryOnJobInputs.thirdGarmentKey` (Task 1).
- Produces: `thirdGarmentKey` on every `/v1/jobs/tryon` submission.

No test runner exists for `apps/catalogues-web` (Next.js, `typecheck`/`lint` scripts only). This task is verified by typecheck + a full manual E2E walkthrough (also serves as the plan's overall end-to-end verification — see the Verification section below).

- [ ] **Step 1: Extend the `GarmentType` interface**

After `lowerUploadLabel` on line 29:

```ts
interface GarmentType {
  id: string;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  instructionImageUrl?: string | null;
  requiresLowerUpload: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  requiresMannequinStep?: boolean;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  requiresThirdUpload: boolean;
  thirdUploadLabel?: string | null;
}
```

- [ ] **Step 2: Add state, refs, and the upload handler**

After the `lowerUploadAbortRef` declaration (after line 847):

```ts
  const [thirdGarmentFile, setThirdGarmentFile] = useState<File | null>(null);
  const thirdGarmentPreviewUrl = useMemo(
    () => (thirdGarmentFile ? URL.createObjectURL(thirdGarmentFile) : ''),
    [thirdGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (thirdGarmentPreviewUrl) URL.revokeObjectURL(thirdGarmentPreviewUrl);
    };
  }, [thirdGarmentPreviewUrl]);
  const [thirdGarmentKey, setThirdGarmentKey] = useState('');
  const [isUploadingThird, setIsUploadingThird] = useState(false);
  const thirdFileInputRef = useRef<HTMLInputElement>(null);
  const thirdUploadAbortRef = useRef<AbortController | null>(null);
```

After `handleLowerGarmentUpload` (after line 1249):

```ts
  async function handleThirdGarmentUpload(file: File) {
    if (isUploadingThird) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setThirdGarmentFile(file);
    setIsUploadingThird(true);
    const thirdAbort = new AbortController();
    thirdUploadAbortRef.current = thirdAbort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {}, thirdAbort.signal);
      setThirdGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Third garment upload failed: ${msg}`,
      );
      setThirdGarmentFile(null);
      setThirdGarmentKey('');
    } finally {
      setIsUploadingThird(false);
    }
  }
```

Update the unmount-abort effect (lines 849-855):

```ts
  // Abort any in-flight XHR uploads when the component unmounts (user navigates away)
  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      lowerUploadAbortRef.current?.abort();
      thirdUploadAbortRef.current?.abort();
    };
  }, []);
```

- [ ] **Step 3: Add `thirdGarmentKey` to every submission payload**

In `inputsBase` (both branches, lines 1359-1375):

```ts
      const inputsBase = mannequinJobId
        ? {
            mannequinJobId,
            faceId,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            thirdGarmentKey: thirdGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
          }
        : {
            upperGarmentKey: garmentKey,
            faceId,
            garmentTypeId: garmentTypeId || undefined,
            lowerCatalogId: effectiveLowerId,
            lowerGarmentKey: lowerGarmentKey || undefined,
            thirdGarmentKey: thirdGarmentKey || undefined,
            shoeCatalogId: effectiveShoesId,
          };
```

In `submitAmazonPose`'s two `/v1/jobs/tryon` calls (lines 1450-1459 and 1472-1481), add `thirdGarmentKey: thirdGarmentKey || undefined,` right after each `lowerGarmentKey: lowerGarmentKey || undefined,` line.

- [ ] **Step 4: Extend the layout condition and `canGenerate` gate**

Line 1517, add a derived flag next to `requiresLowerUpload`:

```ts
  const requiresLowerUpload = selectedGarmentType?.requiresLowerUpload ?? false;
  const requiresThirdUpload = selectedGarmentType?.requiresThirdUpload ?? false;
```

Update the layout conditions at lines 1793, 1819-1820, 1830, 1969, 1976-1979, 1991-1993 — every occurrence of `requiresLowerUpload` in this JSX block becomes `(requiresLowerUpload || requiresThirdUpload)`:

Line 1793 (section title):

```tsx
              <SectionHead
                title={
                  requiresLowerUpload || requiresThirdUpload
                    ? 'Upload Garment Images'
                    : 'Upload Garment Image'
                }
                subtitle="Upload a clean flat lay garment image"
                stepNumber={3}
              />
```

Lines 1819-1820 (upload-zone wrapper — stacks vertically when 2+ uploads):

```tsx
                      flexDirection: requiresLowerUpload || requiresThirdUpload ? 'column' : 'row',
                      gap: requiresLowerUpload || requiresThirdUpload ? 8 : 0,
```

Line 1830 (upper-garment box height):

```tsx
                        height: requiresLowerUpload || requiresThirdUpload ? undefined : 210,
```

Line 1969 (upper-garment label font size):

```tsx
                              fontSize: requiresLowerUpload || requiresThirdUpload ? 11 : 12,
```

Lines 1976-1979 (upper-garment label text):

```tsx
                            {requiresLowerUpload || requiresThirdUpload
                              ? selectedGarmentType?.upperUploadLabel ||
                                `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`
                              : `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`}
```

Lines 1991-1993 (upper-garment hint text):

```tsx
                            {requiresLowerUpload || requiresThirdUpload
                              ? 'JPG, PNG · Max 10MB'
                              : 'Drag and drop an image here · JPG, PNG · Max 10MB'}
```

Add `!isUploadingThird` to `canGenerate` (after line 1528):

```ts
    !isUploading &&
    !isUploadingLower &&
    !isUploadingThird &&
    !isSubmitting &&
```

- [ ] **Step 5: Add the third upload box**

Insert immediately after the lower-garment box's closing `)}` (after line 2209, before the container's closing `</div>` on line 2210) — mirror the entire lower-garment `<label>` block (lines 2030-2208) with every `lower`/`Lower` identifier renamed to `third`/`Third`, and the label text source changed:

```tsx
                    {requiresThirdUpload && (
                      <label
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 12,
                          background: C.card,
                          border: `1px solid ${C.border}`,
                          borderRadius: 8,
                          padding: 12,
                          cursor: 'pointer',
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer.files?.[0];
                          if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                            handleThirdGarmentUpload(f);
                        }}
                      >
                        {thirdGarmentFile ? (
                          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                            <img
                              src={thirdGarmentPreviewUrl}
                              alt={thirdGarmentFile.name}
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                borderRadius: 6,
                              }}
                            />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                setThirdGarmentFile(null);
                                setThirdGarmentKey('');
                              }}
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                width: 24,
                                height: 24,
                                borderRadius: '50%',
                                background: 'rgba(0,0,0,0.5)',
                                border: 'none',
                                color: 'white',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <XIcon size={14} />
                            </button>
                            {isUploadingThird && (
                              <div
                                style={{
                                  position: 'absolute',
                                  bottom: 8,
                                  left: 8,
                                  right: 8,
                                  background: 'rgba(255,255,255,0.95)',
                                  borderRadius: 8,
                                  padding: '6px 10px',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    fontSize: 12,
                                    color: C.text,
                                  }}
                                >
                                  <SpinnerIcon size={14} /> Uploading…
                                </div>
                              </div>
                            )}
                            {thirdGarmentKey && (
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  left: 8,
                                  background: C.mint,
                                  color: 'white',
                                  borderRadius: 6,
                                  padding: '3px 8px',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <CheckIcon color="#fff" size={10} /> Uploaded
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: '100%',
                                  color: C.text,
                                  textAlign: 'center',
                                }}
                              >
                                {selectedGarmentType?.thirdUploadLabel ?? 'Third Garment'}
                              </span>
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: 10,
                                  fontWeight: 500,
                                  lineHeight: '140%',
                                  color: C.mid,
                                  textAlign: 'center',
                                }}
                              >
                                JPG, PNG · Max 10MB
                              </span>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                              }}
                            >
                              <ImagePlusIcon size={14} />
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: '18px',
                                  color: C.text,
                                }}
                              >
                                Browse
                              </span>
                            </div>
                          </>
                        )}
                        <input
                          ref={thirdFileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleThirdGarmentUpload(f);
                          }}
                        />
                      </label>
                    )}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/catalogues-web typecheck
```

Expected: no errors.

- [ ] **Step 7: Manual E2E walkthrough**

```bash
pnpm docker:up
pnpm dev
```

1. In admin-web: create (or edit) a garment type with `requiresThirdUpload=true` and a `thirdUploadLabel`, and map a workflow template's `thirdNodeId` to a real `LoadImage` node in an existing ComfyUI workflow JSON that has 3 image inputs (or add a 3rd `LoadImage` node to a test workflow JSON for this purpose).
2. In catalogues-web's studio wizard: select that garment type, confirm **3** upload boxes render (top, bottom, third) stacked in a column, confirm the third box's label matches `thirdUploadLabel`, upload an image to it, and confirm the "Uploaded" badge appears.
3. Submit the job and confirm `POST /v1/jobs/tryon` returns `201` (check network tab or API logs).
4. Query `job_inputs` for the created job and confirm `third_garment_key` is populated:
   ```bash
   docker exec tryme-postgres psql -U tryon -d tryon_dev -c "SELECT third_garment_key FROM job_inputs ORDER BY job_id DESC LIMIT 1;"
   ```
5. If a real/mock GPU worker is available, let the job run to completion and confirm the ComfyUI submission's node inputs include the third image (inspect via `job_events` or dispatcher logs for the `'inputs uploaded'` log line added in Task 7, which now includes `thirdGarmentFile`).
6. Regression-check a garment type with `requiresThirdUpload=false` — confirm only 1 or 2 boxes render as before, and the job still submits successfully.

- [ ] **Step 8: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(catalogues-web): add a third garment upload box to the studio wizard"
```

---

## Verification (full plan)

1. `pnpm docker:up`
2. `pnpm db:generate && pnpm db:migrate` — confirm migration `0115_*` applies cleanly on a fresh checkout.
3. `pnpm typecheck` — must be clean across every workspace.
4. `pnpm --filter @tryme/api test` — full suite green, including the new/extended files from Tasks 2, 3, 4, 5.
5. `pnpm --filter @tryme/dispatcher test` — full suite green (or no *new* failures beyond the pre-existing `happy-path.test.ts` schema drift flagged in Task 7).
6. `pnpm build` — full monorepo build succeeds (this also typechecks `apps/catalogues-web` and `apps/admin-web` via their `build` scripts).
7. Task 10's manual E2E walkthrough, run once at the end against the fully-integrated branch.
8. Update `docs/progress.md` with a new dated entry: what was built (3rd garment upload slot), what's still open (the `happy-path.test.ts` schema drift discovered but not fixed).
