# Shopify Standalone Client + Universal User Credits — Design

## Summary

Shopify is currently a tenant of the generic embeddable-widget system: every installed store gets a `widget_clients` row (with dummy merchant-signup fields — `companyName`, `email`, `passwordHash: ''`, etc. — synthesized from Shopify shop data) and a `widget_client_credits` row that the merchant must fund via Razorpay for their shoppers to try on for free. This design removes that dependency entirely. Shopify becomes a standalone client: its own identity/auth on `shopify_stores` directly, and its own billing model — shoppers sign in with (or create) their tryme account and pay with their own `user_credits`, exactly like the main studio flow at `/v1/jobs/tryon`. There is no more merchant-funded free tier for Shopify.

The embedded admin app (`apps/shopify`) is unaffected by any of this — it already authenticates via Shopify's own session-token JWT (`requireShopifySession`), never via `widget_clients`.

## Current State (verified against code)

- `shopify_stores.widgetClientId` — `NOT NULL UNIQUE` FK to `widget_clients.id`.
- `upsertShopifyStore` (`apps/api/src/modules/shopify/auth.routes.ts`) creates a `widget_clients` row (clientType `'shopify'`) and a `widget_client_credits` row (balance 0) on first install.
- Storefront widget (`tryon-widget.js`) authenticates via `x-widget-key` header, validated against `widget_clients.widgetKey`, at routes in `apps/api/src/modules/widget/routes.ts` (`/v1/widget/presign`, `/v1/widget/jobs`, `/v1/widget/jobs/:id`, `/v1/widget/jobs/:id/events`).
- Job billing for Shopify jobs: `atomicWidgetDeduct`/`widgetRefund` against `widget_client_credits`, cost `SHOPIFY_JOB_COST` (env, default 10).
- `jobs.widgetClientId` links a job back to its `widget_clients` row; dispatcher's `processShopifyJob` joins `shopify_stores.widgetClientId = jobs.widgetClientId` to resolve the store.
- Files touching `widget_clients`/`widget_client_credits` for Shopify: `auth.routes.ts`, `webhook.routes.ts`, `billing.routes.ts`, `me.routes.ts` (api), `processor.ts`, `consumer.ts`, `sweeper.ts`, `webhooks.ts` (dispatcher).
- `jobs.userId` (nullable FK to `users.id`) already coexists on the same row as `jobs.widgetClientId` — no schema conflict in reusing this column for linked Shopify jobs.
- Main app's per-job cost for a single-garment/single-photo flow (no resolution picker, closest shape to the Shopify flow — `apps/api/src/modules/jobs/createSaree.ts` and `create.ts`'s simple-tryon path both use it) is `getTryonCreditCost(app)` (`apps/api/src/lib/resolution-config.ts`) — reads the admin-configurable `config:system` Redis key (same one `GET/PATCH /admin/config` edits), falling back to `SIMPLE_TRYON_COST = 5` (`packages/types/src/jobs.ts`) if unset. This — not a hardcoded number — is "our tryon pricing"; it's distinct from the flat `SHOPIFY_JOB_COST = 10` env var Shopify jobs use today.
- Main app tokens are signed via `jose`'s `SignJWT`/`jwtVerify` (`apps/api/src/modules/auth/service.ts`'s `signAccess`/`verifyAccess`), HS256, optional `audience` claim already used to scope admin tokens (`audience: 'admin'`).

## Data Model Changes

```sql
ALTER TABLE shopify_stores
  ADD COLUMN store_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN allowed_origins text[] NOT NULL DEFAULT '{}';

-- Backfill for already-installed stores (preserves continuity — no merchant
-- action needed, existing theme-extension deployments keep working):
UPDATE shopify_stores s
SET store_key = wc.widget_key, allowed_origins = wc.allowed_origins
FROM widget_clients wc
WHERE s.widget_client_id = wc.id;

ALTER TABLE shopify_stores DROP COLUMN widget_client_id;

ALTER TABLE jobs
  ADD COLUMN shopify_store_id uuid REFERENCES shopify_stores(id);
```

`widget_clients`/`widget_client_credits`/`merchant_payments` rows for existing Shopify stores are left in place (orphaned, unreferenced) rather than deleted — the backfill above is the only destructive-adjacent step, and it only reads from them. Cleanup of the orphaned rows is deferred, not part of this change.

No new credit tables. Shopify billing reuses `users` / `user_credits` / `credit_ledger` and the existing `atomicDeduct`/`refund` helpers in `apps/api/src/modules/credits/`.

## Storefront Auth (replacing `widget_clients.widgetKey`)

New `requireShopifyStoreKey` preHandler (mirrors `requireWidgetClient` in `apps/api/src/plugins/widget-auth.ts`, but looks up `shopify_stores.storeKey` instead of `widget_clients.widgetKey`, and checks `shopify_stores.allowedOrigins` for CORS instead of `widget_clients.allowedOrigins`). The wire format is unchanged — still the `x-widget-key` header — so the already-deployed theme extension's request shape needs no change on this point.

## New Shopify Customer Routes

`/v1/widget/*` keeps serving the generic embeddable widget (out of scope here — different merchants, different billing). Shopify gets its own namespace so the two never collide:

- `POST /v1/shopify/customer/presign` — same behavior as today's `/v1/widget/presign`, auth via `requireShopifyStoreKey`.
- `POST /v1/shopify/customer/jobs` — creates the job. Requires a valid, non-expired account token (see below) — no anonymous path. Resolves garment via `shopify_product_garments` exactly as today. Charges `user_credits` at `await getTryonCreditCost(app)` via the shared `atomicDeduct`, in the same transaction as the job insert (existing invariant). Sets `jobs.userId` and `jobs.shopifyStoreId`.
- `GET /v1/shopify/customer/jobs/:id` — status/result poll fallback (used by the SSE reconnect logic already in `tryon-widget.js`).
- `GET /v1/shopify/customer/jobs/:id/events` — SSE, same shape as today's `/v1/widget/jobs/:id/events`.
- `POST /v1/shopify/customer/account/link` — called by the popup (authenticated as a normal app user via `Authorization: Bearer`). Mints a one-time code: `redis.set('shopify:link:{code}', userId, 'EX', 60)`. Returns `{ code }`.
- `POST /v1/shopify/customer/account/exchange` — called by the widget (auth via `requireShopifyStoreKey`), burns the one-time code, returns a signed account token.

`tryon-widget.js` is repointed from `/v1/widget/*` to `/v1/shopify/customer/*` — low-risk, we own both sides, and the file is already being touched this cycle (SSE rewrite).

## Account Token

Signed via the existing `signAccess`/`verifyAccess` helpers, `audience: 'shopify-widget'`, claims `{ storeId }`, subject = `userId`, expiry ~30 days. Stateless — no new table. Verified on every `POST /v1/shopify/customer/jobs` call; a token whose `storeId` claim doesn't match the requesting store's id (from `requireShopifyStoreKey`) is rejected, same as a missing token.

## Login Flow (popup)

1. Widget shows "Sign in to try on" as the entry point (not an optional add-on — the only entry point, since there is no fallback billing).
2. Click → `window.open('https://app.tryme.com/widget-link?origin=<store origin>&nonce=<random>')`.
3. That page reuses the existing `(auth)` login/register UI with a "linking your account for Shopify try-on" banner. Shopper signs in or creates a new account — this **is** their one universal tryme profile, same `users` row as the main app.
4. On success, the page calls `POST /v1/shopify/customer/account/link` with the shopper's real access token, gets `{ code }` (keyed only to `userId` — the popup page never knows or needs to know which store initiated this), then `postMessage`s `{ type: 'tryme-widget-link', code }` to `window.opener`, checking the target origin matches the `origin` param from step 2, and closes.
5. Widget JS verifies `event.origin` against the store's own origin, calls `POST /v1/shopify/customer/account/exchange` with `{ code }` (authenticated via `requireShopifyStoreKey`, same as every other customer route — this is what tells the server which store the token is for; never trust a client-supplied store id). Server burns the code for `userId`, mints the account token with `storeId` taken from `requireShopifyStoreKey`'s own resolved store, returns it. Widget stores it in `localStorage` (scoped to the store's own origin — persists across visits until expiry).
6. A "Linked as {email} · Unlink" chip replaces the sign-in button once linked. "Unlink" just clears `localStorage` (token is stateless, not revoked server-side — acceptable given the ~30 day expiry).

## Billing Resolution

Every Shopify job now follows the exact main-app pattern:
- No valid account token → widget shows "Sign in to try on," job is never created.
- Valid token, insufficient balance → `atomicDeduct` fails with `INSUFFICIENT_CREDITS` (402, matching `apps/api/src/modules/credits/ledger.ts`'s existing behavior), widget shows "Out of credits — top up your account" with a link.
- Valid token, sufficient balance → job created, `userId`/`shopifyStoreId` set, `user_credits` debited at `getTryonCreditCost(app)`, `credit_ledger` entry written (reason `JOB_DISPATCH`, matching the existing convention in `ledger.ts` rather than inventing a new reason string).
- Terminal failure (dispatcher) → refund via the same `credits/` refund helper against `user_credits`, not `widgetRefund`. `processShopifyJob` branches on `jobs.userId` being set (always true post-migration) instead of `widgetClientId`.

`SHOPIFY_JOB_COST` (env, `apps/api/src/env.ts`) becomes dead once nothing charges it — remove the env var and its references rather than leaving an unused cost constant around.

## Error Handling

New/changed error codes on `POST /v1/shopify/customer/jobs`:
- `UNAUTHORIZED` (401) — missing/expired/invalid account token.
- `INSUFFICIENT_CREDITS` (402) — reuse the existing main-app error code from `atomicDeduct`, don't invent a Shopify-specific one.
- Existing `NO_WORKFLOW_CONFIGURED`/`SHOPIFY_INPUTS_MISSING` codes (from the funnel-templates work) are unchanged.

## Testing Approach

Backend gets full TDD, matching this repo's existing convention for `apps/api`/`apps/dispatcher`:
- `requireShopifyStoreKey` preHandler: valid/invalid/missing key, origin check.
- Account link/exchange: code mint, single-use burn, expiry, storeId mismatch rejection.
- Job creation: no token → 401; insufficient balance → 409, no job row created; success → `userId`+`shopifyStoreId` set, `user_credits` debited, `credit_ledger` row written.
- Dispatcher refund path: terminal failure with `userId` set refunds `user_credits`, not `widget_client_credits`.
- Migration backfill: a `shopify_stores` row with a known `widget_client_id` ends up with matching `storeKey`/`allowedOrigins` post-migration, and the FK column is gone.

`apps/shopify` (embedded admin) and the theme extension (`tryon-widget.js`) stay manual-verification-only, matching every prior frontend task in this project.

## Deferred / Out of Scope

- Cleanup/deletion of orphaned `widget_clients`/`widget_client_credits`/`merchant_payments` rows for already-installed Shopify stores.
- Generic (non-Shopify) embeddable widget: entirely untouched, keeps its merchant-funded `widget_client_credits` model.
- Any UI for a shopper to see their linked-account try-on history from within the Shopify storefront (they can already see it in the main app under their own account).
- Revoking an account token server-side before its natural expiry (Unlink is client-side only).
