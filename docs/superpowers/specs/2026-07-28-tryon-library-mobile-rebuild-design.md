# Try On Library Mini-App — Mobile-Native Rebuild — Design

## Goal

`/tryon-library-app` is used exclusively on mobile (installed as a Chrome PWA). The current implementation is a duplicated copy of the desktop `/catalogue-manager` UI (centered modals, dense multi-column headers, drag-and-drop) patched with flex-wrap to avoid overflowing — a losing battle, evidenced by two rounds of responsive bug fixes that still didn't produce a clean result. This rebuilds the page from scratch with mobile-first layout and navigation, reusing only the backend APIs and the isolated auth/session plumbing already built. Production bar: premium, simple, clean — not a cut-down desktop page, not a toy.

## Decisions from brainstorming

- **Add Product** keeps both modes: direct "Catalogue Image" upload and AI-generated "Flat Image" (ComfyUI).
- **Bulk Upload** is kept, adapted for mobile: native multi-photo picker instead of drag-and-drop; batch AI-generation, per-item SKU/price, and "set price for all" are all kept.
- **Category navigation** stays as horizontal scroll tabs (Men/Women/Boys/Girls).
- **Add/Edit/Bulk-Upload flows are full-screen steps**, not centered overlay modals. This is the main structural change: it permanently removes the viewport-height-fighting class of bug (clipped Save buttons, dropdowns with no room) instead of patching around it, and gives a native back-button feel appropriate for an installed PWA.
- **Lists are image-forward grids** (2 columns), for both subcategories and products — not compact text rows.
- **Primary action is a floating action button** (bottom-right, thumb-reachable), not a header button.

## Route architecture

Full-screen steps are real Next.js nested routes, not component-state view-switching, so the browser/PWA back button and gesture navigation work natively and every step is independently reachable/refreshable:

```
apps/catalogues-web/src/app/tryon-library-app/
  layout.tsx                                     — session gate (moved up from page.tsx — see below)
  page.tsx                                        — Subcategories screen (root)
  add-subcategory/page.tsx                        — Add Subcategory step
  subcategory/[id]/page.tsx                       — Products screen for one subcategory
  subcategory/[id]/add-product/page.tsx           — Add Product step
  subcategory/[id]/edit-product/[productId]/page.tsx — Edit Product step
  subcategory/[id]/bulk-upload/page.tsx           — Bulk Upload step
```

### Session gate moves to `layout.tsx`

Today, `page.tsx` holds the `checking / unauthed / authed` state machine (silent refresh against `/api/catalog-app/refresh`, then either the login form or `LibraryContent`). With real nested routes, that logic must live in `layout.tsx` so it applies uniformly — direct-linking to `/tryon-library-app/subcategory/xyz/bulk-upload` while logged out shows the login form, never a flash of content or a broken child render. `layout.tsx` becomes a client component: shows the login form when `unauthed`; renders `{children}` only once `authed` (by which point `initCatalogAppToken` has already run, so any child's `useQuery` calls are safe). `middleware.ts`'s `PUBLIC_PATHS` check already does prefix matching (`path === p || path.startsWith(\`${p}/\`)`), so no middleware change is needed — verified, not assumed.

### Category tab state

The root screen's selected category (`men` default) is a `?category=` search param via `router.replace` (no new history entry), not component state — consistent with everything else being real, linkable routes.

### Subcategory metadata on nested screens

`subcategory/[id]/page.tsx` needs the subcategory's name/garment-type for its header. Rather than adding a new single-subcategory GET endpoint, it reuses the existing `GET /v1/merchant/catalog/subcategories` list (already fetched and cached by TanStack Query under `['merchant-catalog-subcategories']` on the root screen) and finds the row by `id` — same approach `edit-product` uses against the cached product list. No backend changes.

## Screen-by-screen

- **Subcategories (root)** — Header: "Try On Library" title + credits chip + avatar/logout. This is the *only* screen with the identity block — nested screens get a plain back-arrow + contextual title, keeping them uncluttered. Horizontal scroll category tabs below the header. 2-column image-forward grid of subcategory cards (thumbnail-style icon, name, garment-type badge, product count). FAB → Add Subcategory.
- **Add Subcategory** — back-arrow + "Add Subcategory" header. Name field, Garment Type dropdown. Sticky bottom Save button (full-width, safe-area-aware). On save: `router.back()`, invalidate the subcategories query.
- **Products (per subcategory)** — back-arrow header with subcategory name + garment-type subtitle. 2-column image-forward grid of product cards (image, name, SKU, price with strikethrough actual price when discounted). A "Bulk Upload" entry lives as a small header/list action here (not a second FAB — two FABs on one screen is confusing). FAB → Add Product. Tapping a product → Edit Product.
- **Add/Edit Product** — back-arrow + "Add Product" / "Edit Product" header. Image-mode toggle (Catalogue Image / Flat Image) preserved exactly as today, full width. Name, SKU, Price fields stacked (not side-by-side — full-width fields are easier to tap and read on a narrow screen than the current 2-column price grid). Sticky bottom Save button.
- **Bulk Upload** — back-arrow + "Bulk Upload" header. Native multi-photo picker button (`<input type="file" multiple>` triggered by a tap target, no drag-and-drop affordance). 2-column grid queue showing per-item thumbnail/status/SKU/price once generated. "Set price for all" shortcut kept. Sticky bottom bar: Cancel / "Add N to Catalogue".

## Visual direction ("premium, simple, clean" — made concrete)

Reuse the existing brand tokens (`C` from `@/components/tokens`, the pink→amber gradient) — this is a new *layout*, not a new brand. Concrete rules so "premium and clean" is actually implementable, not just a vibe:

- **Typography scale**: one consistent scale reused across every screen — 20px/600 for screen titles, 15px/500 for card titles/body, 13px muted (`C.mid`) for meta text (price, SKU, counts). No screen invents its own font sizes.
- **Restrained color**: gradient (`grad`) reserved for the FAB and primary Save/submit buttons only — not decorative anywhere else. Surfaces are white/`C.card` with a single 1px `C.border`, not heavy drop shadows. One soft shadow reserved for genuinely elevated elements (the FAB, the sticky bottom bar's top edge).
- **Spacing**: consistent 16px screen padding (not the desktop 28px), 12px card gaps, 44px minimum tap target height on every interactive element.
- **Safe areas**: the FAB and every sticky bottom action bar use `env(safe-area-inset-bottom)` padding so they clear the iOS home indicator / Android gesture bar on real devices — this was never relevant on desktop and needs to be added new.
- **Loading/empty states**: a centered spinner + one line of copy is enough (no shimmer-skeleton library — would be scope creep for this rebuild), but every screen needs one; a screen that just goes blank while loading reads as broken, not premium.
- **No new animation/transition library** — Next.js route changes are instant by default; this is explicitly out of scope, not an oversight.
- **Icons**: keep the existing `lucide-react` / `@/components/icons` set already used app-wide — no new icon library, for visual consistency with the rest of the product.

## File plan

**Delete** (desktop-derived, being replaced): `LibraryContent.tsx`, `LibraryTopBar.tsx`, `SubcategoryModal.tsx`, `ProductModal.tsx`, `BulkUploadModal.tsx`.

**New**, under `tryon-library-app/`:
- `layout.tsx` — session gate (replaces the gate currently in `page.tsx`)
- `page.tsx` — Subcategories screen
- `add-subcategory/page.tsx`
- `subcategory/[id]/page.tsx`
- `subcategory/[id]/add-product/page.tsx`
- `subcategory/[id]/edit-product/[productId]/page.tsx`
- `subcategory/[id]/bulk-upload/page.tsx`
- Shared pieces used by the screens above: a header component (identity variant for root, back-arrow variant for nested screens), subcategory/product grid card components, the category-tabs strip, the FAB, a restyled `LibraryUserMenu` (kept, mobile-sized touch targets), a sticky bottom action-bar component (shared by Add Subcategory / Add-Edit Product / Bulk Upload).

**Unchanged**: `catalog-app-api.ts`, `catalog-app-helpers.ts`, the `manifest.webmanifest` route, PWA icons, the service worker, and every backend endpoint — this is a pure frontend rebuild, no API changes.

## Backend APIs used (unchanged, listed for completeness)

`GET /v1/merchant/me`, `GET/POST/PATCH/DELETE /v1/merchant/catalog/subcategories[...]`, `GET/POST/PATCH/DELETE /v1/merchant/catalog[...]`, `POST /v1/merchant/catalog/presign`, `POST /v1/merchant/catalog/generate`, `POST /v1/merchant/catalog/generate-bulk`, `GET /v1/merchant/catalog/generate/status`, `GET /v1/models/garment-types` (via `requireUserOrCatalogApp`).

## Testing plan

No backend changes, so no new backend tests. Frontend: `pnpm typecheck` and `pnpm lint` must stay clean; manual verification is screenshot-driven as in prior rounds (no browser automation available in this environment) — this time verifying real device screen sizes (safe-area insets, FAB placement, sticky bottom bars) rather than just breakpoint widths.

## Open trade-offs

- Real nested routes are a bigger rewrite than a component-state screen-stack would have been — accepted for genuine back-button/PWA behavior.
- No shimmer-skeleton loading states, no route-transition animation — explicitly deferred as scope creep, not required for "premium."
- `LibraryUserMenu`'s credits/logout only appears on the root screen; nested screens have no way to check credits or log out without navigating back — acceptable since logout mid-task isn't a real workflow, and credits are informational, not needed while filling out a form.
