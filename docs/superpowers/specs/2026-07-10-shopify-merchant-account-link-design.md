# Shopify Merchant Account Link + Drop Shopify-Native Billing — Design

## Context

We already built a "universal account" system for **shoppers** (end customers of a merchant's Shopify store): they link their tryme account via a popup-login flow and pay for try-ons from their own `user_credits` balance, exactly like the main app.

The **merchant** (the store owner who installs the app) has no such link today. `shopify_stores` has no reference to a `users` row at all — OAuth install is purely Shopify-side, never touches an tryme login. Separately, merchants currently pay an app subscription fee via Shopify's native Billing API (`shopify_plans` table + `recurring_application_charge` flow in `billing.routes.ts`).

This spec covers:
1. Linking the merchant's tryme account to their `shopify_stores` row, reusing the shopper popup-login pattern almost unchanged.
2. Removing Shopify-native billing entirely — merchants top up credits on `app.tryme.com/pricing` like any other user.
3. A minimal, non-analytical Shopify embedded Dashboard.

**Explicitly out of scope** (separate follow-on plan): an admin-web analytics view showing per-store product try-on traffic, credit spend, and general store performance. That's a distinct feature building on top of `ownerUserId` once it exists, and will get its own brainstorm/spec/plan.

## 1. Data Model

Add:
- `shopify_stores.ownerUserId` — `uuid`, nullable, FK → `users.id` `ON DELETE SET NULL`. No uniqueness constraint (a merchant could plausibly own more than one store; a user with no store leaves this untouched — the column just never gets set for them).

Drop (Shopify-native billing is fully retired):
- `shopify_plans` table
- `shopify_stores.shopifyPlanId` column
- `shopify_stores.billingPlanId` column
- `billing.routes.ts` — the whole `recurring_application_charge` select-plan / OAuth-callback / activate-charge flow
- `apps/api/src/modules/admin/shopify-plans.routes.ts` (admin CRUD for Shopify plans)
- The corresponding admin-web Shopify-plans management screen/nav entry
- The `apps/shopify` embedded admin's "Billing" screen/nav entry (folded into the Dashboard's top-up button — see §3)

## 2. Link Flow (mandatory gate, reuses shopper popup pattern)

After OAuth install, `shopify_stores.ownerUserId` is null. The embedded admin (`apps/shopify`) gates **every** screen (Dashboard, Products, Settings) behind a "Link your tryme account" screen until linked — no partial/unlinked access to any screen.

Flow — reuses the existing shopper infrastructure almost entirely as-is, since the mint-code endpoint doesn't care who's calling it:

1. Merchant clicks "Link account" on the gate screen → popup opens to `app.tryme.com/login?next=/widget-link-complete?origin=...&nonce=...` — same URL shape already used for shoppers.
2. Merchant logs in / registers on `app.tryme.com` inside the popup.
3. `widget-link-complete` page (**zero changes**) calls `POST /v1/shopify/customer/account/link` (existing endpoint, mints a one-time Redis code for whichever user is logged in), `postMessage`s `{ code, nonce }` back to `window.opener`, closes.
4. Embedded admin (the popup's opener) receives the message, calls a **new** endpoint: `POST /v1/shopify/store/account/link`, authenticated via the admin's existing `requireShopifySession` preHandler (App Bridge session token — already resolves which store this is, server-side). Body: `{ code }`.
5. Server resolves `code → userId` via the existing `resolveAccountLinkCode` (one-time burn, same as the shopper flow), then sets `shopify_stores.ownerUserId = userId` for that store.
6. Admin app refetches `GET /v1/shopify/me`; sees `ownerUserId` is now set; gate lifts, normal screens render.

**Net new code:** the `ownerUserId` column + migration, the `/v1/shopify/store/account/link` endpoint, and the gate UI + popup-trigger button in `apps/shopify`. The tryme-login side (`widget-link-complete`, `mintAccountLinkCode`, `resolveAccountLinkCode`) is untouched — this is exactly why the shopper work paid off here.

## 3. Dashboard (minimal, non-analytical)

Once linked, `GET /v1/shopify/me` returns `ownerUserId` plus a read-only credit balance (joined from `user_credits` via `ownerUserId`). The Dashboard shows only:

- Product-sync status counts (active / processing / failed — already exists today, unchanged)
- The linked tryme account's credit balance (read-only — no top-up UI in Shopify itself)
- A "Top up on tryme.com" button that opens `https://app.tryme.com/pricing` in a **new browser tab** (the embedded admin runs in an iframe inside Shopify admin, so this must break out via a new tab/window, not an in-place redirect)

Explicitly **not** shown: install date (dropped), any per-product traffic or credit-spend analytics (deferred to the Plan 2 admin-analytics follow-on).

## 4. The "Has Installed Shopify" Signal

With `ownerUserId` in place, "does this tryme user have a linked Shopify store" becomes a trivial existence check:

```sql
EXISTS (SELECT 1 FROM shopify_stores WHERE owner_user_id = $userId AND uninstalled_at IS NULL)
```

Exposed as a boolean field (e.g. `hasShopifyStore`) on the main app's existing user-profile endpoint — not a new dedicated endpoint. Any part of `app.tryme.com` (or admin-web, for the Plan 2 analytics work) can read it from there.

## 5. Note on Shopify Partner Dashboard Logs

The logs visible in the Shopify Partners dashboard are Shopify's own app-wide performance metrics (install/uninstall counts, API call volume, etc.) — global across all merchants, not per-user/per-store data we control or need to replicate. Confirmed out of scope; no action needed here.

## Testing

- Unit/integration: new `/v1/shopify/store/account/link` endpoint — resolves a valid code and sets `ownerUserId`; rejects an invalid/expired/already-burned code; requires a valid `requireShopifySession` token.
- Integration: `GET /v1/shopify/me` reflects `ownerUserId`/credit balance correctly pre- and post-link.
- Migration: drop of `shopify_plans` + the two FK columns applies cleanly against the current schema (no lingering references — `admin/shopify-plans.routes.ts` and its admin-web screen must be removed in the same change, or the drop will orphan dead code referencing gone tables/types).
- Manual/frontend: `apps/shopify`'s gate blocks all screens pre-link, popup round-trip actually lifts the gate, Dashboard renders sync status + balance + working top-up link post-link.
