# Model Face Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free-form tags to `model_faces`, giving the admin face edit card a tags input and the Studio face picker a tag-filter chip row — full parity with the existing `model_backgrounds.tags` feature.

**Architecture:** New `tags text[]` column on `model_faces` (mirrors `model_backgrounds.tags` exactly), threaded through the admin confirm/patch routes, the public `GET /v1/models/faces` route, the admin edit modal, and a generically-extended `SelectGridModal` used by the Studio face picker.

**Tech Stack:** Drizzle ORM (Postgres), Fastify 5 + Zod (`fastify-type-provider-zod`), React (admin-web Vite SPA + catalogues-web Next.js 15), Vitest integration tests against the docker-compose Postgres.

## Global Constraints

- No `specialTag` or category system for faces — tags only.
- No tags field on face creation (`AddFaceModal.tsx`) — edit-only, matching how `BackgroundUploadModal.tsx` also has no tags field at creation.
- `SelectGridModal` (`apps/catalogues-web/src/app/(app)/studio/select-modal.tsx`) changes must be additive/optional — no behavior change for its other callers (poses, lower/shoe, catalogue templates, `embed-studio-wizard.tsx`).
- Tag bounds: `z.array(z.string().min(1).max(40)).max(20).optional()` — copied verbatim from `ConfirmModelBackgroundBody`/`PatchModelBackgroundBody`.
- `pnpm docker:up` must be running before any `pnpm test` (no testcontainers — see CLAUDE.md Testing Architecture).

---

### Task 1: DB schema + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts:17-34` (`modelFaces` table)
- Create: `packages/db/src/migrations/0145_model_face_tags.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `schema.modelFaces.tags` — a Drizzle column of type `text[]`, `NOT NULL DEFAULT '{}'`, consumed by Tasks 3 and 4.

- [ ] **Step 1: Add the `tags` column to the `modelFaces` table definition**

In `packages/db/src/schema/models.ts`, insert a new field into the `modelFaces` table (right after `faceSideR2Key`, before `publicApiSlug`):

```ts
export const modelFaces = pgTable('model_faces', {
  id: uuid('id').primaryKey().defaultRandom(),
  gender: text('gender').notNull(), // 'men' | 'women' | 'boys' | 'girls'
  label: text('label').notNull(),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  faceSideR2Key: text('face_side_r2_key'), // ComfyUI-specific face image (moved from model_pose_assets)
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`), // free-form entity tags, e.g. "warm tone", "closeup"
  // Public developer-API exposure. NULL = not reachable from /v1/dev/*; non-null =
  ...
```

(`sql` is already imported at the top of this file — no new import needed.)

- [ ] **Step 2: Ensure local infra is running**

Run: `pnpm docker:up`
Expected: Postgres/Redis/MinIO containers up (or already running).

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `packages/db/src/migrations/0145_model_face_tags.sql` is created (drizzle-kit picks the next free index after `0144_drop_merchant_credits.sql`), plus a matching entry added to `packages/db/src/migrations/meta/_journal.json` and a new snapshot file in `packages/db/src/migrations/meta/`.

- [ ] **Step 4: Verify the generated SQL**

Read the generated file and confirm it matches this shape (compare against `packages/db/src/migrations/0051_background_tags.sql`, which added the same kind of column to `model_backgrounds`):

```sql
ALTER TABLE "model_faces" ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT ARRAY[]::text[];
```

If drizzle-kit picked a different filename or index, that's fine — indices only need to be sequential, not exactly `0145`. If it collides with a name already in `_journal.json`, re-run `pnpm db:generate` after confirming no stale build artifacts (`packages/db/dist`) are interfering.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add tags column to model_faces"
```

---

### Task 2: Zod schema updates

**Files:**
- Modify: `packages/types/src/admin.ts:169-176` (`ConfirmModelFaceBody`)
- Modify: `packages/types/src/admin.ts:203-212` (`PatchModelFaceBody`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ConfirmModelFaceBody.tags` and `PatchModelFaceBody.tags`, both `string[] | undefined`, consumed by Task 3's route handlers via Fastify's Zod validation.

- [ ] **Step 1: Add `tags` to `ConfirmModelFaceBody`**

```ts
export const ConfirmModelFaceBody = z.object({
  label: z.string().min(1).max(120),
  gender: GenderEnum,
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  faceSideR2Key: z.string().min(1).optional(),
  sortOrder: z.number().int().default(0),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
```

- [ ] **Step 2: Add `tags` to `PatchModelFaceBody`**

```ts
export const PatchModelFaceBody = z.object({
  label: z.string().min(1).max(120).optional(),
  gender: GenderEnum.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  r2Key: z.string().optional(),
  thumbnailKey: z.string().optional(),
  faceSideR2Key: z.string().nullable().optional(),
  publicApiSlug: PublicApiSlugField,
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/admin.ts
git commit -m "feat(types): allow tags on model face confirm/patch bodies"
```

---

### Task 3: Admin API — confirm/patch a face's tags

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts:70-98` (`POST /admin/assets/faces/confirm`)
- Test: `apps/api/test/integration/model-face-tags.test.ts`

**Interfaces:**
- Consumes: `schema.modelFaces.tags` (Task 1), `ConfirmModelFaceBody`/`PatchModelFaceBody` with `tags` (Task 2).
- Produces: `POST /admin/assets/faces/confirm` returns the inserted row including `tags`; `PATCH /admin/assets/faces/:id` accepts `{ tags: string[] }` in its body (no route code change needed — it already spreads `req.body` into `.set()`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/model-face-tags.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('model face tags (admin)', () => {
  let containers: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
    headers = await adminAuthHeader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  it('stores tags on confirm and updates them via PATCH', async () => {
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/faces/confirm',
      headers,
      payload: {
        label: 'Tagged Face',
        gender: 'men',
        r2Key: 'test/face.jpg',
        thumbnailKey: 'test/face.thumb.jpg',
        sortOrder: 0,
        tags: ['warm tone', 'closeup'],
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    const created = confirmRes.json();
    expect(created.tags).toEqual(['warm tone', 'closeup']);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/faces/${created.id}`,
      headers,
      payload: { tags: ['studio'] },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ tags: schema.modelFaces.tags })
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, created.id));
    expect(row?.tags).toEqual(['studio']);
  });

  it('defaults tags to an empty array when omitted on confirm', async () => {
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/faces/confirm',
      headers,
      payload: {
        label: 'Untagged Face',
        gender: 'women',
        r2Key: 'test/face2.jpg',
        thumbnailKey: 'test/face2.thumb.jpg',
        sortOrder: 0,
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().tags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test test/integration/model-face-tags.test.ts`
Expected: FAIL — the confirm route doesn't insert `tags`, so `created.tags` is `undefined`, not `['warm tone', 'closeup']`. (The PATCH assertion may also fail depending on how Drizzle's `.set()` handles the extra Zod field before Task 2's schema change — but Task 2 is already done at this point, so PATCH should pass; only the confirm assertions fail.)

- [ ] **Step 3: Insert `tags` in the confirm handler**

In `apps/api/src/modules/admin/models.routes.ts`, update the `/admin/assets/faces/confirm` handler:

```ts
  app.post(
    '/admin/assets/faces/confirm',
    {
      preHandler: RW,
      schema: { body: ConfirmModelFaceBody },
    },
    async (req) => {
      const { label, gender, r2Key, thumbnailKey, faceSideR2Key, sortOrder, tags } = req.body as {
        label: string;
        gender: string;
        r2Key: string;
        thumbnailKey: string;
        faceSideR2Key?: string;
        sortOrder: number;
        tags?: string[];
      };
      const [row] = await app.db
        .insert(schema.modelFaces)
        .values({
          label,
          gender,
          r2Key,
          thumbnailKey,
          faceSideR2Key: faceSideR2Key ?? null,
          sortOrder,
          tags: tags ?? [],
        })
        .returning();
      return row;
    },
  );
```

The `PATCH /admin/assets/faces/:id` handler needs no change — it already does `.set({ ...(req.body as object), updatedAt: new Date() })`, so once `PatchModelFaceBody` (Task 2) allows `tags`, it flows through automatically.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test test/integration/model-face-tags.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts apps/api/test/integration/model-face-tags.test.ts
git commit -m "feat(api): persist tags on model face confirm/patch"
```

---

### Task 4: Public API — `GET /v1/models/faces` returns tags

**Files:**
- Modify: `apps/api/src/modules/models/routes.ts:99-133` (`GET /v1/models/faces`)
- Test: `apps/api/test/integration/model-faces-tags-public.test.ts`

**Interfaces:**
- Consumes: `schema.modelFaces.tags` (Task 1).
- Produces: `GET /v1/models/faces` response items include `tags: string[]`, consumed by Task 7 (`FaceItem.tags` in `studio/page.tsx`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/model-faces-tags-public.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('GET /v1/models/faces', () => {
  let containers: Containers;
  let app: TestApp;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  // Register + verify + login, returning an access token — same pattern as
  // apps/api/test/integration/catalogue-templates-public.test.ts's loginToken helper.
  async function loginToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('includes tags in the response', async () => {
    await app.db.insert(schema.modelFaces).values({
      gender: 'men',
      label: 'Tagged Face',
      r2Key: 'test/face.jpg',
      thumbnailKey: 'test/face.thumb.jpg',
      tags: ['warm tone', 'closeup'],
    });

    const accessToken = await loginToken(`face-tags-${Date.now()}@x.com`);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/faces?gender=men',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { label: string; tags: string[] }[];
    const found = items.find((i) => i.label === 'Tagged Face');
    expect(found?.tags).toEqual(['warm tone', 'closeup']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test test/integration/model-faces-tags-public.test.ts`
Expected: FAIL — `found?.tags` is `undefined` because the route doesn't select `tags` yet.

- [ ] **Step 3: Add `tags` to the route's select and response**

In `apps/api/src/modules/models/routes.ts`, update `GET /v1/models/faces`:

```ts
      const items = await app.db
        .select({
          id: schema.modelFaces.id,
          gender: schema.modelFaces.gender,
          label: schema.modelFaces.label,
          thumbnailUrl: schema.modelFaces.thumbnailKey,
          tags: schema.modelFaces.tags,
        })
        .from(schema.modelFaces)
        .where(
          and(
            eq(schema.modelFaces.gender, gender),
            eq(schema.modelFaces.isActive, true),
            isNull(schema.modelFaces.deletedAt),
          ),
        )
        .orderBy(asc(schema.modelFaces.sortOrder), asc(schema.modelFaces.label));

      return {
        items: items.map((i) => ({ ...i, thumbnailUrl: app.storage.publicUrl(i.thumbnailUrl) })),
      };
```

(`tags` rides along automatically in the `{ ...i, ... }` spread — no further change needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test test/integration/model-faces-tags-public.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full API test suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS — no existing test asserts an exact shape of `/v1/models/faces` items that the added `tags` field would break (spot-check: `grep -rn "v1/models/faces" apps/api/test` before running, to be sure).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/models/routes.ts apps/api/test/integration/model-faces-tags-public.test.ts
git commit -m "feat(api): expose tags on GET /v1/models/faces"
```

---

### Task 5: Admin UI — tags input on the face edit card

**Files:**
- Modify: `apps/admin-web/src/types.ts:3-17` (`ModelFace` interface)
- Modify: `apps/admin-web/src/components/EditFaceModal.tsx`

**Interfaces:**
- Consumes: `PATCH /admin/assets/faces/:id` accepting `tags` (Task 3).
- Produces: nothing consumed by later tasks — this is the admin-facing leaf.

- [ ] **Step 1: Add `tags` to the `ModelFace` type**

In `apps/admin-web/src/types.ts`, add a field to `ModelFace` (mirrors `ModelBackground.tags` at line 26):

```ts
export interface ModelFace {
  id: string;
  gender: GenderSlug;
  label: string;
  thumbnailKey: string;
  r2Key: string;
  faceSideR2Key: string | null;
  tags: string[];
  /** Non-null = published to the public developer API under this slug. */
  publicApiSlug: string | null;
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add tags to the edit form state**

In `apps/admin-web/src/components/EditFaceModal.tsx`, update the `useState` initializer:

```ts
  const [form, setForm] = useState({
    label: face.label,
    gender: face.gender,
    sortOrder: face.sortOrder,
    publicApiSlug: face.publicApiSlug ?? '',
    tagsInput: (face.tags ?? []).join(', '),
  });
```

- [ ] **Step 3: Send parsed tags on save**

Replace the `handleSave` body's PATCH call — currently it PATCHes the raw `form` object (which now also contains `tagsInput`, not a real API field). Update it to parse tags and swap the field name:

```ts
  const handleSave = async () => {
    setSaving(true);
    try {
      const tags = form.tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const body = {
        label: form.label,
        gender: form.gender,
        sortOrder: form.sortOrder,
        publicApiSlug: form.publicApiSlug,
        tags,
      };
      await apiFetch(`/admin/assets/faces/${face.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onSaved({ ...face, ...body });
      toast({ title: `${form.label} updated` });
      onClose();
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update face',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 4: Add the tags input to the form JSX**

In the same file, add a tags field right after the `PublicApiSlugField` block (before the "Replace image" field), matching `EditBackgroundModal.tsx`'s tags field styling:

```tsx
          <div className="field">
            <label>
              Tags <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              className="input"
              value={form.tagsInput}
              disabled={saving}
              placeholder="e.g. warm tone, closeup, studio"
              onChange={(e) => setForm((f) => ({ ...f, tagsInput: e.target.value }))}
            />
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
            Tags are comma-separated — lets you filter models in Studio (e.g. all "closeup" faces).
          </p>
```

- [ ] **Step 5: Typecheck**

`apps/admin-web` has no standalone `typecheck` script — its `build` script (`tsc -b && vite build`) is what type-checks it.

Run: `pnpm --filter @tryme/admin build`
Expected: PASS, no type errors.

- [ ] **Step 6: Manual verification**

Run: `pnpm --filter @tryme/admin dev`, open the admin panel, go to the Faces tab, edit a face, add tags like `warm tone, closeup`, save, re-open the edit modal, and confirm the tags persisted (comma-joined in the input).

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/components/EditFaceModal.tsx
git commit -m "feat(admin): add tags input to the face edit card"
```

---

### Task 6: Studio — generic tag-filter support in `SelectGridModal`

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/select-modal.tsx`

**Interfaces:**
- Produces: `SelectGridModal` gains optional props `tagOptions?: string[]`, `activeTag?: string`, `onTagChange?: (tag: string) => void`; `SelectableItem` gains optional `tags?: string[]`. Consumed by Task 7.

- [ ] **Step 1: Extend the props and item type**

In `apps/catalogues-web/src/app/(app)/studio/select-modal.tsx`:

```ts
interface SelectableItem {
  id: string;
  label: string;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  tags?: string[];
}

interface SelectGridModalProps<T extends SelectableItem> {
  title: string;
  items: T[];
  selectedIds: string[];
  multiSelect?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  cardHeight?: number;
  aspect?: number;
  columns?: number;
  continueLabel?: string;
  hideLabels?: boolean;
  tagOptions?: string[];
  activeTag?: string;
  onTagChange?: (tag: string) => void;
}
```

- [ ] **Step 2: Destructure the new props and filter items by tag**

```ts
export function SelectGridModal<T extends SelectableItem>({
  title,
  items,
  selectedIds,
  multiSelect = false,
  onSelect,
  onClose,
  cardHeight = 148,
  aspect,
  columns = 4,
  continueLabel,
  hideLabels = false,
  tagOptions,
  activeTag = '',
  onTagChange,
}: SelectGridModalProps<T>) {
  const visibleItems =
    !activeTag || !tagOptions?.length
      ? items
      : items.filter((item) => (item.tags ?? []).includes(activeTag));
```

(`columns` is currently accepted but unused in the render — leave that pre-existing behavior as-is, out of scope here.)

- [ ] **Step 3: Render the tag-chip row and switch the grid to `visibleItems`**

Add a chip row right before the existing `{items.length === 0 ? ...}` block, and change every subsequent reference from `items` to `visibleItems` in that block (the `.length === 0` check and the `.map(...)`):

```tsx
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tagOptions && tagOptions.length > 0 && onTagChange && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => onTagChange('')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${activeTag === '' ? C.pink : C.border2}`,
                  background: activeTag === '' ? 'rgba(245,92,122,0.08)' : C.white,
                  color: activeTag === '' ? C.pink : C.text,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                All tags
              </button>
              {tagOptions.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  onClick={() => onTagChange(tag)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 8,
                    border: `1px solid ${activeTag === tag ? C.pink : C.border2}`,
                    background: activeTag === tag ? 'rgba(245,92,122,0.08)' : C.white,
                    color: activeTag === tag ? C.pink : C.text,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {visibleItems.length === 0 ? (
            <p style={{ fontSize: 14, color: C.mid }}>Nothing available yet.</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: 16,
              }}
            >
              {visibleItems.map((item) => {
```

The rest of the `.map` body is unchanged — only the `items.map` → `visibleItems.map` swap and the new chip row are new.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/select-modal.tsx
git commit -m "feat(web): add optional tag-filter chips to SelectGridModal"
```

---

### Task 7: Studio — wire the tag filter into the face picker

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: `FaceItem.tags` from `GET /v1/models/faces` (Task 4); `SelectGridModal`'s `tagOptions`/`activeTag`/`onTagChange` props (Task 6).
- Produces: nothing consumed elsewhere — Studio-facing leaf.

- [ ] **Step 1: Add `tags` to `FaceItem`**

```ts
interface FaceItem {
  id: string;
  label: string;
  thumbnailUrl: string;
  gender: string;
  tags: string[];
}
```

- [ ] **Step 2: Add face tag state and memos**

Near the existing `bgTagsById`/`bgSpecialTagById`/`bgTags` memos (around line 818), and near `backgroundTagFilter`'s declaration (line 576), add:

```ts
  const [modelTagFilter, setModelTagFilter] = useState<string>('');
```

```ts
  const faceTags = useMemo(() => {
    const set = new Set<string>();
    for (const f of faces?.items ?? []) for (const t of f.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [faces]);
```

- [ ] **Step 3: Filter the modal's item list by the active tag**

Add a memo right after `filteredFaces` (line 652):

```ts
  const modalFaces = useMemo(
    () =>
      modelTagFilter === ''
        ? filteredFaces
        : filteredFaces.filter((f) => (f.tags ?? []).includes(modelTagFilter)),
    [filteredFaces, modelTagFilter],
  );
```

- [ ] **Step 4: Pass the new props into the faces `SelectGridModal`**

Update the call around line 2757:

```tsx
              {modelModalOpen && faces && (
                <SelectGridModal
                  title="Choose your model"
                  items={modalFaces}
                  selectedIds={faceId ? [faceId] : []}
                  aspect={1}
                  columns={5}
                  tagOptions={faceTags}
                  activeTag={modelTagFilter}
                  onTagChange={setModelTagFilter}
                  onSelect={(id) => {
                    handleFaceSelect(id);
                    setModelModalOpen(false);
                  }}
                  onClose={() => setModelModalOpen(false)}
                />
              )}
```

(Only `items` and the three new props changed — `selectedIds`, `aspect`, `columns`, `onSelect`, `onClose` are unchanged.)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification**

Run: `pnpm dev` (or `pnpm --filter @tryme/web dev` + `pnpm --filter @tryme/api dev`), open Studio, tag two or more faces with different tags via the admin panel (Task 5) first, then in Studio step 1 click "View All" on the model picker and confirm:
- The "All tags" + per-tag chip row renders above the grid.
- Clicking a tag filters the grid to matching faces only.
- Clicking "All tags" restores the full list.
- Selecting a face still works and closes the modal.
- The inline (non-modal) 5-col face preview above "View All" is unaffected — always shows the unfiltered first-N faces, exactly as before.

- [ ] **Step 7: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): filter Studio face picker by tag"
```
