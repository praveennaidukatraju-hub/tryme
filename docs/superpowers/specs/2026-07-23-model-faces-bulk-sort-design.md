# Model Faces bulk sort order — design

## Problem

Admin panel's Model Faces view (`apps/admin-web/src/pages/assets/FacesTab.tsx`) has no way to
set display order. `model_faces.sortOrder` column exists in the DB and is fully wired through
the API (`ConfirmModelFaceBody`, `PatchModelFaceBody` both accept `sortOrder`), but:

- `GET /admin/assets/faces` returns rows with no `ORDER BY`, so order is undefined/insertion-order.
- `FacesTab` never sorts by `sortOrder` before rendering.
- There is no bulk UI to assign sort order to multiple faces at once.

The Pose Assets tab (`PoseAssetsTab.tsx`) already solved this exact problem for
`model_pose_assets`. This design ports that pattern to faces.

## Approach

Reuse the PoseAssetsTab bulk-sort pattern verbatim, adapted to faces:

1. **API — `apps/api/src/modules/admin/models.routes.ts`**
   Add `.orderBy(schema.modelFaces.sortOrder)` to the `GET /admin/assets/faces` query
   (currently `app.db.select().from(schema.modelFaces).where(isNull(...))` with no ordering).
   No schema/type changes — `PatchModelFaceBody` already has `sortOrder: z.number().int().optional()`.

2. **Frontend — `apps/admin-web/src/pages/assets/FacesTab.tsx`**
   - Add state: `bulkSortStart` (number, default `0`), `bulkSortSaving` (boolean).
   - Add `doBulkSortOrder()`: takes `filteredFaces` filtered down to `selectedFaceIds` (preserving
     current on-screen order), maps to `{ id, sortOrder: bulkSortStart + i }`, fires parallel
     `PATCH /admin/assets/faces/:id` requests with `{ sortOrder }`, then updates local `faces`
     state and toasts a success/error message. Mirrors `doBulkSortOrder` in `PoseAssetsTab.tsx:210-245`.
   - Add UI: in the selection toolbar (next to the existing "Move to recycle bin" bulk-action
     button), render a "Sort from [number input] [Apply]" control, visible only when
     `selectedFaceIds.length > 0`. Mirrors the toolbar block in `PoseAssetsTab.tsx:475-496`.
   - Change `filteredFaces` derivation to sort by `sortOrder` ascending before pagination, so the
     grid reflects the field once it's set.

## Out of scope

- Drag-and-drop reordering (bulk numeric input only, matching existing Pose Assets UX).
- Changing `sortOrder` behavior for any other asset type (backgrounds, catalog items, etc.).
- Any change to `POST /admin/assets/faces/confirm` (single-face creation already accepts `sortOrder`).

## Testing

- Manual: open admin panel → Assets → Model Faces, select several faces, set "Sort from" to a
  number, click Apply, confirm the grid re-orders and persists after a page reload.
- No new automated tests planned — this mirrors an existing, untested UI pattern
  (`PoseAssetsTab`'s bulk sort has no test coverage either).
