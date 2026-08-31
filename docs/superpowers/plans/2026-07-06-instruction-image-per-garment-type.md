# Dynamic Instruction Image Per Garment Type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `instructions.png` on the studio page with a per-garment-type instruction image that admins can upload from the edit modal.

**Architecture:** Add `instruction_image_key` column to `garment_subcategories`. New presign endpoint for admin instruction image upload. Expose `instructionImageUrl` in GET /v1/models/garment-types. Admin-web edit modal gets an instruction image upload field. Studio page uses the dynamic URL.

**Tech Stack:** Drizzle ORM, PostgreSQL, Fastify, S3-compatible storage (R2/MinIO), TypeScript, React

---

### Task 1: Add migration + DB schema column

**Files:**
- Modify: `packages/db/src/schema/models.ts` (add column)
- Create: `packages/db/src/migrations/0079_instruction_image_key.sql` (new migration)

- [ ] **Step 1: Add `instructionImageKey` to Drizzle schema**

In `packages/db/src/schema/models.ts:57`, after `thumbnailKey`:

```typescript
thumbnailKey: text('thumbnail_key'),
instructionImageKey: text('instruction_image_key'),
```

- [ ] **Step 2: Create migration SQL**

Create `packages/db/src/migrations/0079_instruction_image_key.sql`:

```sql
ALTER TABLE garment_subcategories
  ADD COLUMN instruction_image_key text;
```

- [ ] **Step 3: Run migration**

```bash
pnpm db:migrate
```

Expected: no errors, migration applied.

- [ ] **Step 4: Commit**

```bash
git add packages/db/
git commit -m "feat(db): add instruction_image_key column to garment_subcategories"
```

---

### Task 2: Add storage key builder

**Files:**
- Modify: `packages/storage/src/keys.ts`

- [ ] **Step 1: Add `subcategoryInstruction` key builder**

In `packages/storage/src/keys.ts:21`, after `subcategoryThumb`:

```typescript
subcategoryThumb: (id: string) => `models/subcategories/${id}.thumb.jpg`,
subcategoryInstruction: (id: string) => `models/subcategories/${id}.instruction.jpg`,
```

- [ ] **Step 2: Run existing storage tests**

```bash
pnpm --filter @tryme/storage test
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add packages/storage/
git commit -m "feat(storage): add subcategoryInstruction key builder"
```

---

### Task 3: Add type schemas

**Files:**
- Modify: `packages/types/src/admin.ts`

- [ ] **Step 1: Add instructionImageKey to PatchGarmentTypeBody**

In `packages/types/src/admin.ts:356-365`:

```typescript
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
});
```

- [ ] **Step 2: Add PresignGarmentTypeInstructionBody**

In `packages/types/src/admin.ts`, after `PresignGarmentTypeBody`:

```typescript
export const PresignGarmentTypeInstructionBody = z.object({
  contentType: AssetContentType,
});
```

- [ ] **Step 3: Export new type**

In `packages/types/src/index.ts`, add to the admin export:

```typescript
export {
  ...
  PresignGarmentTypeInstructionBody,
} from './admin.js';
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/types typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/types/
git commit -m "feat(types): add instructionImageKey schemas"
```

---

### Task 4: Add API presign endpoint and update PATCH handler

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts`

- [ ] **Step 1: Add presign instruction endpoint**

In `apps/api/src/modules/admin/subcategories.routes.ts`, after the existing presign block (line 39), add:

```typescript
app.post(
  '/admin/assets/garment-types/instruction/presign',
  {
    preHandler: RW,
    schema: { body: PresignGarmentTypeInstructionBody },
  },
  async (_req) => {
    const newId = randomUUID();
    const instructionKey = keys.subcategoryInstruction(newId);
    const { url } = await app.storage.presignPut(instructionKey, 'image/jpeg', 10_000_000, 300);
    return { uploadUrl: url, instructionImageKey: instructionKey };
  },
);
```

Add the import for `PresignGarmentTypeInstructionBody` at the top:

```typescript
import {
  CreateGarmentTypeBody,
  PatchGarmentTypeBody,
  PresignGarmentTypeBody,
  PresignGarmentTypeInstructionBody,
} from '@tryme/types';
```

- [ ] **Step 2: Update PATCH handler to delete old object when replaced/cleared**

In the PATCH handler (line 87-98), before the update, read the current row to get the old key:

```typescript
app.patch(
  '/admin/assets/garment-types/:id',
  {
    preHandler: RW,
    schema: { params: uuidParam, body: PatchGarmentTypeBody },
  },
  async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;

    // If instructionImageKey is being set or cleared, delete the old object
    if ('instructionImageKey' in body) {
      const [current] = await app.db
        .select({ instructionImageKey: schema.garmentSubcategories.instructionImageKey })
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
      if (current?.instructionImageKey) {
        await app.storage.deleteObject(current.instructionImageKey).catch(() => {});
      }
    }

    const [updated] = await app.db
      .update(schema.garmentSubcategories)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.garmentSubcategories.id, id))
      .returning({ id: schema.garmentSubcategories.id });
    if (!updated) throw new AppError('NOT_FOUND', 404, 'garment type not found');
    return { ok: true };
  },
);
```

- [ ] **Step 3: Update GET /admin/assets/garment-types to include instructionImageUrl**

In the GET handler (line 20-23), update to include `instructionImageKey`:

```typescript
app.get('/admin/assets/garment-types', { preHandler: RW }, async () => {
  const rows = await app.db.select().from(schema.garmentSubcategories);
  return {
    items: rows.map((r) => ({
      ...r,
      instructionImageUrl: r.instructionImageKey
        ? app.storage.publicUrl(r.instructionImageKey)
        : null,
    })),
  };
});
```

- [ ] **Step 4: Run unit tests**

```bash
pnpm --filter @tryme/api test:unit
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/
git commit -m "feat(api): add instruction image presign and PATCH support"
```

---

### Task 5: Update GET /v1/models/garment-types to return instructionImageUrl

**Files:**
- Modify: `apps/api/src/modules/models/routes.ts`

- [ ] **Step 1: Add instructionImageKey to SELECT and map instructionImageUrl**

In `apps/api/src/modules/models/routes.ts:15-38`:

```typescript
const items = await app.db
  .select({
    id: schema.garmentSubcategories.id,
    slug: schema.garmentSubcategories.slug,
    label: schema.garmentSubcategories.label,
    sortOrder: schema.garmentSubcategories.sortOrder,
    thumbnailKey: schema.garmentSubcategories.thumbnailKey,
    instructionImageKey: schema.garmentSubcategories.instructionImageKey,
    requiresLowerUpload: schema.garmentSubcategories.requiresLowerUpload,
    defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
    defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
  })
  .from(schema.garmentSubcategories)
  .where(...);
return {
  items: items.map((i) => ({
    ...i,
    thumbnailUrl: i.thumbnailKey ? app.storage.publicUrl(i.thumbnailKey) : null,
    instructionImageUrl: i.instructionImageKey
      ? app.storage.publicUrl(i.instructionImageKey)
      : null,
  })),
};
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/models/routes.ts
git commit -m "feat(api): expose instructionImageUrl in garment-types endpoint"
```

---

### Task 6: Update admin-web GarmentType interface

**Files:**
- Modify: `apps/admin-web/src/types.ts`

- [ ] **Step 1: Add instructionImageKey to the interface**

In `apps/admin-web/src/types.ts:35-50`:

```typescript
export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  thumbnailKey?: string | null;
  instructionImageKey?: string | null;
  instructionImageUrl?: string | null;
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

- [ ] **Step 2: Commit**

```bash
git add apps/admin-web/src/types.ts
git commit -m "feat(admin-web): add instructionImageKey to GarmentType"
```

---

### Task 7: Add instruction image upload to admin-web edit modal

**Files:**
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`

- [ ] **Step 1: Add state variable**

After the existing `editSubcatTryonCategoryId` state, add:

```typescript
const [editSubcatInstructionFile, setEditSubcatInstructionFile] = useState<File | null>(null);
```

- [ ] **Step 2: Clear state when opening edit modal**

In the edit button click handler, add:

```typescript
setEditSubcatInstructionFile(null);
```

- [ ] **Step 3: Add instruction image field block in the modal**

After the thumbnail image field (after line ~1037), add:

```tsx
<div className="field">
  <label>Instruction image</label>
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    {editSubcatInstructionFile ? (
      <img
        src={URL.createObjectURL(editSubcatInstructionFile)}
        alt="preview"
        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
      />
    ) : editingSubcat.instructionImageUrl ? (
      <img
        src={editingSubcat.instructionImageUrl}
        alt="Instruction"
        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
      />
    ) : (
      <div style={{ width: 64, height: 64, borderRadius: 6, background: 'var(--subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        color: 'var(--muted)', fontSize: 12 }}>
        No image
      </div>
    )}
    <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
      {editSubcatInstructionFile || editingSubcat.instructionImageUrl ? 'Replace image' : 'Upload image'}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setEditSubcatInstructionFile(f);
        }}
      />
    </label>
    {editSubcatInstructionFile && (
      <button className="btn sm ghost" onClick={() => setEditSubcatInstructionFile(null)}>
        <Icon.Close />
      </button>
    )}
  </div>
</div>
```

- [ ] **Step 4: Add instruction image upload + clear in save handler**

In the save `onClick`, add `instructionImageKey?: string | null` to `patchBody` type. After the thumbnail upload block (and before the field diffs), add:

```typescript
if (editSubcatInstructionFile) {
  const presign = await apiFetch<{ uploadUrl: string; instructionImageKey: string }>(
    '/admin/assets/garment-types/instruction/presign',
    {
      method: 'POST',
      body: JSON.stringify({ contentType: editSubcatInstructionFile.type }),
    },
  );
  await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': editSubcatInstructionFile.type },
    body: editSubcatInstructionFile,
  });
  patchBody.instructionImageKey = presign.instructionImageKey;
} else if (
  editingSubcat.instructionImageKey &&
  !editSubcatInstructionFile
) {
  // If we want to clear the image (no new file selected and we explicitly clear)
  // Only clear if the user explicitly removes it (requires a "Remove" button action)
}
```

Add a "Remove" button next to the instruction image preview when one exists. When clicked, set `editSubcatInstructionFile` to `EMPTY_FILE_MARKER` (or a sentinel) so the save handler knows to set `instructionImageKey` to null.

Simpler approach: replace the file-based upload with a direct approach. When user clicks "Remove", set a `boolean` flag like `editRemoveInstructionImage` and in the save handler, set `instructionImageKey: null`.

Add state:
```typescript
const [editRemoveInstructionImage, setEditRemoveInstructionImage] = useState(false);
```

Add "Remove" button (when an existing image is shown and no new file is picked):
```tsx
{!editSubcatInstructionFile && editingSubcat.instructionImageUrl && (
  <button
    className="btn sm ghost"
    onClick={() => {
      setEditRemoveInstructionImage(true);
      setEditSubcatInstructionFile(null);
    }}
    style={editRemoveInstructionImage ? { textDecoration: 'line-through', opacity: 0.5 } : undefined}
  >
    {editRemoveInstructionImage ? 'Pending remove' : <Icon.Close />}
  </button>
)}
```

In save handler, after the upload block:
```typescript
if (editRemoveInstructionImage) {
  patchBody.instructionImageKey = null;
}
```

- [ ] **Step 5: Update save button disable logic**

Add to the disable condition:
```typescript
&& !editSubcatInstructionFile
&& !editRemoveInstructionImage
```

- [ ] **Step 6: Reset state on close**

In all close/reset handlers, add:
```typescript
setEditSubcatInstructionFile(null);
setEditRemoveInstructionImage(false);
```

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin-web): add instruction image upload to garment type edit modal"
```

---

### Task 8: Update studio page to use dynamic instruction image

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

- [ ] **Step 1: Verify the GarmentType interface includes instructionImageUrl**

Find the inline `GarmentType` interface in the studio page (around line 23-31) and add:

```typescript
interface GarmentType {
  id: string;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  instructionImageUrl?: string | null;
  requiresLowerUpload: boolean;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
}
```

- [ ] **Step 2: Replace static instruction image with dynamic URL**

Find the instruction image div (around line 1789-1802). Replace:

```tsx
<img
  src={`${BASE}/assets/instructions.png`}
  alt="Upload instructions"
  style={{
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  }}
/>
```

With:

```tsx
<img
  src={selectedGarmentType?.instructionImageUrl ?? undefined}
  alt="Upload instructions"
  style={{
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  }}
/>
```

- [ ] **Step 3: Hide instruction image div when no URL**

Wrap the instruction image div so it only renders when `instructionImageUrl` is present:

```tsx
{selectedGarmentType?.instructionImageUrl && (
  <div style={{ ... }}>
    <img ... />
  </div>
)}
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/catalogues-web && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/
git commit -m "feat(studio): use dynamic instruction image from garment type"
```

---

### Task 9: Update admin-mobile

**Files:**
- Modify: `apps/admin-mobile/src/types.ts`
- Modify: `apps/admin-mobile/src/app/(tabs)/assets/garment-types/[id].tsx`

- [ ] **Step 1: Add instructionImageKey to admin-mobile GarmentType**

In `apps/admin-mobile/src/types.ts:36-48`:

```typescript
export interface GarmentType {
  id: string;
  genderSlug: GenderSlug;
  slug: string;
  label: string;
  thumbnailKey?: string | null;
  instructionImageKey?: string | null;
  isActive: boolean;
  sortOrder: number;
  requiresLowerUpload: boolean;
  createdAt: string;
  updatedAt: string;
  poseCount?: number;
}
```

- [ ] **Step 2: Add instruction image section to mobile detail page**

In `apps/admin-mobile/src/app/(tabs)/assets/garment-types/[id].tsx`, add an instruction image upload section (same pattern as the thumbnail upload section). Follow the existing mobile image upload patterns used in the same file.

- [ ] **Step 3: Commit**

```bash
git add apps/admin-mobile/
git commit -m "feat(admin-mobile): add instruction image upload for garment types"
```
