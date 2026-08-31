# Google Drive Export — Catalog Page Addendum

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The original Google Drive export (see
`docs/superpowers/plans/2026-08-21-google-drive-export.md`) only added "Save
to Drive" to the live Studio results grid
(`apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`). The
saved-catalog detail page (`/catalogs/[id]`,
`apps/catalogues-web/src/app/(app)/catalogs/[id]/page.tsx`) has its own
**independent** download implementation and never picked up the feature —
confirmed by reading the file: it doesn't import or render
`GenerationPanel`, it has its own per-tile download button (`ImageCard`
component, ~line 500-567) and its own `handleDownloadAll` (~line 703-771).
This adds Save to Drive to both, on this page, using the exact same backend
route the Studio button already calls — no API changes needed.

**No backend changes.** `POST /v1/jobs/:id/export/google-drive` already
authorizes on `job.userId === req.userId` regardless of which UI screen
calls it (`apps/api/src/modules/google-drive/service.ts`) — this task is
UI-only.

---

## Context for the engineer

- `useGoogleDriveStatus()` (`apps/catalogues-web/src/hooks/use-google-drive-status.ts`)
  and `DriveIcon` (`apps/catalogues-web/src/components/icons.tsx:115`)
  already exist from the original implementation — reuse both as-is, do not
  duplicate them.
- This page's per-tile component is `ImageCard`
  (`catalogs/[id]/page.tsx:142-154`), which already receives `job: Job` —
  `job.id` is what the export route needs.
- The page-level component (default export, `params: Promise<{ id: string }>`)
  owns `handleDownloadAll` and the top-level `downloading`/`downloadErr`
  state (~line 590-771) — the "Save All to Drive" control lives at the same
  level, next to the existing "Download All" button (~line 879-907).
- Match `generation-panel.tsx`'s reference implementation for the connect
  redirect: if `driveStatus.data?.status !== 'CONNECTED'`, navigate to
  `/api/integrations/google-drive/connect` (the existing BFF route at
  `apps/catalogues-web/src/app/api/integrations/google-drive/connect/route.ts`)
  instead of calling the export endpoint directly.

---

### Task 1: Per-image "Save to Drive" in `ImageCard`

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogs/[id]/page.tsx`

- [ ] **Step 1: Import what's needed**

Add to the existing import block (~line 5-20):

```ts
import { DriveIcon } from '@/components/icons'; // add to the existing icons.tsx import list, don't duplicate the import statement
import { useGoogleDriveStatus } from '@/hooks/use-google-drive-status';
```

- [ ] **Step 2: Add state and the export handler inside `ImageCard`**

Next to the existing `const [downloading, setDownloading] = useState(false);`
(line 163), add:

```ts
const driveStatus = useGoogleDriveStatus();
const [savingToDrive, setSavingToDrive] = useState(false);

async function saveToDrive() {
  if (savingToDrive) return;
  if (driveStatus.data?.status !== 'CONNECTED') {
    window.location.href = '/api/integrations/google-drive/connect';
    return;
  }
  setSavingToDrive(true);
  try {
    await api.post(`/v1/jobs/${job.id}/export/google-drive`, {});
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Could not save to Google Drive. Try again.');
  } finally {
    setSavingToDrive(false);
  }
}
```

- [ ] **Step 3: Add the button next to the existing download button**

Find the existing download `<button>` block (lines 520-566, ending
`{downloading ? <SpinnerIcon size={14} /> : <DownloadIcon size={16} />}` then
`</button>`). Insert a new button immediately after its closing `</button>`
(still inside the same `{isCompleted && result?.url && (<>...</>)}` block,
before its own closing `</>`):

```tsx
                <button
                  type="button"
                  disabled={savingToDrive}
                  title="Save to Drive"
                  onClick={saveToDrive}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: savingToDrive ? C.border : C.lighter,
                    cursor: savingToDrive ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: C.mid,
                    border: 'none',
                    padding: 0,
                  }}
                >
                  {savingToDrive ? <SpinnerIcon size={14} /> : <DriveIcon size={16} />}
                </button>
```

(Styled to match this page's existing button chrome — `C.lighter`/`C.mid`,
not the Studio grid's floating-circle style, since this page's buttons sit
in a flat toolbar row, not overlaid on the image.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/web run typecheck`
Expected: no errors.

---

### Task 2: "Save All to Drive" next to "Download All"

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogs/[id]/page.tsx` (same file, page-level component)

- [ ] **Step 1: Add state and the bulk handler**

Next to `const [downloading, setDownloading] = useState(false);` at the
page-level component (line 596), add:

```ts
const driveStatus = useGoogleDriveStatus();
const [savingAllToDrive, setSavingAllToDrive] = useState(false);
const [driveErr, setDriveErr] = useState<string | null>(null);

async function handleSaveAllToDrive() {
  if (!data || savingAllToDrive) return;
  if (driveStatus.data?.status !== 'CONNECTED') {
    window.location.href = '/api/integrations/google-drive/connect';
    return;
  }
  const completed = data.jobs.filter((j) => j.status === 'COMPLETED');
  if (completed.length === 0) return;
  setSavingAllToDrive(true);
  setDriveErr(null);
  try {
    const results = await Promise.allSettled(
      completed.map((job) => api.post(`/v1/jobs/${job.id}/export/google-drive`, {})),
    );
    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures > 0) {
      setDriveErr(
        `${failures} of ${completed.length} image${completed.length !== 1 ? 's' : ''} failed to save to Drive.`,
      );
    }
  } finally {
    setSavingAllToDrive(false);
  }
}
```

Add the matching auto-dismiss effect next to the existing `downloadErr` one
(line 634-638):

```ts
useEffect(() => {
  if (!driveErr) return;
  const t = setTimeout(() => setDriveErr(null), 3500);
  return () => clearTimeout(t);
}, [driveErr]);
```

- [ ] **Step 2: Add the button next to "Download All"**

Find the "Download All" button (~line 879-907, `onClick={handleDownloadAll}`
... `Download All <ImageDownIcon size={20} />`). Add a sibling button
immediately after it, inside the same toolbar container:

```tsx
            <button
              type="button"
              onClick={handleSaveAllToDrive}
              disabled={savingAllToDrive || completedCount === 0}
              style={{
                /* mirror the Download All button's existing style block exactly —
                   read it at implementation time rather than duplicate a stale
                   copy here; only cursor/opacity should key off savingAllToDrive
                   instead of downloading */
              }}
            >
              {savingAllToDrive ? (
                <>
                  <SpinnerIcon size={18} /> Saving…
                </>
              ) : (
                <>
                  Save All to Drive <DriveIcon size={20} />
                </>
              )}
            </button>
```

- [ ] **Step 3: Surface `driveErr`**

Find where `downloadErr` is rendered (~line 1025-1041). Add an equivalent
block for `driveErr` immediately after it, reusing the same toast/inline
error styling.

- [ ] **Step 4: Typecheck and manual check**

Run: `pnpm --filter @tryme/web run typecheck`

Manual: open a completed catalog at `/catalogs/[id]`, confirm both the
per-image and "Save All" buttons appear, behave correctly when Drive isn't
yet connected (redirect to connect flow) and when it is (export succeeds),
and that partial-failure messaging matches the existing Download All
pattern's tone.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/catalogs/\[id\]/page.tsx
git commit -m "feat(web): add Save to Drive / Save All to Drive on the catalog detail page"
```

---

## Self-review

- **Scope:** UI-only, one file, reuses the existing hook/icon/route from the
  original implementation — no backend or schema changes.
- **Placeholders:** Task 2 Step 2 deliberately doesn't fabricate the exact
  style object for the new button — copy the real, current "Download All"
  button's style block rather than guess it, since this plan wasn't written
  against a fresh read of every property on that block.
