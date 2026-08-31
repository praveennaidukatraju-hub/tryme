# Model Face Tags — Design

## Goal

Add free-form tags to `model_faces`, mirroring the existing `model_backgrounds.tags`
feature: admin-editable tags on the face edit card, plus a tag-filter chip row in the
Studio face picker — full parity with how backgrounds already work.

## Non-goals

- No `specialTag` (Featured/Trending/Popular) equivalent for faces — backgrounds have
  this via a separate dropdown, but it wasn't asked for and faces have no analogous
  concept today.
- No category system for faces — backgrounds have `categoryId` + a category CRUD UI;
  out of scope here.
- No tags field on `AddFaceModal` (face creation) — backgrounds don't have one on
  `BackgroundUploadModal` either; tags are edit-only there, so faces follow the same
  pattern.
- No changes to `embed-studio-wizard.tsx`'s face picker — that surface wasn't part of
  the ask; the new `SelectGridModal` props are optional so it's unaffected either way.

## 1. Data model

Add to `packages/db/src/schema/models.ts`, `modelFaces` table:

```ts
tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
```

Same shape as `modelBackgrounds.tags` (models.ts:46). New migration
`packages/db/src/migrations/0145_model_faces_tags.sql` (next free index after 0144 —
see `git show origin/master:...` collision-check rule in CLAUDE.md before merging if
this diverges).

## 2. Types + API

**`packages/types/src/admin.ts`**
- `ConfirmModelFaceBody`: add `tags: z.array(z.string().min(1).max(40)).max(20).optional()`.
- `PatchModelFaceBody`: add the same field.
(Bounds copied from `ConfirmModelBackgroundBody`/`PatchModelBackgroundBody`.)

**`apps/api/src/modules/admin/models.routes.ts`**
- `POST /admin/assets/faces/confirm`: destructure `tags` from body, insert
  `tags: tags ?? []`.
- `PATCH /admin/assets/faces/:id`: no code change — handler already spreads
  `req.body` into `.set()`, so `tags` flows through once the Zod schema allows it.
- `GET /admin/assets/faces`: no change — `select()` (full row) already includes `tags`
  once the column exists.

**`apps/api/src/modules/models/routes.ts`** (public/user-facing)
- `GET /v1/models/faces`: add `tags: schema.modelFaces.tags` to the `select()`, and
  include `tags: i.tags` in the response `items.map(...)`.

## 3. Admin UI (`apps/admin-web`)

- `src/types.ts`: add `tags: string[]` to the `ModelFace` interface.
- `src/components/EditFaceModal.tsx`: add a tags input block, copied from
  `EditBackgroundModal.tsx`'s pattern —
  - form state: `tagsInput: (face.tags ?? []).join(', ')`
  - on save: split on `,`, trim, filter empty, send as `tags` in the PATCH body
  - same label/placeholder/helper-text style ("Tags (optional)", "e.g. ...",
    comma-separated helper line).
- `src/pages/assets/FacesTab.tsx`: no changes — backgrounds don't render tag chips on
  their cards either (only `specialTag`, which faces don't have), so face cards stay
  as-is.

## 4. Studio filter UI (`apps/catalogues-web`)

**`src/app/(app)/studio/select-modal.tsx`** — extend `SelectGridModal` generically,
backward-compatibly:
- `SelectableItem` gains optional `tags?: string[]`.
- New optional props: `tagOptions?: string[]`, `activeTag?: string`,
  `onTagChange?: (tag: string) => void`.
- When `tagOptions` is passed and non-empty, render an "All tags" + per-tag pill row
  above the grid (visually matching the inline chip row already used for backgrounds
  in `studio/page.tsx`), and filter `items` by `activeTag` before rendering the grid.
- All new props are optional; existing callers (poses, lower/shoe, catalogue
  templates, embed wizard) pass nothing and see no behavior change.

**`src/app/(app)/studio/page.tsx`**
- `FaceItem` interface: add `tags: string[]`.
- Add `faceTagsById` / `faceTags` memos, computed the same way as the existing
  `bgTagsById` / `bgTags` (lines ~818-832).
- Add `modelTagFilter` state (mirrors `backgroundTagFilter`).
- Pass `tagOptions={faceTags}`, `activeTag={modelTagFilter}`,
  `onTagChange={setModelTagFilter}` into the faces `SelectGridModal` call (~line
  2758), and filter the `items` passed to it by `modelTagFilter` before rendering
  (same approach as the background modal's `filteredItems` at ~line 3275).
- The inline 5-col face preview grid (before "View All" is clicked) is untouched —
  tag filtering only applies inside the "Choose your model" modal, matching how
  backgrounds' tag chips also only live inside their picker modal, not the inline
  grid.

## Testing

- `apps/api` integration test: PATCH a face's tags, confirm a face with tags, GET
  `/v1/models/faces` returns tags.
- Manual: admin edit-card tags round-trip; Studio face-picker modal tag chips filter
  correctly; existing `SelectGridModal` callers (poses, lower/shoe, templates) render
  unchanged.
