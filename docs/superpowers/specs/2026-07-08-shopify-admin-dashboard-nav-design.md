# Shopify Embedded Admin — Navigation Shell + Dashboard Redesign

## Summary

After live-testing the embedded admin (`apps/shopify/`) against a real dev store, two gaps surfaced: there is no persistent navigation between the Dashboard/Billing/Products screens (a merchant lands on Products with no way back), and the Dashboard itself is a placeholder (shop domain + credit balance only). This spec adds a shared navigation shell across all three screens and rebuilds the Dashboard into a real home screen: a "Getting Started" checklist and stat tiles, modeled loosely on a competitor's admin (Antla) but scoped to only what this app can honestly show today — no fabricated conversion-rate or revenue numbers, since neither is tracked anywhere in this codebase.

Explicitly out of scope: analytics/attribution instrumentation (would be needed for a real "conversion %" or "revenue generated" tile — a separate, larger project if ever pursued), duplicating the Products table on the Dashboard (a link out is enough), and any change to the Billing or Products screens' own internals beyond rendering inside the new shell.

---

## Architecture

```
apps/shopify/src/
  App.tsx              — <AppShell><Routes>...</Routes></AppShell>
  components/
    AppShell.tsx        — new: persistent nav (Dashboard/Billing/Products)
  pages/
    DashboardPage.tsx   — rebuilt: checklist + stat tiles
    BillingPage.tsx     — unchanged internals, now renders inside AppShell
    ProductsPage.tsx    — unchanged internals, now renders inside AppShell
```

```
apps/api/src/modules/shopify/
  me.routes.ts          — GET /v1/shopify/me gains a `stats` field
  onboarding.routes.ts  — new: POST /v1/shopify/onboarding/confirm-theme-block
  routes.ts             — registers the new route file
```

---

## Navigation shell

`apps/shopify/src/components/AppShell.tsx` (new) wraps every route. It renders a simple, always-visible row of three links (Dashboard / Billing / Products) above the page content, with the current route visually distinguished (e.g. Polaris `Badge` or bold text on the active link — implementation detail for the plan, not a design fork). `App.tsx` changes from three top-level `<Route>`s to:

```tsx
<AppShell>
  <Routes>
    <Route path="/" element={<DashboardPage />} />
    <Route path="/billing" element={<BillingPage />} />
    <Route path="/products" element={<ProductsPage />} />
    <Route path="/embedded" element={<Navigate to="/" replace />} />
  </Routes>
</AppShell>
```

This directly fixes the "stuck on Products" problem: every screen now has the same three links available, regardless of which one is currently open.

---

## Backend: `stats` on `GET /v1/shopify/me`

The existing handler already loads `store` and computes `credits`/`plan`. It gains three additional counts, each scoped to the authenticated store (`req.shopifyStore`):

```ts
stats: {
  totalTryOns: number;       // count(*) from jobs where widgetClientId = store.widgetClientId
  syncedProductCount: number;   // count(*) from shopify_product_garments where storeId = store.id
  enabledProductCount: number;  // count(*) from shopify_product_garments where storeId = store.id AND enabled = true
}
```

`totalTryOns` needs no extra filtering on `jobs` beyond `widgetClientId` — each Shopify store gets its own dedicated `widgetClients` row (`upsertShopifyStore`), so every job under that `widgetClientId` is inherently a Shopify try-on job; there's no other job type sharing that widget client. This is a single additional query alongside the two existing ones (credits, plan) — no new endpoint, since the Dashboard already calls `/me` on load and this avoids a second round-trip.

---

## Backend: theme-block checklist step

Whether the theme app block (from the earlier storefront-widget plan) is actually placed on a product template is not queryable through Shopify's Admin API — there's no REST/GraphQL endpoint that reports "this app block is present on template X." So this one checklist step is self-reported: the merchant clicks a button once they've added it, and the app remembers.

New route, `apps/api/src/modules/shopify/onboarding.routes.ts`:

```
POST /v1/shopify/onboarding/confirm-theme-block
```

Gated by the existing `requireShopifySession`. No request body. Sets `settings.themeBlockConfirmed = true` on the store's row (merging into the existing `shopifyStores.settings` jsonb column — already present, already typed via `ShopifyStoreSettings`, just unused by any endpoint until now). Idempotent — calling it twice is a no-op the second time. Response echoes the updated `settings` object so the frontend can update its local state without a second `/me` fetch.

This is a narrow, single-purpose endpoint rather than a general `PATCH /v1/shopify/settings` — the other four fields already sitting unused in `ShopifyStoreSettings` (`buttonText`, `buttonColor`, `position`, `customCss`) have no consumer yet, and building generic merge-patch infrastructure for fields nothing reads or writes today would be exactly the kind of speculative generalization to avoid. If a real settings-editing screen is ever built, that's its own future spec.

---

## Frontend: redesigned Dashboard

`DashboardPage.tsx` still does a single `GET /v1/shopify/me` fetch on load (now returning `stats` too). Layout, top to bottom:

1. **Getting Started card** — three rows, each a checkbox-style icon + label + (for step 3 only) a button:
   - "Sync your products" — done if `stats.syncedProductCount > 0`. Has an inline "Sync products now" button calling the existing `POST /v1/shopify/products/sync` (this endpoint has existed since the backend vertical-slice plan, but no frontend has ever called it until now — without this button, a merchant would have no in-app way to complete this checklist step at all).
   - "Enable try-on on a product" — done if `stats.enabledProductCount > 0`. Links to `/products`.
   - "Add the Try It On block to your theme" — done if `settings.themeBlockConfirmed`. Not done: shows a link to Shopify's theme editor (a `shop.myshopify.com`-relative deep link isn't reliably constructable client-side without knowing the current theme ID, so this is a plain instructional link to the general theme editor, not a precise deep link) plus a "I've added it" button calling the confirm endpoint.
   - A completion badge (e.g. "1/3" or "33%") computed client-side from the three booleans above.
2. **Stats row** — three small `Card`s: Try-Ons (`stats.totalTryOns`), Products Synced (`stats.syncedProductCount`), Products Enabled (`stats.enabledProductCount`). Plain numbers, no percentage/currency formatting since none of this is money or a rate.
3. **"Manage Products" button** — replaces today's plain-text link, navigates to `/products`.

---

## Error handling

Same posture as the rest of this app (established across Tasks 6-8): real, non-generic error messages via Polaris `Banner` — this is merchant-facing admin, not the shopper-facing storefront widget. A failed `confirm-theme-block` call shows a banner and leaves the checklist step unchecked (no optimistic update before the request succeeds).

---

## Testing approach

No automated test harness for this app (unchanged from every prior frontend task in this plan — matches `apps/admin-web`'s own precedent). The backend additions (`stats` field, `confirm-theme-block` endpoint) get full Vitest TDD coverage, matching every other backend task built this session. Verification of the frontend changes is manual, against the same live dev store already used for the previous round of testing.

---

## Deferred

- Real "conversion %" / "revenue generated" tiles — needs analytics/attribution instrumentation that doesn't exist anywhere in this codebase; a separate, larger project if ever pursued.
- Duplicating the Products table on the Dashboard.
- A general merchant-settings editing screen (button text/color/position/CSS) — the `ShopifyStoreSettings` fields beyond `themeBlockConfirmed` stay unused until that's its own spec.
- A precise "open the theme editor at the right template" deep link.
