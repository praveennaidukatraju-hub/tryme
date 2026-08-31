# Asset Schema Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign model asset tables to match real asset structure — global backgrounds, garment subcategories, per-subcategory poses and templates (model×bg combos); replace ModelsPage with a unified three-tab AssetsPage.

**Architecture:** `model_backgrounds` drops `face_id` (becomes global pool); `model_poses` swaps `background_id` → `subcategory_id` (FK to new `garment_subcategories`); new `subcategory_templates` stores 4×4 model-face×background pre-rendered images per subcategory. API routes migrate from `/admin/models/*` to `/admin/assets/*`. Admin frontend gains three-tab AssetsPage (Backgrounds | Model Faces | Subcategories→Poses+Templates).

**Tech Stack:** PostgreSQL + Drizzle ORM + Zod, Fastify, React + TypeScript + Vite, pnpm workspaces, testcontainers + Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/db/src/schema/models.ts` | Rewrite | Remove `faceId` from backgrounds; swap `backgroundId`→`subcategoryId` in poses; add `garmentSubcategories` + `subcategoryTemplates` tables |
| `packages/db/src/migrations/0002_asset_schema_redesign.sql` | Create | DDL for schema change |
| `packages/db/test/models-schema.test.ts` | Rewrite | Tests for new schema shape |
| `packages/storage/src/keys.ts` | Modify | Add `subcategoryTemplate` + thumb keys |
| `packages/types/src/admin.ts` | Modify | Fix BG/pose Zod schemas; add subcategory + template Zod schemas |
| `apps/api/src/modules/admin/models.routes.ts` | Modify | Prefix `/admin/assets/`; global BG (no faceId); poses use `subcategoryId`; fix delete cascades |
| `apps/api/src/modules/admin/subcategories.routes.ts` | Create | CRUD for `garment_subcategories` |
| `apps/api/src/modules/admin/templates.routes.ts` | Create | Presign / confirm / toggle / delete for `subcategory_templates` |
| `apps/api/src/server.ts` | Modify | Register 2 new route modules |
| `apps/admin/src/types.ts` | Modify | Update `ModelBackground`, `ModelPose`; add `GarmentSubcategory`, `SubcategoryTemplate` |
| `apps/admin/src/pages/AssetsPage.tsx` | Create | Three-tab Assets page |
| `apps/admin/src/pages/ModelsPage.tsx` | Delete | Replaced by AssetsPage |
| `apps/admin/src/App.tsx` | Modify | Route `assets` → AssetsPage; drop `models` route |
| `apps/admin/src/components/Sidebar.tsx` | Modify | Rename Models → Assets nav item |

---

## Task 1: Rewrite DB Schema

**Files:**
- Modify: `packages/db/src/schema/models.ts`
- Test: `packages/db/test/models-schema.test.ts` (rewrite in Task 2)

- [ ] **Step 1: Rewrite `packages/db/src/schema/models.ts`**

```typescript
import { pgTable, uuid, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core';

export const modelFaces = pgTable('model_faces', {
  id: uuid('id').primaryKey().defaultRandom(),
  gender: text('gender').notNull(), // 'men' | 'women' | 'boys' | 'girls'
  label: text('label').notNull(),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Global pool — no faceId FK
export const modelBackgrounds = pgTable('model_backgrounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// e.g. { genderSlug: 'men', slug: 'fullsleeveshirt', label: 'Full Sleeve Shirt' }
export const garmentSubcategories = pgTable('garment_subcategories', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Poses belong to a garment subcategory (not to a background)
export const modelPoses = pgTable('model_poses', {
  id: uuid('id').primaryKey().defaultRandom(),
  subcategoryId: uuid('subcategory_id').notNull().references(() => garmentSubcategories.id),
  label: text('label').notNull(),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  showsLower: boolean('shows_lower').notNull().default(false),
  showsShoes: boolean('shows_shoes').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per (subcategory × face × background) combination — 4×4 = 16 per subcategory
export const subcategoryTemplates = pgTable('subcategory_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  subcategoryId: uuid('subcategory_id').notNull().references(() => garmentSubcategories.id),
  faceId: uuid('face_id').notNull().references(() => modelFaces.id),
  backgroundId: uuid('background_id').notNull().references(() => modelBackgrounds.id),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

---

## Task 2: Write Migration SQL + Rewrite Schema Tests

**Files:**
- Create: `packages/db/src/migrations/0002_asset_schema_redesign.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json` (add entry)
- Rewrite: `packages/db/test/models-schema.test.ts`

- [ ] **Step 1: Write the failing tests (new schema shape)**

Replace entire `packages/db/test/models-schema.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '../src/schema/index';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let container: Awaited<ReturnType<typeof PostgreSqlContainer.prototype.start>>;
let db: ReturnType<typeof drizzle>;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  sql = postgres(container.getConnectionUri());
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '../src/migrations') });
}, 60_000);

afterAll(async () => {
  await sql.end();
  await container.stop();
});

describe('model_faces', () => {
  it('inserts and retrieves a face', async () => {
    const [face] = await db.insert(schema.modelFaces).values({
      gender: 'men',
      label: 'Test Face',
      r2Key: 'faces/test.jpg',
      thumbnailKey: 'faces/test_thumb.jpg',
    }).returning();

    expect(face.id).toBeTruthy();
    expect(face.gender).toBe('men');
    expect(face.isActive).toBe(true);
  });
});

describe('model_backgrounds (global)', () => {
  it('inserts background without faceId', async () => {
    const [bg] = await db.insert(schema.modelBackgrounds).values({
      label: 'Studio White',
      r2Key: 'backgrounds/studio_white.jpg',
      thumbnailKey: 'backgrounds/studio_white_thumb.jpg',
    }).returning();

    expect(bg.id).toBeTruthy();
    expect(bg.label).toBe('Studio White');
    // no faceId column
    expect((bg as unknown as Record<string, unknown>).faceId).toBeUndefined();
  });
});

describe('garment_subcategories', () => {
  it('inserts a garment subcategory', async () => {
    const [sub] = await db.insert(schema.garmentSubcategories).values({
      genderSlug: 'men',
      slug: 'fullsleeveshirt',
      label: 'Full Sleeve Shirt',
    }).returning();

    expect(sub.id).toBeTruthy();
    expect(sub.genderSlug).toBe('men');
    expect(sub.slug).toBe('fullsleeveshirt');
    expect(sub.isActive).toBe(true);
  });
});

describe('model_poses (per subcategory)', () => {
  it('inserts pose linked to subcategory', async () => {
    const [sub] = await db.insert(schema.garmentSubcategories).values({
      genderSlug: 'men',
      slug: 'tshirt',
      label: 'T-Shirt',
    }).returning();

    const [pose] = await db.insert(schema.modelPoses).values({
      subcategoryId: sub.id,
      label: 'Front standing',
      r2Key: 'poses/tshirt_front.jpg',
      thumbnailKey: 'poses/tshirt_front_thumb.jpg',
      showsLower: true,
      showsShoes: false,
    }).returning();

    expect(pose.subcategoryId).toBe(sub.id);
    expect(pose.showsLower).toBe(true);
    expect(pose.showsShoes).toBe(false);
    // no backgroundId column
    expect((pose as unknown as Record<string, unknown>).backgroundId).toBeUndefined();
  });

  it('rejects pose with non-existent subcategory_id', async () => {
    await expect(
      db.insert(schema.modelPoses).values({
        subcategoryId: '00000000-0000-0000-0000-000000000000',
        label: 'Bad',
        r2Key: 'x',
        thumbnailKey: 'x',
      })
    ).rejects.toThrow();
  });
});

describe('subcategory_templates', () => {
  it('inserts a template for subcategory × face × background', async () => {
    const [face] = await db.insert(schema.modelFaces).values({
      gender: 'men',
      label: 'Template Face',
      r2Key: 'faces/tmpl.jpg',
      thumbnailKey: 'faces/tmpl_thumb.jpg',
    }).returning();

    const [bg] = await db.insert(schema.modelBackgrounds).values({
      label: 'Outdoor',
      r2Key: 'backgrounds/outdoor.jpg',
      thumbnailKey: 'backgrounds/outdoor_thumb.jpg',
    }).returning();

    const [sub] = await db.insert(schema.garmentSubcategories).values({
      genderSlug: 'men',
      slug: 'polo',
      label: 'Polo Shirt',
    }).returning();

    const [tmpl] = await db.insert(schema.subcategoryTemplates).values({
      subcategoryId: sub.id,
      faceId: face.id,
      backgroundId: bg.id,
      r2Key: 'templates/polo_tmpl1_bg1.jpg',
      thumbnailKey: 'templates/polo_tmpl1_bg1_thumb.jpg',
    }).returning();

    expect(tmpl.subcategoryId).toBe(sub.id);
    expect(tmpl.faceId).toBe(face.id);
    expect(tmpl.backgroundId).toBe(bg.id);
    expect(tmpl.isActive).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (migration 0002 not yet created)**

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm test --filter @tryme/db 2>&1 | tail -30
```

Expected: test failures about `faceId` and missing tables.

- [ ] **Step 3: Create migration SQL**

Create `packages/db/src/migrations/0002_asset_schema_redesign.sql`:

```sql
-- Migration 0002: asset schema redesign
-- Backgrounds become global (drop face_id).
-- Poses move from per-background to per-subcategory (drop background_id, add subcategory_id).
-- New: garment_subcategories, subcategory_templates.
-- NOTE: run on a dev DB with no existing model data. If data exists, populate
--       subcategory_id before the NOT NULL step below.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "garment_subcategories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gender_slug" text NOT NULL,
  "slug" text NOT NULL,
  "label" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subcategory_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subcategory_id" uuid NOT NULL,
  "face_id" uuid NOT NULL,
  "background_id" uuid NOT NULL,
  "r2_key" text NOT NULL,
  "thumbnail_key" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Drop old FK: model_poses.background_id → model_backgrounds.id
ALTER TABLE "model_poses" DROP CONSTRAINT IF EXISTS "model_poses_background_id_model_backgrounds_id_fk";
--> statement-breakpoint
-- Add new column (nullable first, becomes NOT NULL after)
ALTER TABLE "model_poses" ADD COLUMN IF NOT EXISTS "subcategory_id" uuid;
--> statement-breakpoint
-- Drop old column
ALTER TABLE "model_poses" DROP COLUMN IF EXISTS "background_id";
--> statement-breakpoint
-- Enforce NOT NULL (safe on empty dev DB; for prod populate first)
ALTER TABLE "model_poses" ALTER COLUMN "subcategory_id" SET NOT NULL;
--> statement-breakpoint
-- Drop old FK: model_backgrounds.face_id → model_faces.id
ALTER TABLE "model_backgrounds" DROP CONSTRAINT IF EXISTS "model_backgrounds_face_id_model_faces_id_fk";
--> statement-breakpoint
ALTER TABLE "model_backgrounds" DROP COLUMN IF EXISTS "face_id";
--> statement-breakpoint
-- FK constraints for new tables and column
DO $$ BEGIN
  ALTER TABLE "model_poses" ADD CONSTRAINT "model_poses_subcategory_id_garment_subcategories_id_fk"
    FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_subcategory_id_fk"
    FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_face_id_fk"
    FOREIGN KEY ("face_id") REFERENCES "public"."model_faces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "subcategory_templates" ADD CONSTRAINT "subcategory_templates_background_id_fk"
    FOREIGN KEY ("background_id") REFERENCES "public"."model_backgrounds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
```

- [ ] **Step 4: Update migration journal**

Append to `packages/db/src/migrations/meta/_journal.json` entries array:

```json
{
  "idx": 2,
  "version": "7",
  "when": 1748822400000,
  "tag": "0002_asset_schema_redesign",
  "breakpoints": true
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
pnpm test --filter @tryme/db 2>&1 | tail -20
```

Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/models.ts \
        packages/db/src/migrations/0002_asset_schema_redesign.sql \
        packages/db/src/migrations/meta/_journal.json \
        packages/db/test/models-schema.test.ts
git commit -m "feat(db): redesign model asset schema — global BGs, subcategory poses + templates"
```

---

## Task 3: Storage Keys + Types Package

**Files:**
- Modify: `packages/storage/src/keys.ts`
- Modify: `packages/types/src/admin.ts`

- [ ] **Step 1: Add template R2 keys to `packages/storage/src/keys.ts`**

```typescript
export const keys = {
  inputGarment: (jobId: string) => `inputs/${jobId}/garment.jpg`,
  output: (jobId: string) => `outputs/${jobId}/result.png`,
  catalogItem: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.jpg`,
  catalogThumb: (typeSlug: string, id: string) => `catalog/${typeSlug}/${id}.thumb.jpg`,
  modelFace: (id: string) => `models/faces/${id}.jpg`,
  modelFaceThumb: (id: string) => `models/faces/${id}.thumb.jpg`,
  modelBackground: (id: string) => `models/backgrounds/${id}.jpg`,
  modelBackgroundThumb: (id: string) => `models/backgrounds/${id}.thumb.jpg`,
  modelPose: (id: string) => `models/poses/${id}.jpg`,
  modelPoseThumb: (id: string) => `models/poses/${id}.thumb.jpg`,
  subcategoryTemplate: (id: string) => `models/templates/${id}.jpg`,
  subcategoryTemplateThumb: (id: string) => `models/templates/${id}.thumb.jpg`,
};
```

- [ ] **Step 2: Rewrite model asset Zod schemas in `packages/types/src/admin.ts`**

Replace the "Model asset upload schemas" section (lines 46–104) with:

```typescript
// ── Model asset upload schemas ────────────────────────────────────────────

const AssetContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const GenderEnum = z.enum(['men', 'women', 'boys', 'girls']);

export const PresignModelFaceBody = z.object({
  contentType: AssetContentType,
});
export const ConfirmModelFaceBody = z.object({
  label: z.string().min(1).max(120),
  gender: GenderEnum,
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
export const PatchModelFaceBody = z.object({
  label: z.string().min(1).max(120).optional(),
  gender: GenderEnum.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// Backgrounds are now global — no faceId
export const PresignModelBackgroundBody = z.object({
  contentType: AssetContentType,
});
export const ConfirmModelBackgroundBody = z.object({
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
export const PatchModelBackgroundBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// Poses belong to a garment subcategory — subcategoryId replaces backgroundId
export const PresignModelPoseBody = z.object({
  subcategoryId: z.string().uuid(),
  contentType: AssetContentType,
});
export const ConfirmModelPoseBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  showsLower: z.boolean().default(false),
  showsShoes: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export const PatchModelPoseBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  showsLower: z.boolean().optional(),
  showsShoes: z.boolean().optional(),
});

// Garment subcategories
export const CreateGarmentSubcategoryBody = z.object({
  genderSlug: GenderEnum,
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  sortOrder: z.number().int().default(0),
});
export const PatchGarmentSubcategoryBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// Subcategory templates (pre-rendered face×background combos)
export const PresignSubcategoryTemplateBody = z.object({
  subcategoryId: z.string().uuid(),
  faceId: z.string().uuid(),
  backgroundId: z.string().uuid(),
  contentType: AssetContentType,
});
export const ConfirmSubcategoryTemplateBody = z.object({
  subcategoryId: z.string().uuid(),
  faceId: z.string().uuid(),
  backgroundId: z.string().uuid(),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
export const PatchSubcategoryTemplateBody = z.object({
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
```

- [ ] **Step 3: Build types package to verify no errors**

```bash
pnpm --filter @tryme/types build 2>&1 | tail -10
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/storage/src/keys.ts packages/types/src/admin.ts
git commit -m "feat(storage,types): add template keys; fix BG/pose schemas; add subcategory/template schemas"
```

---

## Task 4: Redesign models.routes.ts → assets.routes.ts

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts`

The function is renamed `adminAssetsRoutes` and all routes move to `/admin/assets/*`. Key logic changes:
- Background routes: remove `faceId` param; `backgroundCount` on faces comes from `subcategoryTemplates` instead of `modelBackgrounds`
- Pose routes: `backgroundId` param → `subcategoryId`  
- Face delete: no longer cascades to backgrounds/poses (they're independent); still blocks if face referenced in `job_inputs` OR `subcategory_templates`
- Background delete: blocks if referenced in `subcategory_templates` or `job_inputs`; no pose cascade

- [ ] **Step 1: Rewrite `apps/api/src/modules/admin/models.routes.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { schema } from '@tryme/db';
import { eq, count, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { keys } from '@tryme/storage';
import {
  PresignModelFaceBody, ConfirmModelFaceBody, PatchModelFaceBody,
  PresignModelBackgroundBody, ConfirmModelBackgroundBody, PatchModelBackgroundBody,
  PresignModelPoseBody, ConfirmModelPoseBody, PatchModelPoseBody,
} from '@tryme/types';
import { requireAdmin } from './guard';
import { AppError } from '../../lib/errors';

export async function adminAssetsRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  // ── Faces ─────────────────────────────────────────────────────────────────

  app.get('/admin/assets/faces', { preHandler: W }, async () => {
    const rows = await app.db.select().from(schema.modelFaces);
    const tmplCounts = await app.db
      .select({ faceId: schema.subcategoryTemplates.faceId, cnt: count() })
      .from(schema.subcategoryTemplates)
      .groupBy(schema.subcategoryTemplates.faceId);
    const countMap = Object.fromEntries(tmplCounts.map((r) => [r.faceId, Number(r.cnt)]));
    return {
      items: rows.map((r) => ({ ...r, templateCount: countMap[r.id] ?? 0 })),
    };
  });

  app.post('/admin/assets/faces/presign', {
    preHandler: W,
    schema: { body: PresignModelFaceBody },
  }, async (req) => {
    const { contentType } = req.body as { contentType: string };
    const newId = randomUUID();
    const r2Key = keys.modelFace(newId);
    const thumbKey = keys.modelFaceThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/assets/faces/confirm', {
    preHandler: W,
    schema: { body: ConfirmModelFaceBody },
  }, async (req) => {
    const { label, gender, r2Key, thumbnailKey, sortOrder } = req.body as {
      label: string; gender: string; r2Key: string; thumbnailKey: string; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.modelFaces)
      .values({ label, gender, r2Key, thumbnailKey, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/assets/faces/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelFaceBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [updated] = await app.db
      .update(schema.modelFaces)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelFaces.id, id))
      .returning({ id: schema.modelFaces.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'face not found');
    return { ok: true };
  });

  app.delete('/admin/assets/faces/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [face] = await app.db.select().from(schema.modelFaces).where(eq(schema.modelFaces.id, id));
    if (!face) throw new AppError('NOT_FOUND', 404, 'face not found');

    const jobRef = await app.db.select({ jobId: schema.jobInputs.jobId })
      .from(schema.jobInputs).where(eq(schema.jobInputs.faceId, id)).limit(1);
    if (jobRef.length > 0) throw new AppError('CONFLICT', 409, 'face is referenced by existing jobs');

    const tmplRef = await app.db.select({ id: schema.subcategoryTemplates.id })
      .from(schema.subcategoryTemplates).where(eq(schema.subcategoryTemplates.faceId, id)).limit(1);
    if (tmplRef.length > 0) throw new AppError('CONFLICT', 409, 'face is used in subcategory templates — delete templates first');

    await Promise.allSettled([
      app.storage.deleteObject(face.r2Key),
      app.storage.deleteObject(face.thumbnailKey),
    ]);
    await app.db.delete(schema.modelFaces).where(eq(schema.modelFaces.id, id));
    return { ok: true };
  });

  // ── Backgrounds (global) ──────────────────────────────────────────────────

  app.get('/admin/assets/backgrounds', { preHandler: W }, async () => {
    const rows = await app.db.select().from(schema.modelBackgrounds);
    return { items: rows };
  });

  app.post('/admin/assets/backgrounds/presign', {
    preHandler: W,
    schema: { body: PresignModelBackgroundBody },
  }, async (req) => {
    const { contentType } = req.body as { contentType: string };
    const newId = randomUUID();
    const r2Key = keys.modelBackground(newId);
    const thumbKey = keys.modelBackgroundThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/assets/backgrounds/confirm', {
    preHandler: W,
    schema: { body: ConfirmModelBackgroundBody },
  }, async (req) => {
    const { label, r2Key, thumbnailKey, sortOrder } = req.body as {
      label: string; r2Key: string; thumbnailKey: string; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label, r2Key, thumbnailKey, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/assets/backgrounds/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelBackgroundBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [updated] = await app.db
      .update(schema.modelBackgrounds)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelBackgrounds.id, id))
      .returning({ id: schema.modelBackgrounds.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'background not found');
    return { ok: true };
  });

  app.delete('/admin/assets/backgrounds/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [bg] = await app.db.select().from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, id));
    if (!bg) throw new AppError('NOT_FOUND', 404, 'background not found');

    const jobRef = await app.db.select({ jobId: schema.jobInputs.jobId })
      .from(schema.jobInputs).where(eq(schema.jobInputs.backgroundId, id)).limit(1);
    if (jobRef.length > 0) throw new AppError('CONFLICT', 409, 'background is referenced by existing jobs');

    const tmplRef = await app.db.select({ id: schema.subcategoryTemplates.id })
      .from(schema.subcategoryTemplates).where(eq(schema.subcategoryTemplates.backgroundId, id)).limit(1);
    if (tmplRef.length > 0) throw new AppError('CONFLICT', 409, 'background is used in subcategory templates — delete templates first');

    await Promise.allSettled([
      app.storage.deleteObject(bg.r2Key),
      app.storage.deleteObject(bg.thumbnailKey),
    ]);
    await app.db.delete(schema.modelBackgrounds).where(eq(schema.modelBackgrounds.id, id));
    return { ok: true };
  });

  // ── Poses (per subcategory) ───────────────────────────────────────────────

  app.get('/admin/assets/poses', {
    preHandler: W,
    schema: { querystring: z.object({ subcategoryId: z.string().uuid() }) },
  }, async (req) => {
    const { subcategoryId } = req.query as { subcategoryId: string };
    const rows = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.subcategoryId, subcategoryId));
    return { items: rows };
  });

  app.post('/admin/assets/poses/presign', {
    preHandler: W,
    schema: { body: PresignModelPoseBody },
  }, async (req) => {
    const { subcategoryId, contentType } = req.body as { subcategoryId: string; contentType: string };
    const [sub] = await app.db.select().from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, subcategoryId));
    if (!sub) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
    const newId = randomUUID();
    const r2Key = keys.modelPose(newId);
    const thumbKey = keys.modelPoseThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/assets/poses/confirm', {
    preHandler: W,
    schema: { body: ConfirmModelPoseBody },
  }, async (req) => {
    const { subcategoryId, label, r2Key, thumbnailKey, showsLower, showsShoes, sortOrder } = req.body as {
      subcategoryId: string; label: string; r2Key: string; thumbnailKey: string;
      showsLower: boolean; showsShoes: boolean; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.modelPoses)
      .values({ subcategoryId, label, r2Key, thumbnailKey, showsLower, showsShoes, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/assets/poses/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelPoseBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [updated] = await app.db
      .update(schema.modelPoses)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelPoses.id, id))
      .returning({ id: schema.modelPoses.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'pose not found');
    return { ok: true };
  });

  app.delete('/admin/assets/poses/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [pose] = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.id, id));
    if (!pose) throw new AppError('NOT_FOUND', 404, 'pose not found');

    const jobRef = await app.db.select({ jobId: schema.jobInputs.jobId })
      .from(schema.jobInputs).where(eq(schema.jobInputs.poseId, id)).limit(1);
    if (jobRef.length > 0) throw new AppError('CONFLICT', 409, 'pose is referenced by existing jobs');

    await Promise.allSettled([
      app.storage.deleteObject(pose.r2Key),
      app.storage.deleteObject(pose.thumbnailKey),
    ]);
    await app.db.delete(schema.modelPoses).where(eq(schema.modelPoses.id, id));
    return { ok: true };
  });
}
```

- [ ] **Step 2: Build api to check for TS errors**

```bash
pnpm --filter @tryme/api build 2>&1 | tail -20
```

Expected: errors about `adminModelsRoutes` import (will fix in Task 6).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts
git commit -m "feat(api): redesign model asset routes — /admin/assets/ prefix, global BGs, subcategoryId poses"
```

---

## Task 5: New subcategories.routes.ts + templates.routes.ts

**Files:**
- Create: `apps/api/src/modules/admin/subcategories.routes.ts`
- Create: `apps/api/src/modules/admin/templates.routes.ts`

- [ ] **Step 1: Create `apps/api/src/modules/admin/subcategories.routes.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { schema } from '@tryme/db';
import { eq, count, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CreateGarmentSubcategoryBody, PatchGarmentSubcategoryBody } from '@tryme/types';
import { requireAdmin } from './guard';
import { AppError } from '../../lib/errors';

export async function adminSubcategoriesRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/assets/subcategories', { preHandler: W }, async () => {
    const rows = await app.db.select().from(schema.garmentSubcategories);
    const poseCounts = await app.db
      .select({ subcategoryId: schema.modelPoses.subcategoryId, cnt: count() })
      .from(schema.modelPoses)
      .groupBy(schema.modelPoses.subcategoryId);
    const tmplCounts = await app.db
      .select({ subcategoryId: schema.subcategoryTemplates.subcategoryId, cnt: count() })
      .from(schema.subcategoryTemplates)
      .groupBy(schema.subcategoryTemplates.subcategoryId);
    const poseMap = Object.fromEntries(poseCounts.map((r) => [r.subcategoryId, Number(r.cnt)]));
    const tmplMap = Object.fromEntries(tmplCounts.map((r) => [r.subcategoryId, Number(r.cnt)]));
    return {
      items: rows.map((r) => ({
        ...r,
        poseCount: poseMap[r.id] ?? 0,
        templateCount: tmplMap[r.id] ?? 0,
      })),
    };
  });

  app.post('/admin/assets/subcategories', {
    preHandler: W,
    schema: { body: CreateGarmentSubcategoryBody },
  }, async (req) => {
    const { genderSlug, slug, label, sortOrder } = req.body as {
      genderSlug: string; slug: string; label: string; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug, slug, label, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/assets/subcategories/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchGarmentSubcategoryBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [updated] = await app.db
      .update(schema.garmentSubcategories)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.garmentSubcategories.id, id))
      .returning({ id: schema.garmentSubcategories.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
    return { ok: true };
  });

  app.delete('/admin/assets/subcategories/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [sub] = await app.db.select().from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, id));
    if (!sub) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

    const poses = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.subcategoryId, id));
    const poseJobRefs = poses.length > 0
      ? await app.db.select({ jobId: schema.jobInputs.jobId })
          .from(schema.jobInputs)
          .where(inArray(schema.jobInputs.poseId, poses.map((p) => p.id)))
          .limit(1)
      : [];
    if (poseJobRefs.length > 0) throw new AppError('CONFLICT', 409, 'subcategory has poses referenced by existing jobs');

    const templates = await app.db.select().from(schema.subcategoryTemplates)
      .where(eq(schema.subcategoryTemplates.subcategoryId, id));

    // Delete R2 objects best-effort
    const r2Keys = [
      ...poses.flatMap((p) => [p.r2Key, p.thumbnailKey]),
      ...templates.flatMap((t) => [t.r2Key, t.thumbnailKey]),
    ];
    await Promise.allSettled(r2Keys.map((k) => app.storage.deleteObject(k)));

    // Delete in transaction
    await app.db.transaction(async (tx) => {
      if (templates.length > 0) {
        await tx.delete(schema.subcategoryTemplates)
          .where(eq(schema.subcategoryTemplates.subcategoryId, id));
      }
      if (poses.length > 0) {
        await tx.delete(schema.modelPoses)
          .where(eq(schema.modelPoses.subcategoryId, id));
      }
      await tx.delete(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
    });

    return { ok: true };
  });
}
```

- [ ] **Step 2: Create `apps/api/src/modules/admin/templates.routes.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { keys } from '@tryme/storage';
import {
  PresignSubcategoryTemplateBody,
  ConfirmSubcategoryTemplateBody,
  PatchSubcategoryTemplateBody,
} from '@tryme/types';
import { requireAdmin } from './guard';
import { AppError } from '../../lib/errors';

export async function adminTemplatesRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/assets/templates', {
    preHandler: W,
    schema: { querystring: z.object({ subcategoryId: z.string().uuid() }) },
  }, async (req) => {
    const { subcategoryId } = req.query as { subcategoryId: string };
    const rows = await app.db.select({
      id: schema.subcategoryTemplates.id,
      subcategoryId: schema.subcategoryTemplates.subcategoryId,
      faceId: schema.subcategoryTemplates.faceId,
      backgroundId: schema.subcategoryTemplates.backgroundId,
      r2Key: schema.subcategoryTemplates.r2Key,
      thumbnailKey: schema.subcategoryTemplates.thumbnailKey,
      isActive: schema.subcategoryTemplates.isActive,
      sortOrder: schema.subcategoryTemplates.sortOrder,
      createdAt: schema.subcategoryTemplates.createdAt,
      updatedAt: schema.subcategoryTemplates.updatedAt,
      faceLabel: schema.modelFaces.label,
      backgroundLabel: schema.modelBackgrounds.label,
    })
      .from(schema.subcategoryTemplates)
      .leftJoin(schema.modelFaces, eq(schema.subcategoryTemplates.faceId, schema.modelFaces.id))
      .leftJoin(schema.modelBackgrounds, eq(schema.subcategoryTemplates.backgroundId, schema.modelBackgrounds.id))
      .where(eq(schema.subcategoryTemplates.subcategoryId, subcategoryId));
    return { items: rows };
  });

  app.post('/admin/assets/templates/presign', {
    preHandler: W,
    schema: { body: PresignSubcategoryTemplateBody },
  }, async (req) => {
    const { subcategoryId, faceId, backgroundId, contentType } = req.body as {
      subcategoryId: string; faceId: string; backgroundId: string; contentType: string;
    };
    const [sub] = await app.db.select().from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, subcategoryId));
    if (!sub) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

    const [face] = await app.db.select({ id: schema.modelFaces.id })
      .from(schema.modelFaces).where(eq(schema.modelFaces.id, faceId));
    if (!face) throw new AppError('NOT_FOUND', 404, 'face not found');

    const [bg] = await app.db.select({ id: schema.modelBackgrounds.id })
      .from(schema.modelBackgrounds).where(eq(schema.modelBackgrounds.id, backgroundId));
    if (!bg) throw new AppError('NOT_FOUND', 404, 'background not found');

    const newId = randomUUID();
    const r2Key = keys.subcategoryTemplate(newId);
    const thumbKey = keys.subcategoryTemplateThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/assets/templates/confirm', {
    preHandler: W,
    schema: { body: ConfirmSubcategoryTemplateBody },
  }, async (req) => {
    const { subcategoryId, faceId, backgroundId, r2Key, thumbnailKey, sortOrder } = req.body as {
      subcategoryId: string; faceId: string; backgroundId: string;
      r2Key: string; thumbnailKey: string; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.subcategoryTemplates)
      .values({ subcategoryId, faceId, backgroundId, r2Key, thumbnailKey, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/assets/templates/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchSubcategoryTemplateBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [updated] = await app.db
      .update(schema.subcategoryTemplates)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.subcategoryTemplates.id, id))
      .returning({ id: schema.subcategoryTemplates.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'template not found');
    return { ok: true };
  });

  app.delete('/admin/assets/templates/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [tmpl] = await app.db.select().from(schema.subcategoryTemplates)
      .where(eq(schema.subcategoryTemplates.id, id));
    if (!tmpl) throw new AppError('NOT_FOUND', 404, 'template not found');

    await Promise.allSettled([
      app.storage.deleteObject(tmpl.r2Key),
      app.storage.deleteObject(tmpl.thumbnailKey),
    ]);
    await app.db.delete(schema.subcategoryTemplates)
      .where(eq(schema.subcategoryTemplates.id, id));
    return { ok: true };
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts \
        apps/api/src/modules/admin/templates.routes.ts
git commit -m "feat(api): add subcategory and template admin routes"
```

---

## Task 6: Wire New Routes in server.ts

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Update imports and registration in `apps/api/src/server.ts`**

Replace the `adminModelsRoutes` import with:

```typescript
import { adminAssetsRoutes } from './modules/admin/models.routes';
import { adminSubcategoriesRoutes } from './modules/admin/subcategories.routes';
import { adminTemplatesRoutes } from './modules/admin/templates.routes';
```

Replace `await app.register(adminModelsRoutes);` with:

```typescript
  await app.register(adminAssetsRoutes);
  await app.register(adminSubcategoriesRoutes);
  await app.register(adminTemplatesRoutes);
```

- [ ] **Step 2: Build api**

```bash
pnpm --filter @tryme/api build 2>&1 | tail -20
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): register subcategory and template route modules"
```

---

## Task 7: Update Admin types.ts

**Files:**
- Modify: `apps/admin/src/types.ts`

- [ ] **Step 1: Update interfaces in `apps/admin/src/types.ts`**

Replace the `ModelFace`, `ModelBackground`, `ModelPose` interfaces and add `GarmentSubcategory`, `SubcategoryTemplate`:

```typescript
export type GenderSlug = 'men' | 'women' | 'boys' | 'girls';

export interface ModelFace {
  id: string;
  gender: GenderSlug;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  templateCount?: number;
}

// Global — no faceId
export interface ModelBackground {
  id: string;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface GarmentSubcategory {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
  templateCount?: number;
}

// Poses belong to a subcategory — no backgroundId
export interface ModelPose {
  id: string;
  subcategoryId: string;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  showsLower: boolean;
  showsShoes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubcategoryTemplate {
  id: string;
  subcategoryId: string;
  faceId: string;
  faceLabel?: string;
  backgroundId: string;
  backgroundLabel?: string;
  thumbnailKey: string;
  r2Key: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

Keep all other interfaces (`CatalogItem`, `User`, `Job`, etc.) unchanged.

- [ ] **Step 2: Commit**

```bash
git add apps/admin/src/types.ts
git commit -m "feat(admin): update types — global BG, subcategoryId poses, new subcategory/template types"
```

---

## Task 8: Create AssetsPage — Backgrounds + Faces Tabs

**Files:**
- Create: `apps/admin/src/pages/AssetsPage.tsx` (initial with Backgrounds + Faces tabs)

- [ ] **Step 1: Create `apps/admin/src/pages/AssetsPage.tsx` with Backgrounds + Faces tabs**

```typescript
import { useState, useEffect, useCallback } from 'react';
import type {
  ModelFace, ModelBackground, GarmentSubcategory, ModelPose, SubcategoryTemplate, GenderSlug,
} from '../types';
import { apiFetch } from '../lib/data';
import { Icon } from '../components/Icons';
import { Switch } from '../components/Switch';
import { UploadModal } from '../components/UploadModal';
import type { FieldDef } from '../components/UploadModal';

type AssetTab = 'backgrounds' | 'faces' | 'subcategories';
type GenderFilter = 'all' | GenderSlug;

type SubView =
  | { kind: 'list' }
  | { kind: 'subcategory'; sub: GarmentSubcategory; subTab: 'poses' | 'templates' };

type ConfirmDelete =
  | { type: 'background'; id: string; label: string }
  | { type: 'face'; id: string; label: string }
  | { type: 'subcategory'; id: string; label: string }
  | { type: 'pose'; id: string; label: string }
  | { type: 'template'; id: string; label: string };

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

const FACE_FIELDS: FieldDef[] = [
  { type: 'text', name: 'label', label: 'Label', required: true },
  {
    type: 'select', name: 'gender', label: 'Gender',
    options: [
      { value: 'men', label: 'Men' },
      { value: 'women', label: 'Women' },
      { value: 'boys', label: 'Boys' },
      { value: 'girls', label: 'Girls' },
    ],
  },
  { type: 'number', name: 'sortOrder', label: 'Sort order', min: 0, defaultValue: 0 },
];

const BG_FIELDS: FieldDef[] = [
  { type: 'text', name: 'label', label: 'Label', required: true },
  { type: 'number', name: 'sortOrder', label: 'Sort order', min: 0, defaultValue: 0 },
];

const POSE_FIELDS: FieldDef[] = [
  { type: 'text', name: 'label', label: 'Label', required: true },
  { type: 'toggle', name: 'showsLower', label: 'Shows lower garment' },
  { type: 'toggle', name: 'showsShoes', label: 'Shows shoes' },
  { type: 'number', name: 'sortOrder', label: 'Sort order', min: 0, defaultValue: 0 },
];

export default function AssetsPage({ onNav: _onNav, toast }: Props) {
  const [activeTab, setActiveTab] = useState<AssetTab>('backgrounds');
  const [genderFilter, setGenderFilter] = useState<GenderFilter>('all');
  const [subView, setSubView] = useState<SubView>({ kind: 'list' });

  const [backgrounds, setBackgrounds] = useState<ModelBackground[]>([]);
  const [faces, setFaces] = useState<ModelFace[]>([]);
  const [subcategories, setSubcategories] = useState<GarmentSubcategory[]>([]);
  const [poses, setPoses] = useState<ModelPose[]>([]);
  const [templates, setTemplates] = useState<SubcategoryTemplate[]>([]);

  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete | null>(null);

  // ── Upload target state ───────────────────────────────────────────────────
  const [showBgUpload, setShowBgUpload] = useState(false);
  const [showFaceUpload, setShowFaceUpload] = useState(false);
  const [showPoseUpload, setShowPoseUpload] = useState(false);
  const [showTmplUpload, setShowTmplUpload] = useState(false);

  // ── Data loaders ─────────────────────────────────────────────────────────

  const loadBackgrounds = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelBackground[] }>('/admin/assets/backgrounds');
      setBackgrounds(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load backgrounds' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadFaces = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelFace[] }>('/admin/assets/faces');
      setFaces(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load faces' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadSubcategories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: GarmentSubcategory[] }>('/admin/assets/subcategories');
      setSubcategories(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load subcategories' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadPoses = useCallback(async (subcategoryId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelPose[] }>(`/admin/assets/poses?subcategoryId=${subcategoryId}`);
      setPoses(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load poses' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadTemplates = useCallback(async (subcategoryId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: SubcategoryTemplate[] }>(`/admin/assets/templates?subcategoryId=${subcategoryId}`);
      setTemplates(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load templates' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (activeTab === 'backgrounds') loadBackgrounds();
    else if (activeTab === 'faces') loadFaces();
    else if (activeTab === 'subcategories') {
      if (subView.kind === 'list') loadSubcategories();
      else if (subView.kind === 'subcategory') {
        if (subView.subTab === 'poses') loadPoses(subView.sub.id);
        else loadTemplates(subView.sub.id);
      }
    }
  }, [activeTab, subView, loadBackgrounds, loadFaces, loadSubcategories, loadPoses, loadTemplates]);

  // ── Toggle handlers ───────────────────────────────────────────────────────

  const toggleBg = async (id: string) => {
    const item = backgrounds.find((b) => b.id === id);
    if (!item) return;
    const next = !item.isActive;
    setBackgrounds((prev) => prev.map((b) => b.id === id ? { ...b, isActive: next } : b));
    try {
      await apiFetch(`/admin/assets/backgrounds/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setBackgrounds((prev) => prev.map((b) => b.id === id ? { ...b, isActive: item.isActive } : b));
      toast({ kind: 'error', title: 'Failed to update background' });
    }
  };

  const toggleFace = async (id: string) => {
    const item = faces.find((f) => f.id === id);
    if (!item) return;
    const next = !item.isActive;
    setFaces((prev) => prev.map((f) => f.id === id ? { ...f, isActive: next } : f));
    try {
      await apiFetch(`/admin/assets/faces/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setFaces((prev) => prev.map((f) => f.id === id ? { ...f, isActive: item.isActive } : f));
      toast({ kind: 'error', title: 'Failed to update face' });
    }
  };

  const togglePose = async (id: string) => {
    const item = poses.find((p) => p.id === id);
    if (!item) return;
    const next = !item.isActive;
    setPoses((prev) => prev.map((p) => p.id === id ? { ...p, isActive: next } : p));
    try {
      await apiFetch(`/admin/assets/poses/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setPoses((prev) => prev.map((p) => p.id === id ? { ...p, isActive: item.isActive } : p));
      toast({ kind: 'error', title: 'Failed to update pose' });
    }
  };

  const toggleTemplate = async (id: string) => {
    const item = templates.find((t) => t.id === id);
    if (!item) return;
    const next = !item.isActive;
    setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, isActive: next } : t));
    try {
      await apiFetch(`/admin/assets/templates/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `Template ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, isActive: item.isActive } : t));
      toast({ kind: 'error', title: 'Failed to update template' });
    }
  };

  // ── Delete handler ────────────────────────────────────────────────────────

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { type, id, label } = confirmDelete;
    setConfirmDelete(null);
    const paths: Record<typeof type, string> = {
      background: `/admin/assets/backgrounds/${id}`,
      face: `/admin/assets/faces/${id}`,
      subcategory: `/admin/assets/subcategories/${id}`,
      pose: `/admin/assets/poses/${id}`,
      template: `/admin/assets/templates/${id}`,
    };
    try {
      await apiFetch(paths[type], { method: 'DELETE' });
      if (type === 'background') setBackgrounds((prev) => prev.filter((b) => b.id !== id));
      else if (type === 'face') setFaces((prev) => prev.filter((f) => f.id !== id));
      else if (type === 'subcategory') {
        setSubcategories((prev) => prev.filter((s) => s.id !== id));
        setSubView({ kind: 'list' });
      }
      else if (type === 'pose') setPoses((prev) => prev.filter((p) => p.id !== id));
      else if (type === 'template') setTemplates((prev) => prev.filter((t) => t.id !== id));
      toast({ title: `${label} deleted` });
    } catch {
      toast({ kind: 'error', title: `Failed to delete ${type}` });
    }
  };

  // ── Thumb placeholder ─────────────────────────────────────────────────────

  const thumb = (label: string, w = 64, h = 64) => (
    <div style={{
      width: w, height: h, borderRadius: 6,
      background: 'var(--subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: 'var(--muted)', fontSize: 11, fontWeight: 600,
    }}>
      {label.slice(0, 2).toUpperCase()}
    </div>
  );

  // ── Template upload fields (dynamic with face+bg selects) ─────────────────

  const tmplFields: FieldDef[] = [
    {
      type: 'select', name: 'faceId', label: 'Model face',
      options: faces.map((f) => ({ value: f.id, label: `[${f.gender}] ${f.label}` })),
    },
    {
      type: 'select', name: 'backgroundId', label: 'Background',
      options: backgrounds.map((b) => ({ value: b.id, label: b.label })),
    },
    { type: 'number', name: 'sortOrder', label: 'Sort order', min: 0, defaultValue: 0 },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  const TABS: { k: AssetTab; l: string }[] = [
    { k: 'backgrounds', l: 'Backgrounds' },
    { k: 'faces', l: 'Model Faces' },
    { k: 'subcategories', l: 'Subcategories' },
  ];

  const GENDER_TABS: { k: GenderFilter; l: string }[] = [
    { k: 'all', l: 'All' },
    { k: 'men', l: 'Men' },
    { k: 'women', l: 'Women' },
    { k: 'boys', l: 'Boys' },
    { k: 'girls', l: 'Girls' },
  ];

  const filteredFaces = faces.filter((f) => genderFilter === 'all' || f.gender === genderFilter);

  return (
    <>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          {subView.kind === 'subcategory' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 13, color: 'var(--muted)' }}>
              <button className="btn sm ghost" onClick={() => setSubView({ kind: 'list' })} style={{ padding: '2px 8px', fontSize: 13 }}>
                Subcategories
              </button>
              <Icon.Chevron />
              <span>{subView.sub.label}</span>
            </div>
          )}
          <h1>
            {activeTab === 'backgrounds' ? 'Backgrounds'
              : activeTab === 'faces' ? 'Model Faces'
              : subView.kind === 'subcategory' ? subView.sub.label
              : 'Subcategories'}
          </h1>
          <p className="lede">
            {activeTab === 'backgrounds' && 'Global backgrounds sent to ComfyUI for all garment types.'}
            {activeTab === 'faces' && 'Model face images — select gender to filter.'}
            {activeTab === 'subcategories' && subView.kind === 'list' && 'Garment subcategories. Click to manage poses and templates.'}
            {activeTab === 'subcategories' && subView.kind === 'subcategory' && `Poses and templates for ${subView.sub.genderSlug} / ${subView.sub.slug}.`}
          </p>
        </div>
        <div className="head-tools">
          {activeTab === 'backgrounds' && (
            <button className="btn" onClick={() => setShowBgUpload(true)}><Icon.Add /> Add background</button>
          )}
          {activeTab === 'faces' && (
            <button className="btn" onClick={() => setShowFaceUpload(true)}><Icon.Add /> Add face</button>
          )}
          {activeTab === 'subcategories' && subView.kind === 'list' && (
            <button className="btn" onClick={() => {
              const slug = prompt('Subcategory slug (e.g. fullsleeveshirt):');
              const label = prompt('Label (e.g. Full Sleeve Shirt):');
              const genderSlug = prompt('Gender (men/women/boys/girls):');
              if (!slug || !label || !genderSlug) return;
              apiFetch('/admin/assets/subcategories', {
                method: 'POST',
                body: JSON.stringify({ slug, label, genderSlug }),
              }).then((row) => {
                setSubcategories((prev) => [...prev, row as GarmentSubcategory]);
                toast({ title: `${label} created` });
              }).catch(() => toast({ kind: 'error', title: 'Failed to create subcategory' }));
            }}><Icon.Add /> Add subcategory</button>
          )}
          {activeTab === 'subcategories' && subView.kind === 'subcategory' && subView.subTab === 'poses' && (
            <button className="btn" onClick={() => setShowPoseUpload(true)}><Icon.Add /> Add pose</button>
          )}
          {activeTab === 'subcategories' && subView.kind === 'subcategory' && subView.subTab === 'templates' && (
            <button className="btn" onClick={() => setShowTmplUpload(true)}><Icon.Add /> Add template</button>
          )}
        </div>
      </div>

      {/* ── Asset tabs ───────────────────────────────────────────────────── */}
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.k} className={`tab ${activeTab === t.k ? 'active' : ''}`}
            onClick={() => { setActiveTab(t.k); setSubView({ kind: 'list' }); }}>
            {t.l}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
      )}

      {/* ── Backgrounds tab ──────────────────────────────────────────────── */}
      {!loading && activeTab === 'backgrounds' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
          {backgrounds.map((bg) => (
            <div key={bg.id} className="card" style={{ opacity: bg.isActive ? 1 : 0.6, padding: 14 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {thumb(bg.label, 64, 48)}
                <div style={{ marginTop: 4 }}>
                  <span className="semi">{bg.label}</span>
                  <span className="sub mono" style={{ display: 'block', marginTop: 2 }}>{bg.id.slice(0, 8)}…</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={bg.isActive} onChange={() => toggleBg(bg.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'background', id: bg.id, label: bg.label })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {backgrounds.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No backgrounds yet.</div>
          )}
        </div>
      )}

      {/* ── Faces tab ────────────────────────────────────────────────────── */}
      {!loading && activeTab === 'faces' && (
        <>
          <div className="tabs" style={{ marginTop: -8 }}>
            {GENDER_TABS.map((t) => (
              <button key={t.k} className={`tab ${genderFilter === t.k ? 'active' : ''}`}
                onClick={() => setGenderFilter(t.k)}>
                {t.l}
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginTop: 14 }}>
            {filteredFaces.map((face) => (
              <div key={face.id} className="card" style={{ opacity: face.isActive ? 1 : 0.6, padding: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {thumb(face.label, 48, 64)}
                  <div style={{ marginTop: 4 }}>
                    <span className="semi">{face.label}</span>
                    <div style={{ marginTop: 4 }}><span className="badge dot accent">{face.gender}</span></div>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                      {face.templateCount ?? 0} template{face.templateCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <Switch checked={face.isActive} onChange={() => toggleFace(face.id)} />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'face', id: face.id, label: face.label })}><Icon.Trash /></button>
                  </div>
                </div>
              </div>
            ))}
            {filteredFaces.length === 0 && (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No faces found.</div>
            )}
          </div>
        </>
      )}

      {/* ── Subcategories tab — list view ────────────────────────────────── */}
      {!loading && activeTab === 'subcategories' && subView.kind === 'list' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subcategory</th>
                <th>Gender</th>
                <th>Poses</th>
                <th>Templates</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {subcategories.map((sub) => (
                <tr key={sub.id} style={{ cursor: 'pointer' }}
                  onClick={() => setSubView({ kind: 'subcategory', sub, subTab: 'poses' })}>
                  <td>
                    <div>
                      <span className="semi">{sub.label}</span>
                      <span className="sub mono" style={{ display: 'block' }}>{sub.slug}</span>
                    </div>
                  </td>
                  <td><span className="badge dot accent">{sub.genderSlug}</span></td>
                  <td><span className="mono">{sub.poseCount ?? 0}</span></td>
                  <td><span className="mono">{sub.templateCount ?? 0} / 16</span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Switch checked={sub.isActive} onChange={async () => {
                      const next = !sub.isActive;
                      setSubcategories((prev) => prev.map((s) => s.id === sub.id ? { ...s, isActive: next } : s));
                      try {
                        await apiFetch(`/admin/assets/subcategories/${sub.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
                        toast({ title: `${sub.label} ${sub.isActive ? 'deactivated' : 'activated'}` });
                      } catch {
                        setSubcategories((prev) => prev.map((s) => s.id === sub.id ? { ...s, isActive: sub.isActive } : s));
                        toast({ kind: 'error', title: 'Failed to update subcategory' });
                      }
                    }} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'subcategory', id: sub.id, label: sub.label })}><Icon.Trash /></button>
                  </td>
                </tr>
              ))}
              {subcategories.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No subcategories yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Subcategory detail — poses + templates sub-tabs ─────────────── */}
      {!loading && activeTab === 'subcategories' && subView.kind === 'subcategory' && (
        <>
          <div className="tabs" style={{ marginTop: -8 }}>
            {(['poses', 'templates'] as const).map((t) => (
              <button key={t} className={`tab ${subView.subTab === t ? 'active' : ''}`}
                onClick={() => setSubView({ ...subView, subTab: t })}>
                {t === 'poses' ? 'Poses' : 'Templates'}
              </button>
            ))}
          </div>

          {/* Poses grid */}
          {subView.subTab === 'poses' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14, marginTop: 14 }}>
              {poses.map((pose) => (
                <div key={pose.id} className="card" style={{ opacity: pose.isActive ? 1 : 0.6, padding: 14 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    {thumb(pose.label, 48, 64)}
                    <div style={{ marginTop: 4 }}>
                      <span className="semi">{pose.label}</span>
                      <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {pose.showsLower && <span className="badge dot accent">Lower</span>}
                        {pose.showsShoes && <span className="badge dot warn">Shoes</span>}
                        {!pose.showsLower && !pose.showsShoes && <span className="badge dot">Upper</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <Switch checked={pose.isActive} onChange={() => togglePose(pose.id)} />
                    <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'pose', id: pose.id, label: pose.label })}><Icon.Trash /></button>
                  </div>
                </div>
              ))}
              {poses.length === 0 && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No poses yet. Add the first pose.</div>
              )}
            </div>
          )}

          {/* Templates grid */}
          {subView.subTab === 'templates' && (
            <>
              <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, marginBottom: 14 }}>
                {templates.length} / 16 templates uploaded (4 model faces × 4 backgrounds).
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                {templates.map((tmpl) => (
                  <div key={tmpl.id} className="card" style={{ opacity: tmpl.isActive ? 1 : 0.6, padding: 14 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      {thumb(tmpl.faceLabel ?? '??', 48, 64)}
                      <div style={{ marginTop: 4 }}>
                        <span className="semi" style={{ fontSize: 12 }}>{tmpl.faceLabel}</span>
                        <span className="sub mono" style={{ display: 'block', marginTop: 2, fontSize: 11 }}>× {tmpl.backgroundLabel}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <Switch checked={tmpl.isActive} onChange={() => toggleTemplate(tmpl.id)} />
                      <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'template', id: tmpl.id, label: `${tmpl.faceLabel} × ${tmpl.backgroundLabel}` })}><Icon.Trash /></button>
                    </div>
                  </div>
                ))}
                {templates.length === 0 && (
                  <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No templates yet.</div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ── Delete confirm modal ─────────────────────────────────────────── */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>Delete {confirmDelete.type}</h3></div>
            <div className="modal-body">
              <p>Delete <strong>{confirmDelete.label}</strong>? This cannot be undone.</p>
              {confirmDelete.type === 'subcategory' && (
                <p style={{ color: 'var(--danger)', marginTop: 8 }}>All related poses and templates will also be deleted.</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload modals ────────────────────────────────────────────────── */}
      {showBgUpload && (
        <UploadModal
          title="Add background"
          presignPath="/admin/assets/backgrounds/presign"
          confirmPath="/admin/assets/backgrounds/confirm"
          fields={BG_FIELDS}
          onDone={(row) => { setShowBgUpload(false); setBackgrounds((prev) => [...prev, row as ModelBackground]); }}
          onClose={() => setShowBgUpload(false)}
          toast={toast}
        />
      )}
      {showFaceUpload && (
        <UploadModal
          title="Add model face"
          presignPath="/admin/assets/faces/presign"
          confirmPath="/admin/assets/faces/confirm"
          fields={FACE_FIELDS}
          onDone={(row) => { setShowFaceUpload(false); setFaces((prev) => [...prev, row as ModelFace]); }}
          onClose={() => setShowFaceUpload(false)}
          toast={toast}
        />
      )}
      {showPoseUpload && subView.kind === 'subcategory' && (
        <UploadModal
          title="Add pose"
          presignPath="/admin/assets/poses/presign"
          presignExtra={{ subcategoryId: subView.sub.id }}
          confirmPath="/admin/assets/poses/confirm"
          confirmExtra={{ subcategoryId: subView.sub.id }}
          fields={POSE_FIELDS}
          onDone={(row) => { setShowPoseUpload(false); setPoses((prev) => [...prev, row as ModelPose]); }}
          onClose={() => setShowPoseUpload(false)}
          toast={toast}
        />
      )}
      {showTmplUpload && subView.kind === 'subcategory' && (
        <UploadModal
          title="Add template"
          presignPath="/admin/assets/templates/presign"
          presignExtra={{ subcategoryId: subView.sub.id }}
          confirmPath="/admin/assets/templates/confirm"
          confirmExtra={{ subcategoryId: subView.sub.id }}
          fields={tmplFields}
          onDone={(row) => { setShowTmplUpload(false); setTemplates((prev) => [...prev, row as SubcategoryTemplate]); }}
          onClose={() => setShowTmplUpload(false)}
          toast={toast}
        />
      )}
    </>
  );
}

- [ ] **Step 2: Commit**

```bash
git add apps/admin/src/pages/AssetsPage.tsx
git commit -m "feat(admin): add AssetsPage with Backgrounds, Faces, Subcategories/Poses/Templates tabs"
```

---

## Task 9: Wire AssetsPage into App + Sidebar

**Files:**
- Modify: `apps/admin/src/App.tsx`
- Modify: `apps/admin/src/components/Sidebar.tsx`
- Delete: `apps/admin/src/pages/ModelsPage.tsx`

- [ ] **Step 1: Update `apps/admin/src/App.tsx`**

Replace:
```typescript
import ModelsPage from './pages/ModelsPage';
```
With:
```typescript
import AssetsPage from './pages/AssetsPage';
```

Replace `type Page`:
```typescript
type Page = 'dashboard' | 'assets' | 'catalog' | 'users' | 'jobs' | 'settings';
```

Replace `PAGE_LABELS`:
```typescript
const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'Dashboard',
  assets: 'Assets',
  catalog: 'Catalog',
  users: 'Users',
  jobs: 'Jobs',
  settings: 'Settings',
};
```

Replace `{page === 'models' && <ModelsPage {...pageProps} />}` with:
```typescript
          {page === 'assets' && <AssetsPage {...pageProps} />}
```

- [ ] **Step 2: Update `apps/admin/src/components/Sidebar.tsx`**

Replace the `items` array entry for models:
```typescript
{ k: 'models', label: 'Models', icon: Icon.Image, roles: ['SUPER_ADMIN', 'MODERATOR'] },
```
With:
```typescript
{ k: 'assets', label: 'Assets', icon: Icon.Image, roles: ['SUPER_ADMIN', 'MODERATOR'] },
```

- [ ] **Step 3: Delete ModelsPage.tsx**

```bash
rm apps/admin/src/pages/ModelsPage.tsx
```

- [ ] **Step 4: Build admin to verify no TypeScript errors**

```bash
pnpm --filter @tryme/admin build 2>&1 | tail -20
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/App.tsx apps/admin/src/components/Sidebar.tsx
git rm apps/admin/src/pages/ModelsPage.tsx
git commit -m "feat(admin): replace ModelsPage with AssetsPage; update Sidebar nav"
```

---

## Task 10: End-to-End Manual Verification

- [ ] **Step 1: Start dev stack**

```bash
pnpm docker:up
pnpm db:migrate
pnpm dev
```

- [ ] **Step 2: Verify Backgrounds tab**

1. Open admin → Assets → Backgrounds
2. Click "Add background" → upload a test image → confirm
3. Verify card appears in grid
4. Toggle active → verify switch state persists on reload
5. Delete background → verify removal

- [ ] **Step 3: Verify Model Faces tab**

1. Open Assets → Model Faces
2. Add a face (gender = men) → confirm
3. Filter by Men → face visible; filter by Women → not visible
4. Delete face → verify removal

- [ ] **Step 4: Verify Subcategories + Poses**

1. Open Assets → Subcategories → Add subcategory (slug=fullsleeveshirt, label=Full Sleeve Shirt, gender=men)
2. Click the subcategory row → opens detail view
3. Poses sub-tab → Add pose → verify pose card appears
4. Toggle pose active

- [ ] **Step 5: Verify Templates**

1. In subcategory detail → Templates sub-tab
2. Click "Add template" → select a face and background from dropdowns → upload image
3. Verify template card shows face label × background label
4. Toggle active

- [ ] **Step 6: Verify delete cascade**

1. Delete a subcategory that has poses and templates
2. Verify the subcategory, its poses, and its templates are all removed

- [ ] **Step 7: Commit progress doc update**

Update `docs/progress.md` with what was completed:

```markdown
## 2026-05-21 — Asset Schema Redesign

**Done:**
- DB schema redesign: global backgrounds, garment_subcategories, subcategory_templates
- Migration 0002 applied
- Storage keys for templates
- Types package updated (BG global, poses per-subcategory)
- API routes migrated to /admin/assets/* prefix
- New subcategory and template CRUD routes
- AssetsPage with 3-tab UI (Backgrounds | Model Faces | Subcategories)
- Subcategory detail: Poses + Templates sub-tabs
- ModelsPage removed

**Failed / Not Done:**
- (fill in any skipped items)

**Open Questions / Decisions:**
- Template upload modal: verify UploadModal correctly threads faceId/backgroundId from select fields into presignExtra
- Seed script for 4×4 template matrix not yet written
```

---

## Self-Review

**Spec coverage:**
- ✓ Global backgrounds (no faceId) — Tasks 1, 3, 4
- ✓ Garment subcategories table — Tasks 1, 2, 5
- ✓ Poses per-subcategory — Tasks 1, 2, 4
- ✓ Subcategory templates (16 per subcategory) — Tasks 1, 2, 5
- ✓ Storage keys for templates — Task 3
- ✓ Admin types update — Task 7
- ✓ AssetsPage 3 tabs — Task 8
- ✓ Sidebar + App wiring — Task 9

**Gaps / Risks:**
- Template upload modal uses `faceId`/`backgroundId` as `select` fields in the form. Verify `UploadModal` merges select field values into the presign/confirm body (not just `presignExtra`). If it only uses `presignExtra`, the template presign call needs a wrapper that reads the selected values. Review `UploadModal.tsx` before executing Task 8.
- `subcategoryTemplates` schema is not yet exported from `packages/db/src/schema/index.ts` — the `export * from './models'` covers it since it's defined in `models.ts`, so this is fine.
- `job_inputs.background_id` FK references `model_backgrounds.id` — still valid after removing `face_id` from that table. No job_inputs change needed.
