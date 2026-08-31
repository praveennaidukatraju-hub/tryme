# Tryon Garment-From-Catalog Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual garment-image upload on the simple-tryon page with a "Browse from Catalog" picker that reuses the user's own completed Studio-generated images, and auto-resolves the tryon workflow category from an admin-configured garment-type mapping — eliminating the client-visible category selector entirely.

**Architecture:** One new nullable FK column (`garment_subcategories.tryon_category_id`) lets an admin map a garment type to a tryon workflow category on the existing Assets > Garment Types admin page. The resolution chain `job_outputs → job_inputs.garmentTypeId → garment_subcategories.tryonCategoryId → tryon_categories.workflowTemplateId` lets the API resolve both the garment image (a deterministic R2 key, `keys.output(sourceJobId)`) and the ComfyUI workflow from a single `sourceJobId` the user picks in a new catalog-browse modal. `createSimpleTryonJob` is rewritten to take `sourceJobId` instead of `garmentKey`/`categoryId`.

**Tech Stack:** Fastify 5 + zod, Drizzle ORM / Postgres, Next.js 15 (App Router) + `@tanstack/react-query`, Vite + React admin panel.

## Global Constraints

- pnpm workspaces only — no npm/yarn lockfiles.
- ESM only, TypeScript 5.6, Node 20+.
- `packages/db` and `packages/types` compile to `dist/` — rebuild (`pnpm --filter <pkg> build`) after any schema/type change or dependent apps won't see it.
- No testcontainers — API integration tests reuse the docker-compose Postgres/Redis/MinIO; `pnpm docker:up` must be running before `pnpm test`.
- Credit deduct + job insert must be one Postgres transaction; refund on terminal failure is also transactional (existing pattern in `createSimpleTryonJob`, must be preserved).
- All components in `apps/web` use the `C` token map from `apps/web/src/components/tokens.ts` — never raw hex.
- No frontend test runner exists for `apps/web` or `apps/admin` — verification for those tasks is `pnpm typecheck` + manual dev-server check, not automated tests.
- Never commit or push without explicit user instruction (standing rule for this session).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/migrations/0074_garment_tryon_category.sql` | New column: `garment_subcategories.tryon_category_id` |
| `packages/db/src/migrations/meta/_journal.json` | Journal entry for migration 0074 |
| `packages/db/src/schema/models.ts` | Add `tryonCategoryId` to `garmentSubcategories` table def |
| `packages/types/src/admin.ts` | Add `tryonCategoryId` to `CreateGarmentTypeBody` / `PatchGarmentTypeBody` |
| `packages/types/src/jobs.ts` | Rewrite `CreateSimpleTryonRequest`: drop `garmentKey`/`categoryId`, add `sourceJobId` |
| `apps/api/src/modules/admin/subcategories.routes.ts` | Wire `tryonCategoryId` through the garment-type create handler |
| `apps/api/src/modules/jobs/create.ts` | Rewrite `createSimpleTryonJob` to resolve garment + workflow from `sourceJobId` |
| `apps/api/src/modules/jobs/routes.ts` | New `GET /v1/tryon/garment-images` endpoint |
| `apps/api/test/integration/simple-tryon.test.ts` | New — covers job creation + picker endpoint |
| `apps/admin/src/types.ts` | Add `tryonCategoryId` to `GarmentType` interface |
| `apps/admin/src/pages/assets/GarmentTypesTab.tsx` | Add "Tryon Category" select to edit modal + table badge |
| `apps/web/src/app/(app)/tryon/page.tsx` | Remove category selector + garment upload; add catalog-browse modal; swap card order |

---

### Task 1: Database — `tryon_category_id` column on `garment_subcategories`

**Files:**
- Create: `packages/db/src/migrations/0074_garment_tryon_category.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/models.ts:52-67`

**Interfaces:**
- Produces: `schema.garmentSubcategories.tryonCategoryId: string | null` — consumed by Task 3 (admin write), Task 4 (job resolution chain), Task 5 (admin UI), Task 6 (picker endpoint eligibility filter).

- [ ] **Step 1: Confirm the next migration index is still 74**

Run:
```bash
tail -5 packages/db/src/migrations/meta/_journal.json
ls packages/db/src/migrations/ | sort -t/ | tail -3
```
Expected: highest existing index is `73` (`0073_saree_sample_image`). If a newer migration exists (e.g. from a `git pull`), use the next index after that one instead of 74 everywhere in this task — see CLAUDE.md "Migration Index Conflicts".

- [ ] **Step 2: Write the migration SQL**

```sql
-- packages/db/src/migrations/0074_garment_tryon_category.sql
ALTER TABLE "garment_subcategories"
  ADD COLUMN "tryon_category_id" uuid REFERENCES "tryon_categories"("id") ON DELETE SET NULL;
```

- [ ] **Step 3: Add the journal entry**

Edit `packages/db/src/migrations/meta/_journal.json` — the file ends with:

```json
    {
      "idx": 73,
      "version": "7",
      "when": 1783300000000,
      "tag": "0073_saree_sample_image",
      "breakpoints": true
    }
  ]
}
```

Change it to:

```json
    {
      "idx": 73,
      "version": "7",
      "when": 1783300000000,
      "tag": "0073_saree_sample_image",
      "breakpoints": true
    },
    {
      "idx": 74,
      "version": "7",
      "when": 1783500000000,
      "tag": "0074_garment_tryon_category",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 4: Add the column to the Drizzle schema**

In `packages/db/src/schema/models.ts`, the `garmentSubcategories` table currently ends (lines 52-67):

```ts
export const garmentSubcategories = pgTable('garment_subcategories', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  thumbnailKey: text('thumbnail_key'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  requiresLowerUpload: boolean('requires_lower_upload').notNull().default(false),
  defaultLowerCatalogId: uuid('default_lower_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  defaultShoeCatalogId: uuid('default_shoe_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add the new column before `createdAt`. Note: this deliberately does **not** use a typed `.references(() => tryonCategories.id)` helper — `tryon.ts` imports `workflowTemplates` from `models.ts`, so importing `tryonCategories` back into `models.ts` would create a circular module import. The FK is enforced at the SQL level (Step 2); this codebase never uses Drizzle's relational query API (every join in the codebase is a manual `.leftJoin(..., eq(...))`), so the missing `.references()` on the TS side has no runtime effect.

```ts
export const garmentSubcategories = pgTable('garment_subcategories', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  thumbnailKey: text('thumbnail_key'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  requiresLowerUpload: boolean('requires_lower_upload').notNull().default(false),
  defaultLowerCatalogId: uuid('default_lower_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  defaultShoeCatalogId: uuid('default_shoe_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  // FK to tryon_categories.id enforced in SQL only — see migration 0074. Not a
  // typed drizzle reference to avoid a circular import with schema/tryon.ts.
  tryonCategoryId: uuid('tryon_category_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Rebuild the db package**

```bash
pnpm --filter @tryme/db build
```
Expected: exits 0, no TypeScript errors.

- [ ] **Step 6: Apply the migration to the local dev DB**

```bash
pnpm db:migrate
```
Expected: log line for `0074_garment_tryon_category` applied (or `already exists` if you re-run — that's safe per CLAUDE.md).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/0074_garment_tryon_category.sql \
  packages/db/src/migrations/meta/_journal.json \
  packages/db/src/schema/models.ts
git commit -m "feat(db): add garment_subcategories.tryon_category_id"
```

---

### Task 2: Types — admin garment-type body + `CreateSimpleTryonRequest`

**Files:**
- Modify: `packages/types/src/admin.ts:346-367`
- Modify: `packages/types/src/jobs.ts:48-52`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateGarmentTypeBody`/`PatchGarmentTypeBody` gain `tryonCategoryId: string | null | undefined` — consumed by Task 3. `CreateSimpleTryonRequest` becomes `{ personKey: string; sourceJobId: string }` (breaking change — no `garmentKey`/`categoryId`) — consumed by Task 4 and Task 7.

- [ ] **Step 1: Add `tryonCategoryId` to the admin garment-type bodies**

In `packages/types/src/admin.ts`, `CreateGarmentTypeBody` and `PatchGarmentTypeBody` currently read:

```ts
export const CreateGarmentTypeBody = z.object({
  genderSlug: GenderEnum,
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
  thumbnailKey: z.string().optional(),
  requiresLowerUpload: z.boolean().optional().default(false),
});
export const PatchGarmentTypeBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  thumbnailKey: z.string().nullable().optional(),
  requiresLowerUpload: z.boolean().optional(),
  defaultLowerCatalogId: z.string().uuid().nullable().optional(),
  defaultShoeCatalogId: z.string().uuid().nullable().optional(),
});
```

Change to:

```ts
export const CreateGarmentTypeBody = z.object({
  genderSlug: GenderEnum,
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
  thumbnailKey: z.string().optional(),
  requiresLowerUpload: z.boolean().optional().default(false),
  tryonCategoryId: z.string().uuid().nullable().optional(),
});
export const PatchGarmentTypeBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  thumbnailKey: z.string().nullable().optional(),
  requiresLowerUpload: z.boolean().optional(),
  defaultLowerCatalogId: z.string().uuid().nullable().optional(),
  defaultShoeCatalogId: z.string().uuid().nullable().optional(),
  tryonCategoryId: z.string().uuid().nullable().optional(),
});
```

- [ ] **Step 2: Rewrite `CreateSimpleTryonRequest`**

In `packages/types/src/jobs.ts`, replace:

```ts
export const CreateSimpleTryonRequest = z.object({
  personKey: z.string().regex(INPUT_GARMENT_KEY),
  garmentKey: z.string().regex(INPUT_GARMENT_KEY),
  categoryId: z.string().uuid().optional(),
});
```

with:

```ts
export const CreateSimpleTryonRequest = z.object({
  personKey: z.string().regex(INPUT_GARMENT_KEY),
  sourceJobId: z.string().uuid(),
});
```

- [ ] **Step 3: Rebuild the types package**

```bash
pnpm --filter @tryme/types build
```
Expected: exits 0. `apps/api` will show type errors referencing `garmentKey`/`categoryId` until Task 4 — that's expected mid-plan, resolved by the end of Task 4.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/admin.ts packages/types/src/jobs.ts
git commit -m "feat(types): tryonCategoryId on garment-type body, sourceJobId on simple-tryon request"
```

---

### Task 3: Admin API — wire `tryonCategoryId` through garment-type create

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts:41-70`

**Interfaces:**
- Consumes: `CreateGarmentTypeBody`/`PatchGarmentTypeBody` from Task 2 (already includes `tryonCategoryId`).
- Produces: nothing new consumed elsewhere — this task only makes the existing routes accept the field. The `PATCH` handler already spreads `req.body` generically (`.set({ ...body, updatedAt: new Date() })` at line 84) so it needs no code change — only the zod schema addition from Task 2 is required for PATCH to accept `tryonCategoryId`. Only the `POST` (create) handler destructures fields explicitly and needs an edit.

- [ ] **Step 1: Add `tryonCategoryId` to the create handler**

In `apps/api/src/modules/admin/subcategories.routes.ts`, the create handler currently reads:

```ts
    async (req) => {
      const { genderSlug, slug, label, sortOrder, thumbnailKey, requiresLowerUpload } =
        req.body as {
          genderSlug: string;
          slug: string;
          label: string;
          sortOrder: number;
          thumbnailKey?: string;
          requiresLowerUpload?: boolean;
        };
      const [row] = await app.db
        .insert(schema.garmentSubcategories)
        .values({
          genderSlug,
          slug,
          label,
          sortOrder,
          thumbnailKey,
          requiresLowerUpload: requiresLowerUpload ?? false,
        })
        .returning();
      return row;
    },
```

Change to:

```ts
    async (req) => {
      const {
        genderSlug,
        slug,
        label,
        sortOrder,
        thumbnailKey,
        requiresLowerUpload,
        tryonCategoryId,
      } = req.body as {
        genderSlug: string;
        slug: string;
        label: string;
        sortOrder: number;
        thumbnailKey?: string;
        requiresLowerUpload?: boolean;
        tryonCategoryId?: string | null;
      };
      const [row] = await app.db
        .insert(schema.garmentSubcategories)
        .values({
          genderSlug,
          slug,
          label,
          sortOrder,
          thumbnailKey,
          requiresLowerUpload: requiresLowerUpload ?? false,
          tryonCategoryId: tryonCategoryId ?? null,
        })
        .returning();
      return row;
    },
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: no new errors from this file (pre-existing errors from Task 2's `CreateSimpleTryonRequest` change in `create.ts` are expected until Task 4 — ignore those for this step).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts
git commit -m "feat(api): accept tryonCategoryId on garment-type create"
```

---

### Task 4: API — `createSimpleTryonJob` rewrite + garment-images picker endpoint

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:1-16` (imports), `:281-375` (`createSimpleTryonJob`)
- Modify: `apps/api/src/modules/jobs/routes.ts:1-16` (imports), add new route near line 124
- Create: `apps/api/test/integration/simple-tryon.test.ts`

**Interfaces:**
- Consumes: `schema.garmentSubcategories.tryonCategoryId` (Task 1), `CreateSimpleTryonRequest` (Task 2).
- Produces: `POST /v1/jobs/simple-tryon` now takes `{ personKey, sourceJobId }`, returns `{ jobId, catalogueId }` (unchanged shape). `GET /v1/tryon/garment-images` (new) returns `{ jobId: string; thumbnailUrl: string | null; garmentTypeName: string; tryonCategoryName: string }[]` — consumed by Task 7 (`apps/web` tryon page).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/simple-tryon.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('simple tryon (garment from catalog)', () => {
  let c: Containers;
  let app: TestApp;
  let realHeadObject: typeof app.storage.headObject | undefined;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    realHeadObject = app.storage.headObject?.bind(app.storage);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
  });
  afterEach(() => {
    if (realHeadObject) app.storage.headObject = realHeadObject;
  });

  async function registerUser(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, email));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    const accessToken = login.json().accessToken as string;
    const userId = JSON.parse(atob(accessToken.split('.')[1])).sub as string;
    return { token: accessToken, userId };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  // Seeds an eligible source job: an active tryon workflow → an active tryon
  // category pointing at it → a garment type mapped to that category → a
  // COMPLETED job owned by `userId` whose job_inputs.garmentTypeId points at
  // that garment type, with a job_outputs row (thumbnail optional).
  async function seedEligibleSourceJob(userId: string, opts?: { withThumbnail?: boolean }) {
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `tryon-wf-${randomUUID()}`,
        label: 'Tryon workflow',
        workflowType: 'tryon',
        jsonContent: {},
        isActive: true,
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();

    const [category] = await app.db
      .insert(schema.tryonCategories)
      .values({
        name: 'Upper',
        slug: `upper-${randomUUID()}`,
        workflowTemplateId: workflow.id,
        isActive: true,
      })
      .returning();

    const [subcat] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `shirt-${randomUUID()}`,
        label: 'Shirt',
        tryonCategoryId: category.id,
      })
      .returning();

    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();

    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/seed/garment.jpg',
      garmentTypeId: subcat.id,
    });

    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey: keys.output(job.id),
      thumbnailKey: opts?.withThumbnail === false ? null : keys.outputThumb(job.id),
    });

    return { jobId: job.id, workflowTemplateId: workflow.id, subcategoryId: subcat.id };
  }

  it('happy path: deducts 35 credits, uses keys.output(sourceJobId) as garment, resolves workflow', async () => {
    const { token, userId } = await registerUser('tryon-happy@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId, workflowTemplateId, subcategoryId } =
      await seedEligibleSourceJob(userId);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId, catalogueId } = res.json();
    expect(jobId).toBeTruthy();
    expect(catalogueId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(35);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(65);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(keys.output(sourceJobId));
    expect(inputs.garmentTypeId).toBe(subcategoryId);
    const params = inputs.params as Record<string, unknown>;
    expect(params.personKey).toBe(personKey);
    expect(params.workflowTemplateId).toBe(workflowTemplateId);

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);
  });

  it('rejects with FORBIDDEN when sourceJobId belongs to another user', async () => {
    const { userId: otherUserId } = await registerUser('tryon-owner@x.com');
    const { jobId: sourceJobId } = await seedEligibleSourceJob(otherUserId);

    const { token, userId } = await registerUser('tryon-thief@x.com');
    await grantCredits(userId, 100);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects with NOT_FOUND when sourceJobId does not exist', async () => {
    const { token, userId } = await registerUser('tryon-missing@x.com');
    await grantCredits(userId, 100);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects with VALIDATION when the source job is not COMPLETED', async () => {
    const { token, userId } = await registerUser('tryon-notdone@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId);
    await app.db.update(schema.jobs).set({ status: 'QUEUED' }).where(eq(schema.jobs.id, sourceJobId));
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects with VALIDATION when the garment type has no tryon category mapped', async () => {
    const { token, userId } = await registerUser('tryon-unmapped@x.com');
    await grantCredits(userId, 100);
    const [subcat] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `unmapped-${randomUUID()}`, label: 'Unmapped' })
      .returning();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/seed/garment.jpg',
      garmentTypeId: subcat.id,
    });
    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey: keys.output(job.id),
      thumbnailKey: keys.outputThumb(job.id),
    });
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId: job.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refunds credits and marks FAILED on enqueue failure', async () => {
    const { token, userId } = await registerUser('tryon-enqfail@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/simple-tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: { personKey, sourceJobId },
      });
      expect(res.statusCode).toBe(503);

      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(100);

      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.userId, userId));
      expect(job.status).toBe('FAILED');
      expect(job.errorCode).toBe('ENQUEUE_FAIL');
    } finally {
      app.redis.xadd = realXadd;
    }
  });

  describe('GET /v1/tryon/garment-images', () => {
    it('returns only eligible completed images owned by the caller', async () => {
      const { token, userId } = await registerUser('tryon-picker@x.com');
      const { jobId: eligibleJobId } = await seedEligibleSourceJob(userId);

      // Ineligible: garmentTypeId set but no tryonCategoryId mapping.
      const [unmapped] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'men', slug: `um-${randomUUID()}`, label: 'Unmapped' })
        .returning();
      const [unmappedJob] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: unmappedJob.id,
        upperGarmentKey: 'inputs/seed/garment.jpg',
        garmentTypeId: unmapped.id,
      });
      await app.db.insert(schema.jobOutputs).values({
        jobId: unmappedJob.id,
        resultKey: keys.output(unmappedJob.id),
      });

      // Ineligible: another user's eligible job.
      const { userId: otherUserId } = await registerUser('tryon-picker-other@x.com');
      await seedEligibleSourceJob(otherUserId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/tryon/garment-images',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ jobId: string; garmentTypeName: string }>;
      expect(body.map((r) => r.jobId)).toEqual([eligibleJobId]);
      expect(body[0].garmentTypeName).toBe('Shirt');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api test -- simple-tryon
```
Expected: FAIL — `CreateSimpleTryonRequest` still has `garmentKey`/`categoryId` semantics in `create.ts`, `GET /v1/tryon/garment-images` doesn't exist yet (404s), and `garmentSubcategories.tryonCategoryId` isn't written by `seedEligibleSourceJob`'s insert path being exercised (schema is present from Task 1, but nothing reads it yet).

- [ ] **Step 3: Rewrite `createSimpleTryonJob`**

In `apps/api/src/modules/jobs/create.ts`, add `keys` to the imports at the top:

```ts
import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { keys } from '@tryme/storage';
import {
  type CreateSimpleTryonRequest,
  type CreateTryOnJobRequest,
  RESOLUTION_COSTS,
  type Resolution,
  SIMPLE_TRYON_COST,
} from '@tryme/types';
import { aliasedTable, and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { atomicDeduct, refund } from '../credits/ledger.js';
import { promptGuard } from './sanitize.js';
```

Replace the entire `createSimpleTryonJob` function (currently lines 281-375) with:

```ts
export async function createSimpleTryonJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSimpleTryonRequest>,
) {
  const { personKey, sourceJobId } = body;
  const COST = SIMPLE_TRYON_COST;

  await assertOwnsUploadKey(app, userId, personKey);

  // Resolve the source image's garment type → tryon category → workflow template.
  // Left-joins because a job with no garmentTypeId or an unmapped garment type
  // must fail with a clear VALIDATION error, not silently 404.
  const [source] = await app.db
    .select({
      jobUserId: schema.jobs.userId,
      jobStatus: schema.jobs.status,
      garmentTypeId: schema.jobInputs.garmentTypeId,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .where(eq(schema.jobs.id, sourceJobId));

  if (!source) throw new AppError('NOT_FOUND', 404, 'source image not found');
  if (source.jobUserId !== userId) {
    throw new AppError('FORBIDDEN', 403, 'source image not owned by caller');
  }
  if (source.jobStatus !== 'COMPLETED') {
    throw new AppError('VALIDATION', 400, 'source image is not a completed job');
  }
  if (!source.workflowTemplateId) {
    throw new AppError('VALIDATION', 400, 'garment type has no tryon category configured');
  }

  const garmentKey = keys.output(sourceJobId);
  const workflowTemplateId = source.workflowTemplateId;

  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({ queueStream: schema.creditPlans.queueStream })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';

  const catalogueId = randomUUID();
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({ userId, catalogueId, status: 'QUEUED', priority, creditsCharged: COST })
      .returning();
    await atomicDeduct(tx as unknown as DB, userId, COST, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      upperGarmentKey: garmentKey,
      garmentTypeId: source.garmentTypeId,
      params: { personKey, workflowTemplateId },
    });
    return [newJob];
  });

  const stream = `jobs:${queueStream}`;
  try {
    await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', job.id, 'userId', userId);
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'tryon' });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed — simple tryon job will be refunded');
    await refund(app.db, userId, COST, job.id, 'REFUND_ENQUEUE_FAIL');
    await app.db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
      .where(eq(schema.jobs.id, job.id));
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id, catalogueId };
}
```

- [ ] **Step 4: Add the `GET /v1/tryon/garment-images` route**

In `apps/api/src/modules/jobs/routes.ts`, insert the new route right after the existing `GET /v1/tryon/categories` route (after its closing `});` around line 124), before the `// List catalogues` comment:

```ts
  // GET /v1/tryon/garment-images — caller's own completed catalog images eligible
  // for reuse as a simple-tryon garment: must carry a garmentTypeId whose garment
  // type has a tryonCategoryId mapped by admin. Inner joins do the eligibility
  // filtering — no explicit IS NOT NULL checks needed.
  app.get('/v1/tryon/garment-images', { preHandler: app.requireUser }, async (req) => {
    const rows = await app.db
      .select({
        jobId: schema.jobs.id,
        thumbnailKey: schema.jobOutputs.thumbnailKey,
        garmentTypeName: schema.garmentSubcategories.label,
        tryonCategoryName: schema.tryonCategories.name,
      })
      .from(schema.jobs)
      .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .innerJoin(
        schema.garmentSubcategories,
        eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
      )
      .innerJoin(
        schema.tryonCategories,
        eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
      )
      .where(and(eq(schema.jobs.userId, req.userId), eq(schema.jobs.status, 'COMPLETED')))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(50);

    return Promise.all(
      rows.map(async (r) => {
        const thumbKey = r.thumbnailKey ?? keys.output(r.jobId);
        let thumbnailUrl: string | null = null;
        try {
          thumbnailUrl = (await app.storage.presignGet(thumbKey, 3600)).url;
        } catch {
          /* missing object — leave null, client shows placeholder */
        }
        return {
          jobId: r.jobId,
          thumbnailUrl,
          garmentTypeName: r.garmentTypeName,
          tryonCategoryName: r.tryonCategoryName,
        };
      }),
    );
  });

```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api test -- simple-tryon
```
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Typecheck the whole API**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: no errors (this resolves the intermediate breakage noted in Task 2 Step 3).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/routes.ts \
  apps/api/test/integration/simple-tryon.test.ts
git commit -m "feat(api): resolve simple-tryon garment+workflow from sourceJobId, add garment-images picker endpoint"
```

---

### Task 5: Admin panel — "Tryon Category" mapping on Garment Types

**Files:**
- Modify: `apps/admin/src/types.ts:35-49`
- Modify: `apps/admin/src/pages/assets/GarmentTypesTab.tsx`

**Interfaces:**
- Consumes: `GET /admin/tryon-categories` (existing endpoint, returns `TryonCategory[]`), `PATCH /admin/assets/garment-types/:id` (Task 3, accepts `tryonCategoryId`).
- Produces: nothing consumed by later tasks — this is a leaf UI task.

- [ ] **Step 1: Add `tryonCategoryId` to the `GarmentType` interface**

In `apps/admin/src/types.ts`, `GarmentType` currently reads (lines 35-49):

```ts
export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  thumbnailKey?: string | null;
  isActive: boolean;
  sortOrder: number;
  requiresLowerUpload: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
}
```

Add the field:

```ts
export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  thumbnailKey?: string | null;
  isActive: boolean;
  sortOrder: number;
  requiresLowerUpload: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  tryonCategoryId?: string | null;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
}
```

- [ ] **Step 2: Import `TryonCategory` and add local state in `GarmentTypesTab.tsx`**

Change the type import (line 7):

```ts
import type { GarmentType, GenderSlug, PoseGarmentConfig, WorkflowOption } from '../../types';
```

to:

```ts
import type {
  GarmentType,
  GenderSlug,
  PoseGarmentConfig,
  TryonCategory,
  WorkflowOption,
} from '../../types';
```

Add a `tryonCategories` list state next to `confirmDelete` (after line 40 `const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteGT | null>(null);`):

```ts
  const [tryonCategories, setTryonCategories] = useState<TryonCategory[]>([]);
```

Add `editSubcatTryonCategoryId` next to the other edit-modal fields (after line 60 `const [editSubcatDefaultShoeId, setEditSubcatDefaultShoeId] = useState<string>('');`):

```ts
  const [editSubcatTryonCategoryId, setEditSubcatTryonCategoryId] = useState<string>('');
```

- [ ] **Step 3: Fetch tryon categories once on mount**

Add a new `useEffect` after the existing `visibilitychange` effect (after line 100, before `saveConfig`):

```ts
  useEffect(() => {
    apiFetch<TryonCategory[]>('/admin/tryon-categories')
      .then(setTryonCategories)
      .catch(() => {});
  }, []);
```

- [ ] **Step 4: Initialize the field when opening the edit modal**

The "Edit" button `onClick` (around line 389) currently reads:

```tsx
                        <button
                          className="btn sm ghost"
                          onClick={() => {
                            setEditingSubcat(sub);
                            setEditSubcatLabel(sub.label);
                            setEditSubcatRequiresLowerUpload(sub.requiresLowerUpload);
                            setEditSubcatDefaultLowerId(sub.defaultLowerCatalogId ?? '');
                            setEditSubcatDefaultShoeId(sub.defaultShoeCatalogId ?? '');
                            setEditSubcatImageFile(null);
                          }}
                        >
```

Add the tryon-category init line:

```tsx
                        <button
                          className="btn sm ghost"
                          onClick={() => {
                            setEditingSubcat(sub);
                            setEditSubcatLabel(sub.label);
                            setEditSubcatRequiresLowerUpload(sub.requiresLowerUpload);
                            setEditSubcatDefaultLowerId(sub.defaultLowerCatalogId ?? '');
                            setEditSubcatDefaultShoeId(sub.defaultShoeCatalogId ?? '');
                            setEditSubcatTryonCategoryId(sub.tryonCategoryId ?? '');
                            setEditSubcatImageFile(null);
                          }}
                        >
```

- [ ] **Step 5: Add the select field to the edit modal**

The "Requires lower garment upload" field block (lines 708-721) currently ends right before the "Default lower garment" field:

```tsx
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editSubcatRequiresLowerUpload}
                    disabled={editSubcatSaving}
                    onChange={(e) => setEditSubcatRequiresLowerUpload(e.target.checked)}
                  />
                  Requires lower garment upload
                  <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                    (user uploads bottom wear separately)
                  </span>
                </label>
              </div>
              <div className="field">
                <label>Default lower garment</label>
```

Insert a new field between them:

```tsx
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={editSubcatRequiresLowerUpload}
                    disabled={editSubcatSaving}
                    onChange={(e) => setEditSubcatRequiresLowerUpload(e.target.checked)}
                  />
                  Requires lower garment upload
                  <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                    (user uploads bottom wear separately)
                  </span>
                </label>
              </div>
              <div className="field">
                <label>Tryon Category</label>
                <select
                  className="select"
                  value={editSubcatTryonCategoryId}
                  disabled={editSubcatSaving}
                  onChange={(e) => setEditSubcatTryonCategoryId(e.target.value)}
                >
                  <option value="">— none —</option>
                  {tryonCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                  Maps this garment type to a tryon workflow for the "Browse from Catalog" picker
                  on the tryon page.
                </span>
              </div>
              <div className="field">
                <label>Default lower garment</label>
```

- [ ] **Step 6: Include the field in the save diff + button disabled check**

The save button's `disabled` condition (around line 1009) currently reads:

```tsx
                disabled={
                  editSubcatSaving ||
                  (!editSubcatImageFile &&
                    editSubcatLabel.trim() === editingSubcat.label.trim() &&
                    editSubcatRequiresLowerUpload === editingSubcat.requiresLowerUpload &&
                    editSubcatDefaultLowerId === (editingSubcat.defaultLowerCatalogId ?? '') &&
                    editSubcatDefaultShoeId === (editingSubcat.defaultShoeCatalogId ?? ''))
                }
```

Change to:

```tsx
                disabled={
                  editSubcatSaving ||
                  (!editSubcatImageFile &&
                    editSubcatLabel.trim() === editingSubcat.label.trim() &&
                    editSubcatRequiresLowerUpload === editingSubcat.requiresLowerUpload &&
                    editSubcatDefaultLowerId === (editingSubcat.defaultLowerCatalogId ?? '') &&
                    editSubcatDefaultShoeId === (editingSubcat.defaultShoeCatalogId ?? '') &&
                    editSubcatTryonCategoryId === (editingSubcat.tryonCategoryId ?? ''))
                }
```

The `onClick` handler below it declares `patchBody`'s type and diffs each field. It currently reads (around line 1020):

```tsx
                    const patchBody: {
                      thumbnailKey?: string;
                      label?: string;
                      requiresLowerUpload?: boolean;
                      defaultLowerCatalogId?: string | null;
                      defaultShoeCatalogId?: string | null;
                    } = {};
```

Change to:

```tsx
                    const patchBody: {
                      thumbnailKey?: string;
                      label?: string;
                      requiresLowerUpload?: boolean;
                      defaultLowerCatalogId?: string | null;
                      defaultShoeCatalogId?: string | null;
                      tryonCategoryId?: string | null;
                    } = {};
```

And the diff block (around line 1049-1054) currently reads:

```tsx
                    if (editSubcatDefaultLowerId !== (editingSubcat.defaultLowerCatalogId ?? '')) {
                      patchBody.defaultLowerCatalogId = editSubcatDefaultLowerId || null;
                    }
                    if (editSubcatDefaultShoeId !== (editingSubcat.defaultShoeCatalogId ?? '')) {
                      patchBody.defaultShoeCatalogId = editSubcatDefaultShoeId || null;
                    }
```

Add the new field's diff right after:

```tsx
                    if (editSubcatDefaultLowerId !== (editingSubcat.defaultLowerCatalogId ?? '')) {
                      patchBody.defaultLowerCatalogId = editSubcatDefaultLowerId || null;
                    }
                    if (editSubcatDefaultShoeId !== (editingSubcat.defaultShoeCatalogId ?? '')) {
                      patchBody.defaultShoeCatalogId = editSubcatDefaultShoeId || null;
                    }
                    if (editSubcatTryonCategoryId !== (editingSubcat.tryonCategoryId ?? '')) {
                      patchBody.tryonCategoryId = editSubcatTryonCategoryId || null;
                    }
```

- [ ] **Step 7: Reset the field on close/save**

There are two full-reset blocks — the header close button (around line 679) and the footer Cancel button (around line 992) — plus the post-save reset (around line 1064). All three currently reset `editSubcatDefaultShoeId` last. In each of the three, add `setEditSubcatTryonCategoryId('');` immediately after the `setEditSubcatDefaultShoeId('');` line. Example (header close button):

```tsx
              <button
                className="btn sm ghost"
                onClick={() => {
                  setEditingSubcat(null);
                  setEditSubcatImageFile(null);
                  setEditSubcatLabel('');
                  setEditSubcatRequiresLowerUpload(false);
                  setEditSubcatDefaultLowerId('');
                  setEditSubcatDefaultShoeId('');
                  setEditSubcatTryonCategoryId('');
                }}
                disabled={editSubcatSaving}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
```

Apply the same one-line addition to the footer Cancel button's `onClick` and to the post-save reset block inside the Save button's `onClick` (the block right after `toast({ title: ... updated' });`).

- [ ] **Step 8: Add a table column showing the mapped category**

The table header (around line 256) currently reads:

```tsx
                <tr>
                  <th>Garment Type</th>
                  <th>Gender</th>
                  <th>Default Lower</th>
                  <th>Default Shoe</th>
                  <th>Active</th>
                  <th></th>
                </tr>
```

Change to:

```tsx
                <tr>
                  <th>Garment Type</th>
                  <th>Gender</th>
                  <th>Default Lower</th>
                  <th>Default Shoe</th>
                  <th>Tryon Category</th>
                  <th>Active</th>
                  <th></th>
                </tr>
```

Insert a new `<td>` right after the "Default Shoe" `<td>` block closes (around line 357, right before `<td onClick={(e) => e.stopPropagation()}>` that wraps the `Switch`):

```tsx
                    <td>
                      {(() => {
                        const cat = tryonCategories.find((c) => c.id === sub.tryonCategoryId);
                        return cat ? (
                          <span className="badge dot accent">{cat.name}</span>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>
                        );
                      })()}
                    </td>
```

Update the empty-state row's `colSpan` (around line 415) from `6` to `7`:

```tsx
                {filteredGarmentTypes.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}
                    >
                      No garment types found.
                    </td>
                  </tr>
                )}
```

- [ ] **Step 9: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```
Expected: no errors.

- [ ] **Step 10: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```
Open the admin panel, go to Assets > Garment Types, edit a garment type, confirm the "Tryon Category" dropdown appears, populates from existing tryon categories, saves, and the table badge reflects it.

- [ ] **Step 11: Commit**

```bash
git add apps/admin/src/types.ts apps/admin/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin): map garment types to tryon categories"
```

---

### Task 6: Web — replace garment upload with catalog picker on the tryon page

**Files:**
- Modify: `apps/web/src/app/(app)/tryon/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/tryon/garment-images` (Task 4), `POST /v1/jobs/simple-tryon` with `{ personKey, sourceJobId }` (Task 4).
- Produces: nothing consumed elsewhere — leaf UI task.

- [ ] **Step 1: Simplify the data query — drop `categories`/`garmentSampleUrl` usage**

The current query block (lines 349-362) reads:

```tsx
  const { data: tryonData } = useQuery<TryonCategoriesResponse>({
    queryKey: ['tryon-categories'],
    queryFn: () => api.get('/v1/tryon/categories'),
    staleTime: 5 * 60 * 1000,
  });
  const categories = tryonData?.categories ?? [];
  const personSampleUrl = tryonData?.personSampleUrl ?? null;
  const garmentSampleUrl = tryonData?.garmentSampleUrl ?? null;

  useEffect(() => {
    if (categories.length > 0 && !selectedCategoryId) {
      setSelectedCategoryId(categories[0]?.id ?? null);
    }
  }, [categories, selectedCategoryId]);
```

Change to (the endpoint itself is unchanged — still needed for `personSampleUrl` on the surviving person upload card):

```tsx
  const { data: tryonData } = useQuery<TryonCategoriesResponse>({
    queryKey: ['tryon-categories'],
    queryFn: () => api.get('/v1/tryon/categories'),
    staleTime: 5 * 60 * 1000,
  });
  const personSampleUrl = tryonData?.personSampleUrl ?? null;
```

- [ ] **Step 2: Replace state — drop garment-upload state, add garment-picker state**

The state block (lines 295-305) currently reads:

```tsx
  const [personFile, setPersonFile] = useState<File | null>(null);
  const [garmentFile, setGarmentFile] = useState<File | null>(null);
  const [personPreview, setPersonPreview] = useState<string | null>(null);
  const [garmentPreview, setGarmentPreview] = useState<string | null>(null);
  const [personProgress, setPersonProgress] = useState(0);
  const [garmentProgress, setGarmentProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
```

Change to:

```tsx
  const [personFile, setPersonFile] = useState<File | null>(null);
  const [personPreview, setPersonPreview] = useState<string | null>(null);
  const [personProgress, setPersonProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [selectedGarmentJob, setSelectedGarmentJob] = useState<{
    jobId: string;
    thumbnailUrl: string | null;
    garmentTypeName: string;
  } | null>(null);
  const [showGarmentPicker, setShowGarmentPicker] = useState(false);
```

- [ ] **Step 3: Add the `GarmentCatalogImage` type near the top of the file**

Right after the existing `TryonCategoriesResponse` type (line 15), add:

```tsx
type GarmentCatalogImage = {
  jobId: string;
  thumbnailUrl: string | null;
  garmentTypeName: string;
  tryonCategoryName: string;
};
```

- [ ] **Step 4: Rewrite `handleGenerate` and `canGenerate`**

The current block (lines 410-462) reads:

```tsx
  const handleGenerate = async () => {
    if (!personFile || !garmentFile) {
      setError('Upload both a person image and a garment image first.');
      return;
    }
    setGenerating(true);
    setError(null);
    setResultUrl(null);
    setPersonProgress(1);
    setGarmentProgress(1);
    try {
      const [personPresign, garmentPresign] = await Promise.all([
        api.post<{ uploadUrl: string; r2Key: string }>('/v1/uploads/presign', {
          contentType: personFile.type,
          contentLength: personFile.size,
        }),
        api.post<{ uploadUrl: string; r2Key: string }>('/v1/uploads/presign', {
          contentType: garmentFile.type,
          contentLength: garmentFile.size,
        }),
      ]);

      await Promise.all([
        api.uploadToR2WithProgress(personPresign.uploadUrl, personFile, setPersonProgress),
        api.uploadToR2WithProgress(garmentPresign.uploadUrl, garmentFile, setGarmentProgress),
      ]);

      setPersonProgress(100);
      setGarmentProgress(100);

      const { jobId } = await api.post<{ jobId: string; catalogueId: string }>(
        '/v1/jobs/simple-tryon',
        {
          personKey: personPresign.r2Key,
          garmentKey: garmentPresign.r2Key,
          ...(selectedCategoryId ? { categoryId: selectedCategoryId } : {}),
        },
      );

      // useJobStream callback above watches for this jobId and handles COMPLETED/FAILED
      setPendingJobId(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      // Show user-friendly message; only expose safe messages (upload/credit errors)
      const safe = /upload|credit|image|file|size|format/i.test(msg);
      setError(safe ? msg : 'Something went wrong. Please try again.');
      setGenerating(false);
      setPersonProgress(0);
      setGarmentProgress(0);
    }
  };

  const canGenerate = !generating && !!personFile && !!garmentFile;
```

Change to:

```tsx
  const handleGenerate = async () => {
    if (!personFile || !selectedGarmentJob) {
      setError('Select a garment from the catalog and upload a person image first.');
      return;
    }
    setGenerating(true);
    setError(null);
    setResultUrl(null);
    setPersonProgress(1);
    try {
      const personPresign = await api.post<{ uploadUrl: string; r2Key: string }>(
        '/v1/uploads/presign',
        { contentType: personFile.type, contentLength: personFile.size },
      );

      await api.uploadToR2WithProgress(personPresign.uploadUrl, personFile, setPersonProgress);
      setPersonProgress(100);

      const { jobId } = await api.post<{ jobId: string; catalogueId: string }>(
        '/v1/jobs/simple-tryon',
        { personKey: personPresign.r2Key, sourceJobId: selectedGarmentJob.jobId },
      );

      // useJobStream callback above watches for this jobId and handles COMPLETED/FAILED
      setPendingJobId(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      // Show user-friendly message; only expose safe messages (upload/credit errors)
      const safe = /upload|credit|image|file|size|format/i.test(msg);
      setError(safe ? msg : 'Something went wrong. Please try again.');
      setGenerating(false);
      setPersonProgress(0);
    }
  };

  const canGenerate = !generating && !!personFile && !!selectedGarmentJob;
```

- [ ] **Step 5: Also clear `resultUrl`/`error` when a new garment is picked**

Add a small handler used by the modal (place it right after `handleGenerate`, before the JSX `return`):

```tsx
  const handleSelectGarment = (img: GarmentCatalogImage) => {
    setSelectedGarmentJob({
      jobId: img.jobId,
      thumbnailUrl: img.thumbnailUrl,
      garmentTypeName: img.garmentTypeName,
    });
    setShowGarmentPicker(false);
    setError(null);
    setResultUrl(null);
  };
```

- [ ] **Step 6: Remove the category-selector JSX block**

Delete the entire "Category selector" block (lines 497-540):

```tsx
          {/* Category selector */}
          {categories.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
              {categories.map((cat) => {
                ...
              })}
            </div>
          )}

```

- [ ] **Step 7: Replace the two-`UploadZone` row — garment picker card first, person `UploadZone` second**

The current row (lines 542-585) reads:

```tsx
          {/* Two upload cards */}
          <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
            <UploadZone
              file={personFile}
              preview={personPreview}
              progress={personProgress}
              label="1. Upload Person Image"
              tip="Front-facing images with good lighting deliver the most accurate results."
              disabled={generating}
              sampleUrl={personSampleUrl}
              onFile={(f) => pickFile(f, setPersonFile, setPersonPreview)}
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="8" r="3.5" stroke={C.mid} strokeWidth="1.2" />
                  <path
                    d="M5 20C5 17 8 15 12 15C16 15 19 17 19 20"
                    stroke={C.mid}
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
            <UploadZone
              file={garmentFile}
              preview={garmentPreview}
              progress={garmentProgress}
              label="2. Upload Garment Image"
              tip="Use clean garment images with minimal background distractions."
              disabled={generating}
              sampleUrl={garmentSampleUrl}
              onFile={(f) => pickFile(f, setGarmentFile, setGarmentPreview)}
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 7L7 4H9.5C9.5 5.38 10.62 6.5 12 6.5C13.38 6.5 14.5 5.38 14.5 4H17L21 7L18.5 9.5L17 8V20H7V8L5.5 9.5L3 7Z"
                    stroke={C.mid}
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            />
          </div>
```

Replace with (garment picker card first, person `UploadZone` second — swapped position per requirement; labels renumbered):

```tsx
          {/* Garment picker + person upload */}
          <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                borderRadius: 12,
                background: C.bg,
                boxShadow: `inset 0 0 0 1px ${C.border}`,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 12,
                boxSizing: 'border-box',
              }}
            >
              <div>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                  1. Select Garment
                </span>
              </div>

              {/* biome-ignore lint/a11y/useSemanticElements: matches UploadZone's drop-zone pattern */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => !generating && setShowGarmentPicker(true)}
                onKeyDown={(e) => e.key === 'Enter' && !generating && setShowGarmentPicker(true)}
                style={{
                  flex: 1,
                  margin: '12px 0',
                  borderRadius: 12,
                  outline: `1px dashed ${selectedGarmentJob ? 'transparent' : C.lighter}`,
                  outlineOffset: -1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: 12,
                  boxSizing: 'border-box',
                  cursor: generating ? 'default' : 'pointer',
                  overflow: 'hidden',
                }}
              >
                {selectedGarmentJob?.thumbnailUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={selectedGarmentJob.thumbnailUrl}
                    alt={selectedGarmentJob.garmentTypeName}
                    style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
                  />
                ) : (
                  <>
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: '50%',
                        background: C.white,
                        boxShadow: `inset 0 0 0 1px ${C.border2}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M3 7L7 4H9.5C9.5 5.38 10.62 6.5 12 6.5C13.38 6.5 14.5 5.38 14.5 4H17L21 7L18.5 9.5L17 8V20H7V8L5.5 9.5L3 7Z"
                          stroke={C.mid}
                          strokeWidth="1.2"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 500, color: C.text }}>
                      Browse from Catalog
                    </span>
                  </>
                )}
              </div>

              {selectedGarmentJob && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: C.mid,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selectedGarmentJob.garmentTypeName}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowGarmentPicker(true)}
                    disabled={generating}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: C.pink,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: generating ? 'default' : 'pointer',
                      padding: 0,
                    }}
                  >
                    Change
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                {/* biome-ignore lint/performance/noImgElement: static SVG asset */}
                <img
                  src="/assets/bulb.svg"
                  alt=""
                  width={12}
                  height={14}
                  style={{ flexShrink: 0, marginTop: 1 }}
                />
                <span style={{ fontSize: 10, fontWeight: 600, color: C.pink, flexShrink: 0 }}>
                  Tips
                </span>
                <span style={{ fontSize: 10, fontWeight: 400, lineHeight: '16px', color: C.mid }}>
                  Pick any garment you&apos;ve already generated in Studio — its tryon workflow
                  applies automatically.
                </span>
              </div>
            </div>

            <UploadZone
              file={personFile}
              preview={personPreview}
              progress={personProgress}
              label="2. Upload Person Image"
              tip="Front-facing images with good lighting deliver the most accurate results."
              disabled={generating}
              sampleUrl={personSampleUrl}
              onFile={(f) => pickFile(f, setPersonFile, setPersonPreview)}
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="8" r="3.5" stroke={C.mid} strokeWidth="1.2" />
                  <path
                    d="M5 20C5 17 8 15 12 15C16 15 19 17 19 20"
                    stroke={C.mid}
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
          </div>
```

- [ ] **Step 8: Add the `GarmentCatalogModal` component**

Add this new component right after the `UploadZone` component's closing brace (after line 292, before `export default function TryOnPage()`):

```tsx
function GarmentCatalogModal({
  onSelect,
  onClose,
}: {
  onSelect: (img: GarmentCatalogImage) => void;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<GarmentCatalogImage[]>({
    queryKey: ['tryon-garment-images'],
    queryFn: () => api.get('/v1/tryon/garment-images'),
  });
  const images = data ?? [];

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: modal backdrop close on click
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.white,
          borderRadius: 16,
          width: '100%',
          maxWidth: 640,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: `1px solid ${C.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
            Browse from Catalog
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: C.mid,
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', color: C.mid, padding: '2rem' }}>Loading…</div>
          ) : images.length === 0 ? (
            <div style={{ textAlign: 'center', color: C.mid, padding: '2rem', fontSize: 13 }}>
              No eligible catalog images yet — generate one in Studio first.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 12,
              }}
            >
              {images.map((img) => (
                <button
                  key={img.jobId}
                  type="button"
                  onClick={() => onSelect(img)}
                  style={{
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: 0,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    background: 'none',
                    textAlign: 'left',
                  }}
                >
                  {img.thumbnailUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={img.thumbnailUrl}
                      alt={img.garmentTypeName}
                      style={{
                        width: '100%',
                        aspectRatio: '3/4',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <div style={{ width: '100%', aspectRatio: '3/4', background: C.bg }} />
                  )}
                  <div style={{ padding: '6px 8px' }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: C.text,
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {img.garmentTypeName}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Render the modal**

Right before the closing `</div>` of the root element and after the "Contact Us modal" block (end of file, around line 1128, right before the final `</div>\n  );`), add:

```tsx
      {/* Garment catalog picker modal */}
      {showGarmentPicker && (
        <GarmentCatalogModal
          onSelect={handleSelectGarment}
          onClose={() => setShowGarmentPicker(false)}
        />
      )}
```

- [ ] **Step 10: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```
Expected: no errors. If `TryonCategory`/`TryonCategoriesResponse` types show an "unused" lint warning because `categories`/`garmentSampleUrl` are no longer read, that's fine — the types still describe the real API response shape.

- [ ] **Step 11: Manual verification**

```bash
pnpm --filter @tryme/web dev
```
Open `/tryon` in a browser (log in first, ensure the user has at least one Studio-generated catalog image whose garment type is mapped to a tryon category via Task 5's admin UI):
- Confirm the category selector is gone.
- Confirm the left card shows "1. Select Garment" with a "Browse from Catalog" prompt, and the person upload is now the second card labeled "2. Upload Person Image".
- Click it, confirm the modal lists eligible images (or shows the empty state if none are mapped yet).
- Pick one, confirm the card shows its thumbnail + "Change" button.
- Upload a person image, click Generate, confirm the job posts successfully and the SSE flow still resolves to a result image.

- [ ] **Step 12: Commit**

```bash
git add "apps/web/src/app/(app)/tryon/page.tsx"
git commit -m "feat(web): replace tryon garment upload with browse-from-catalog picker"
```

---

## Self-Review

**Spec coverage:**
- Data model (`tryonCategoryId` column, no `tryonSampleImageKey`) → Task 1. ✓
- Resolution chain via `job_outputs`/`job_inputs.garmentTypeId` → Task 4. ✓
- Admin mapping UI on Assets > Garment Types → Task 5. ✓
- New `GET /v1/tryon/garment-images` + rewritten `POST /v1/jobs/simple-tryon` → Task 4. ✓
- Frontend: category selector removed, garment upload removed, catalog-browse modal added, person upload unchanged, card order swapped (garment first, person second) → Task 6. ✓
- Observability gap closed (`job_inputs.garmentTypeId` now populated for simple-tryon jobs) → Task 4 Step 3 (`garmentTypeId: source.garmentTypeId` in the insert). ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" language — every step has full code. No task references a function/type not defined earlier in the plan.

**Type consistency:** `sourceJobId` (Task 2 zod, Task 4 handler, Task 6 client call) — consistent. `GarmentCatalogImage` (Task 4 endpoint response shape, Task 6 type + modal + `selectedGarmentJob` state) — field names (`jobId`, `thumbnailUrl`, `garmentTypeName`, `tryonCategoryName`) match exactly across Task 4's route and Task 6's type/usage. `tryonCategoryId` (Task 1 schema, Task 2 zod bodies, Task 3 handler, Task 5 admin state/JSX) — consistent camelCase throughout the TS layer, `tryon_category_id` at the SQL layer only.
