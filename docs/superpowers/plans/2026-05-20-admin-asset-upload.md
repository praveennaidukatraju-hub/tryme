# Admin Asset Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the admin panel to upload and manage model assets (faces, backgrounds, poses) and catalog items (lower garments, shoes) via a presign → R2 PUT → confirm flow.

**Architecture:** Admin requests a presigned R2 PUT URL from the API, uploads the image directly from the browser to R2 (same pattern as user garment uploads), then POSTs metadata to a confirm endpoint which writes the DB row. Model assets follow a face → background → pose hierarchy; cascade delete cleans up R2 and child rows. Catalog items link to `catalogCategories`; the upload modal fetches available categories filtered by type.

**Tech Stack:** Node.js 22 · TypeScript 5.6 · Fastify 5 · Drizzle ORM · @aws-sdk/client-s3 / s3-request-presigner · React 18 · Vite

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/storage/src/keys.ts` | Modify | Add `modelFace`, `modelFaceThumb`, `modelBackground`, `modelBackgroundThumb`, `modelPose`, `modelPoseThumb` key helpers |
| `packages/storage/test/keys.test.ts` | Modify | Tests for new key helpers |
| `packages/types/src/admin.ts` | Modify | Presign/confirm/patch Zod schemas for model faces, backgrounds, poses |
| `apps/api/src/modules/admin/models.routes.ts` | Create | Full CRUD (GET, presign, confirm, PATCH, DELETE) for faces/backgrounds/poses |
| `apps/api/src/modules/admin/catalog.routes.ts` | Modify | Enrich `GET /admin/catalog/items` with `type` field; add `GET /admin/catalog/categories` |
| `apps/api/src/server.ts` | Modify | Register `adminModelsRoutes` |
| `apps/admin/src/components/UploadModal.tsx` | Create | Reusable two-phase upload modal (presign → R2 → confirm) |
| `apps/admin/src/pages/ModelsPage.tsx` | Modify | Replace mock data with real API; wire upload modal and PATCH/DELETE |
| `apps/admin/src/pages/CatalogPage.tsx` | Modify | Replace mock data with real API; wire upload modal and PATCH/DELETE |

---

## Task 1: Storage key helpers for model assets

**Files:**
- Modify: `packages/storage/src/keys.ts`
- Modify: `packages/storage/test/keys.test.ts`

- [ ] **Step 1: Write failing tests for new key helpers**

Open `packages/storage/test/keys.test.ts` and add these six tests after the existing four:

```typescript
it('builds model face key', () => {
  expect(keys.modelFace('uuid-1')).toBe('models/faces/uuid-1.jpg');
});
it('builds model face thumb key', () => {
  expect(keys.modelFaceThumb('uuid-1')).toBe('models/faces/uuid-1.thumb.jpg');
});
it('builds model background key', () => {
  expect(keys.modelBackground('uuid-1')).toBe('models/backgrounds/uuid-1.jpg');
});
it('builds model background thumb key', () => {
  expect(keys.modelBackgroundThumb('uuid-1')).toBe('models/backgrounds/uuid-1.thumb.jpg');
});
it('builds model pose key', () => {
  expect(keys.modelPose('uuid-1')).toBe('models/poses/uuid-1.jpg');
});
it('builds model pose thumb key', () => {
  expect(keys.modelPoseThumb('uuid-1')).toBe('models/poses/uuid-1.thumb.jpg');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @tryme/storage test
```

Expected: 4 passing, 6 failing with `TypeError: keys.modelFace is not a function` (or similar).

- [ ] **Step 3: Implement the six key helpers**

Replace the entire contents of `packages/storage/src/keys.ts` with:

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
};
```

- [ ] **Step 4: Run tests to verify all pass**

```bash
pnpm --filter @tryme/storage test
```

Expected: 10/10 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/keys.ts packages/storage/test/keys.test.ts
git commit -m "feat(storage): add model asset R2 key helpers"
```

---

## Task 2: Zod schemas for admin model asset routes

**Files:**
- Modify: `packages/types/src/admin.ts`

- [ ] **Step 1: Add model asset schemas**

Open `packages/types/src/admin.ts`. After the last export (`SystemConfigBody`), append:

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

export const PresignModelBackgroundBody = z.object({
  faceId: z.string().uuid(),
  contentType: AssetContentType,
});
export const ConfirmModelBackgroundBody = z.object({
  faceId: z.string().uuid(),
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

export const PresignModelPoseBody = z.object({
  backgroundId: z.string().uuid(),
  contentType: AssetContentType,
});
export const ConfirmModelPoseBody = z.object({
  backgroundId: z.string().uuid(),
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
```

- [ ] **Step 2: Verify types package builds with zero errors**

```bash
pnpm --filter @tryme/types build
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/admin.ts
git commit -m "feat(types): add admin model asset request schemas"
```

---

## Task 3: API routes for model asset CRUD

**Files:**
- Create: `apps/api/src/modules/admin/models.routes.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Create `models.routes.ts`**

Create `apps/api/src/modules/admin/models.routes.ts` with the full contents below. There is no test framework for the API — verification is a TypeScript build check.

```typescript
import type { FastifyInstance } from 'fastify';
import { schema } from '@tryme/db';
import { eq, count } from 'drizzle-orm';
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

export async function adminModelsRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  // ── Faces ─────────────────────────────────────────────────────────────────

  app.get('/admin/models/faces', { preHandler: W }, async () => {
    const rows = await app.db.select().from(schema.modelFaces);
    const bgCounts = await app.db
      .select({ faceId: schema.modelBackgrounds.faceId, cnt: count() })
      .from(schema.modelBackgrounds)
      .groupBy(schema.modelBackgrounds.faceId);
    const countMap = Object.fromEntries(bgCounts.map((r) => [r.faceId, Number(r.cnt)]));
    return {
      items: rows.map((r) => ({ ...r, backgroundCount: countMap[r.id] ?? 0 })),
    };
  });

  app.post('/admin/models/faces/presign', {
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

  app.post('/admin/models/faces/confirm', {
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

  app.patch('/admin/models/faces/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelFaceBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await app.db
      .update(schema.modelFaces)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelFaces.id, id));
    return { ok: true };
  });

  app.delete('/admin/models/faces/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [face] = await app.db.select().from(schema.modelFaces).where(eq(schema.modelFaces.id, id));
    if (!face) throw new AppError('NOT_FOUND', 404, 'face not found');

    const bgs = await app.db.select().from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.faceId, id));

    for (const bg of bgs) {
      const poses = await app.db.select().from(schema.modelPoses)
        .where(eq(schema.modelPoses.backgroundId, bg.id));
      for (const pose of poses) {
        await app.storage.deleteObject(pose.r2Key);
        await app.storage.deleteObject(pose.thumbnailKey);
      }
      await app.db.delete(schema.modelPoses).where(eq(schema.modelPoses.backgroundId, bg.id));
      await app.storage.deleteObject(bg.r2Key);
      await app.storage.deleteObject(bg.thumbnailKey);
    }
    await app.db.delete(schema.modelBackgrounds).where(eq(schema.modelBackgrounds.faceId, id));
    await app.storage.deleteObject(face.r2Key);
    await app.storage.deleteObject(face.thumbnailKey);
    await app.db.delete(schema.modelFaces).where(eq(schema.modelFaces.id, id));
    return { ok: true };
  });

  // ── Backgrounds ───────────────────────────────────────────────────────────

  app.get('/admin/models/backgrounds', {
    preHandler: W,
    schema: { querystring: z.object({ faceId: z.string().uuid() }) },
  }, async (req) => {
    const { faceId } = req.query as { faceId: string };
    const rows = await app.db.select().from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.faceId, faceId));
    const poseCounts = await app.db
      .select({ backgroundId: schema.modelPoses.backgroundId, cnt: count() })
      .from(schema.modelPoses)
      .groupBy(schema.modelPoses.backgroundId);
    const countMap = Object.fromEntries(poseCounts.map((r) => [r.backgroundId, Number(r.cnt)]));
    return {
      items: rows.map((r) => ({ ...r, poseCount: countMap[r.id] ?? 0 })),
    };
  });

  app.post('/admin/models/backgrounds/presign', {
    preHandler: W,
    schema: { body: PresignModelBackgroundBody },
  }, async (req) => {
    const { faceId, contentType } = req.body as { faceId: string; contentType: string };
    const [face] = await app.db.select().from(schema.modelFaces).where(eq(schema.modelFaces.id, faceId));
    if (!face) throw new AppError('NOT_FOUND', 404, 'face not found');
    const newId = randomUUID();
    const r2Key = keys.modelBackground(newId);
    const thumbKey = keys.modelBackgroundThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/models/backgrounds/confirm', {
    preHandler: W,
    schema: { body: ConfirmModelBackgroundBody },
  }, async (req) => {
    const { faceId, label, r2Key, thumbnailKey, sortOrder } = req.body as {
      faceId: string; label: string; r2Key: string; thumbnailKey: string; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ faceId, label, r2Key, thumbnailKey, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/models/backgrounds/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelBackgroundBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await app.db
      .update(schema.modelBackgrounds)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelBackgrounds.id, id));
    return { ok: true };
  });

  app.delete('/admin/models/backgrounds/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [bg] = await app.db.select().from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, id));
    if (!bg) throw new AppError('NOT_FOUND', 404, 'background not found');

    const poses = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.backgroundId, id));
    for (const pose of poses) {
      await app.storage.deleteObject(pose.r2Key);
      await app.storage.deleteObject(pose.thumbnailKey);
    }
    await app.db.delete(schema.modelPoses).where(eq(schema.modelPoses.backgroundId, id));
    await app.storage.deleteObject(bg.r2Key);
    await app.storage.deleteObject(bg.thumbnailKey);
    await app.db.delete(schema.modelBackgrounds).where(eq(schema.modelBackgrounds.id, id));
    return { ok: true };
  });

  // ── Poses ─────────────────────────────────────────────────────────────────

  app.get('/admin/models/poses', {
    preHandler: W,
    schema: { querystring: z.object({ backgroundId: z.string().uuid() }) },
  }, async (req) => {
    const { backgroundId } = req.query as { backgroundId: string };
    const rows = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.backgroundId, backgroundId));
    return { items: rows };
  });

  app.post('/admin/models/poses/presign', {
    preHandler: W,
    schema: { body: PresignModelPoseBody },
  }, async (req) => {
    const { backgroundId, contentType } = req.body as { backgroundId: string; contentType: string };
    const [bg] = await app.db.select().from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, backgroundId));
    if (!bg) throw new AppError('NOT_FOUND', 404, 'background not found');
    const newId = randomUUID();
    const r2Key = keys.modelPose(newId);
    const thumbKey = keys.modelPoseThumb(newId);
    const [main, thumb] = await Promise.all([
      app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
      app.storage.presignPut(thumbKey, contentType, 1_000_000, 300),
    ]);
    return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
  });

  app.post('/admin/models/poses/confirm', {
    preHandler: W,
    schema: { body: ConfirmModelPoseBody },
  }, async (req) => {
    const { backgroundId, label, r2Key, thumbnailKey, showsLower, showsShoes, sortOrder } = req.body as {
      backgroundId: string; label: string; r2Key: string; thumbnailKey: string;
      showsLower: boolean; showsShoes: boolean; sortOrder: number;
    };
    const [row] = await app.db
      .insert(schema.modelPoses)
      .values({ backgroundId, label, r2Key, thumbnailKey, showsLower, showsShoes, sortOrder })
      .returning();
    return row;
  });

  app.patch('/admin/models/poses/:id', {
    preHandler: W,
    schema: { params: uuidParam, body: PatchModelPoseBody },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await app.db
      .update(schema.modelPoses)
      .set({ ...(req.body as object), updatedAt: new Date() })
      .where(eq(schema.modelPoses.id, id));
    return { ok: true };
  });

  app.delete('/admin/models/poses/:id', {
    preHandler: W,
    schema: { params: uuidParam },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [pose] = await app.db.select().from(schema.modelPoses)
      .where(eq(schema.modelPoses.id, id));
    if (!pose) throw new AppError('NOT_FOUND', 404, 'pose not found');
    await app.storage.deleteObject(pose.r2Key);
    await app.storage.deleteObject(pose.thumbnailKey);
    await app.db.delete(schema.modelPoses).where(eq(schema.modelPoses.id, id));
    return { ok: true };
  });
}
```

- [ ] **Step 2: Register routes in `apps/api/src/server.ts`**

Add the import after the last admin import line (line 25, after `adminMeRoutes`):

```typescript
import { adminModelsRoutes } from './modules/admin/models.routes';
```

Add the registration after `await app.register(adminMeRoutes);` (line 67):

```typescript
await app.register(adminModelsRoutes);
```

- [ ] **Step 3: Verify API builds with zero TypeScript errors**

```bash
pnpm --filter @tryme/api build
```

Expected: build succeeds, zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts apps/api/src/server.ts
git commit -m "feat(api): admin CRUD routes for model faces, backgrounds, poses"
```

---

## Task 4: Enrich catalog API for admin panel

The admin frontend needs `type: 'lower' | 'shoe'` on each catalog item, and needs to list categories when uploading a new item. The existing `GET /admin/catalog/items` returns raw rows without the type; add a join. Also add `GET /admin/catalog/categories` for the upload modal.

**Files:**
- Modify: `apps/api/src/modules/admin/catalog.routes.ts`

- [ ] **Step 1: Update `GET /admin/catalog/items` to include `type`**

The endpoint currently is:
```typescript
app.get('/admin/catalog/items', { preHandler: W }, async () =>
  app.db.select().from(schema.catalogItems));
```

Replace it with:

```typescript
app.get('/admin/catalog/items', { preHandler: W }, async () => {
  const rows = await app.db
    .select({
      id: schema.catalogItems.id,
      categoryId: schema.catalogItems.categoryId,
      label: schema.catalogItems.label,
      r2Key: schema.catalogItems.r2Key,
      thumbnailKey: schema.catalogItems.thumbnailKey,
      isActive: schema.catalogItems.isActive,
      sortOrder: schema.catalogItems.sortOrder,
      createdAt: schema.catalogItems.createdAt,
      updatedAt: schema.catalogItems.updatedAt,
      typeSlug: schema.catalogTypes.slug,
    })
    .from(schema.catalogItems)
    .innerJoin(schema.catalogCategories, eq(schema.catalogItems.categoryId, schema.catalogCategories.id))
    .innerJoin(schema.catalogTypes, eq(schema.catalogCategories.typeId, schema.catalogTypes.id));
  return rows.map((r) => ({ ...r, type: r.typeSlug }));
});
```

Add the missing import — `eq` is already imported. Add `innerJoin` to the drizzle imports at the top of the file. The existing import line is:
```typescript
import { eq, and, count } from 'drizzle-orm';
```
Change it to:
```typescript
import { eq, and, count, inArray } from 'drizzle-orm';
```

Actually `innerJoin` is a Drizzle ORM query builder method called on the query chain, not a standalone import. No import change needed for joins.

- [ ] **Step 2: Add `GET /admin/catalog/categories` endpoint**

Add this route inside `adminCatalogRoutes`, after the existing `app.get('/admin/catalog/items', ...)` block:

```typescript
app.get('/admin/catalog/categories', { preHandler: W }, async () => {
  const rows = await app.db
    .select({
      id: schema.catalogCategories.id,
      typeId: schema.catalogCategories.typeId,
      parentId: schema.catalogCategories.parentId,
      slug: schema.catalogCategories.slug,
      label: schema.catalogCategories.label,
      sortOrder: schema.catalogCategories.sortOrder,
      isActive: schema.catalogCategories.isActive,
      typeSlug: schema.catalogTypes.slug,
    })
    .from(schema.catalogCategories)
    .innerJoin(schema.catalogTypes, eq(schema.catalogCategories.typeId, schema.catalogTypes.id))
    .orderBy(schema.catalogCategories.sortOrder);
  return rows;
});
```

- [ ] **Step 3: Verify API builds with zero TypeScript errors**

```bash
pnpm --filter @tryme/api build
```

Expected: build succeeds, zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/catalog.routes.ts
git commit -m "feat(api): enrich catalog items with type; add GET /admin/catalog/categories"
```

---

## Task 5: UploadModal component

This modal handles the full two-phase upload: admin fills in metadata fields + picks an image file → clicks Upload → modal calls presign API → PUT to R2 (×2: main + thumbnail, same file) → calls confirm API → calls `onDone`.

**Files:**
- Create: `apps/admin/src/components/UploadModal.tsx`

- [ ] **Step 1: Create `UploadModal.tsx`**

Create `apps/admin/src/components/UploadModal.tsx` with the full contents below:

```typescript
import { useState } from 'react';
import { Icon } from './Icons';
import { Switch } from './Switch';
import { apiFetch } from '../lib/data';

export type FieldDef =
  | { type: 'text'; name: string; label: string; required?: boolean }
  | { type: 'select'; name: string; label: string; options: { value: string; label: string }[] }
  | { type: 'number'; name: string; label: string; min?: number; defaultValue?: number }
  | { type: 'toggle'; name: string; label: string };

interface PresignResult {
  uploadUrl: string;
  r2Key: string;
  thumbnailUploadUrl: string;
  thumbnailKey: string;
}

interface UploadModalProps {
  title: string;
  presignPath: string;
  presignExtra?: Record<string, unknown>;
  confirmPath: string;
  confirmExtra?: Record<string, unknown>;
  fields: FieldDef[];
  onDone: (row: unknown) => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

function uploadWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`R2 upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Network error during R2 upload'));
    xhr.send(file);
  });
}

export function UploadModal({
  title,
  presignPath,
  presignExtra,
  confirmPath,
  confirmExtra,
  fields,
  onDone,
  onClose,
  toast,
}: UploadModalProps) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const init: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      if (f.type === 'toggle') init[f.name] = false;
      else if (f.type === 'number') init[f.name] = f.defaultValue ?? 0;
      else if (f.type === 'select') init[f.name] = f.options[0]?.value ?? '';
      else init[f.name] = '';
    }
    return init;
  });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'confirming'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const busy = status !== 'idle';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const handleSubmit = async () => {
    if (!file) { setError('Select an image file'); return; }
    for (const f of fields) {
      if (f.type === 'text' && f.required && !(values[f.name] as string).trim()) {
        setError(`${f.label} is required`);
        return;
      }
    }
    setError(null);
    setStatus('uploading');
    setProgress(0);
    try {
      const presignRes = await apiFetch<PresignResult>(presignPath, {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type, ...presignExtra }),
      });
      await uploadWithProgress(presignRes.uploadUrl, file, (p) => setProgress(Math.round(p * 65)));
      await uploadWithProgress(presignRes.thumbnailUploadUrl, file, (p) => setProgress(65 + Math.round(p * 25)));
      setStatus('confirming');
      setProgress(92);
      const confirmBody: Record<string, unknown> = {
        ...values,
        ...confirmExtra,
        r2Key: presignRes.r2Key,
        thumbnailKey: presignRes.thumbnailKey,
      };
      const row = await apiFetch(confirmPath, {
        method: 'POST',
        body: JSON.stringify(confirmBody),
      });
      setProgress(100);
      toast({ title: `${title} added` });
      onDone(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setStatus('idle');
      setProgress(0);
    }
  };

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, calc(100vw - 80px))' }}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn sm ghost" onClick={onClose} disabled={busy} style={{ marginLeft: 'auto' }}>
            <Icon.Close />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div style={{
              color: 'var(--danger)', fontSize: 13,
              padding: '8px 12px', borderRadius: 6,
              background: 'var(--danger-soft)', border: '1px solid var(--danger-border)',
            }}>
              {error}
            </div>
          )}

          {/* File picker */}
          <div className="field">
            <label>Image</label>
            {preview && (
              <img
                src={preview}
                alt="preview"
                style={{
                  width: 72, height: 96, objectFit: 'cover',
                  borderRadius: 6, border: '1px solid var(--border)', marginBottom: 8,
                  display: 'block',
                }}
              />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={handleFileChange}
              style={{ fontSize: 13 }}
            />
          </div>

          {/* Dynamic fields */}
          {fields.map((f) => (
            <div key={f.name} className="field">
              <label>{f.label}</label>
              {f.type === 'text' && (
                <input
                  className="input"
                  value={values[f.name] as string}
                  disabled={busy}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )}
              {f.type === 'select' && (
                <select
                  className="select"
                  value={values[f.name] as string}
                  disabled={busy}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              {f.type === 'number' && (
                <input
                  className="input"
                  type="number"
                  value={values[f.name] as number}
                  disabled={busy}
                  min={f.min}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: Number(e.target.value) }))}
                  style={{ width: 100 }}
                />
              )}
              {f.type === 'toggle' && (
                <Switch
                  checked={values[f.name] as boolean}
                  onChange={() => {
                    if (busy) return;
                    setValues((v) => ({ ...v, [f.name]: !v[f.name] }));
                  }}
                />
              )}
            </div>
          ))}

          {/* Progress bar */}
          {busy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {status === 'uploading' ? `Uploading… ${progress}%` : 'Saving…'}
              </div>
              <div className="bar-track">
                <div className="bar-fill accent" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleSubmit}
            disabled={busy || !file}
          >
            <Icon.Upload /> Upload
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify admin app builds with zero TypeScript errors**

```bash
pnpm --filter @tryme/admin build
```

Expected: build succeeds, zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/components/UploadModal.tsx
git commit -m "feat(admin): UploadModal component for presign → R2 → confirm asset flow"
```

---

## Task 6: Wire ModelsPage to real API

Replace mock data in `ModelsPage.tsx` with real API calls; wire toggle (PATCH), delete (DELETE with cascade warning), and the Add button to `UploadModal`.

**Files:**
- Modify: `apps/admin/src/pages/ModelsPage.tsx`

- [ ] **Step 1: Replace the file with the full implementation below**

Replace the entire contents of `apps/admin/src/pages/ModelsPage.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import type { ModelFace, ModelBackground, ModelPose, GenderSlug } from '../types';
import { apiFetch } from '../lib/data';
import { Icon } from '../components/Icons';
import { Switch } from '../components/Switch';
import { UploadModal } from '../components/UploadModal';
import type { FieldDef } from '../components/UploadModal';

type GenderTab = 'all' | GenderSlug;
const GENDER_TABS: { k: GenderTab; l: string }[] = [
  { k: 'all', l: 'All' },
  { k: 'men', l: 'Men' },
  { k: 'women', l: 'Women' },
  { k: 'boys', l: 'Boys' },
  { k: 'girls', l: 'Girls' },
];

type View =
  | { kind: 'faces' }
  | { kind: 'backgrounds'; faceId: string; faceLabel: string }
  | { kind: 'poses'; faceId: string; faceLabel: string; backgroundId: string; backgroundLabel: string };

type ConfirmDelete =
  | { type: 'face'; id: string; label: string }
  | { type: 'background'; id: string; label: string }
  | { type: 'pose'; id: string; label: string };

type UploadTarget =
  | { kind: 'face' }
  | { kind: 'background'; faceId: string }
  | { kind: 'pose'; backgroundId: string };

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

export default function ModelsPage({ onNav: _onNav, toast }: Props) {
  const [faces, setFaces] = useState<ModelFace[]>([]);
  const [backgrounds, setBackgrounds] = useState<ModelBackground[]>([]);
  const [poses, setPoses] = useState<ModelPose[]>([]);
  const [view, setView] = useState<View>({ kind: 'faces' });
  const [genderTab, setGenderTab] = useState<GenderTab>('all');
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete | null>(null);
  const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
  const [loading, setLoading] = useState(false);

  const loadFaces = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelFace[] }>('/admin/models/faces');
      setFaces(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load faces' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadBackgrounds = useCallback(async (faceId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelBackground[] }>(`/admin/models/backgrounds?faceId=${faceId}`);
      setBackgrounds(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load backgrounds' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadPoses = useCallback(async (backgroundId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ModelPose[] }>(`/admin/models/poses?backgroundId=${backgroundId}`);
      setPoses(res.items);
    } catch {
      toast({ kind: 'error', title: 'Failed to load poses' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (view.kind === 'faces') loadFaces();
    else if (view.kind === 'backgrounds') loadBackgrounds(view.faceId);
    else loadPoses(view.backgroundId);
  }, [view, loadFaces, loadBackgrounds, loadPoses]);

  // ── Toggle handlers ──────────────────────────────────────────────────────

  const toggleFaceActive = async (id: string) => {
    const face = faces.find((f) => f.id === id);
    if (!face) return;
    const next = !face.isActive;
    setFaces((prev) => prev.map((f) => f.id === id ? { ...f, isActive: next } : f));
    try {
      await apiFetch(`/admin/models/faces/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${face.label} ${face.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setFaces((prev) => prev.map((f) => f.id === id ? { ...f, isActive: face.isActive } : f));
      toast({ kind: 'error', title: 'Failed to update face' });
    }
  };

  const toggleBackgroundActive = async (id: string) => {
    const bg = backgrounds.find((b) => b.id === id);
    if (!bg) return;
    const next = !bg.isActive;
    setBackgrounds((prev) => prev.map((b) => b.id === id ? { ...b, isActive: next } : b));
    try {
      await apiFetch(`/admin/models/backgrounds/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${bg.label} ${bg.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setBackgrounds((prev) => prev.map((b) => b.id === id ? { ...b, isActive: bg.isActive } : b));
      toast({ kind: 'error', title: 'Failed to update background' });
    }
  };

  const togglePoseActive = async (id: string) => {
    const pose = poses.find((p) => p.id === id);
    if (!pose) return;
    const next = !pose.isActive;
    setPoses((prev) => prev.map((p) => p.id === id ? { ...p, isActive: next } : p));
    try {
      await apiFetch(`/admin/models/poses/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${pose.label} ${pose.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setPoses((prev) => prev.map((p) => p.id === id ? { ...p, isActive: pose.isActive } : p));
      toast({ kind: 'error', title: 'Failed to update pose' });
    }
  };

  // ── Delete handler ────────────────────────────────────────────────────────

  const doDelete = async () => {
    if (!confirmDelete) return;
    const { type, id, label } = confirmDelete;
    setConfirmDelete(null);
    try {
      await apiFetch(`/admin/models/${type === 'face' ? 'faces' : type === 'background' ? 'backgrounds' : 'poses'}/${id}`, { method: 'DELETE' });
      if (type === 'face') setFaces((prev) => prev.filter((f) => f.id !== id));
      else if (type === 'background') setBackgrounds((prev) => prev.filter((b) => b.id !== id));
      else setPoses((prev) => prev.filter((p) => p.id !== id));
      toast({ title: `${label} deleted` });
    } catch {
      toast({ kind: 'error', title: `Failed to delete ${type}` });
    }
  };

  // ── Upload modal config ───────────────────────────────────────────────────

  const uploadConfig = uploadTarget === null ? null : (() => {
    if (uploadTarget.kind === 'face') {
      return {
        title: 'Add face',
        presignPath: '/admin/models/faces/presign',
        confirmPath: '/admin/models/faces/confirm',
        fields: FACE_FIELDS,
        presignExtra: undefined as Record<string, unknown> | undefined,
        confirmExtra: undefined as Record<string, unknown> | undefined,
      };
    }
    if (uploadTarget.kind === 'background') {
      return {
        title: 'Add background',
        presignPath: '/admin/models/backgrounds/presign',
        confirmPath: '/admin/models/backgrounds/confirm',
        fields: BG_FIELDS,
        presignExtra: { faceId: uploadTarget.faceId },
        confirmExtra: { faceId: uploadTarget.faceId },
      };
    }
    return {
      title: 'Add pose',
      presignPath: '/admin/models/poses/presign',
      confirmPath: '/admin/models/poses/confirm',
      fields: POSE_FIELDS,
      presignExtra: { backgroundId: uploadTarget.backgroundId },
      confirmExtra: { backgroundId: uploadTarget.backgroundId },
    };
  })();

  // ── Header helpers ────────────────────────────────────────────────────────

  const pageTitle = view.kind === 'faces'
    ? 'Models'
    : view.kind === 'backgrounds'
      ? view.faceLabel
      : view.backgroundLabel;

  const pageLede = view.kind === 'faces'
    ? 'Manage model faces. Click a face to configure backgrounds and poses.'
    : view.kind === 'backgrounds'
      ? `Backgrounds for ${view.faceLabel}. Click a background to manage poses.`
      : `Poses for ${view.backgroundLabel}.`;

  const addLabel = view.kind === 'faces'
    ? 'Add face'
    : view.kind === 'backgrounds'
      ? 'Add background'
      : 'Add pose';

  const handleAddClick = () => {
    if (view.kind === 'faces') setUploadTarget({ kind: 'face' });
    else if (view.kind === 'backgrounds') setUploadTarget({ kind: 'background', faceId: view.faceId });
    else setUploadTarget({ kind: 'pose', backgroundId: view.backgroundId });
  };

  // ── Filtered data ─────────────────────────────────────────────────────────

  const filteredFaces = faces.filter((f) => genderTab === 'all' || f.gender === genderTab);
  const filteredBackgrounds = (view.kind === 'backgrounds' || view.kind === 'poses')
    ? backgrounds.filter((b) => b.faceId === view.faceId)
    : [];
  const filteredPoses = view.kind === 'poses'
    ? poses.filter((p) => p.backgroundId === view.backgroundId)
    : [];

  // ── Thumb placeholder ─────────────────────────────────────────────────────

  const renderThumb = (label: string) => (
    <div style={{
      width: 48, height: 64, borderRadius: 6,
      background: 'var(--subtle)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: 'var(--muted)', fontSize: 12, fontWeight: 600,
    }}>
      {label.slice(0, 2).toUpperCase()}
    </div>
  );

  return (
    <>
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          {view.kind !== 'faces' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 13, color: 'var(--muted)' }}>
              <button className="btn sm ghost" onClick={() => setView({ kind: 'faces' })} style={{ padding: '2px 8px', fontSize: 13 }}>
                Models
              </button>
              <Icon.Chevron />
              {view.kind === 'poses' && (
                <>
                  <button className="btn sm ghost" onClick={() => setView({ kind: 'backgrounds', faceId: view.faceId, faceLabel: view.faceLabel })} style={{ padding: '2px 8px', fontSize: 13 }}>
                    {view.faceLabel}
                  </button>
                  <Icon.Chevron />
                </>
              )}
              <span>{pageTitle}</span>
            </div>
          )}
          <h1>{pageTitle}</h1>
          <p className="lede">{pageLede}</p>
        </div>
        <div className="head-tools">
          <button className="btn" onClick={handleAddClick}>
            <Icon.Add /> {addLabel}
          </button>
        </div>
      </div>

      {/* ── Loading ─────────────────────────────────────────────────────── */}
      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
      )}

      {/* ── Gender tabs ─────────────────────────────────────────────────── */}
      {!loading && view.kind === 'faces' && (
        <div className="tabs">
          {GENDER_TABS.map((t) => (
            <button key={t.k} className={`tab ${genderTab === t.k ? 'active' : ''}`} onClick={() => setGenderTab(t.k)}>
              {t.l}
            </button>
          ))}
        </div>
      )}

      {/* ── Faces grid ─────────────────────────────────────────────────── */}
      {!loading && view.kind === 'faces' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {filteredFaces.map((face) => (
            <div key={face.id} className="card" style={{ opacity: face.isActive ? 1 : 0.6, padding: 14 }}>
              <div style={{ cursor: 'pointer' }} onClick={() => setView({ kind: 'backgrounds', faceId: face.id, faceLabel: face.label })}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {renderThumb(face.label)}
                  <div style={{ marginTop: 4 }}>
                    <span className="semi">{face.label}</span>
                    <div style={{ marginTop: 4 }}>
                      <span className="badge dot accent">{face.gender}</span>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                      {face.backgroundCount ?? 0} background{face.backgroundCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={face.isActive} onChange={() => toggleFaceActive(face.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost"><Icon.Edit /></button>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'face', id: face.id, label: face.label })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {filteredFaces.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No faces found.</div>
          )}
        </div>
      )}

      {/* ── Backgrounds grid ───────────────────────────────────────────── */}
      {!loading && view.kind === 'backgrounds' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {filteredBackgrounds.map((bg) => (
            <div key={bg.id} className="card" style={{ opacity: bg.isActive ? 1 : 0.6, padding: 14 }}>
              <div style={{ cursor: 'pointer' }} onClick={() => setView({ kind: 'poses', faceId: view.faceId, faceLabel: view.faceLabel, backgroundId: bg.id, backgroundLabel: bg.label })}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  {renderThumb(bg.label)}
                  <div style={{ marginTop: 4 }}>
                    <span className="semi">{bg.label}</span>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                      {bg.poseCount ?? 0} pose{bg.poseCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={bg.isActive} onChange={() => toggleBackgroundActive(bg.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost"><Icon.Edit /></button>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'background', id: bg.id, label: bg.label })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {filteredBackgrounds.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No backgrounds found for this face.</div>
          )}
        </div>
      )}

      {/* ── Poses grid ─────────────────────────────────────────────────── */}
      {!loading && view.kind === 'poses' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {filteredPoses.map((pose) => (
            <div key={pose.id} className="card" style={{ opacity: pose.isActive ? 1 : 0.6, padding: 14 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {renderThumb(pose.label)}
                <div style={{ marginTop: 4 }}>
                  <span className="semi">{pose.label}</span>
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {pose.showsLower && <span className="badge dot accent">Shows lower</span>}
                    {pose.showsShoes && <span className="badge dot warn">Shows shoes</span>}
                    {!pose.showsLower && !pose.showsShoes && <span className="badge dot">Upper only</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <Switch checked={pose.isActive} onChange={() => togglePoseActive(pose.id)} />
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn sm ghost"><Icon.Edit /></button>
                  <button className="btn sm ghost" onClick={() => setConfirmDelete({ type: 'pose', id: pose.id, label: pose.label })}><Icon.Trash /></button>
                </div>
              </div>
            </div>
          ))}
          {filteredPoses.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No poses found for this background.</div>
          )}
        </div>
      )}

      {/* ── Delete confirm modal ────────────────────────────────────────── */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Delete {confirmDelete.type}</h3>
            </div>
            <div className="modal-body">
              <p>Delete <strong>{confirmDelete.label}</strong>? This cannot be undone.</p>
              {confirmDelete.type === 'face' && (
                <p style={{ color: 'var(--danger)', marginTop: 8 }}>All related backgrounds and poses will also be deleted.</p>
              )}
              {confirmDelete.type === 'background' && (
                <p style={{ color: 'var(--danger)', marginTop: 8 }}>All related poses will also be deleted.</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload modal ────────────────────────────────────────────────── */}
      {uploadTarget && uploadConfig && (
        <UploadModal
          title={uploadConfig.title}
          presignPath={uploadConfig.presignPath}
          presignExtra={uploadConfig.presignExtra}
          confirmPath={uploadConfig.confirmPath}
          confirmExtra={uploadConfig.confirmExtra}
          fields={uploadConfig.fields}
          onDone={(row) => {
            setUploadTarget(null);
            if (view.kind === 'faces') setFaces((prev) => [...prev, row as ModelFace]);
            else if (view.kind === 'backgrounds') setBackgrounds((prev) => [...prev, row as ModelBackground]);
            else setPoses((prev) => [...prev, row as ModelPose]);
          }}
          onClose={() => setUploadTarget(null)}
          toast={toast}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify admin app builds with zero TypeScript errors**

```bash
pnpm --filter @tryme/admin build
```

Expected: build succeeds, zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/pages/ModelsPage.tsx
git commit -m "feat(admin): wire ModelsPage to real API with upload, toggle, delete"
```

---

## Task 7: Wire CatalogPage to real API

Replace mock data with real API calls. The upload modal for catalog items needs to pick a category — fetch all categories via the new `/admin/catalog/categories` endpoint and filter by selected type in the modal.

**Files:**
- Modify: `apps/admin/src/pages/CatalogPage.tsx`

- [ ] **Step 1: Replace the file with the full implementation below**

Replace the entire contents of `apps/admin/src/pages/CatalogPage.tsx`:

```typescript
import { useState, useEffect } from 'react';
import type { CatalogItem } from '../types';
import { apiFetch } from '../lib/data';
import { Icon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { Th } from '../components/Th';
import type { SortDir } from '../components/Th';
import { Switch } from '../components/Switch';
import { UploadModal } from '../components/UploadModal';
import type { FieldDef } from '../components/UploadModal';

const PAGE_SIZE = 25;

type Tab = 'all' | 'lower' | 'shoe';
const TABS: { k: Tab; l: string }[] = [
  { k: 'all', l: 'All items' },
  { k: 'lower', l: 'Lower garments' },
  { k: 'shoe', l: 'Shoes' },
];

interface CategoryRow {
  id: number;
  label: string;
  typeSlug: string;
}

interface Props {
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function CatalogPage({ onNav: _onNav, toast }: Props) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<keyof CatalogItem>('sortOrder');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch<CatalogItem[]>('/admin/catalog/items'),
      apiFetch<CategoryRow[]>('/admin/catalog/categories'),
    ]).then(([itemsRes, catsRes]) => {
      setItems(itemsRes);
      setCategories(catsRes);
    }).catch(() => {
      toast({ kind: 'error', title: 'Failed to load catalog' });
    }).finally(() => setLoading(false));
  }, [toast]);

  const filtered = items.filter((c) => {
    if (tab !== 'all' && c.type !== tab) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortKey] ?? '';
    const bVal = b[sortKey] ?? '';
    let cmp: number;
    if (typeof aVal === 'boolean') {
      cmp = Number(bVal as boolean) - Number(aVal);
    } else if (typeof aVal === 'string') {
      cmp = aVal.localeCompare(bVal as string);
    } else {
      cmp = (aVal as number) - (bVal as number);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSort = (k: keyof CatalogItem) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir('asc'); }
  };

  const toggleActive = async (id: string) => {
    const item = items.find((c) => c.id === id);
    if (!item) return;
    const next = !item.isActive;
    setItems((prev) => prev.map((c) => c.id === id ? { ...c, isActive: next } : c));
    try {
      await apiFetch(`/admin/catalog/items/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: next }) });
      toast({ title: `${item.label} ${item.isActive ? 'deactivated' : 'activated'}` });
    } catch {
      setItems((prev) => prev.map((c) => c.id === id ? { ...c, isActive: item.isActive } : c));
      toast({ kind: 'error', title: 'Failed to update item' });
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const item = items.find((c) => c.id === confirmDelete);
    setConfirmDelete(null);
    try {
      await apiFetch(`/admin/catalog/items/${confirmDelete}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((c) => c.id !== confirmDelete));
      toast({ title: `${item?.label ?? confirmDelete} deleted` });
    } catch {
      toast({ kind: 'error', title: 'Failed to delete item' });
    }
  };

  // Build upload field defs — category options depend on which categories exist
  // Filter: lower categories + shoe categories both shown; admin picks type via category select
  const uploadFields: FieldDef[] = [
    { type: 'text', name: 'label', label: 'Label', required: true },
    {
      type: 'select',
      name: 'categoryId',
      label: 'Category',
      options: categories.map((c) => ({
        value: String(c.id),
        label: `[${c.typeSlug}] ${c.label}`,
      })),
    },
    { type: 'number', name: 'sortOrder', label: 'Sort order', min: 0, defaultValue: 0 },
  ];

  const lowerCount = items.filter((c) => c.type === 'lower').length;
  const shoeCount = items.filter((c) => c.type === 'shoe').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Catalog</h1>
          <p className="lede">
            {lowerCount} lower garments · {shoeCount} shoes — optional add-ons shown when pose permits.
          </p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Search by label or ID…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            />
          </div>
          <button className="btn" onClick={() => setShowUpload(true)}><Icon.Add /> Add item</button>
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.k} className={`tab ${tab === t.k ? 'active' : ''}`} onClick={() => { setTab(t.k); setPage(0); }}>
            {t.l}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>Loading…</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <Th k="label" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Label</Th>
                <Th k="type" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Type</Th>
                <Th k="sortOrder" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Order</Th>
                <Th k="isActive" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Active</Th>
                <Th k="updatedAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}>Updated</Th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {paged.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 6, background: 'var(--subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon.Image />
                      </div>
                      <div>
                        <span className="semi">{c.label}</span>
                        <span className="sub mono" style={{ display: 'block' }}>{c.id}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge dot ${c.type === 'lower' ? 'accent' : 'warn'}`}>
                      {c.type === 'lower' ? 'Lower' : 'Shoe'}
                    </span>
                  </td>
                  <td><span className="mono">{c.sortOrder}</span></td>
                  <td><Switch checked={c.isActive} onChange={() => toggleActive(c.id)} /></td>
                  <td><span className="mono">{c.updatedAt.slice(0, 10)}</span></td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn sm ghost"><Icon.Edit /></button>
                      <button className="btn sm ghost" onClick={() => setConfirmDelete(c.id)}><Icon.Trash /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {paged.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '2rem' }}>No items found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} totalPages={totalPages} onPage={setPage} totalItems={sorted.length} pageSize={PAGE_SIZE} />

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>Delete catalog item</h3></div>
            <div className="modal-body">
              <p>Delete <strong>{items.find((c) => c.id === confirmDelete)?.label ?? confirmDelete}</strong>? This cannot be undone.</p>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={doDelete}><Icon.Trash /> Delete</button>
            </div>
          </div>
        </div>
      )}

      {showUpload && categories.length > 0 && (
        <UploadModal
          title="Add catalog item"
          presignPath="/admin/catalog/items/presign"
          presignExtra={{ categoryId: undefined }}
          confirmPath="/admin/catalog/items/confirm"
          fields={uploadFields}
          onDone={(row) => {
            setShowUpload(false);
            // Reload to get type field populated (needs join)
            apiFetch<CatalogItem[]>('/admin/catalog/items').then(setItems).catch(() => {});
          }}
          onClose={() => setShowUpload(false)}
          toast={toast}
        />
      )}
    </>
  );
}
```

**Important note:** The catalog presign endpoint expects `categoryId` (an integer), but `UploadModal` collects it from the `categoryId` field as a string (from the select). The confirm endpoint also needs `categoryId` as a number. The `UploadModal` sends `values` as-is, so `categoryId` will be sent as a string `"3"` etc. The Zod schema on the backend uses `z.number().int().positive()` which will reject a string.

- [ ] **Step 2: Fix catalog presign/confirm to accept `categoryId` as string or number**

Open `apps/api/src/modules/admin/catalog.routes.ts` and update the two Zod schemas used inline. The existing `PresignCatalogItemBody` and `ConfirmCatalogItemBody` are defined in `packages/types/src/admin.ts` and both use `z.number().int().positive()` for `categoryId`. Add `.or(z.coerce.number())` coercion.

Update in `packages/types/src/admin.ts`:

Change:
```typescript
export const PresignCatalogItemBody = z.object({
  categoryId: z.number().int().positive(),
  label: z.string().min(1).max(120),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export const ConfirmCatalogItemBody = z.object({
  categoryId: z.number().int().positive(),
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
```

To:
```typescript
const CoercedPositiveInt = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);

export const PresignCatalogItemBody = z.object({
  categoryId: CoercedPositiveInt,
  label: z.string().min(1).max(120),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export const ConfirmCatalogItemBody = z.object({
  categoryId: CoercedPositiveInt,
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
});
```

Also fix the `CatalogPage.tsx` upload modal — the `presignExtra` currently has `categoryId: undefined` which is wrong. The `categoryId` comes from the form field `values.categoryId`. Remove the `presignExtra` override from `CatalogPage.tsx`'s `UploadModal` usage:

Change:
```typescript
presignExtra={{ categoryId: undefined }}
```
To:
```typescript
presignExtra={undefined}
```

The form `values.categoryId` (the select field) will be merged into the presign body automatically by `UploadModal`'s `handleSubmit` via `{ contentType: file.type, ...presignExtra }` — but wait, `presignExtra` and `values` are separate. Looking at `UploadModal.handleSubmit`:

```typescript
body: JSON.stringify({ contentType: file.type, ...presignExtra }),
```

The presign body only includes `contentType` + `presignExtra`. The form `values` (including `categoryId`) are only sent in the confirm body. But the presign endpoint needs `categoryId` too (to look up the category → type → generate the R2 key).

**Fix:** In `CatalogPage.tsx`, pass `categoryId` as `presignExtra` dynamically from the form. But `UploadModal` doesn't expose the current form values to the parent. The cleanest fix is to make `presignExtra` also include the form values that matter for presign.

The real issue is that `UploadModal` sends presign body as `{ contentType, ...presignExtra }` and confirm body as `{ ...values, ...confirmExtra, r2Key, thumbnailKey }`. For catalog items, `categoryId` comes from the form (in `values`) but is also needed in the presign body.

**Solution:** The `UploadModal` should merge `values` into the presign body too. Update `UploadModal.handleSubmit`:

Change the presign fetch body from:
```typescript
body: JSON.stringify({ contentType: file.type, ...presignExtra }),
```
To:
```typescript
body: JSON.stringify({ contentType: file.type, ...values, ...presignExtra }),
```

This way the presign request gets all form values (including `categoryId`) plus any explicit overrides from `presignExtra`. The model face/background/pose presign endpoints will ignore unknown fields (Zod strips extra properties by default), so this is safe.

Update `apps/admin/src/components/UploadModal.tsx` line in `handleSubmit`:

```typescript
const presignRes = await apiFetch<PresignResult>(presignPath, {
  method: 'POST',
  body: JSON.stringify({ contentType: file.type, ...values, ...presignExtra }),
});
```

And remove `presignExtra` prop from the `UploadModal` usage in `CatalogPage.tsx` entirely (delete the `presignExtra={undefined}` line).

- [ ] **Step 3: Verify both packages build with zero TypeScript errors**

```bash
pnpm --filter @tryme/types build && pnpm --filter @tryme/api build && pnpm --filter @tryme/admin build
```

Expected: all three build with zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/pages/CatalogPage.tsx apps/admin/src/components/UploadModal.tsx packages/types/src/admin.ts
git commit -m "feat(admin): wire CatalogPage to real API with upload, toggle, delete"
```

---

## Self-Review

**Spec coverage:**
- ✅ Admin uploads model faces → `POST /admin/models/faces/presign` + `confirm`
- ✅ Admin uploads backgrounds (linked to face) → `POST /admin/models/backgrounds/presign` + `confirm`
- ✅ Admin uploads poses (linked to background) with showsLower/showsShoes flags → `POST /admin/models/poses/presign` + `confirm`
- ✅ Admin uploads catalog items (lower/shoe) with category pick → reuses existing presign/confirm
- ✅ Toggle active (PATCH) for all asset types
- ✅ Delete with cascade (face → backgrounds → poses, R2 cleanup)
- ✅ Upload is distinct from user step 7 (user garment upload): different R2 key prefixes (`models/` vs `inputs/`), different endpoints (`/admin/models/` vs `/v1/uploads/presign`)
- ✅ Progress bar during R2 PUT via XHR
- ✅ Both presign body and confirm body include form values (categoryId fix)

**Placeholder scan:** None found.

**Type consistency:**
- `FieldDef` exported from `UploadModal.tsx`, imported in `ModelsPage.tsx` and `CatalogPage.tsx` ✅
- `apiFetch` imported from `../lib/data` in both pages ✅
- `ModelFace`, `ModelBackground`, `ModelPose`, `CatalogItem` from `../types` ✅
- API route bodies typed with `req.body as { ... }` explicit casts matching the Zod schemas ✅
- `schema.modelFaces`, `schema.modelBackgrounds`, `schema.modelPoses` all exported from `@tryme/db` via `packages/db/src/schema/index.ts` ✅
