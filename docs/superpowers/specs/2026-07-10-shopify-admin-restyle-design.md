# Shopify Embedded Admin — Brand Restyle — Design

## Context

A new visual mock ("TryMe Shopify Admin Dashboard" — a DC-tool prototype export with fake in-memory state, no real logic) was dropped in at
`TryMe Shopify Admin Dashboard/TryMe Admin.dc.html`. It shows a branded pink-to-amber gradient look for `apps/shopify` (the embedded Shopify admin app), replacing the current default Polaris styling.

Comparing the mock against the real `apps/shopify` code this session found:

- **Link gate, top nav, Dashboard, Products** already exist and are functionally equivalent or superior to the mock (the real Dashboard has an onboarding checklist the mock lacks; the real Products page has a per-product funnel-assignment dropdown and an image picker the mock lacks). These screens need a **visual restyle only**.
- **Funnel Setup**: the mock depicts a different concept (shopper-segment routing — new visitor / cart abandoner / returning shopper — to try-on variants including an "express checkout" variant). Our real Funnel Setup feature is product-attribute rule-based assignment (product type/tags/vendor → workflow template) and has no shopper-session tracking or checkout-variant concept at all. **Decision (confirmed with user): keep the real feature, restyle only — do not build shopper-segment routing.**
- This is confirmed to be **a UI upgrade only** — the mock's literal HTML/markup is a loose visual reference for the brand theme (colors, gradients, card treatment), not a structure to replicate exactly. Existing Polaris component trees stay as-is.

## Goal

Apply the TryMe brand gradient (pink `#f55c7a` → amber `#f6b553`, the same tokens already used in `apps/catalogues-web`) to `apps/shopify`'s existing screens via Polaris's CSS custom-property theming layer, plus two small backend additions the restyled Dashboard needs (per-status product counts, a "connected since" date). No functional regressions — every existing feature (onboarding checklist, funnel dropdown, image picker, product-attribute funnel rules) stays exactly as it works today.

## Theming mechanism

Polaris (`^13.9.5`) exposes its entire design system as `--p-*` CSS custom properties. A new `apps/shopify/src/theme.css`, imported once in `main.tsx` after Polaris's own stylesheet, overrides the accent/interactive/border-radius/shadow tokens Polaris components read from — no component code changes, no component swaps. Concretely this overrides tokens like `--p-color-bg-fill-brand`, `--p-color-text-brand`, `--p-color-border-brand`, and `--p-border-radius-*` to point at the brand pink/amber instead of Shopify's default green/blue.

Polaris has no native gradient-fill primitive (its buttons are solid-color). For the handful of primary CTAs that should read as gradient in the mock (Link account, Sync products now), a small `.btn-brand-gradient` utility class in the same `theme.css` gets applied via Polaris `Button`'s `className` passthrough — background gradient using the same two hex values, applied only to primary-action buttons, not every button on the page.

No new dependency, no build-tooling change — this is a single new CSS file plus targeted `className` props on a handful of existing `Button` elements.

## Backend changes — `GET /v1/shopify/me`

Two additive fields, both computed in the existing route handler (no new endpoint):

- **`stats.statusCounts: { active: number, processing: number, failed: number, disabled: number }`** — grouped count over `shopifyProductGarments` for the current store. Reconciliation rule (confirmed with user): `enabled = false` buckets a row into `disabled` **regardless of its sync `status`**; otherwise the row buckets by its real `status` (`active` / `processing` / `failed`). Rows with `status = 'deleted'` are excluded entirely (already excluded from the products list elsewhere).
- **`store.connectedSince: string`** (ISO timestamp) — reuses the existing `shopifyStores.installedAt` column. We do not currently distinguish "app installed" from "account linked" as separate timestamps, and adding that distinction is out of scope for a UI-only restyle; `installedAt` is the closest existing signal and is accurate for the common case (a store installs the app and links in the same session).

`ShopifyStats`/`ShopifyMe` types in `apps/shopify/src/types.ts` gain these two fields.

## Per-screen changes

- **Link gate** (`LinkAccountGate.tsx`): restyle the `Card`/`Button` to the brand gradient treatment (icon block, gradient CTA button). `openLinkPopup` and the link-confirmation flow are untouched.
- **Nav** (`AppShell.tsx`): restyle the top bar — brand mark, active-tab underline in brand pink, shop domain on the right (already partially present). Same 3 routes (`/`, `/products`, `/funnel-setup`).
- **Dashboard** (`DashboardPage.tsx`): keep the onboarding checklist as-is (a real feature the mock doesn't have). Add a new "Product sync status" `Card` showing the four `statusCounts` buckets with colored status dots (green/amber/red/gray, matching the Products page's badge tones). Restyle credit-balance and store cards to the brand treatment; add `connectedSince` display to the store card. Top-up button becomes the gradient CTA.
- **Products** (`ProductsPage.tsx`): add a search `TextField` (filters by title, client-side over already-loaded `items` — no new endpoint since the list is already paginated at 100/page) and a status `Select` filter (all/active/processing/failed/disabled, using the same reconciliation rule as the Dashboard counts). Restyle the status `Badge` tones to the brand palette. The existing funnel-assignment dropdown and image-picker columns are untouched.
- **Funnel Setup** (`FunnelSetupPage.tsx`): restyle only (`Card`/`Banner`/`Button` brand treatment) — the product-attribute rule logic, conditions UI, and re-run mechanism are unchanged.

## Testing

- Backend: extend the existing `/v1/shopify/me` integration test — seed products across all 4 reconciled buckets (including an `enabled=false` + `status='active'` row to prove the override rule) and assert `statusCounts`; assert `connectedSince` matches the seeded store's `installedAt`.
- Frontend: no test harness exists for `apps/shopify` pages currently (matches the established pattern in `apps/admin-web`/`apps/catalogues-web` — no `.test.tsx` files for pages in this repo). The Products search/filter is pure client-side logic over already-fetched data, low-risk; verified manually via `pnpm --filter @tryme/shopify dev` in a real embedded-admin session against a real dev store.

## Out of scope

- Shopper-segment / checkout-variant funnel routing (the mock's Funnel Setup concept) — explicitly rejected, no shopper-session tracking exists.
- A distinct "account-linked-at" timestamp separate from `installedAt` — not needed for a UI-only pass.
- Shopify-native billing (already removed earlier this session, not reintroduced).
- `apps/admin-mobile` — paused per project convention, untouched regardless.
- Pixel-matching the mock's literal HTML/CSS — this is a brand-theme pass over existing Polaris components, not a rebuild to custom markup.
