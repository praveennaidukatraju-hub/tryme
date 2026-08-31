# Shopify Embedded Admin — Design Spec

## Summary

An embedded Polaris admin app inside the Shopify admin, giving merchants control over three things that currently have no merchant-facing UI: which subscription plan they're on, which of their products have the try-on button actually working, and which product image is used as the garment input for a given product. This is the `apps/shopify/` piece deferred by both the backend vertical-slice plan and the storefront-widget plan (see their "Deferred" sections).

Explicitly out of scope: theme block placement itself (that stays Shopify's native theme-editor job — merchants assign a JSON template to the products they want the button on, same as today), internal `admin-web`/`admin-mobile` views for Shopify data (separate, already-deferred plan), and any change to the storefront widget's own UX (built in the prior plan).

---

## Architecture

```
Shopify Admin (iframe)
  +--------------------------------------+
  | apps/shopify/ (Vite + React + Polaris)|
  |  - Dashboard screen                   |
  |  - Billing screen                     |
  |  - Products screen                    |
  |  App Bridge session token             |
  +-------------------+-------------------+
                      | Authorization: Bearer <token>
                      v
              apps/api (Fastify)
  +---------------------------------------------+
  | modules/shopify/me.routes.ts (existing)      |
  | modules/shopify/billing.routes.ts (existing) |
  | modules/shopify/products.routes.ts (new)     |
  |   GET  /v1/shopify/products                  |
  |   GET  /v1/shopify/products/:id/images        |
  |   PATCH /v1/shopify/products/:id              |
  | modules/widget/routes.ts (extended)          |
  |   POST /v1/widget/jobs — enabled-gate check   |
  +---------------------------------------------+
                      |
                      v
            Postgres / Shopify Admin API
```

Nothing in the dispatcher, storefront widget, billing-charge-activation logic, or webhook handling changes. This spec only adds an admin frontend and the backend surface it needs.

---

## New app: `apps/shopify/`

Vite + React 18 + `react-router-dom`, matching `apps/admin-web`'s existing stack exactly (no state-management library, no heavy framework — plain `fetch` + component state, same as `admin-web`'s current pattern). Additional dependencies specific to this app: `@shopify/app-bridge-react` (embedding + session tokens) and `@shopify/polaris` (Shopify's own component library, for a native-feeling embedded admin UI merchants already expect from Shopify apps).

### Auth flow

1. App loads inside the Shopify admin iframe with `host`/`shop` query params (Shopify's standard embedded-app bootstrap).
2. App Bridge initializes with `SHOPIFY_API_KEY` (public, safe to ship client-side) + the `host` param.
3. Before every API call, `getSessionToken(app)` fetches a fresh App Bridge session token (~60s lifetime) and the request sends it as `Authorization: Bearer <token>`.
4. Backend verification is the existing `requireShopifySession` preHandler (`apps/api/src/plugins/shopify-auth.ts`) — no new auth code needed for endpoints that already use it (`/me`, `/billing/*`); new endpoints use the same preHandler.
5. On a 401 (expired token), the frontend's fetch wrapper re-fetches a token once and retries the request once before surfacing an error — no infinite retry loop.

### Screens

**Dashboard** — shows install status, current plan name + credit balance (from existing `GET /v1/shopify/me`), a "Sync products now" button (`POST /v1/shopify/products/sync`, existing endpoint), and navigation to Billing/Products.

**Billing** — Polaris `Card` list of `shopifyPlans` (from existing `GET /v1/shopify/billing/plans`), current plan visually highlighted. Each plan has a "Select" button calling the existing `POST /v1/shopify/billing/select`, which returns `{ confirmationUrl }`. Because Shopify's billing confirmation screen cannot render inside an embedded iframe, the frontend uses App Bridge's `Redirect` action to navigate the **top-level** window to `confirmationUrl` (not a normal `<a>`/`fetch` — must break out of the iframe). After the merchant approves/declines on Shopify's own page, the existing `GET /v1/shopify/billing/callback` (already built, HMAC-less-callback-safe per the prior session's fix) redirects back into `/embedded?shop=...&billing=active`, which this app's router treats as "return to Dashboard."

**Products** — paginated table (`GET /v1/shopify/products`, new endpoint) with columns: thumbnail, title, sync status badge (`processing` / `active` / `failed`, styled via Polaris `Badge`), an enable/disable `Toggle`, and a "Change image" button. The toggle is disabled (greyed, with a tooltip: "Waiting for product sync") when status ≠ `active` — a merchant cannot enable try-on for a product with no successfully-synced garment image yet. "Change image" opens a Polaris `Modal` with a grid of that product's live Shopify images (`GET /v1/shopify/products/:id/images`, new endpoint, called on modal open — always current, no caching, per this spec's explicit choice over caching a synced image list). Selecting an image calls `PATCH /v1/shopify/products/:id` with `{ garmentImageUrl }`.

---

## Data model change

`shopify_product_garments` gains two columns (new migration):

```sql
ALTER TABLE shopify_product_garments
  ADD COLUMN enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN title text;
```

- `enabled` — merchant-controlled, **defaults to `false`** (opt-in per product, not opt-out). This is a deliberate choice: existing installs (2 real dev stores already live-tested this session) must not suddenly have try-on live on every product the moment this ships. A merchant explicitly turns it on per product via the Products screen.
- `title` — cached at product-sync time (`products.sync.ts`'s `syncProduct`/`upsertGarment`) purely so the Products list can render without an extra live Shopify call per page load. This is a display cache only — the live-fetch choice for the *image gallery* (below) is a separate, deliberate decision per this spec's earlier discussion, not inconsistent with caching titles.

---

## New/changed backend endpoints

All under `apps/api/src/modules/shopify/products.routes.ts` (new file), registered in `apps/api/src/modules/shopify/routes.ts` alongside the existing `products/sync` route, all gated by the existing `requireShopifySession` preHandler.

### `GET /v1/shopify/products`

Paginated with `?page=&pageSize=` (`page` starts at 1, `pageSize` default 20 max 100), matching the established `PaginatedSearch` Zod-schema convention already used in `apps/api/src/modules/admin/users.routes.ts:10-11`. Pure DB query against `shopify_product_garments` scoped to `req.shopifyStore.id`. Response: `{ page, pageSize, total, items: [{ shopifyProductId, title, thumbnailUrl, status, enabled }] }`. `thumbnailUrl` is `app.storage.publicUrl(r2Key)` (same pattern as the widget job's `resultUrl`).

### `GET /v1/shopify/products/:id/images`

Live proxy: fetches `https://{shop}/admin/api/{SHOPIFY_API_VERSION}/products/{id}/images.json` using the store's own decrypted access token, returns the array of `{ id, src }`. No caching, no storage — this data is only used transiently to populate the picker modal. Same CDN-host allowlist validation (`assertShopifyCdn`, imported/reused from `products.sync.ts`) applied to any `src` values before they're returned, defense-in-depth even though this is Shopify's own API response.

### `PATCH /v1/shopify/products/:id`

Body: `{ enabled?: boolean, garmentImageUrl?: string }` (at least one field required, both optional independently — a merchant can toggle enabled without touching the image, or vice versa).

- `enabled` — plain `UPDATE shopify_product_garments SET enabled = $1 WHERE store_id = $2 AND shopify_product_id = $3`. Rejects (400) if no row exists yet for that product. Setting `enabled: true` additionally rejects (400) if the row's `status !== 'active'` (matches the Products screen's disabled-toggle UI, enforced server-side too — never trust the frontend alone). Setting `enabled: false` is always allowed regardless of `status` — a merchant must always be able to turn off a product even if it later moved to `failed`.
- `garmentImageUrl` — before downloading, the handler re-fetches that product's real image list from Shopify server-side (same call as the `/images` endpoint) and rejects (400) if the submitted URL isn't in that set — prevents a tampered request from feeding in an arbitrary external URL. Once verified, downloads and stores it via the same hardened fetch path as `products.sync.ts`'s `syncProduct` (SSRF-guarded: CDN-host allowlist, `redirect: 'error'`, `AbortController` timeout, 10MB cap) into a **new** R2 key (not overwriting the old one in place — write-then-swap, so a mid-request failure never leaves the row pointing at a half-written object), then updates `r2Key` to the new value in the same transaction as clearing any prior `failedReason`.

### `POST /v1/widget/jobs` (existing route, extended)

`apps/api/src/modules/widget/routes.ts`'s Shopify branch (currently ~line 186-205) changes its garment lookup from a single combined query to two steps:

1. Query for `storeId + shopifyProductId + status = 'active'` (unchanged from today) — if no row, existing 202 "preparing, check back in a moment" + trigger resync (unchanged).
2. If a row exists but `enabled = false`, return a **different** 202 message ("This product isn't available for try-on right now.") and do **not** trigger a resync — the product is fully synced, this is the merchant's own choice, not a freshness problem, so resyncing would be pointless work.
3. If a row exists and `enabled = true`, proceed exactly as today.

---

## Error handling

This is merchant-facing admin, not the shopper-facing storefront widget — the "never leak internal errors" rule from the prior plan applies to `tryon-widget.js`, not here. Products/Billing screens show real (but not stack-trace-level) error messages via Polaris `Banner` components: e.g. "Failed to load products: <server message>", "Failed to update plan: <server message>". No hidden generic-only messaging requirement in this app.

- Session-token 401 → one silent retry (fresh token), then a banner directing the merchant to reload the embedded app.
- `PATCH /v1/shopify/products/:id` image-mismatch rejection → 400 with a clear "that image no longer exists on this product" message (handles the race where a merchant deletes a Shopify image between opening the picker and confirming a selection).
- Billing `Select` failure → banner, merchant retries manually; no automatic retry loop (matches the existing `billing.routes.ts` tolerance elsewhere in this codebase — errors surface, they don't get silently retried).

---

## Testing approach

- **Backend** (migration, `products.routes.ts`'s three endpoints, the `widget/routes.ts` enabled-gate change): full Vitest TDD coverage, same discipline as every prior task this session — RED/GREEN evidence, full-suite regression run, typecheck.
- **Frontend** (`apps/shopify/`): no automated test harness, matching `apps/admin-web`'s existing precedent (that app has no test setup either). Verification is manual against the real dev store already installed this session (`ai-vastra-store.myshopify.com`), same style as the theme extension's own manual verification: load the embedded app in the Shopify admin, confirm Dashboard/Billing/Products all render and function against real data, confirm the enable-toggle actually gates `POST /v1/widget/jobs` end-to-end via a real storefront click-through.

---

## Deferred (unchanged scope boundary from prior plans)

- Theme block placement/template assignment UI — stays Shopify's native theme editor, not rebuilt inside this app.
- `apps/admin-web` / `apps/admin-mobile` internal views for Shopify store/plan data (Admin Parity Rule applies once/if this ships — flagging, not building here).
- Bulk product actions (e.g. "enable all products matching X") — single-product operations only for this spec; a real bulk-actions UI would be its own follow-up once usage data shows it's needed.
- Any change to plan pricing/tier definitions themselves (`shopify_plans` row content) — this spec only builds the UI to *select* existing plans, not to define new ones (that's still admin-only via the existing internal `/admin/shopify-plans` CRUD).
