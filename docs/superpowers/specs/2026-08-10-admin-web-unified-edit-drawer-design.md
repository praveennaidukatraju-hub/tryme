# Admin-Web Unified Edit Drawer — Design Spec

## Problem

`apps/admin-web` has no single popup pattern for "add or edit a record." Two screenshots surfaced this directly: **Add Model Face** opens as a small centered `.modal` (image picker, flat 2-field row, footer with Cancel + a `.btn.primary` action), while **Edit Garment Type** opens as a full-height right-side `.drawer` (much wider, fields grouped under titled sections, richer header with thumbnail + badge + slug).

It's worse than "different pages look different." Within the *same* tab, on the *exact same record type* (`GarmentTypesTab.tsx`): **Add garment type** (line 865) opens a 440px centered `.modal`, while **Edit garment type** (via `EditGarmentTypeModal.tsx`) opens a 780px `.drawer` with sectioned fields. A user adding a record and then immediately editing what they just added sees the popup shape change under them.

This isn't isolated. A repo-wide grep found 73 `.modal`/`.drawer` instances across 39 files, almost all hand-rolling their own `.modal`/`.modal-overlay` (or occasionally `.drawer`) markup independently — the same duplication problem already visible elsewhere in this codebase (6 places hand-roll a confirm-dialog's JSX instead of reusing the one `ConfirmModal` component that exists for exactly that purpose).

**Correction from the implementation plan** (`docs/superpowers/plans/2026-08-10-admin-web-unified-edit-drawer.md`): the raw grep count above includes confirm-style action dialogs ("Delete category", "Cancel job", "Move to recycle bin", bulk "Change gender for N backgrounds" pickers, etc.) that were miscounted as add/edit forms during brainstorming — a title/line-number grep can't distinguish "edit a record" from "confirm an action" or "bulk-manage a list." Reading every modal's actual header during plan-writing narrowed this to **42 genuine add/edit/create-with-input instances across ~28 files** — the plan's per-task file lists are the authoritative, verified breakdown; the Appendix below is left as the original raw inventory for scope-boundary reference (which files were checked and ruled out), not as an accurate in-scope count.

## Goal

Standardize every add/edit popup in `apps/admin-web` on the richer pattern already proven by `EditGarmentTypeModal`: full-height right-side drawer, wider, sectioned content where a form genuinely has multiple groupings, a richer header, consistent footer. Build it once as a shared component and migrate the ~42 in-scope instances (see plan) to render through it, instead of reskinning each file's bespoke markup independently.

## Scope decisions (from brainstorming)

- **In scope**: every popup that creates or edits a record — the ~73 instances in the Appendix.
- **Out of scope, left exactly as-is**:
  - Confirm dialogs — the shared `ConfirmModal` component and the 6 places that duplicate its markup (`UsersPage.tsx` ×4, `DemoCatalogPage.tsx` ×2). A yes/no confirmation becoming a wide side panel would be the wrong pattern — confirms should stay small, centered, fast to dismiss.
  - `SearchableSelect`'s dropdown and the ad hoc positioned filter/menu popovers in `AssetsPage.tsx`, `JobsPage.tsx`, `WorkersPage.tsx`, `CreditAnalysisPage.tsx` — these are lightweight, anchored-to-trigger popovers, not record forms.
  - The pre-existing `ConfirmModal.tsx` bug (`className="modal-scrim"` — a class with no CSS definition anywhere, so its backdrop renders unstyled) is a separate, already-flagged issue. Not fixed as part of this work.
- **Header content**: thumbnail shown *only* when the record actually has an image; otherwise a generic leading icon, never a placeholder/blank image box. Title plus a row of whatever real identifying tags the record has (badge, slug, status) — nothing forced to exist. Records with no thumbnail concept at all (Users, Workers, Credit Plans, Contact Requests, Settings sections) get icon + title only.
- **Section headers**: only appear where a form already has more than one genuine logical grouping (like Garment Types' "Basic Info" vs "Two-Step Generation"). Short forms (e.g. Add Model Face: image + label + gender + sort order) stay a single flat field list inside the drawer body — no manufactured "Basic Info" heading over 3 fields.
- **Footer button style**: no new button style needed. Checked directly — the "muted" look on Add Face's button in the screenshot was its `disabled` state (no image picked yet), not a different class; it's already `.btn.primary` (`background: var(--ink)`), the same class `EditGarmentTypeModal`'s "Save changes" uses. The footer just needs every migrated form routed through one shared slot: `Cancel` (`.btn.ghost`) + a primary action (`.btn.primary`), label contextual to the action ("Save changes" for edit, "Add face" / "Add garment type" / etc. for create).
- **Architecture**: one shared component, not 39 independent reskins. A shared primitive is what prevents this exact inconsistency from recurring the next time someone adds a 40th form.

## `EditDrawer` component

New file: `apps/admin-web/src/components/EditDrawer.tsx`.

```ts
interface EditDrawerProps {
  open: boolean;
  onClose: () => void;

  // Header
  title: string;
  subtitle?: string;                 // e.g. slug, shown under the title
  tags?: { label: string; tone?: 'default' | 'accent' }[]; // e.g. gender badge, status
  thumbnail?: { url: string | null; onReplace?: () => void }; // omit the prop entirely for record types with no image concept
  icon?: ReactNode;                  // fallback leading icon when `thumbnail` is not provided

  // Sizing
  width?: 'md' | 'lg';               // 'md' = existing .drawer default (640px); 'lg' = min(780px, calc(100vw - 60px)), matches EditGarmentTypeModal today

  // Body — exactly one of these two
  sections?: { title: string; children: ReactNode }[];
  children?: ReactNode;              // flat body, used when the form has one logical grouping

  // Footer
  onSave: () => void;
  saveLabel?: string;                // default 'Save changes'
  saving?: boolean;
  saveDisabled?: boolean;
}
```

Rendering:
- Backdrop: `<div className="modal-overlay" onClick={saving ? undefined : onClose}>` — the dominant, correctly-styled backdrop class (76 existing uses today), not `.scrim` (1 use) or the broken `.modal-scrim`.
- Panel: `<div className="drawer" style={{ width: ... }}>`, reusing the existing `.drawer`/`.drawer-head`/`.drawer-body`/`.drawer-foot` CSS in `tokens.css` — no new CSS needed for the container itself.
- Header: thumbnail/icon + title + subtitle + tags row, inside `.drawer-head`.
- Body: if `sections` is provided, render each as a labeled group (new, minimal CSS: a section heading style consistent with the existing `.modal-head h3` type scale, plus spacing between groups); otherwise render `children` directly inside `.drawer-body`.
- Footer: `.drawer-foot` containing `<button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>` and `<button className="btn primary" onClick={onSave} disabled={saving || saveDisabled}>{saving ? 'Saving…' : saveLabel ?? 'Save changes'}</button>`.
- Closing on Escape and on backdrop click (disabled while `saving`), matching the current convention already used by every existing modal/drawer in the app (`onClick={(e) => e.stopPropagation()}` on the panel, close on the overlay).

Each migrated file keeps its own field markup, `useState` form data, validation, and API calls exactly as they are today — only the outer container changes, from bespoke `.modal`/`.modal-overlay` JSX (or bespoke `.drawer`/`.modal-overlay` JSX) to `<EditDrawer>` with the file's fields passed as `children` or `sections`.

## Migration

All ~39 files convert their add/edit popups to render through `EditDrawer`. Per-file work is mechanical: replace the outer `.modal-overlay > .modal > .modal-head/.modal-body/.modal-foot` (or `.modal-overlay > .drawer > .drawer-head/.drawer-body/.drawer-foot`) wrapper with `<EditDrawer>`, move the existing field JSX into `children` (or split into `sections` when the form already has more than one logical grouping — e.g. `EditGarmentTypeModal`'s existing "Basic Info" / "Two-Step Generation" split maps directly onto the `sections` prop), and wire `title`/`subtitle`/`tags`/`thumbnail` from whatever the record already carries.

Given the size (~39 files), the implementation plan should:
1. Build `EditDrawer` and convert 1–2 pilot forms first — one simple flat form (e.g. Add/Edit Model Face) and the one form that already matches the target shape (`EditGarmentTypeModal`, converting it onto the new shared primitive instead of its bespoke drawer JSX) — to validate the prop shape covers both the flat and sectioned cases before touching the rest.
2. Migrate the remaining files in batches grouped by area: Assets tabs (Faces, Backgrounds, Garment Types' Add flow, Pose Assets, Catalog, Catalogue Templates, Sample Videos, Saree Styles), Workflows, Users/Workers, Shopify Funnels, Tryon, Saree, Dev API, Settings, Demo Catalog/Chatbot QnA.

Two files (`GarmentTypesTab.tsx`'s 4 modal instances, `CatalogTab.tsx`'s 8) need their exact per-instance purpose confirmed against the file at plan-writing time — the Appendix below has verified line numbers and counts from a live grep of the codebase, but not every instance's specific field content was read in this session.

## Non-goals

- No change to confirm dialogs, dropdowns, or other non-record popovers (see Scope).
- No fix to the pre-existing `ConfirmModal.tsx` `modal-scrim` CSS bug — separate, already-flagged issue.
- No new field validation or API behavior changes — this is a structural/visual migration only.
- No unification of field-level component styling (inputs/toggles/selects) beyond what already matches across the app today.
- No visual redesign beyond adopting the drawer pattern — colors, spacing tokens, button styles all reuse what's already in `tokens.css`.

## Testing

No automated UI test infrastructure exists in `admin-web` today (consistent with prior work in this codebase). Verification is:
1. `pnpm --filter @tryme/admin build` and `pnpm --filter @tryme/admin typecheck` after each migration batch.
2. Manual browser pass per migrated form: open Add, open Edit, confirm header shows the right thumbnail/tags (or correctly omits them), confirm sections appear only where the form has genuine groupings, confirm Cancel and Save both work, confirm the drawer closes on Escape and on backdrop click.
3. A final pass confirming no page regressed — every page in the admin sidebar opened once, every add/edit action on it exercised at least once.

## Appendix — current-state inventory (verified via grep, this session)

Centered `.modal` popups today (73 instances):

| File | Line(s) | Count |
|---|---|---|
| `components/AddFaceModal.tsx` | 244 | 1 |
| `components/EditFaceModal.tsx` | 115 | 1 |
| `components/BackgroundUploadModal.tsx` | 144 | 1 |
| `components/EditBackgroundModal.tsx` | 141 | 1 |
| `components/EditPoseAssetModal.tsx` | 239 | 1 |
| `components/EditPoseModal.tsx` | 293 | 1 |
| `components/PoseUploadModal.tsx` | 210 | 1 |
| `components/SampleVideoUploadModal.tsx` | 135 | 1 |
| `components/UploadModal.tsx` | 186 | 1 |
| `components/WorkflowUploadModal.tsx` | 430 | 1 |
| `components/BatchCatalogUploadModal.tsx` | 153 | 1 |
| `components/DemoItemModal.tsx` | 149 | 1 |
| `components/DemoSetModal.tsx` | 43 | 1 |
| `components/DemoSubcategoryModal.tsx` | 50 | 1 |
| `pages/CatalogPage.tsx` | 437, 563 | 2 |
| `pages/assets/CatalogTab.tsx` | 543, 588, 628, 681, 749, 953, 1142, 1451 | 8 |
| `pages/assets/CatalogueTemplatesTab.tsx` | 211 | 1 |
| `pages/assets/BackgroundsTab.tsx` | 745, 799, 860, 917, 970, 1053, 1257 | 7 |
| `pages/DevApiPage.tsx` | 486, 594, 733 | 3 |
| `pages/assets/SareeStylesTab.tsx` | 118 | 1 |
| `pages/JobsPage.tsx` | 589, 1566 | 2 |
| `pages/RecycleBinPage.tsx` | 544 | 1 |
| `pages/SareePage.tsx` | 666 | 1 |
| `pages/assets/SampleVideosTab.tsx` | 166 | 1 |
| `pages/assets/FacesTab.tsx` | 362, 414 | 2 |
| `pages/assets/GarmentTypesTab.tsx` | 844, 879, 1737, 2350 | 4 |
| `pages/ShopifyFunnelsPage.tsx` | 397, 491, 583 | 3 |
| `pages/assets/PoseAssetsTab.tsx` | 649, 685, 739, 786, 846 | 5 |
| `pages/TryonPage.tsx` | 405, 523, 662 | 3 |
| `pages/UsersPage.tsx` | 954, 1125, 1212, 1289, 1765 | 5 (excludes 4 confirm-dialog instances, out of scope) |
| `pages/WorkflowsPage.tsx` | 732, 1020, 1195 | 3 (excludes the `ConfirmModal` usage at 1172, out of scope) |

Full-height `.drawer` popups today (5 instances — the target shape, already in this form; migrating them onto `EditDrawer` is a container swap, not a visual change):

| File | Line | Note |
|---|---|---|
| `pages/ChatbotQnaPage.tsx` | 197 | Currently uses `.scrim` for its backdrop, not `.modal-overlay` — normalize this during migration |
| `components/EditCatalogueTemplateModal.tsx` | 421 | |
| `components/EditGarmentTypeModal.tsx` | 514 | The reference implementation this spec generalizes |
| `pages/SettingsPage.tsx` | 143, 479 | 2 |

Out of scope (confirm dialogs and non-record popovers, left untouched):

| File | What |
|---|---|
| `components/ConfirmModal.tsx` | Shared confirm-dialog component |
| `pages/UsersPage.tsx` (991, 1015, 1058, 1853), `pages/DemoCatalogPage.tsx` (431, 579) | Hand-rolled confirm dialogs duplicating `ConfirmModal`'s markup |
| `components/SearchableSelect.tsx` | Portal-positioned dropdown, no backdrop |
| `pages/AssetsPage.tsx`, `pages/JobsPage.tsx`, `pages/WorkersPage.tsx`, `pages/CreditAnalysisPage.tsx` | Ad hoc positioned filter/menu popovers |
