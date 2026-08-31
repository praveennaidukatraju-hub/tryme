# Catalogue Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder "Ready-Made Catalogue Template" feature (background-category shortcut) with real admin-defined templates — named sets of (pose, background) "looks" — and let studio users pick a subset of a template's looks instead of manually choosing a background and poses.

**Architecture:** Two new tables (`catalogue_templates`, `catalogue_template_looks`) referencing existing `model_pose_assets`/`model_backgrounds` — no changes to workflow assignment. `createJob` is generalized from "N poses × 1 shared background" to "N (pose, background) pairs" in one atomic transaction, replacing the non-atomic per-background-group HTTP-call pattern the dormant Amazon flow used. New admin CRUD tab + new public endpoint + studio-page "Choose Looks" section that replaces Background/Poses when a template is active.

**Tech Stack:** Fastify 5 + zod, Drizzle ORM/Postgres, React 19 (admin-web, Vite SPA) + Next.js 15 (catalogues-web), Vitest integration tests against the docker-compose Postgres/Redis/MinIO stack.

Spec: `docs/superpowers/specs/2026-07-11-catalogue-templates-design.md` (as hardened after review — atomic `looks[]`, Amazon override skipped for templates).

---

### Task 1: DB schema + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts`

- [ ] **Step 1: Add the two new tables**

Add after the `catalogItemSubcategories` table at the end of `packages/db/src/schema/models.ts` (after line 190, the closing of that table):

```ts
export const catalogueTemplates = pgTable('catalogue_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(), // 'men' | 'women' | 'boys' | 'girls'
  label: text('label').notNull(),
  thumbnailKey: text('thumbnail_key'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One (pose, background) pairing — a "look" — within a catalogue template. Pose/background
// FKs are NO ACTION: both are soft-deleted (deletedAt / isActive=false), never hard-deleted,
// so a look can never dangle from an actual row removal. A look whose pose or background has
// been deactivated is filtered out at read time (GET /v1/models/catalogue-templates), not here.
export const catalogueTemplateLooks = pgTable(
  'catalogue_template_looks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id),
    backgroundId: uuid('background_id')
      .notNull()
      .references(() => modelBackgrounds.id),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    templateIdx: index('catalogue_template_looks_template_id_idx').on(table.templateId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run (requires `DATABASE_URL` in `.env`, docker infra up via `pnpm docker:up`):

```bash
pnpm db:generate
```

Expected: a new file `packages/db/src/migrations/0104_<generated-name>.sql` (or the next free index — check `packages/db/src/migrations/meta/_journal.json`'s last `idx` first; at the time of writing it's `103`, so `0104` is expected) containing `CREATE TABLE catalogue_templates` and `CREATE TABLE catalogue_template_looks` with the index, plus a matching `meta/0104_snapshot.json` and an updated `meta/_journal.json`.

- [ ] **Step 3: Apply the migration and verify**

```bash
pnpm db:migrate
```

Expected: no errors. Verify the tables exist:

```bash
docker exec -it $(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1) psql -U postgres -d tryme -c "\d catalogue_templates" -c "\d catalogue_template_looks"
```

Expected: both tables listed with the columns above.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add catalogue_templates and catalogue_template_looks tables"
```

---

### Task 2: Storage key builder

**Files:**
- Modify: `packages/storage/src/keys.ts:24-25`

- [ ] **Step 1: Add the key builder**

In `packages/storage/src/keys.ts`, after the `subcategoryInstruction` line (line 25), add:

```ts
  catalogueTemplateThumb: (id: string) => `models/catalogue-templates/${id}.thumb.jpg`,
```

- [ ] **Step 2: Verify the package builds**

```bash
pnpm --filter @tryme/storage build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add catalogueTemplateThumb key builder"
```

---

### Task 3: Extend `CreateTryOnJobRequest` with `looks[]`

**Files:**
- Modify: `packages/types/src/jobs.ts:36-62`

- [ ] **Step 1: Replace the `CreateTryOnJobRequest` export**

In `packages/types/src/jobs.ts`, replace the existing `export const CreateTryOnJobRequest = z.object({ ... });` block (lines 36-62) with:

```ts
export const CreateTryOnJobInputs = z
  .object({
    upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY),
    faceId: z.string().uuid(),
    // Legacy/custom form: a single shared background applied to every pose.
    backgroundId: z.string().uuid().optional(),
    poseIds: z.array(z.string().uuid()).min(1).max(6).optional(),
    // Template form: each pose carries its own background. Exactly one of
    // (backgroundId + poseIds) or looks must be provided — enforced below.
    looks: z
      .array(
        z.object({
          poseId: z.string().uuid(),
          backgroundId: z.string().uuid(),
        }),
      )
      .min(1)
      .max(12)
      .optional(),
    garmentTypeId: z.string().uuid().optional(),
    lowerCatalogId: z.string().uuid().optional(),
    lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
    shoeCatalogId: z.string().uuid().optional(),
  })
  .refine((d) => Boolean(d.backgroundId && d.poseIds) !== Boolean(d.looks), {
    message: 'Provide either (backgroundId + poseIds) or looks, not both',
  });

export const CreateTryOnJobRequest = z.object({
  catalogueId: z.string().uuid().optional(),
  inputs: CreateTryOnJobInputs,
  params: z
    .object({
      seedStage1: z.number().int().optional(),
      seedStage2: z.number().int().optional(),
      stepsStage1: z.number().int().min(1).max(30).optional(), // ponytail: flat cap; make per-tier when step pricing is decided
      stepsStage2: z.number().int().min(1).max(30).optional(),
      outputWidth: z.number().int().min(512).max(4096).optional(),
      outputHeight: z.number().int().min(512).max(4096).optional(),
    })
    .optional(),
  userHint: z.string().max(300).optional(),
  aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
  resolution: z.enum(['HD', '2K', '4K']),
  platform: z.string().optional(),
});
```

- [ ] **Step 2: Verify the package builds and existing callers still typecheck**

```bash
pnpm --filter @tryme/types build
pnpm --filter @tryme/api typecheck
```

Expected: both clean. `apps/api/src/modules/jobs/regenerate.ts` still supplies `backgroundId`+`poseIds` (never `looks`) so it satisfies the new `.refine()` unchanged.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/jobs.ts
git commit -m "feat(types): add optional looks[] form to CreateTryOnJobRequest"
```

---

### Task 4: Admin zod schemas for catalogue templates

**Files:**
- Modify: `packages/types/src/admin.ts`

- [ ] **Step 1: Add the CRUD body schemas**

At the end of `packages/types/src/admin.ts`, add:

```ts
export const CreateCatalogueTemplateBody = z.object({
  genderSlug: GenderEnum,
  label: z.string().min(1).max(120),
  thumbnailKey: z.string().optional(),
  sortOrder: z.number().int().default(0),
});
export const PatchCatalogueTemplateBody = z.object({
  label: z.string().min(1).max(120).optional(),
  thumbnailKey: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const PutCatalogueTemplateLooksBody = z.object({
  looks: z
    .array(
      z.object({
        poseAssetId: z.string().uuid(),
        backgroundId: z.string().uuid(),
      }),
    )
    .max(20),
});
export const PresignCatalogueTemplateThumbnailBody = z.object({
  contentType: AssetContentType,
});
```

(`GenderEnum` and `AssetContentType` are already defined earlier in this same file — lines 101-102 — so no new imports are needed.)

- [ ] **Step 2: Re-export from the package index**

Check `packages/types/src/index.ts` for how `admin.ts` is re-exported:

```bash
grep -n "admin" packages/types/src/index.ts
```

If it's a wildcard `export * from './admin.js';`, no change needed. If specific names are re-exported, add `CreateCatalogueTemplateBody`, `PatchCatalogueTemplateBody`, `PutCatalogueTemplateLooksBody`, `PresignCatalogueTemplateThumbnailBody` to that list.

- [ ] **Step 3: Verify the package builds**

```bash
pnpm --filter @tryme/types build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/admin.ts packages/types/src/index.ts
git commit -m "feat(types): add catalogue template admin CRUD zod schemas"
```

---

### Task 5: Generalize `createJob` to per-look backgrounds (TDD)

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:53-371` (the `createJob` function)
- Test: `apps/api/test/integration/jobs-create-looks.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/jobs-create-looks.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('createJob — atomic multi-background looks[] form', () => {
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
    app.storage.headObject = (async () => ({ contentLength: 1024 })) as typeof app.storage.headObject;
  });
  afterEach(() => {
    if (realHeadObject) app.storage.headObject = realHeadObject;
  });

  async function registerUser(email: string, tier = 'free') {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
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

  async function seedCreditPlan(slug: string, watermark: boolean) {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, watermark })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark } });
  }

  async function seedFaceAndTwoBackgrounds() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [bgA] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'BgA', r2Key: 'a.jpg', thumbnailKey: 'a.jpg' })
      .returning();
    const [bgB] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'BgB', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    return { faceId: face.id, bgAId: bgA.id, bgBId: bgB.id };
  }

  async function seedTwoPoses() {
    const [poseA] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PoseA', r2Key: 'pa.jpg', thumbnailKey: 'pa.jpg' })
      .returning();
    const [poseB] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PoseB', r2Key: 'pb.jpg', thumbnailKey: 'pb.jpg' })
      .returning();
    return { poseAId: poseA.id, poseBId: poseB.id };
  }

  it('creates one job per look, each with its OWN background, in a single credit-charged batch', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-basic@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId, bgBId } = await seedFaceAndTwoBackgrounds();
    const { poseAId, poseBId } = await seedTwoPoses();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseBId, backgroundId: bgBId },
          ],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
    const { catalogueId, jobIds } = res.json();
    expect(jobIds).toHaveLength(2);

    const inputsRows = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(inputsRows[0]?.backgroundId).toBe(bgAId);
    expect(inputsRows[0]?.poseId).toBe(poseAId);

    const inputsRows2 = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[1]));
    expect(inputsRows2[0]?.backgroundId).toBe(bgBId);
    expect(inputsRows2[0]?.poseId).toBe(poseBId);

    const jobRows = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.catalogueId, catalogueId));
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.source === 'catalog')).toBe(true);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100 - 35 * 2); // 2K = 35 credits each
  });

  it('rejects duplicate (poseId, backgroundId) pairs within one looks[] request', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-dup@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseAId, backgroundId: bgAId },
          ],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged
  });

  it('does NOT apply the Amazon white-bg override to the looks[] form', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-amazon@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    // A white background exists in the system (as Amazon platform requires for the legacy form).
    await app.db.insert(schema.modelBackgrounds).values({
      label: 'White',
      r2Key: 'w.jpg',
      thumbnailKey: 'w.jpg',
      isWhiteBg: true,
    });
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        platform: 'Amazon',
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [inputsRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    // Must stay bgAId — NOT swapped to the white background.
    expect(inputsRow?.backgroundId).toBe(bgAId);
  });

  it('legacy backgroundId+poseIds form still applies the Amazon white-bg override', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-legacy-amazon@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [whiteBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'White', r2Key: 'w.jpg', thumbnailKey: 'w.jpg', isWhiteBg: true })
      .returning();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId: bgAId,
          poseIds: [poseAId],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        platform: 'Amazon',
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [inputsRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(inputsRow?.backgroundId).toBe(whiteBg.id);
  });

  it('rolls back the whole batch (no partial charge) when one background is inactive', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-rollback@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId, poseBId } = await seedTwoPoses();
    const [inactiveBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Inactive', r2Key: 'i.jpg', thumbnailKey: 'i.jpg', isActive: false })
      .returning();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseBId, backgroundId: inactiveBg.id },
          ],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // fully rolled back — no partial job/charge
    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Ensure infra is up first: `pnpm docker:up`. Then:

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: FAIL — `looks` is not yet handled by `createJob` (zod will 400 on unrecognized-but-actually-it's-accepted-by-schema-already-from-Task-3, so requests will 500 or behave like the legacy path incorrectly since `createJob` doesn't read `body.inputs.looks` yet). Confirm the failures are in the assertions about per-look backgrounds / duplicate-rejection / Amazon-skip, not schema-validation errors (those were already fixed in Task 3).

- [ ] **Step 3: Replace `createJob` with the per-look version**

In `apps/api/src/modules/jobs/create.ts`, replace the entire `createJob` function (lines 53-371, from `export async function createJob(` through its closing `}` right before `export async function createSimpleTryonJob`) with:

```ts
export async function createJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateTryOnJobRequest>,
) {
  const { faceId, garmentTypeId, upperGarmentKey, lowerCatalogId, lowerGarmentKey, shoeCatalogId } =
    body.inputs;
  const aspectRatio: string | undefined = body.aspectRatio;
  const platform: string | undefined = body.platform;

  // S1: compute cost server-side from actual output dims — never trust client's `resolution`.
  const customW = body.params?.outputWidth;
  const customH = body.params?.outputHeight;
  const requestedDims =
    customW && customH
      ? { width: customW, height: customH }
      : (ASPECT_DIMENSIONS[body.aspectRatio] ?? { width: 2048, height: 2048 });
  // Platform-wide resolution ceiling — admin-configured, not per-workflow (see
  // getMaxOutputPx). Only downscale, and only the long edge exceeding it; the
  // dispatcher patches the workflow with whatever dims land in job_inputs.params,
  // so this is the single enforcement point.
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
  const COST = await getResolutionCreditCost(app, resolution);

  // H2: keys are format-pinned by zod, but the format alone does not prove the
  // caller owns the object — another user's key has the same shape. Verify each
  // garment key was issued to THIS user by /v1/uploads/presign (Redis binding)
  // before any credit/DB mutation.
  await assertOwnsUploadKey(app, userId, upperGarmentKey);
  if (lowerGarmentKey) await assertOwnsUploadKey(app, userId, lowerGarmentKey);

  // Normalize to a single per-look list. Exactly one of (backgroundId + poseIds) or
  // looks is present — enforced by CreateTryOnJobInputs's zod .refine() — but the
  // check is repeated here since TS can't see that constraint through the optional
  // fields on body.inputs.
  const legacyBackgroundId = body.inputs.backgroundId;
  const legacyPoseIds = body.inputs.poseIds;
  const templateLooks = body.inputs.looks;
  if (!templateLooks && !(legacyBackgroundId && legacyPoseIds)) {
    throw new AppError(
      'VALIDATION',
      400,
      'inputs must include either backgroundId+poseIds or looks',
    );
  }

  let looks: Array<{ poseId: string; backgroundId: string }>;
  if (templateLooks) {
    // Per-look backgrounds are authoritative for templates — the Amazon white-bg
    // override below must never run for this form.
    looks = templateLooks;
  } else {
    // Amazon platform requires a white background — override the single shared
    // background with the one tagged isWhiteBg in the admin panel. Only applies
    // to the legacy form; template backgrounds are never overridden.
    let effectiveBackgroundId = legacyBackgroundId as string;
    if (platform === 'Amazon') {
      const [whiteBg] = await app.db
        .select({ id: schema.modelBackgrounds.id })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            eq(schema.modelBackgrounds.isWhiteBg, true),
          ),
        )
        .limit(1);
      if (!whiteBg) {
        throw new AppError(
          'VALIDATION',
          400,
          'Amazon platform requires a white background to be configured',
        );
      }
      effectiveBackgroundId = whiteBg.id;
      app.log.info(
        { originalBg: legacyBackgroundId, amazonBg: effectiveBackgroundId, platform },
        'amazon bg override',
      );
    }
    looks = (legacyPoseIds as string[]).map((poseId) => ({
      poseId,
      backgroundId: effectiveBackgroundId,
    }));
  }

  const dedupeKeys = new Set(looks.map((l) => `${l.poseId}::${l.backgroundId}`));
  if (dedupeKeys.size !== looks.length) {
    throw new AppError('VALIDATION', 400, 'duplicate pose+background combination in looks');
  }

  const distinctPoseIds = Array.from(new Set(looks.map((l) => l.poseId)));
  const distinctBackgroundIds = Array.from(new Set(looks.map((l) => l.backgroundId)));

  const [face, backgroundRows, poses] = await Promise.all([
    app.db
      .select({ id: schema.modelFaces.id })
      .from(schema.modelFaces)
      .where(and(eq(schema.modelFaces.id, faceId), eq(schema.modelFaces.isActive, true))),
    app.db
      .select({ id: schema.modelBackgrounds.id })
      .from(schema.modelBackgrounds)
      .where(
        and(
          inArray(schema.modelBackgrounds.id, distinctBackgroundIds),
          eq(schema.modelBackgrounds.isActive, true),
        ),
      ),
    app.db
      .select({ id: schema.modelPoseAssets.id })
      .from(schema.modelPoseAssets)
      .where(
        and(
          inArray(schema.modelPoseAssets.id, distinctPoseIds),
          eq(schema.modelPoseAssets.isActive, true),
          isNull(schema.modelPoseAssets.deletedAt),
        ),
      ),
  ]);

  if (!face[0]) throw new AppError('BAD_CATALOG', 400, 'face not found or inactive');
  if (backgroundRows.length !== distinctBackgroundIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more backgrounds not found or inactive');
  if (poses.length !== distinctPoseIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more poses not found or inactive');

  // S6: validate optional catalog IDs so the dispatcher never silently falls back
  // on a bad ID that slipped through as null.
  const catalogChecks = await Promise.all([
    lowerCatalogId
      ? app.db
          .select({ id: schema.catalogItems.id })
          .from(schema.catalogItems)
          .where(
            and(eq(schema.catalogItems.id, lowerCatalogId), eq(schema.catalogItems.isActive, true)),
          )
      : Promise.resolve([{ id: lowerCatalogId }]),
    shoeCatalogId
      ? app.db
          .select({ id: schema.catalogItems.id })
          .from(schema.catalogItems)
          .where(
            and(eq(schema.catalogItems.id, shoeCatalogId), eq(schema.catalogItems.isActive, true)),
          )
      : Promise.resolve([{ id: shoeCatalogId }]),
    garmentTypeId
      ? app.db
          .select({ id: schema.garmentSubcategories.id })
          .from(schema.garmentSubcategories)
          .where(
            and(
              eq(schema.garmentSubcategories.id, garmentTypeId),
              eq(schema.garmentSubcategories.isActive, true),
            ),
          )
      : Promise.resolve([{ id: garmentTypeId }]),
  ]);
  if (lowerCatalogId && !catalogChecks[0]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'lower catalog item not found or inactive');
  if (shoeCatalogId && !catalogChecks[1]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'shoe catalog item not found or inactive');
  if (garmentTypeId && !catalogChecks[2]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');

  // Validate that workflow-required inputs are present for every selected pose.
  // If a pose's workflow has a lower garment node → lowerCatalogId is mandatory.
  // Same for shoes. This mirrors what the studio UI shows based on hasLower/hasShoes.
  // A per-garment-type pose_garment_configs override (when one exists with a
  // workflowTemplateId set) takes priority over the pose's own default workflow —
  // must match the resolution used by /v1/models/poses and the dispatcher exactly,
  // otherwise the UI and the server disagree on what's required.
  const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
  const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');
  const poseWorkflowRows = await app.db
    .select({
      poseId: schema.modelPoseAssets.id,
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      defaultSizeNodeIds: defaultWorkflow.sizeNodeIds,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      configIsActive: schema.poseGarmentConfigs.isActive,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
      overrideSizeNodeIds: overrideWorkflow.sizeNodeIds,
    })
    .from(schema.modelPoseAssets)
    .leftJoin(defaultWorkflow, eq(schema.modelPoseAssets.workflowTemplateId, defaultWorkflow.id))
    .leftJoin(
      schema.poseGarmentConfigs,
      and(
        eq(schema.poseGarmentConfigs.poseAssetId, schema.modelPoseAssets.id),
        garmentTypeId
          ? eq(schema.poseGarmentConfigs.subcategoryId, garmentTypeId)
          : isNull(schema.poseGarmentConfigs.subcategoryId),
      ),
    )
    .leftJoin(
      overrideWorkflow,
      eq(schema.poseGarmentConfigs.workflowTemplateId, overrideWorkflow.id),
    )
    .where(inArray(schema.modelPoseAssets.id, distinctPoseIds));

  // A per-garment-type active override can hide a pose for this garment type
  // specifically (see /v1/models/poses) — reject here too so a stale client can't
  // submit a job for a pose+garmentType combo the admin explicitly disabled.
  if (garmentTypeId && poseWorkflowRows.some((r) => r.configIsActive === false)) {
    throw new AppError('BAD_CATALOG', 400, 'one or more poses not found or inactive');
  }

  const poseWorkflows = poseWorkflowRows.map((r) => ({
    poseId: r.poseId,
    lowerNodeId: r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
    shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
    sizeNodeIds: r.configWorkflowTemplateId != null ? r.overrideSizeNodeIds : r.defaultSizeNodeIds,
  }));

  // Build map for O(1) lookup in the insert loop
  const poseWorkflowMap = new Map(poseWorkflows.map((pw) => [pw.poseId, pw]));

  for (const pw of poseWorkflows) {
    if (pw.lowerNodeId && !lowerCatalogId && !lowerGarmentKey) {
      throw new AppError('VALIDATION', 400, 'lower garment required for this pose');
    }
    if (pw.shoeNodeId && !shoeCatalogId) {
      throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
    }
  }

  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({
        queueStream: schema.creditPlans.queueStream,
        watermark: schema.creditPlans.watermark,
      })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  // Fall back to 'normal' if the user's tier has no matching credit_plans row.
  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';
  // Snapshot watermark entitlement from the plan at job creation time.
  // Never re-derived after this point — see spec precedence rule.
  const watermark: boolean = planRow?.watermark ?? false;

  const catalogueId = body.catalogueId ?? randomUUID();
  const jobIds = await app.db.transaction(async (tx) => {
    const created: string[] = [];
    for (const look of looks) {
      const pw = poseWorkflowMap.get(look.poseId);

      // Only store inputs the workflow actually supports — strips irrelevant fields
      // so the dispatcher never receives/resolves data it won't use.
      const effectiveLowerCatalogId =
        pw?.lowerNodeId && !lowerGarmentKey ? (lowerCatalogId ?? null) : null;
      const effectiveLowerGarmentKey = pw?.lowerNodeId && lowerGarmentKey ? lowerGarmentKey : null;
      const effectiveShoeCatalogId = pw?.shoeNodeId ? (shoeCatalogId ?? null) : null;
      // Always store aspectRatio — patcher gates on sizeNodeIds.length at dispatch time
      const effectiveAspectRatio = aspectRatio;

      const [job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId,
          status: 'QUEUED',
          priority,
          queueStream,
          watermark,
          creditsCharged: COST,
          source: 'catalog',
        })
        .returning();
      await atomicDeduct(tx as unknown as DB, userId, COST, job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId: garmentTypeId ?? null,
        lowerCatalogId: effectiveLowerCatalogId,
        lowerGarmentKey: effectiveLowerGarmentKey,
        shoeCatalogId: effectiveShoeCatalogId,
        userHint: promptGuard(body.userHint),
        params: {
          ...(body.params ?? {}),
          // Always the clamped, server-computed dims — whether derived from the
          // aspect-ratio enum or a custom request, this is what the dispatcher
          // patches the workflow with. Never let a raw pre-maxOutputPx value through.
          outputWidth: outputDims.width,
          outputHeight: outputDims.height,
          ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
          resolution,
          ...(platform ? { platform } : {}),
        },
      });
      created.push(job.id);
    }
    return created;
  });

  const stream = `jobs:${queueStream}`;
  const failedEnqueues: string[] = [];
  for (const jobId of jobIds) {
    try {
      await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'userId', userId);
      jobsCreatedTotal.inc({ priority: queueStream, kind: 'catalogue' });
    } catch (err) {
      app.log.error({ err, jobId }, 'redis xadd failed — job will be refunded');
      failedEnqueues.push(jobId);
    }
  }

  if (failedEnqueues.length > 0) {
    await Promise.all(
      failedEnqueues.map(async (jobId) => {
        await refund(app.db, userId, COST, jobId, 'REFUND_ENQUEUE_FAIL');
        await app.db
          .update(schema.jobs)
          .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
          .where(eq(schema.jobs.id, jobId));
      }),
    );
    if (failedEnqueues.length === jobIds.length) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  return { catalogueId, jobIds };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run the full API suite to check for regressions**

```bash
pnpm --filter @tryme/api test
```

Expected: no new failures introduced by this change (pre-existing failures, if any, are out of scope — note them but do not fix here unless they're a direct regression from this diff, e.g. `regenerate.test.ts`'s `studio (catalogue) job regenerate` test, which exercises the legacy `backgroundId`+`poseIds` path through `createJob` and must still pass unchanged).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/jobs-create-looks.test.ts
git commit -m "feat(api): generalize createJob to atomic per-look backgrounds"
```

---

### Task 6: Admin API routes for catalogue templates (TDD)

**Files:**
- Create: `apps/api/src/modules/admin/catalogue-templates.routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/integration/catalogue-templates-admin.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/catalogue-templates-admin.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { adminHeaders } from '../helpers/admin';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin catalogue-templates CRUD', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedPoseAndBackground() {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    return { poseId: pose.id, bgId: bg.id };
  }

  it('creates, lists, patches, and soft-deletes a template', async () => {
    const headers = await adminHeaders(app, ['SUPER_ADMIN']);

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'Autumn', sortOrder: 0 },
    });
    expect(createRes.statusCode).toBe(200);
    const { id } = createRes.json();

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/assets/catalogue-templates',
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    const { items } = listRes.json();
    expect(items.find((t: { id: string }) => t.id === id)).toBeTruthy();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-templates/${id}`,
      headers,
      payload: { label: 'Autumn Collection', isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(eq(schema.catalogueTemplates.id, id));
    expect(row.label).toBe('Autumn Collection');
    expect(row.isActive).toBe(false);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/admin/assets/catalogue-templates/${id}`,
      headers,
    });
    expect(deleteRes.statusCode).toBe(200);
    const [afterDelete] = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(eq(schema.catalogueTemplates.id, id));
    expect(afterDelete.deletedAt).not.toBeNull();
  });

  it('PUT .../looks replaces the full ordered list, rejects unknown/inactive pose or background', async () => {
    const headers = await adminHeaders(app, ['SUPER_ADMIN']);
    const { poseId, bgId } = await seedPoseAndBackground();

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'T', sortOrder: 0 },
    });
    const { id: templateId } = createRes.json();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: { looks: [{ poseAssetId: poseId, backgroundId: bgId }] },
    });
    expect(putRes.statusCode).toBe(200);

    const looksRows = await app.db
      .select()
      .from(schema.catalogueTemplateLooks)
      .where(eq(schema.catalogueTemplateLooks.templateId, templateId));
    expect(looksRows).toHaveLength(1);

    // Replacing again with an empty list clears all looks (full-replace semantics).
    const clearRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: { looks: [] },
    });
    expect(clearRes.statusCode).toBe(200);
    const clearedRows = await app.db
      .select()
      .from(schema.catalogueTemplateLooks)
      .where(eq(schema.catalogueTemplateLooks.templateId, templateId));
    expect(clearedRows).toHaveLength(0);

    // Unknown pose id → rejected, no partial write.
    const badRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: {
        looks: [{ poseAssetId: '00000000-0000-0000-0000-000000000000', backgroundId: bgId }],
      },
    });
    expect(badRes.statusCode).toBe(400);
  });

  it('rejects duplicate (pose, background) pairs in the same PUT', async () => {
    const headers = await adminHeaders(app, ['SUPER_ADMIN']);
    const { poseId, bgId } = await seedPoseAndBackground();
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'T2', sortOrder: 0 },
    });
    const { id: templateId } = createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: {
        looks: [
          { poseAssetId: poseId, backgroundId: bgId },
          { poseAssetId: poseId, backgroundId: bgId },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

Check `apps/api/test/helpers/admin.ts` first to confirm the exact shape of its helper (e.g. `adminHeaders(app, roles)`):

```bash
cat apps/api/test/helpers/admin.ts
```

If the helper's name/signature differs from `adminHeaders(app, ['SUPER_ADMIN'])`, adjust the three call sites in the test above to match the actual helper (do not invent a new one — reuse what exists).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api test -- catalogue-templates-admin
```

Expected: FAIL — 404s, since none of these routes exist yet.

- [ ] **Step 3: Create the routes file**

Create `apps/api/src/modules/admin/catalogue-templates.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateCatalogueTemplateBody,
  PatchCatalogueTemplateBody,
  PresignCatalogueTemplateThumbnailBody,
  PutCatalogueTemplateLooksBody,
} from '@tryme/types';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

export async function adminCatalogueTemplatesRoutes(app: FastifyInstance) {
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const D = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/assets/catalogue-templates', { preHandler: RW }, async () => {
    const templates = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(isNull(schema.catalogueTemplates.deletedAt))
      .orderBy(asc(schema.catalogueTemplates.sortOrder));
    const looks = await app.db.select().from(schema.catalogueTemplateLooks);
    const lookCountByTemplate = new Map<string, number>();
    for (const l of looks) {
      lookCountByTemplate.set(l.templateId, (lookCountByTemplate.get(l.templateId) ?? 0) + 1);
    }
    return {
      items: templates.map((t) => ({
        ...t,
        thumbnailUrl: t.thumbnailKey ? app.storage.publicUrl(t.thumbnailKey) : null,
        lookCount: lookCountByTemplate.get(t.id) ?? 0,
      })),
    };
  });

  app.post(
    '/admin/assets/catalogue-templates/thumbnail/presign',
    { preHandler: RW, schema: { body: PresignCatalogueTemplateThumbnailBody } },
    async (_req) => {
      const newId = randomUUID();
      const thumbnailKey = keys.catalogueTemplateThumb(newId);
      const { url } = await app.storage.presignPut(thumbnailKey, 'image/jpeg', 5_000_000, 300);
      return { uploadUrl: url, thumbnailKey };
    },
  );

  app.post(
    '/admin/assets/catalogue-templates',
    { preHandler: RW, schema: { body: CreateCatalogueTemplateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateCatalogueTemplateBody>;
      const [row] = await app.db
        .insert(schema.catalogueTemplates)
        .values({
          genderSlug: body.genderSlug,
          label: body.label,
          thumbnailKey: body.thumbnailKey ?? null,
          sortOrder: body.sortOrder,
        })
        .returning();
      return row;
    },
  );

  app.patch(
    '/admin/assets/catalogue-templates/:id',
    { preHandler: RW, schema: { params: uuidParam, body: PatchCatalogueTemplateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      if ('thumbnailKey' in body) {
        const [current] = await app.db
          .select({ thumbnailKey: schema.catalogueTemplates.thumbnailKey })
          .from(schema.catalogueTemplates)
          .where(eq(schema.catalogueTemplates.id, id));
        if (current?.thumbnailKey) {
          await app.storage.deleteObject(current.thumbnailKey).catch(() => {});
        }
      }
      const [updated] = await app.db
        .update(schema.catalogueTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.catalogueTemplates.id, id))
        .returning({ id: schema.catalogueTemplates.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');
      return { ok: true };
    },
  );

  app.delete(
    '/admin/assets/catalogue-templates/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplates)
        .where(eq(schema.catalogueTemplates.id, id));
      if (!row) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');
      await app.db
        .update(schema.catalogueTemplates)
        .set({ deletedAt: new Date() })
        .where(eq(schema.catalogueTemplates.id, id));
      return { ok: true };
    },
  );

  app.put(
    '/admin/assets/catalogue-templates/:id/looks',
    { preHandler: RW, schema: { params: uuidParam, body: PutCatalogueTemplateLooksBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { looks } = req.body as z.infer<typeof PutCatalogueTemplateLooksBody>;

      const [template] = await app.db
        .select({ id: schema.catalogueTemplates.id })
        .from(schema.catalogueTemplates)
        .where(eq(schema.catalogueTemplates.id, id));
      if (!template) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');

      const dedupeKeys = new Set(looks.map((l) => `${l.poseAssetId}::${l.backgroundId}`));
      if (dedupeKeys.size !== looks.length) {
        throw new AppError('VALIDATION', 400, 'duplicate pose+background combination');
      }

      if (looks.length > 0) {
        const poseIds = Array.from(new Set(looks.map((l) => l.poseAssetId)));
        const backgroundIds = Array.from(new Set(looks.map((l) => l.backgroundId)));
        const [poseRows, backgroundRows] = await Promise.all([
          app.db
            .select({ id: schema.modelPoseAssets.id })
            .from(schema.modelPoseAssets)
            .where(
              and(
                inArray(schema.modelPoseAssets.id, poseIds),
                eq(schema.modelPoseAssets.isActive, true),
                isNull(schema.modelPoseAssets.deletedAt),
              ),
            ),
          app.db
            .select({ id: schema.modelBackgrounds.id })
            .from(schema.modelBackgrounds)
            .where(
              and(
                inArray(schema.modelBackgrounds.id, backgroundIds),
                eq(schema.modelBackgrounds.isActive, true),
                isNull(schema.modelBackgrounds.deletedAt),
              ),
            ),
        ]);
        if (poseRows.length !== poseIds.length) {
          throw new AppError('VALIDATION', 400, 'one or more poses not found or inactive');
        }
        if (backgroundRows.length !== backgroundIds.length) {
          throw new AppError('VALIDATION', 400, 'one or more backgrounds not found or inactive');
        }
      }

      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.catalogueTemplateLooks)
          .where(eq(schema.catalogueTemplateLooks.templateId, id));
        if (looks.length > 0) {
          await tx.insert(schema.catalogueTemplateLooks).values(
            looks.map((l, i) => ({
              templateId: id,
              poseAssetId: l.poseAssetId,
              backgroundId: l.backgroundId,
              sortOrder: i,
            })),
          );
        }
      });

      return { ok: true, count: looks.length };
    },
  );
}
```

- [ ] **Step 4: Register the routes in `server.ts`**

In `apps/api/src/server.ts`, add the import near the other admin route imports (after line 34, `import { adminGarmentTypesRoutes } from './modules/admin/subcategories.routes.js';`):

```ts
import { adminCatalogueTemplatesRoutes } from './modules/admin/catalogue-templates.routes.js';
```

And register it near line 203 (after `await app.register(adminGarmentTypesRoutes);`):

```ts
  await app.register(adminCatalogueTemplatesRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api test -- catalogue-templates-admin
```

Expected: all 3 tests PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/catalogue-templates.routes.ts apps/api/src/server.ts apps/api/test/integration/catalogue-templates-admin.test.ts
git commit -m "feat(api): admin CRUD routes for catalogue templates"
```

---

### Task 7: Public `GET /v1/models/catalogue-templates` (TDD)

**Files:**
- Modify: `apps/api/src/modules/models/routes.ts:292-293` (insert before the closing `}`)
- Test: `apps/api/test/integration/catalogue-templates-public.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/catalogue-templates-public.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('GET /v1/models/catalogue-templates', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function registerAndLogin(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(schema.users.email ? eq(schema.users.email, email) : undefined);
    return user;
  }

  it('returns only resolvable looks, drops templates left with zero looks', async () => {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [activePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Active', genderSlug: 'men', r2Key: 'ap.jpg', thumbnailKey: 'ap.jpg' })
      .returning();
    const [inactivePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Inactive',
        genderSlug: 'men',
        r2Key: 'ip.jpg',
        thumbnailKey: 'ip.jpg',
        isActive: false,
      })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();

    const [templateWithSurvivingLook] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Has Looks', sortOrder: 0 })
      .returning();
    const [templateFullyFiltered] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'All Filtered', sortOrder: 1 })
      .returning();

    await app.db.insert(schema.catalogueTemplateLooks).values([
      { templateId: templateWithSurvivingLook.id, poseAssetId: activePose.id, backgroundId: bg.id, sortOrder: 0 },
      { templateId: templateWithSurvivingLook.id, poseAssetId: inactivePose.id, backgroundId: bg.id, sortOrder: 1 },
      { templateId: templateFullyFiltered.id, poseAssetId: inactivePose.id, backgroundId: bg.id, sortOrder: 0 },
    ]);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email: 'templates-public@x.com', password: 'password123' },
    });
    const token = login.json().accessToken;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/catalogue-templates?gender=men',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    const surviving = items.find((t: { id: string }) => t.id === templateWithSurvivingLook.id);
    expect(surviving).toBeTruthy();
    expect(surviving.looks).toHaveLength(1);
    expect(surviving.looks[0].poseId).toBe(activePose.id);

    // Template whose only look references an inactive pose is dropped entirely.
    expect(items.find((t: { id: string }) => t.id === templateFullyFiltered.id)).toBeUndefined();

    void face;
  });

  it('overlays garmentTypeId hasLower/hasShoes and per-type active overrides, matching /v1/models/poses', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', genderSlug: 'women', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-override-${pose.id}`,
        label: 'WF',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['1'],
        lowerNodeId: '2',
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [subcat] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-${pose.id}`, label: 'SC' })
      .returning();
    await app.db.insert(schema.poseGarmentConfigs).values({
      poseAssetId: pose.id,
      subcategoryId: subcat.id,
      workflowTemplateId: workflow.id,
    });
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'T', sortOrder: 0 })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: bg.id,
      sortOrder: 0,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email: 'templates-override@x.com', password: 'password123' },
    });
    const token = login.json().accessToken;

    // Without garmentTypeId — pose has no default workflow → hasLower false.
    const resWithout = await app.inject({
      method: 'GET',
      url: '/v1/models/catalogue-templates?gender=women',
      headers: { authorization: `Bearer ${token}` },
    });
    const withoutLook = resWithout.json().items[0].looks[0];
    expect(withoutLook.hasLower).toBe(false);

    // With garmentTypeId matching the override — hasLower true (workflow has lowerNodeId).
    const resWith = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${subcat.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const withLook = resWith.json().items[0].looks[0];
    expect(withLook.hasLower).toBe(true);
  });
});
```

Note: the first test references `eq` without importing it — check `apps/api/test/helpers/auth.ts` or similar existing tests for how they resolve a just-registered user's id (some tests decode the JWT instead of querying, per the `jobs-create.test.ts` pattern: `JSON.parse(atob(login.json().accessToken.split('.')[1])).sub`). Simplify the first test's `registerAndLogin` helper to that JWT-decode approach instead of a raw `eq` query, and delete the unused `registerAndLogin`/`face` cruft — the test only needs a valid bearer token, not the user id. Rewrite it as:

```ts
  async function loginToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return login.json().accessToken as string;
  }
```

and replace both inline `register` + `accessToken` blocks in the two `it(...)` bodies with `const token = await loginToken('templates-public@x.com');` / `const token = await loginToken('templates-override@x.com');` respectively, removing the unused `registerAndLogin` function and the stray `void face;` line entirely.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api test -- catalogue-templates-public
```

Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 3: Add the route**

In `apps/api/src/modules/models/routes.ts`, insert immediately before the final closing `}` of `modelsRoutes` (currently line 293, right after the `/v1/models/poses` route's closing `);` at line 292):

```ts

  app.get(
    '/v1/models/catalogue-templates',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']),
          garmentTypeId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const { gender, garmentTypeId } = req.query as { gender: string; garmentTypeId?: string };

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
        })
        .from(schema.catalogueTemplates)
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, gender),
            eq(schema.catalogueTemplates.isActive, true),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder));

      if (templates.length === 0) return { items: [] };
      const templateIds = templates.map((t) => t.id);

      const lookRows = await app.db
        .select({
          lookId: schema.catalogueTemplateLooks.id,
          templateId: schema.catalogueTemplateLooks.templateId,
          poseId: schema.modelPoseAssets.id,
          poseLabel: schema.modelPoseAssets.label,
          poseDisplayName: schema.modelPoseAssets.displayName,
          poseThumbnailKey: schema.modelPoseAssets.thumbnailKey,
          lowerNodeId: schema.workflowTemplates.lowerNodeId,
          shoeNodeId: schema.workflowTemplates.shoeNodeId,
          backgroundId: schema.modelBackgrounds.id,
          backgroundLabel: schema.modelBackgrounds.label,
          backgroundThumbnailKey: schema.modelBackgrounds.thumbnailKey,
        })
        .from(schema.catalogueTemplateLooks)
        .innerJoin(
          schema.modelPoseAssets,
          and(
            eq(schema.catalogueTemplateLooks.poseAssetId, schema.modelPoseAssets.id),
            eq(schema.modelPoseAssets.isActive, true),
            isNull(schema.modelPoseAssets.deletedAt),
          ),
        )
        .innerJoin(
          schema.modelBackgrounds,
          and(
            eq(schema.catalogueTemplateLooks.backgroundId, schema.modelBackgrounds.id),
            eq(schema.modelBackgrounds.isActive, true),
            isNull(schema.modelBackgrounds.deletedAt),
          ),
        )
        .leftJoin(
          schema.workflowTemplates,
          eq(schema.modelPoseAssets.workflowTemplateId, schema.workflowTemplates.id),
        )
        .where(inArray(schema.catalogueTemplateLooks.templateId, templateIds))
        .orderBy(asc(schema.catalogueTemplateLooks.sortOrder));

      // Same per-garmentType override overlay as /v1/models/poses: a config row with
      // a workflowTemplateId set overrides hasLower/hasShoes; configIsActive:false
      // hides the look for this garmentType specifically.
      let configMap = new Map<string, { lowerNodeId: string | null; shoeNodeId: string | null }>();
      let inactiveForType = new Set<string>();
      if (garmentTypeId && lookRows.length > 0) {
        const poseIds = Array.from(new Set(lookRows.map((r) => r.poseId)));
        const configs = await app.db
          .select({
            poseAssetId: schema.poseGarmentConfigs.poseAssetId,
            workflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
            isActive: schema.poseGarmentConfigs.isActive,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
          })
          .from(schema.poseGarmentConfigs)
          .leftJoin(
            schema.workflowTemplates,
            eq(schema.poseGarmentConfigs.workflowTemplateId, schema.workflowTemplates.id),
          )
          .where(
            and(
              inArray(schema.poseGarmentConfigs.poseAssetId, poseIds),
              eq(schema.poseGarmentConfigs.subcategoryId, garmentTypeId),
            ),
          );
        configMap = new Map(
          configs
            .filter((c) => c.workflowTemplateId != null)
            .map((c) => [
              c.poseAssetId,
              { lowerNodeId: c.lowerNodeId ?? null, shoeNodeId: c.shoeNodeId ?? null },
            ]),
        );
        inactiveForType = new Set(
          configs.filter((c) => c.isActive === false).map((c) => c.poseAssetId),
        );
      }

      const looksByTemplate = new Map<string, typeof lookRows>();
      for (const row of lookRows) {
        if (inactiveForType.has(row.poseId)) continue;
        if (!looksByTemplate.has(row.templateId)) looksByTemplate.set(row.templateId, []);
        looksByTemplate.get(row.templateId)?.push(row);
      }

      const items = templates
        .map((t) => {
          const rows = looksByTemplate.get(t.id) ?? [];
          const looks = rows.map((r) => {
            const cfg = configMap.get(r.poseId);
            const lowerNodeId = cfg !== undefined ? cfg.lowerNodeId : r.lowerNodeId;
            const shoeNodeId = cfg !== undefined ? cfg.shoeNodeId : r.shoeNodeId;
            return {
              id: r.lookId,
              poseId: r.poseId,
              poseLabel: r.poseDisplayName ?? r.poseLabel,
              poseThumbnailUrl: app.storage.publicUrl(r.poseThumbnailKey),
              backgroundId: r.backgroundId,
              backgroundLabel: r.backgroundLabel,
              backgroundThumbnailUrl: app.storage.publicUrl(r.backgroundThumbnailKey),
              hasLower: lowerNodeId != null,
              hasShoes: shoeNodeId != null,
            };
          });
          return {
            id: t.id,
            label: t.label,
            thumbnailUrl: t.thumbnailKey
              ? app.storage.publicUrl(t.thumbnailKey)
              : (looks[0]?.poseThumbnailUrl ?? null),
            looks,
          };
        })
        .filter((t) => t.looks.length > 0);

      return { items };
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api test -- catalogue-templates-public
```

Expected: both tests PASS.

- [ ] **Step 5: Typecheck and full suite**

```bash
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/api test
```

Expected: clean, no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/models/routes.ts apps/api/test/integration/catalogue-templates-public.test.ts
git commit -m "feat(api): public GET /v1/models/catalogue-templates endpoint"
```

---

### Task 8: Admin-web types

**Files:**
- Modify: `apps/admin-web/src/types.ts`

- [ ] **Step 1: Add the interfaces**

After the `WorkflowOption` interface block in `apps/admin-web/src/types.ts` (find its end with `grep -n "^export interface WorkflowOption" -A 20 apps/admin-web/src/types.ts` to locate the exact insertion point), add:

```ts
export interface CatalogueTemplate {
  id: string;
  genderSlug: GenderSlug;
  label: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  lookCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogueTemplateLook {
  id: string;
  poseAssetId: string;
  backgroundId: string;
  sortOrder: number;
}
```

- [ ] **Step 2: Verify the package builds**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: clean (new types aren't used anywhere yet, so this just confirms no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add apps/admin-web/src/types.ts
git commit -m "feat(admin): add CatalogueTemplate/CatalogueTemplateLook types"
```

---

### Task 9: Admin-web tab registration

**Files:**
- Modify: `apps/admin-web/src/pages/assets/AssetsContext.tsx:14-24`

- [ ] **Step 1: Add the tab to the union and valid-tabs list**

In `apps/admin-web/src/pages/assets/AssetsContext.tsx`, change:

```ts
export type AssetTab = 'garment-types' | 'faces' | 'backgrounds' | 'lower' | 'shoe' | 'pose-assets';
```

to:

```ts
export type AssetTab =
  | 'garment-types'
  | 'faces'
  | 'backgrounds'
  | 'lower'
  | 'shoe'
  | 'pose-assets'
  | 'catalogue-templates';
```

and change:

```ts
const VALID_TABS: AssetTab[] = [
  'garment-types',
  'faces',
  'backgrounds',
  'lower',
  'shoe',
  'pose-assets',
];
```

to:

```ts
const VALID_TABS: AssetTab[] = [
  'garment-types',
  'faces',
  'backgrounds',
  'lower',
  'shoe',
  'pose-assets',
  'catalogue-templates',
];
```

- [ ] **Step 2: Find and update the tab-switcher UI that renders these tabs**

Find where `AssetTab` values are rendered as clickable tabs (likely the parent `AssetsPage.tsx` or similar):

```bash
grep -rln "pose-assets" apps/admin-web/src/pages/ | grep -v AssetsContext
```

Read that file, find the tab list array (e.g. `[{ k: 'garment-types', l: 'Garment Types' }, ...]`), and add `{ k: 'catalogue-templates', l: 'Templates' }` following the same entry shape, plus the corresponding `activeTab === 'catalogue-templates' && <CatalogueTemplatesTab />` render branch (added in Task 10 once that component exists — for now, add the tab button and a placeholder `activeTab === 'catalogue-templates' && <div>Templates</div>` so the app still compiles; Task 10 replaces the placeholder with the real component).

- [ ] **Step 3: Verify typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/assets/AssetsContext.tsx apps/admin-web/src/pages/assets/AssetsPage.tsx
git commit -m "feat(admin): register catalogue-templates asset tab"
```

(Adjust the second file path in the commit to whatever file Step 2 actually modified.)

---

### Task 10: Admin-web `CatalogueTemplatesTab` + edit modal

**Files:**
- Create: `apps/admin-web/src/components/EditCatalogueTemplateModal.tsx`
- Create: `apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx`
- Modify: the file from Task 9 Step 2 (replace the placeholder with the real component)

- [ ] **Step 1: Create the edit/create modal**

Create `apps/admin-web/src/components/EditCatalogueTemplateModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/data';
import type { CatalogueTemplate, GenderSlug, ModelBackground, ModelPoseAsset } from '../types';
import { Icon } from './Icons';

async function putFile(url: string, file: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

interface LookRow {
  key: string; // stable React key — random per row, independent of the eventual saved id
  poseAssetId: string;
  backgroundId: string;
}

interface Props {
  template: CatalogueTemplate | null; // null = creating a new template
  defaultGenderSlug: GenderSlug;
  poseAssets: ModelPoseAsset[];
  backgrounds: ModelBackground[];
  onSaved: () => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export function EditCatalogueTemplateModal({
  template,
  defaultGenderSlug,
  poseAssets,
  backgrounds,
  onSaved,
  onClose,
  toast,
}: Props) {
  const { storagePublicUrl } = useAuth();
  const isEditing = template !== null;
  const [label, setLabel] = useState(template?.label ?? '');
  const [genderSlug, setGenderSlug] = useState<GenderSlug>(template?.genderSlug ?? defaultGenderSlug);
  const [sortOrder, setSortOrder] = useState(template?.sortOrder ?? 0);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [looks, setLooks] = useState<LookRow[]>([]);
  const [looksLoaded, setLooksLoaded] = useState(!isEditing);
  const [saving, setSaving] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !template) return;
    apiFetch<{ items: { id: string; poseAssetId: string; backgroundId: string }[] }>(
      `/admin/assets/catalogue-templates/${template.id}/looks`,
    )
      .then((res) => {
        // The list endpoint doesn't return looks — this call is a convenience
        // GET on the same collection resource; if it 404s (no such route),
        // fall back to an empty list (this is a brand-new template with no
        // looks saved yet, or the admin is re-opening one created before any
        // looks existed).
        setLooks(
          (res.items ?? []).map((l) => ({
            key: l.id,
            poseAssetId: l.poseAssetId,
            backgroundId: l.backgroundId,
          })),
        );
      })
      .catch(() => setLooks([]))
      .finally(() => setLooksLoaded(true));
  }, [isEditing, template]);

  const genderPoseAssets = poseAssets.filter((p) => p.genderSlug === genderSlug || !p.genderSlug);

  function addLookRow() {
    setLooks((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        poseAssetId: genderPoseAssets[0]?.id ?? '',
        backgroundId: backgrounds[0]?.id ?? '',
      },
    ]);
  }

  function updateLookRow(key: string, patch: Partial<LookRow>) {
    setLooks((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLookRow(key: string) {
    setLooks((prev) => prev.filter((l) => l.key !== key));
  }

  const handleSave = async () => {
    if (!label.trim()) return;
    const dedupe = new Set(looks.map((l) => `${l.poseAssetId}::${l.backgroundId}`));
    if (dedupe.size !== looks.length) {
      toast({ kind: 'error', title: 'Duplicate look', body: 'Remove the duplicate pose+background pair.' });
      return;
    }
    setSaving(true);
    try {
      let thumbnailKey: string | undefined;
      if (thumbnailFile) {
        const presign = await apiFetch<{ uploadUrl: string; thumbnailKey: string }>(
          '/admin/assets/catalogue-templates/thumbnail/presign',
          { method: 'POST', body: JSON.stringify({ contentType: thumbnailFile.type }) },
        );
        await putFile(presign.uploadUrl, thumbnailFile);
        thumbnailKey = presign.thumbnailKey;
      }

      let templateId: string;
      if (isEditing && template) {
        templateId = template.id;
        await apiFetch(`/admin/assets/catalogue-templates/${templateId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            label: label.trim(),
            sortOrder,
            ...(thumbnailKey ? { thumbnailKey } : {}),
          }),
        });
      } else {
        const created = await apiFetch<{ id: string }>('/admin/assets/catalogue-templates', {
          method: 'POST',
          body: JSON.stringify({
            genderSlug,
            label: label.trim(),
            sortOrder,
            ...(thumbnailKey ? { thumbnailKey } : {}),
          }),
        });
        templateId = created.id;
      }

      await apiFetch(`/admin/assets/catalogue-templates/${templateId}/looks`, {
        method: 'PUT',
        body: JSON.stringify({
          looks: looks
            .filter((l) => l.poseAssetId && l.backgroundId)
            .map((l) => ({ poseAssetId: l.poseAssetId, backgroundId: l.backgroundId })),
        }),
      });

      toast({ title: `${label.trim()} saved` });
      onSaved();
      onClose();
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Failed to save template',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(640px, calc(100vw - 40px))' }}
      >
        <div className="modal-head">
          <h3>{isEditing ? 'Edit catalogue template' : 'New catalogue template'}</h3>
          <button className="btn sm ghost" onClick={onClose} disabled={saving} style={{ marginLeft: 'auto' }}>
            <Icon.Close />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '72vh', overflowY: 'auto' }}>
          <div className="field">
            <label>Label</label>
            <input
              className="input"
              value={label}
              disabled={saving}
              placeholder="e.g. Autumn Collection"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Gender {isEditing && <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>(locked after creation)</span>}</label>
            <select
              className="select"
              value={genderSlug}
              disabled={saving || isEditing}
              onChange={(e) => setGenderSlug(e.target.value as GenderSlug)}
            >
              <option value="men">Men</option>
              <option value="women">Women</option>
              <option value="boys">Boys</option>
              <option value="girls">Girls</option>
            </select>
          </div>

          <div className="field">
            <label>Sort order</label>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={sortOrder}
              disabled={saving}
              onChange={(e) => setSortOrder(Number(e.target.value))}
              style={{ width: 120 }}
            />
          </div>

          <div className="field">
            <label>Cover thumbnail</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {(thumbnailFile || template?.thumbnailUrl) && (
                // biome-ignore lint/performance/noImgElement: admin panel thumbnail
                <img
                  src={thumbnailFile ? URL.createObjectURL(thumbnailFile) : (template?.thumbnailUrl ?? undefined)}
                  alt=""
                  style={{ width: 48, height: 60, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--border)' }}
                />
              )}
              <input
                ref={thumbInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={saving}
                onChange={(e) => setThumbnailFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          <div className="field">
            <label>
              Looks{' '}
              <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
                (pose + background pairs — falls back to the first look's pose thumbnail if no cover is set)
              </span>
            </label>
            {!looksLoaded ? (
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>Loading looks…</p>
            ) : (
              <>
                {looks.map((row) => (
                  <div key={row.key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={row.poseAssetId}
                      disabled={saving}
                      onChange={(e) => updateLookRow(row.key, { poseAssetId: e.target.value })}
                    >
                      {genderPoseAssets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName ?? p.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="select"
                      style={{ flex: 1 }}
                      value={row.backgroundId}
                      disabled={saving}
                      onChange={(e) => updateLookRow(row.key, { backgroundId: e.target.value })}
                    >
                      {backgrounds.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn sm danger"
                      disabled={saving}
                      onClick={() => removeLookRow(row.key)}
                    >
                      <Icon.Trash />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn sm ghost"
                  style={{ marginTop: 8 }}
                  disabled={saving || genderPoseAssets.length === 0 || backgrounds.length === 0}
                  onClick={addLookRow}
                >
                  <Icon.Add /> Add look
                </button>
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={handleSave} disabled={saving || !label.trim()}>
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note on the `useEffect` GET-looks call: the admin API from Task 6 does not expose a `GET .../looks` sub-resource (only the top-level list returns `lookCount`, not the individual look rows). Add that missing read endpoint now — go back to `apps/api/src/modules/admin/catalogue-templates.routes.ts` and add, right after the `PUT .../looks` route:

```ts
  app.get(
    '/admin/assets/catalogue-templates/:id/looks',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await app.db
        .select()
        .from(schema.catalogueTemplateLooks)
        .where(eq(schema.catalogueTemplateLooks.templateId, id))
        .orderBy(asc(schema.catalogueTemplateLooks.sortOrder));
      return { items: rows };
    },
  );
```

Add one test for it in `apps/api/test/integration/catalogue-templates-admin.test.ts` (append to the existing `PUT .../looks` test, right after the `putRes` assertion):

```ts
    const getLooksRes = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
    });
    expect(getLooksRes.statusCode).toBe(200);
    expect(getLooksRes.json().items).toHaveLength(1);
```

Re-run `pnpm --filter @tryme/api test -- catalogue-templates-admin` to confirm this addition passes too, then commit this backend addendum separately:

```bash
git add apps/api/src/modules/admin/catalogue-templates.routes.ts apps/api/test/integration/catalogue-templates-admin.test.ts
git commit -m "feat(api): add GET .../catalogue-templates/:id/looks read endpoint"
```

- [ ] **Step 2: Create the tab**

Create `apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { EditCatalogueTemplateModal } from '../../components/EditCatalogueTemplateModal';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiFetch } from '../../lib/data';
import type { CatalogueTemplate, ModelPoseAsset } from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

export function CatalogueTemplatesTab() {
  const { genderFilter, setGenderFilter, allBackgrounds, loadAllBackgrounds, loading, setLoading, toast } =
    useAssetsContext();

  const [templates, setTemplates] = useState<CatalogueTemplate[]>([]);
  const [poseAssets, setPoseAssets] = useState<ModelPoseAsset[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<CatalogueTemplate | null | 'new'>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [templatesRes, poseAssetsRes] = await Promise.all([
        apiFetch<{ items: CatalogueTemplate[] }>('/admin/assets/catalogue-templates'),
        apiFetch<{ items: ModelPoseAsset[] }>('/admin/assets/pose-assets'),
      ]);
      setTemplates(templatesRes.items);
      setPoseAssets(poseAssetsRes.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load catalogue templates' });
    } finally {
      setLoading(false);
    }
  }, [toast, setLoading]);

  useEffect(() => {
    void load();
    if (allBackgrounds.length === 0) void loadAllBackgrounds();
  }, [load, allBackgrounds.length, loadAllBackgrounds]);

  const toggleActive = async (t: CatalogueTemplate) => {
    const next = !t.isActive;
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? { ...x, isActive: next } : x)));
    try {
      await apiFetch(`/admin/assets/catalogue-templates/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: next }),
      });
    } catch {
      setTemplates((prev) => prev.map((x) => (x.id === t.id ? { ...x, isActive: t.isActive } : x)));
      toast({ kind: 'error', title: 'Failed to update template' });
    }
  };

  const doDelete = async () => {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      await apiFetch(`/admin/assets/catalogue-templates/${id}`, { method: 'DELETE' });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      toast({ title: 'Template deleted' });
    } catch (e) {
      toast({ kind: 'error', title: 'Delete failed', body: (e as Error).message });
    }
  };

  const filtered = templates.filter((t) => genderFilter === 'all' || t.genderSlug === genderFilter);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Catalogue Templates</h1>
          <p className="lede">
            Curated (pose, background) look sets. Users pick a template on the studio page instead of manually
            choosing a background and poses.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn ghost" onClick={() => setEditingTemplate('new')}>
            <Icon.Add /> New template
          </button>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: -8 }}>
        {GENDER_TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${genderFilter === t.k ? 'active' : ''}`}
            onClick={() => setGenderFilter(t.k)}
          >
            {t.l}
          </button>
        ))}
      </div>

      {!loading &&
        (filtered.length === 0 ? (
          <p style={{ color: 'var(--muted)', marginTop: 24 }}>No catalogue templates for this gender.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 12,
              marginTop: 12,
            }}
          >
            {filtered.map((t) => (
              <div
                key={t.id}
                className="card"
                style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', opacity: t.isActive ? 1 : 0.55 }}
              >
                <div
                  style={{
                    background: 'var(--surface2, #1a1a1a)',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    aspectRatio: '3/4',
                  }}
                >
                  {t.thumbnailUrl ? (
                    // biome-ignore lint/performance/noImgElement: admin panel
                    <img src={t.thumbnailUrl} alt={t.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <Icon.Image />
                  )}
                </div>
                <div style={{ padding: '8px 8px 10px' }}>
                  <p style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.label}>
                    {t.label}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 0' }}>
                    {t.lookCount} look{t.lookCount !== 1 ? 's' : ''} · {t.genderSlug}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                    <Switch checked={t.isActive} onChange={() => void toggleActive(t)} />
                    <button className="btn ghost" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setEditingTemplate(t)}>
                      <Icon.Edit /> Edit
                    </button>
                  </div>
                  <button
                    className="btn danger"
                    style={{ width: '100%', marginTop: 4, fontSize: 11, padding: '3px 0' }}
                    onClick={() => setConfirmDeleteId(t.id)}
                  >
                    <Icon.Trash /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}

      {confirmDeleteId && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete catalogue template</h3>
            </div>
            <div className="modal-body">
              <p>Delete this template? Studio users will no longer see it.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDeleteId(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={doDelete}>
                <Icon.Trash /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {editingTemplate !== null && (
        <EditCatalogueTemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          defaultGenderSlug={genderFilter === 'all' ? 'men' : genderFilter}
          poseAssets={poseAssets}
          backgrounds={allBackgrounds}
          onSaved={() => void load()}
          onClose={() => setEditingTemplate(null)}
          toast={toast}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Wire it into the tab switcher**

In the file modified in Task 9 Step 2, replace the placeholder `activeTab === 'catalogue-templates' && <div>Templates</div>` branch with:

```tsx
{activeTab === 'catalogue-templates' && <CatalogueTemplatesTab />}
```

and add the import:

```ts
import { CatalogueTemplatesTab } from './assets/CatalogueTemplatesTab';
```

(adjust the relative path to match where that file actually lives, based on Task 9 Step 2's location).

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm --filter @tryme/admin typecheck
npx biome check apps/admin-web/src/components/EditCatalogueTemplateModal.tsx apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx
```

Expected: both clean. Fix any biome findings with `npx biome check --write <file>` and re-verify.

- [ ] **Step 5: Manual smoke test**

```bash
pnpm --filter @tryme/admin dev
```

Open the admin panel, navigate to Assets → Templates. Create a template, add a look (pose + background), save, verify it appears in the grid with the correct look count, toggle active/inactive, edit it, delete it. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/components/EditCatalogueTemplateModal.tsx apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx
git add <the Task-9-Step-2 tab-switcher file>
git commit -m "feat(admin): CatalogueTemplatesTab with looks builder"
```

---

### Task 11: Studio page — data layer

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

- [ ] **Step 1: Add the `TemplateLook`/`CatalogueTemplateItem` types**

After the `PoseItem` interface (`apps/catalogues-web/src/app/(app)/studio/page.tsx:54-60`), add:

```ts
interface TemplateLook {
  id: string;
  poseId: string;
  poseLabel: string;
  poseThumbnailUrl: string;
  backgroundId: string;
  backgroundLabel: string;
  backgroundThumbnailUrl: string;
  hasLower: boolean;
  hasShoes: boolean;
}
interface CatalogueTemplateItem {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  looks: TemplateLook[];
}
```

- [ ] **Step 2: Add `selectedLookIds` state**

Near `const [poseIds, setPoseIds] = useState<string[]>([]);` (line 700), add:

```ts
  const [selectedLookIds, setSelectedLookIds] = useState<string[]>([]);
```

- [ ] **Step 3: Replace the template data source**

Replace the entire block from `const readyMadeCatalogueTemplates = useMemo(` through the `useEffect` that resets `catalogueTemplateId` (lines 809-846) with:

```ts
  const { data: catalogueTemplatesData } = useQuery<{ items: CatalogueTemplateItem[] }>({
    queryKey: ['catalogue-templates', gender, garmentTypeId],
    queryFn: () =>
      api.get(
        `/v1/models/catalogue-templates?gender=${gender}${garmentTypeId ? `&garmentTypeId=${garmentTypeId}` : ''}`,
      ),
    enabled: !!gender,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const catalogueTemplates = useMemo(
    () => [
      { id: 'custom', label: 'Custom', thumbnailUrl: null, looks: [] as TemplateLook[] },
      ...(catalogueTemplatesData?.items ?? []),
    ],
    [catalogueTemplatesData],
  );
  const activeTemplate = catalogueTemplates.find((t) => t.id === catalogueTemplateId);
  const selectedLooks = (activeTemplate?.looks ?? []).filter((l) => selectedLookIds.includes(l.id));
  useEffect(() => {
    if (
      catalogueTemplateId !== 'custom' &&
      !(catalogueTemplatesData?.items ?? []).some((t) => t.id === catalogueTemplateId)
    ) {
      setCatalogueTemplateId('custom');
      setSelectedLookIds([]);
    }
  }, [catalogueTemplateId, catalogueTemplatesData]);
```

- [ ] **Step 4: Replace `needsLower`/`needsShoes` with the shared, mode-aware derivation**

Replace (lines 877-879):

```ts
  const selectedPoses = poses?.items.filter((p) => poseIds.includes(p.id)) ?? [];
  const needsLower = selectedPoses.some((p) => p.hasLower);
  const needsShoes = selectedPoses.some((p) => p.hasShoes);
```

with:

```ts
  const selectedPoses = poses?.items.filter((p) => poseIds.includes(p.id)) ?? [];
  const needsLower =
    catalogueTemplateId === 'custom'
      ? selectedPoses.some((p) => p.hasLower)
      : selectedLooks.some((l) => l.hasLower);
  const needsShoes =
    catalogueTemplateId === 'custom'
      ? selectedPoses.some((p) => p.hasShoes)
      : selectedLooks.some((l) => l.hasShoes);
  const selectedCount = catalogueTemplateId === 'custom' ? poseIds.length : selectedLookIds.length;
```

- [ ] **Step 5: Update the handlers**

Replace `handleBackgroundSelect` and `handleCatalogueTemplateSelect` (lines 1044-1056):

```ts
  function handleBackgroundSelect(id: string) {
    setCatalogueTemplateId('custom');
    setBackgroundId(id);
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
  }
  function handleCatalogueTemplateSelect(id: string) {
    setCatalogueTemplateId(id);
    setSelectedLookIds([]);
    setBackgroundId('');
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
  }
  function handleLookToggle(id: string) {
    setSelectedLookIds((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]));
    setLowerCatalogId('');
    setShoeCatalogId('');
  }
```

(`handleBackgroundSelect` drops its `preserveTemplate` parameter — it's no longer called with a second argument anywhere since template selection no longer routes through it. Search for any remaining `handleBackgroundSelect(id, true)` call sites — `grep -n "handleBackgroundSelect(" "apps/catalogues-web/src/app/(app)/studio/page.tsx"` — and confirm none pass a second argument; the only prior second-argument caller was the old `handleCatalogueTemplateSelect`, which this step already replaced.)

Also update `handleFaceSelect` (lines 1036-1043) to also clear `selectedLookIds`:

```ts
  function handleFaceSelect(id: string) {
    setFaceId(id);
    setCatalogueTemplateId('custom');
    setSelectedLookIds([]);
    setBackgroundId('');
    setPoseIds([]);
    setLowerCatalogId('');
    setShoeCatalogId('');
  }
```

- [ ] **Step 6: Verify typecheck (will still fail on unused `TemplateLook` import warnings etc. until later tasks wire the JSX — that's expected at this checkpoint)**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: may show errors about `catalogueTemplates` shape mismatches in the still-unmodified JSX (Task 12 fixes those) — confirm the errors are confined to the template-section JSX (around what will become line ~2020+) and not elsewhere. Do not proceed to commit until Task 12 is also done; these two tasks land in one commit.

---

### Task 12: Studio page — JSX (wrap Background/Poses, insert Choose Looks)

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

- [ ] **Step 1: Fix the template card grid's `emptyContent` reference and modal to the new shape**

The existing template-card rendering block (originally lines 1979-2088) already reads `template.thumbnailUrl` and `template.label`, which the new `CatalogueTemplateItem` shape still provides — no change needed there. The `SelectGridModal items={catalogueTemplates}` call also still works unchanged (it only needs `id`/`label`/`thumbnailUrl`). Leave that whole block (`{/* ── Ready-made catalogue templates ── */}` section) as-is.

- [ ] **Step 2: Wrap the Background section in a `catalogueTemplateId === 'custom'` guard**

Find the Background section's opening (`{/* ── Background ── */}` followed by `<section>`) and its matching closing `</section>` (the one immediately before `{/* ── Poses ── */}`). Wrap the whole `<section>...</section>` block:

```tsx
            {/* ── Background (custom mode only) ── */}
            {catalogueTemplateId === 'custom' && (
              <section>
                {/* ...entire existing Background section content, unchanged... */}
              </section>
            )}
```

- [ ] **Step 3: Wrap the Poses section in the same guard**

Find the Poses section (`{/* ── Poses ── */}` through its closing `</section>`, right before the `needsLower &&` block) and wrap it identically:

```tsx
            {/* ── Poses (custom mode only) ── */}
            {catalogueTemplateId === 'custom' && (
              <section>
                {/* ...entire existing Poses section content, unchanged... */}
              </section>
            )}
```

- [ ] **Step 4: Insert the "Choose Looks" section**

Immediately after the wrapped Poses section's closing `)}` (from Step 3) and before the `{needsLower &&` block, insert:

```tsx
            {/* ── Choose Looks (template mode only) ── */}
            {catalogueTemplateId !== 'custom' && (
              <section>
                <SectionHead
                  title="Choose Looks"
                  titleSuffix={
                    selectedLookIds.length > 0 && (
                      <span style={{ fontWeight: 500, fontSize: 12, color: C.mid, marginLeft: 6 }}>
                        ({selectedLookIds.length} selected)
                      </span>
                    )
                  }
                />
                {(activeTemplate?.looks.length ?? 0) === 0 ? (
                  <p style={{ fontSize: 14, color: C.mid }}>
                    No looks available for this garment type yet.
                  </p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                    {(activeTemplate?.looks ?? []).map((look) => (
                      <SelCard
                        key={look.id}
                        selected={selectedLookIds.includes(look.id)}
                        onClick={() => handleLookToggle(look.id)}
                        imageUrl={look.poseThumbnailUrl}
                        label={`${look.poseLabel} · ${look.backgroundLabel}`}
                        w="100%"
                        ratio={215.2 / 282}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 6: Lint**

```bash
npx biome check "apps/catalogues-web/src/app/(app)/studio/page.tsx"
```

Expected: clean, or apply `npx biome check --write "apps/catalogues-web/src/app/(app)/studio/page.tsx"` and re-verify.

- [ ] **Step 7: Commit (Tasks 11 + 12 together — the data layer alone doesn't compile without the JSX changes)**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): replace placeholder templates with real catalogue-templates data + Choose Looks section"
```

---

### Task 13: Studio page — shared creditCost/canGenerate/generateBlocker

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx:1236-1259`

- [ ] **Step 1: Replace the creditCost/canGenerate/generateBlocker block**

Replace:

```ts
  const creditCost = resolution ? RESOLUTION_COSTS[resolution] * poseIds.length : 0;
  const canGenerate =
    poseIds.length > 0 &&
    !!garmentKey &&
    !!faceId &&
    !!backgroundId &&
    customDimsReady &&
    !!resolution &&
    !isUploading &&
    !isUploadingLower &&
    !isSubmitting &&
    !generationInProgress;

  const generateBlocker = generationInProgress
    ? 'Generation in progress…'
    : isUploading
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Upload a garment image first'
        : poseIds.length === 0
          ? 'Select at least one pose'
          : !customDimsReady
            ? 'Enter valid width and height for custom size'
            : '';
```

with:

```ts
  const creditCost = resolution ? RESOLUTION_COSTS[resolution] * selectedCount : 0;
  const canGenerate =
    selectedCount > 0 &&
    !!garmentKey &&
    !!faceId &&
    (catalogueTemplateId === 'custom' ? !!backgroundId : true) &&
    customDimsReady &&
    !!resolution &&
    !isUploading &&
    !isUploadingLower &&
    !isSubmitting &&
    !generationInProgress;

  const generateBlocker = generationInProgress
    ? 'Generation in progress…'
    : isUploading
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Upload a garment image first'
        : selectedCount === 0
          ? catalogueTemplateId === 'custom'
            ? 'Select at least one pose'
            : 'Select at least one look'
          : !customDimsReady
            ? 'Enter valid width and height for custom size'
            : '';
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): drive credit cost and generate-guard off shared selectedCount"
```

---

### Task 14: Studio page — submission logic

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx:1077-1146` (the `handleSubmit` function)

- [ ] **Step 1: Replace the submission guard and body construction**

Replace the start of `handleSubmit` (the line `if (!garmentKey || !faceId || !backgroundId || poseIds.length === 0 || !resolution) return;`) with:

```ts
    if (!garmentKey || !faceId || !resolution) return;
    if (catalogueTemplateId === 'custom') {
      if (!backgroundId || poseIds.length === 0) return;
    } else {
      if (selectedLookIds.length === 0) return;
    }
```

- [ ] **Step 2: Replace the request body's `inputs` and the `activeGeneration.jobs` construction**

Replace the body of the `try { ... }` block in `handleSubmit` — specifically the `inputs: { ... }` object and the `setActiveGeneration({ ... })` call — with:

```ts
      const effectivePlatform =
        platform === 'Amazon' ? (amazonUseWhiteBg ? 'Amazon' : undefined) : platform;
      const effectiveLowerId =
        lowerCatalogId ||
        (needsLower ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined) : undefined);
      const effectiveShoesId =
        shoeCatalogId ||
        (needsShoes ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined) : undefined);
      const inputsBase = {
        upperGarmentKey: garmentKey,
        faceId,
        garmentTypeId: garmentTypeId || undefined,
        lowerCatalogId: effectiveLowerId,
        lowerGarmentKey: lowerGarmentKey || undefined,
        shoeCatalogId: effectiveShoesId,
      };
      const inputs =
        catalogueTemplateId === 'custom'
          ? { ...inputsBase, backgroundId, poseIds }
          : {
              ...inputsBase,
              looks: selectedLooks.map((l) => ({ poseId: l.poseId, backgroundId: l.backgroundId })),
            };
      const { catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
        '/v1/jobs/tryon',
        {
          inputs,
          aspectRatio: effectiveAspect,
          resolution,
          ...(Object.keys(customParams).length ? { params: customParams } : {}),
          ...(effectivePlatform ? { platform: effectivePlatform } : {}),
        },
      );
      // Credits were deducted server-side — refresh balance + catalogues list.
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      const submittedLooks =
        catalogueTemplateId === 'custom'
          ? poseIds.map((poseId) => {
              const pose = poses?.items.find((p) => p.id === poseId);
              return { poseId, label: pose?.label ?? 'Pose', thumbnailUrl: pose?.thumbnailUrl ?? '' };
            })
          : selectedLooks.map((l) => ({ poseId: l.poseId, label: l.poseLabel, thumbnailUrl: l.poseThumbnailUrl }));
      setActiveGeneration({
        catalogueId,
        jobs: jobIds.map((id, i) => ({
          id,
          poseId: submittedLooks[i]?.poseId ?? '',
          label: submittedLooks[i]?.label ?? `Look ${i + 1}`,
          thumbnailUrl: submittedLooks[i]?.thumbnailUrl ?? '',
        })),
      });
```

(This replaces the old `inputs: { upperGarmentKey, faceId, backgroundId, poseIds, ... }` object and the old `jobs: poseIds.map((poseId, i) => {...})` block. Leave `setGenerationInProgress(true); isSubmittingRef.current = false; setIsSubmitting(false);` and the `catch` block below unchanged.)

- [ ] **Step 3: Leave `submitAmazonPose` unchanged**

`submitAmazonPose` is only reachable when `amazonUseWhiteBg` is `true`, which is permanently hardcoded `false` (line 592, "Bypassed: Amazon no longer forces white bg"). It is unreachable dead code regardless of this feature and is out of scope — do not modify it.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: clean.

- [ ] **Step 5: Lint**

```bash
npx biome check "apps/catalogues-web/src/app/(app)/studio/page.tsx"
```

Expected: clean.

- [ ] **Step 6: Manual smoke test**

```bash
pnpm --filter @tryme/web dev
```

In the browser: open Studio, pick a gender/model, upload a garment, select a custom look (background + poses) and generate — confirm this still works exactly as before (regression check). Then pick a real catalogue template created in Task 10's manual test, check one or more looks, and generate — confirm the resulting catalogue has one image per checked look, each on its own background. Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): submit template looks via atomic looks[] request"
```

---

### Task 15: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo typecheck**

```bash
pnpm typecheck
```

Expected: clean across all packages.

- [ ] **Step 2: Full lint**

```bash
pnpm lint
```

Expected: clean, or fix with `pnpm lint:fix` and re-verify.

- [ ] **Step 3: Full API test suite**

```bash
pnpm --filter @tryme/api test
```

Expected: all passing (including every new test file added in Tasks 5, 6, 7).

- [ ] **Step 4: Build**

```bash
pnpm build
```

Expected: clean across all apps/packages.

- [ ] **Step 5: Update `docs/progress.md`**

Add a new dated entry at the top of `docs/progress.md` per CLAUDE.md's Progress Tracking convention, summarizing: DB tables added, `createJob` generalized to atomic per-look backgrounds with the Amazon-override guard, new admin CRUD tab, new public endpoint, studio page's "Choose Looks" section replacing Background/Poses in template mode. Note under "Open Questions / Decisions": per-look lower/shoe selection was explicitly deferred in favor of one shared pick applied wherever needed (per design decision during brainstorming).

- [ ] **Step 6: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log catalogue-templates feature completion"
```
