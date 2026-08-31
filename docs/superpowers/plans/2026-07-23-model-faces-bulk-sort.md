# Model Faces Bulk Sort Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins bulk-assign `sortOrder` to selected Model Faces from the Assets page, and have the Faces grid actually reflect that order.

**Architecture:** `GET /admin/assets/faces` gains an `ORDER BY sortOrder` clause (one-line API change, no schema/type change — `sortOrder` is already a column and already accepted by `PatchModelFaceBody`). `FacesTab.tsx` gets a "Sort from [N] [Apply]" bulk-action control that fires parallel `PATCH /admin/assets/faces/:id` calls assigning sequential `sortOrder` values to the current selection, in on-screen order — mirroring the existing, working `doBulkSortOrder` in `PoseAssetsTab.tsx`. The displayed list is sorted by `sortOrder` before pagination.

**Tech Stack:** Fastify 5 + Drizzle ORM (API), React + TypeScript + Vite (admin-web SPA). No test framework exists in `apps/admin-web` — verification is `tsc -b` (typecheck/build) plus manual browser check, matching how `PoseAssetsTab`'s identical pattern was verified.

## Global Constraints

- Never use raw hex/hardcoded colors in admin-web — use existing `.btn`, `.input`, `.badge` classes already used elsewhere in `FacesTab.tsx` (this file doesn't use the `C` token map from `apps/catalogues-web`; it uses plain CSS classes — follow the file's own existing conventions).
- No new API endpoint, no new Zod schema — `PatchModelFaceBody` (`packages/types/src/admin.ts:140-148`) already has `sortOrder: z.number().int().optional()`.
- Follow the exact UX/code shape of `PoseAssetsTab.tsx`'s bulk sort (lines 61-62, 210-245, 475-496) for consistency across admin tabs.
- Per project CLAUDE.md: only commit when a full, verified unit of work is done — one commit at the end of this plan, not per task, since the two tasks are small and interdependent.

---

### Task 1: Order Faces by `sortOrder` in the API

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts:29-35`

**Interfaces:**
- Consumes: `schema.modelFaces` (from `@tryme/db`), already imported at top of file.
- Produces: `GET /admin/assets/faces` now returns `{ items: ModelFace[] }` sorted ascending by `sortOrder` — Task 2's frontend sort becomes a no-op safety net once this lands, but both are kept per the approved design.

- [ ] **Step 1: Read current route to confirm exact text to replace**

Current code (`apps/api/src/modules/admin/models.routes.ts:29-35`):

```ts
  app.get('/admin/assets/faces', { preHandler: RW }, async () => {
    const rows = await app.db
      .select()
      .from(schema.modelFaces)
      .where(isNull(schema.modelFaces.deletedAt));
    return { items: rows };
  });
```

- [ ] **Step 2: Add `.orderBy(schema.modelFaces.sortOrder)`**

Replace the block above with:

```ts
  app.get('/admin/assets/faces', { preHandler: RW }, async () => {
    const rows = await app.db
      .select()
      .from(schema.modelFaces)
      .where(isNull(schema.modelFaces.deletedAt))
      .orderBy(schema.modelFaces.sortOrder);
    return { items: rows };
  });
```

- [ ] **Step 3: Typecheck the API package**

Run: `pnpm --filter @tryme/api build`
Expected: exits 0, no TypeScript errors. `.orderBy()` is a standard Drizzle query builder method already used elsewhere in this same file (e.g. line 422 `orderBy(schema.modelPoseAssets.sortOrder, ...)`), so no import changes are needed.

- [ ] **Step 4: Manual smoke test**

With `pnpm docker:up` and the API running (`pnpm --filter @tryme/api dev`), hit the endpoint:

```bash
curl -s http://localhost:4000/admin/assets/faces -H "Cookie: access_token=<a valid admin session cookie>" | python3 -m json.tool | head -30
```

Expected: request succeeds (401 means you need a real admin cookie — this step is optional if the admin panel itself will be used for verification in Task 2's manual check instead). Skip this step if no admin session is readily available; Task 2's browser check covers end-to-end verification.

---

### Task 2: Bulk sort UI in FacesTab

**Files:**
- Modify: `apps/admin-web/src/pages/assets/FacesTab.tsx`

**Interfaces:**
- Consumes: `apiFetch` (from `../../lib/data`), `apiErrorMessage` (same module), `faces`/`setFaces`/`toast` from `useAssetsContext()` — all already imported/destructured in this file (`FacesTab.tsx:8,10,23-33`). `ModelFace` type already has `sortOrder: number` (`apps/admin-web/src/types.ts:11`).
- Produces: nothing consumed by other tasks — this is the last task in the plan.

- [ ] **Step 1: Add bulk-sort state**

In `FacesTab.tsx`, right after the existing state declarations (after line 61, `const [facesPage, setFacesPage] = useState(1);`), add:

```ts
  const [bulkSortStart, setBulkSortStart] = useState(0);
  const [bulkSortSaving, setBulkSortSaving] = useState(false);
```

- [ ] **Step 2: Add `doBulkSortOrder` function**

Directly after the existing `doBulkDeleteFaces` function (after the closing `};` that currently ends at line 117), add:

```ts
  const doBulkSortOrder = async () => {
    if (selectedFaceIds.length === 0) return;
    setBulkSortSaving(true);
    const orderedSelected = filteredFaces
      .filter((f) => selectedFaceIds.includes(f.id))
      .map((f, i) => ({ id: f.id, sortOrder: bulkSortStart + i }));
    try {
      await Promise.all(
        orderedSelected.map(({ id, sortOrder }) =>
          apiFetch(`/admin/assets/faces/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sortOrder }),
          }),
        ),
      );
      setFaces((prev) =>
        prev.map((f) => {
          const entry = orderedSelected.find((e) => e.id === f.id);
          return entry ? { ...f, sortOrder: entry.sortOrder } : f;
        }),
      );
      toast({
        title: `Sort order updated for ${orderedSelected.length} face${orderedSelected.length !== 1 ? 's' : ''}`,
      });
      setSelectedFaceIds([]);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to update sort order',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setBulkSortSaving(false);
    }
  };
```

Note: this references `filteredFaces`, which is currently declared *after* this point in the file (line 119). Since `doBulkSortOrder` is only called from a JSX event handler (never during render), and `filteredFaces` is in the same closure by the time the component re-renders, this matches the exact ordering already used successfully in `PoseAssetsTab.tsx` (its `doBulkSortOrder` at line 210 also references `filteredPoseAssets` declared later at line 273) — no need to reorder declarations.

- [ ] **Step 3: Sort `filteredFaces` by `sortOrder`**

Current code (`FacesTab.tsx:119`):

```ts
  const filteredFaces = faces.filter((f) => genderFilter === 'all' || f.gender === genderFilter);
```

Replace with:

```ts
  const filteredFaces = faces
    .filter((f) => genderFilter === 'all' || f.gender === genderFilter)
    .sort((a, b) => a.sortOrder - b.sortOrder);
```

- [ ] **Step 4: Add the "Sort from" control to the selection toolbar**

Current code (`FacesTab.tsx:182-189`):

```tsx
            {selectedFaceIds.length > 0 && (
              <button
                className="btn sm danger"
                onClick={() => setConfirmBulkDeleteFaceIds([...selectedFaceIds])}
              >
                <Icon.Trash /> Move to recycle bin ({selectedFaceIds.length})
              </button>
            )}
```

Replace with:

```tsx
            {selectedFaceIds.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    Sort from
                  </span>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    step={1}
                    value={bulkSortStart}
                    disabled={bulkSortSaving}
                    onChange={(e) => setBulkSortStart(Number(e.target.value))}
                    style={{ width: 64, padding: '3px 6px', fontSize: 12, height: 28 }}
                  />
                  <button
                    className="btn sm"
                    disabled={bulkSortSaving}
                    onClick={() => void doBulkSortOrder()}
                  >
                    {bulkSortSaving ? 'Saving…' : `Apply (${selectedFaceIds.length})`}
                  </button>
                </div>
                <button
                  className="btn sm danger"
                  onClick={() => setConfirmBulkDeleteFaceIds([...selectedFaceIds])}
                >
                  <Icon.Trash /> Move to recycle bin ({selectedFaceIds.length})
                </button>
              </>
            )}
```

- [ ] **Step 5: Typecheck the admin-web package**

Run: `pnpm --filter @tryme/admin build`
Expected: exits 0, no TypeScript errors (`tsc -b && vite build`).

- [ ] **Step 6: Manual browser verification**

```bash
pnpm docker:up
pnpm --filter @tryme/api dev &
pnpm --filter @tryme/admin dev &
```

Open the admin panel, log in, go to **Assets → Model Faces**:
1. Select 3+ faces (single-click each thumbnail to toggle selection — matches existing selection UX already in this file).
2. Confirm a "Sort from [0] Apply (N)" control appears next to "Move to recycle bin".
3. Set the number to e.g. `10`, click Apply.
4. Confirm a success toast appears ("Sort order updated for N faces") and the grid re-orders so the previously-selected faces now appear first, in the order they were selected/displayed.
5. Reload the page — confirm the new order persists (this exercises Task 1's `orderBy`).

Expected: all steps pass with no console errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts apps/admin-web/src/pages/assets/FacesTab.tsx
git commit -m "$(cat <<'EOF'
feat(admin-web): bulk sort order for Model Faces

Adds a "Sort from [N] Apply" control to the Faces asset view, mirroring
the existing Pose Assets pattern. GET /admin/assets/faces now orders by
sortOrder so the change is actually visible in the grid.
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- API `.orderBy()` addition → Task 1. ✓
- Frontend bulk-sort state, function, UI, and display sort → Task 2, Steps 1-4. ✓
- Out-of-scope items (drag-and-drop, other asset types, confirm route) — untouched, none of the tasks touch them. ✓
- Testing section (manual verification, no new automated tests) → Task 1 Step 4, Task 2 Steps 5-6. ✓

**Placeholder scan:** No TBD/TODO, all code blocks are complete and copy-pasteable, no "similar to Task N" shorthand — Task 2 Step 2 explicitly repeats the full function body rather than referencing PoseAssetsTab.

**Type consistency:** `doBulkSortOrder`, `bulkSortStart`, `bulkSortSaving`, `filteredFaces`, `selectedFaceIds`, `setFaces` all match names already declared in the existing `FacesTab.tsx` (verified against the file read during design) or introduced consistently within Task 2 itself.
