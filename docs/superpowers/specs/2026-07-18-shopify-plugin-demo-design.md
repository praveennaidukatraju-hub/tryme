# Shopify Catalogue Plugin — Working Mock Design

**Status:** Approved
**Date:** 2026-07-18

## Purpose

Prospective and existing Shopify merchants need to understand, before or shortly after installing the (future) Ai Vastra Shopify app, what it will feel like to use it inside their own store admin. Today that's only explainable verbally. This project builds a **working mock** inside `apps/catalogues-web` that simulates:

1. The merchant's real Shopify "Add product" page (Products → Add product).
2. Our plugin's entry point sitting inside that page's Media section.
3. Clicking it opens our real Studio generation wizard **in an iframe**, exactly the way a real embedded Shopify app would.
4. The merchant walks through gender → garment type → garment upload → model face → background → pose, generates a real AI try-on image via our existing pipeline, and explicitly chooses to drop the result into the (mocked) product's Media grid.

This is a sales/demo and internal-alignment tool. It is not a real Shopify integration — no Shopify API, no OAuth, no real store data. Everything Shopify-shaped on the page is static, local, illustrative chrome built to match two reference screenshots of the real Shopify "Add product" page (`image.png` — Title/Description/Media/Category + Status/Publishing/Organization/Theme template; `image2.png` — Inventory/SKU/Shipping/Variants/Purchase options).

## Audience & Fidelity

Usable both for external merchant-facing demos and internal stakeholder walkthroughs — so it should be polished and convincing, not schematic. The generation is **fully functional**: real API calls, real ComfyUI generation, real credits spent. It is not a canned/staged simulation. This is deliberate — a merchant seeing a real AI-generated photo of a product built from their own selections is far more convincing than a scripted demo, and it doubles as an extra manual QA path for the core Studio generation flow.

## Where It Lives

- New sidebar nav entry, **BUSINESS** group (next to "My Catalogue" and "Developers"), label **"Shopify Plugin"**, route `/shopify-plugin`, **merchant-only** (same `isMerchant` gate already used for those two neighbors).
- The page renders inside the normal `(app)` layout — same Sidebar/TopBar/auth as every other page in the app.

## Architecture

### The iframe boundary is real

Real Shopify apps that inject UI into the merchant's admin do so via an iframe (App Bridge pattern). To honestly simulate that architecture — not just visually imply it — the generation wizard is a **real, same-origin `<iframe>`**, not a modal that shares React component instances with the parent page.

- Parent page: `apps/catalogues-web/src/app/(app)/shopify-plugin/page.tsx` (inside the normal authenticated app shell).
- Iframe target: `apps/catalogues-web/src/app/embed/shopify-plugin-studio/page.tsx` — a **new top-level route group outside `(app)`**, so it renders with zero AI Vastra chrome (no Sidebar, no TopBar, no ChatWidget, no profile-completion gate) — just the wizard, full-bleed, sized for the modal that hosts the iframe.
- Because the iframe is same-origin, the existing httpOnly-cookie session auth just works — no new auth plumbing.
- The iframe route still needs the job-status SSE stream (`JobStreamProvider`), so it gets its own minimal layout providing only that, not the rest of the app shell.

### Cross-frame communication: postMessage

The modal chrome (title bar, Close/Done button) lives in the **parent** page, not inside the iframe — so the merchant can always dismiss it regardless of what's happening inside. When the merchant clicks "Use this image" on a completed result inside the iframe, it does:

```
window.parent.postMessage({ type: 'tryme:image-selected', imageUrl, jobId, poseLabel }, window.location.origin)
```

The parent listens for `message` events, verifies `event.origin === window.location.origin`, and on receipt appends the image to its local (client-only, non-persisted) Media grid state — live, without closing the modal, since a batch may contain multiple poses and the merchant may want to add more than one.

### Reuse, don't refactor

The existing `/studio` page (`apps/catalogues-web/src/app/(app)/studio/page.tsx`) is a large (~4,200 line), working, wide-desktop-oriented page. Refactoring it into a shared "variant" component to serve both the full Studio and this narrow embedded wizard is not worth the risk to a page that already works, and its 3-column layout doesn't fit a ~760px iframe anyway.

Instead, the embedded wizard is a **new, purpose-built, narrower component** that:

- Reuses existing *sub*-components as-is: `GenderCard` pattern (rebuilt locally — see Scope below), `SelCard`, and `SelectGridModal` (`apps/catalogues-web/src/app/(app)/studio/select-modal.tsx`, already generic and exported).
- Reuses `GenerationPanel` (`apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`) **unmodified in behavior** — it gets two new optional, additive props (`onUseImage`, `hideCatalogueLink`) so the real Studio page's usage is unaffected.
- Calls the exact same backend endpoints as Studio: `/v1/models/garment-types`, `/v1/models/faces`, `/v1/models/backgrounds`, `/v1/models/poses`, `/v1/uploads/presign`, `/v1/jobs/tryon`.

## Scope Boundaries (what the embedded wizard does NOT do)

The user's ask lists the steps explicitly: gender, garment type, model face, pose, background. To keep the embedded demo focused on exactly that flow:

- **No platform/aspect-ratio picker.** Fixed to Shopify's own real defaults from the existing `BRAND_CONFIG` table in Studio: `aspectRatio: '1:1'`, `resolution: 'HD'`.
- **No lower-garment/shoe catalog picker.** If a selected pose needs a lower garment or shoes (`hasLower`/`hasShoes`), the wizard falls back to the garment type's `defaultLowerCatalogId`/`defaultShoeCatalogId` — the exact same fallback Studio itself uses when the merchant doesn't customize those.
- **No mannequin/two-pass garment types, no template/catalogue-template picker, no Amazon white-background special case.** These are real Studio features not mentioned in the ask; the embedded wizard only implements the plain custom-mode multi-pose flow.
- The rest of the mock Shopify "Add product" page (Title, Description, Price, Inventory, Shipping, Variants, Purchase options) is **static, non-interactive** placeholder chrome — visually faithful to the two reference screenshots, wired to nothing.

## Page Breakdown

### `/shopify-plugin` (parent, static Shopify replica + live Media grid)

- Shopify admin chrome: dark top bar (wordmark + "Spring '26" badge + notification/avatar icons) and a black left nav rail (Home, Orders, **Products** *active*, Customers, Growth, Discounts, Content, Markets, Finance, Analytics, Sales channels, Apps, Settings) — pure decoration.
- "Add product" content, matching both screenshots: Title, Description (toolbar shown, non-editable), **Media grid** (interactive — see below), Category, Price row — left column; Status / Publishing / Product organization / Theme template — right column; then Inventory (Quantity table), SKU/Barcode/Sell-when-out-of-stock, Shipping (Package/weight), Variants, Purchase options below.
- **Media grid** is the only interactive surface on the page: local React state `images: { id, url, source: 'seed' | 'tryme' }[]`, seeded with one placeholder product photo. Alongside Shopify's plain "+" add-media tile sits a new branded tile, **"Generate with Ai Vastra"** (gradient border, small logo).
- Clicking the Ai Vastra tile opens a modal (title bar "Generate product photos with Ai Vastra" + Close/Done button) containing the iframe.
- Each image added via the iframe gets a small "✨ Generated by Ai Vastra" badge on its tile so it's visually distinguishable from the seed photo.
- Merchant-gated: if the loaded `/v1/me` response has `isMerchant: false`, the page shows a short "This preview is available for merchant accounts" message instead of the mock (mirrors the existing sidebar gate, doesn't hard-redirect).

### `/embed/shopify-plugin-studio` (iframe target, condensed wizard)

Single vertical stepper, sized for the modal (not full desktop width):

1. Gender (4-way card picker: women/men/boys/girls)
2. Garment type (grid, from `/v1/models/garment-types?gender=`)
3. Garment upload (presigned direct-to-R2 upload, same flow as Studio)
4. Model face (inline row + "View all" → `SelectGridModal`)
5. Background (inline row + "View all" → `SelectGridModal`)
6. Pose(s) — multi-select (inline row + "View all" → `SelectGridModal`, `multiSelect`)
7. Generate → `POST /v1/jobs/tryon` → `GenerationPanel` renders real progress and real results.

On each completed result, `GenerationPanel` shows an additional **"Use this image"** button (via the new `onUseImage` prop) that posts the `tryme:image-selected` message to the parent. The panel's normal "View full catalogue →" link is hidden here (`hideCatalogueLink`) since navigating the iframe away from the wizard would strand the merchant mid-demo.

## Self-Review Notes

- No placeholders/TBDs — every field above has a concrete default (Shopify's own aspect ratio default, Studio's own lower/shoe fallback).
- No contradictions: the "fully functional" decision and the "no platform picker" scope boundary are compatible because the fixed values (`1:1` / `HD`) are real, valid inputs to the real endpoint, not stubs.
- Scoped to one subsystem (a new demo surface); does not touch billing, real Shopify integration, or the real Studio page's behavior for existing users.
