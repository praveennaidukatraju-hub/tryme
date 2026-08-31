# Shopify Storefront Widget: Bill Merchant, Not Shopper — Design

## Context

The Shopify storefront try-on widget (`apps/shopify-extension/extensions/tryon-theme-extension`) currently requires the **shopper** (the merchant's customer, browsing the storefront) to link their own tryme account before using Try It On, and bills the shopper's own tryme credit balance for each generation (shipped in commit `700bbfb`, "gate try-on behind account linking, bill user's own credits").

This reverses that model. Shoppers should never see a login step. Every try-on generation on a merchant's storefront is billed against the **merchant's own** tryme credit balance — the same balance now exposed via `shopifyStores.ownerUserId`, added earlier this session for the merchant-side account-link feature (see `docs/superpowers/specs/2026-07-10-shopify-merchant-account-link-design.md` and its plan).

This is a pure removal/redirect of an existing billing target — no new infrastructure. The merchant-side account-link mechanism (mint/resolve codes, `widget-link-complete` popup page) is reused unmodified; only the shopper-facing half of the same code family goes away.

## Why shoppers can never hit an "unlinked store" state

The embedded Polaris admin (`apps/shopify`) already gates all merchant screens — Dashboard, Products, Funnel Setup — behind the merchant linking their tryme account (`LinkAccountGate.tsx`, built earlier this session). Funnel Setup is where the merchant enables the storefront embed/theme block. Since a merchant cannot reach Funnel Setup until `shopifyStores.ownerUserId` is set, a shopper can never encounter a live "Try It On" button on a store whose owner hasn't linked an account. No shopper-facing UX is designed for this case; the API still defensively checks for it (see below), but it's unreachable through the normal product flow.

## Behavior Changes

### 1. Job creation bills the merchant, not the shopper

`POST /v1/shopify/customer/jobs` (`apps/api/src/modules/shopify/customer.routes.ts`) currently requires a shopper-specific Bearer token (`requireAccountUserId`, verified via `verifyShopifyAccountToken`) in addition to the store's widget key. That requirement is removed. The route now only needs `x-widget-key` (already resolved to `req.shopifyStoreRow` via the existing `requireShopifyStoreKey` preHandler).

- `jobs.userId` is set to `store.ownerUserId` instead of a shopper's linked userId.
- `atomicDeduct` charges `store.ownerUserId`'s credit balance.
- If `store.ownerUserId` is null (defensive only — see above), the route throws `AppError('INSUFFICIENT_CREDITS', 402, ...)` directly, before ever calling `atomicDeduct` (which requires a real userId to query `userCredits`). If the merchant has insufficient credits, `atomicDeduct` itself throws the same error. The widget treats both identically — see below.

### 2. Shopper-facing error message

The widget's existing 402 handler currently shows: `Out of credits — <a href="${appBase}/pricing">top up your account</a>`. This referenced the shopper's own account and pricing page, which no longer exists in this flow. It's replaced with a plain, generic message: **"Try-on is temporarily unavailable, please check back later."** No link, no mention of credits, accounts, or billing.

### 3. Job status/events scoped by store, not shopper

`GET /v1/shopify/customer/jobs/:id` and `GET /v1/shopify/customer/jobs/:id/events` currently check `job.userId === userId`, where `userId` came from the shopper's own verified token — this stopped one shopper from reading another shopper's job. Now that `jobs.userId` is the same merchant account for every shopper on a given store, that check no longer distinguishes shoppers from each other. It's replaced with `job.shopifyStoreId === storeId` (the store resolved from the widget key). `jobId` is a random UUID, unguessable in practice, so this preserves the same practical protection the old check gave, without needing any shopper identity at all.

The SSE channel these two routes subscribe to (`sse:events:${userId}`) becomes a channel shared by every shopper of a given store (since `userId` is now the merchant's `ownerUserId`). This is harmless: the subscriber already filters incoming events by `jobId` before forwarding them to the client (`if (evt.jobId !== id) return;` in `customer.routes.ts`), so a shopper only ever sees events for the specific job they created.

### 4. Removed entirely (dead code)

These become unused once shoppers no longer authenticate:

- Route: `POST /v1/shopify/customer/account/exchange` (`customer.routes.ts`)
- Functions: `signShopifyAccountToken`, `verifyShopifyAccountToken` (`apps/api/src/modules/shopify/customer-auth.ts`)
- Helper: `requireAccountUserId` (`customer.routes.ts`)
- Widget (`tryon-widget.js`): `ACCOUNT_TOKEN_KEY`, `getAccountToken`/`setAccountToken`/`clearAccountToken`, `linkAccount()`, `exchangeCode()`, `doAccountLink()`, the `signin` step's wiring, the `Authorization: Bearer` header on every customer-route fetch call.
- Widget modal UI: the `signin` step (`.tryme-tryon__step--signin` and its button) — clicking "Try It On" now goes straight to the `upload` step whenever the modal opens.
- `app_base` / `appBase` / `data-app-base` — this attribute existed only to build the shopper login popup URL and the old pricing link. Both are gone, so the attribute is removed from the JS, the Liquid template, and the block's `{% schema %}` settings entirely.

**Kept as-is** (still used by the merchant-side flow, which is unrelated to this change):
- `mintAccountLinkCode` / `resolveAccountLinkCode` (`customer-auth.ts`)
- `apps/catalogues-web/src/app/widget-link-complete/page.tsx`
- `POST /v1/shopify/customer/account/link` (mints a code for whichever tryme user is logged in — used by the merchant's `LinkAccountGate.tsx` popup flow via the same generic mechanism)

### 5. `api_base` stays

The `api_base` / `data-api-base` setting is unrelated to shopper login — it's the base URL for photo upload, job creation, and status polling — and is unaffected by this change.

## Data Flow (after this change)

1. Shopper clicks "Try It On" on a product page → modal opens directly to the upload step (no signin gate).
2. Shopper picks a photo → `POST /v1/shopify/customer/presign` (widget-key only, unchanged) → uploads to R2.
3. Widget calls `POST /v1/shopify/customer/jobs` with just the widget key. API resolves `store.ownerUserId`, deducts credits from that account, creates the job with `userId = store.ownerUserId`.
4. Widget polls/streams `GET /v1/shopify/customer/jobs/:id` / `.../events`, now authorized by `job.shopifyStoreId === storeId` instead of a shopper identity.
5. On 402 (merchant unlinked or out of credits), widget shows the generic unavailable message.

## Testing

- `apps/api/test/integration/shopify-customer.test.ts` — rewritten:
  - Job creation succeeds with only `x-widget-key` when the store has `ownerUserId` set and sufficient credits; the created job's `userId` equals the store's `ownerUserId`; the owner's credit balance is decremented by the job cost.
  - Job creation returns 402 when the store's `ownerUserId` is null.
  - Job creation returns 402 when the merchant's credit balance is insufficient.
  - `GET /jobs/:id` returns the job for the correct store's widget key and 404s for a different store's widget key, regardless of shopper identity (there is none).
  - The `/v1/shopify/customer/account/exchange` route no longer exists (404, not 401).
- `apps/api/src/modules/shopify/customer-auth.test.ts` — trimmed to just the `mintAccountLinkCode`/`resolveAccountLinkCode` round-trip test; the sign/verify token tests are deleted along with the functions they test.

## Out of Scope

- Per-store analytics/admin dashboards (credit spend, product traffic) — already deferred to a separate future plan per earlier discussion this session.
- Any change to the merchant-side account-link flow built earlier this session — unaffected by this spec.
