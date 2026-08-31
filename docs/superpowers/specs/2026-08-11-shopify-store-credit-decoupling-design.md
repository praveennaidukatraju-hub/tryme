# Shopify store credit decoupling — design spec

## Context

Today, a Shopify store's credits are not actually separate from the merchant's
tryme.com web-app credits. `shopify_stores.ownerUserId` links a store to a
`users` row (set via an in-app "link your tryme.com account" flow), and
both Shopify billing paths write into that user's shared `user_credits`
balance:

- `grantShopifyTrialCredits` (one-time 25 credits per store) —
  `apps/api/src/modules/shopify/billing.ts:188-194`
- `syncStoreSubscription` (starter/growth/pro plan credits, hourly poll +
  confirm-redirect) — `billing.ts:118-124`

`atomicDeduct` (`apps/api/src/modules/credits/ledger.ts:7-22`) is
source-agnostic — it just checks `balance >= amount` and decrements, with no
awareness of whether the balance came from a web purchase, a Shopify trial
grant, or a Shopify plan-sync grant. Confirmed directly: a merchant's
web-purchased credits are spendable by a Shopify-triggered job
(`catalog.routes.ts` admin "Generate", `customer.routes.ts` storefront
widget), and vice versa. This is a deliberate merge today (every credit
feature built this session assumed one shared wallet) but the product
decision now is to **prevent** the two pools from mixing.

The `jobs` table already anticipates a store-billed path: `jobs.userId` is
nullable, and `jobs.shopifyStoreId` already exists as a nullable FK
(`packages/db/src/schema/jobs.ts:25,57-59`). What's missing is everywhere
that currently assumes `userId` is both the job owner and the billing
target: `createJob`'s single `userId` parameter
(`apps/api/src/modules/jobs/create.ts:713-715`), the dispatcher's inlined
refund logic keyed on a non-null-asserted `job.userId!`
(`apps/dispatcher/src/job/processor.ts`), and the SSE progress channel name
(`sse:events:${userId}`), which today only works for Shopify jobs because
`jobs.userId === store.ownerUserId` coincidentally.

Because credits become store-scoped, the account-link flow that exists
purely to identify a billing target (`LinkAccountGate`, "Disconnect
account") no longer serves any purpose and is removed. There are no real
merchants on this yet ("no real users" — confirmed), so no data migration is
needed for historical merged credit amounts.

## Goals

- Shopify-store credits (trial grant + plan-sync grant) live in a balance
  scoped to the store, never mixing with any tryme.com user's
  `user_credits` balance.
- Shopify-triggered jobs (merchant "Generate" in the embedded app, storefront
  widget try-ons) deduct from and refund to the store's balance, not any
  user's balance.
- The account-link flow (login-to-link, "Disconnect account") is removed
  entirely — the embedded app works immediately after install, no login
  step.
- The merchant dashboard shows the store's active plan more prominently than
  today's inline text.
- Admin gets a new "Shopify Stores" page to see store credit balances and
  activity history, replacing the now-nonsensical idea of showing Shopify
  activity on a `users` admin page (stores have no user relationship
  anymore).

## Non-goals

- Dropping `shopify_stores.ownerUserId` from the schema. Left in place,
  unused. No functional gain from a migration that removes it.
- Reconciling or backfilling historical credit amounts that are already
  merged into linked users' `user_credits` balances. Confirmed: no real
  merchants exist yet, so every store simply starts its new store-scoped
  balance at 0.
- Admin-triggered manual credit grants/adjustments on the new Shopify Stores
  page. Read-only for this pass.
- Renaming "Disconnect account" — moot, the button is removed entirely along
  with the rest of the account-link flow.
- Any change to `credit_ledger` / `user_credits` schema or behavior. The
  web-app credit system is untouched; this spec only adds a parallel,
  separate system for Shopify stores.
- Retrying/backfilling `jobs.userId` for historical Shopify job rows that
  already have it set from before this change. Existing rows are left as
  they are; only new Shopify jobs get `userId: null`.

## Design

### Data model

Two new tables, mirroring `user_credits` / `credit_ledger` in shape and
semantics rather than reusing them or bolting a balance column onto
`shopify_stores`:

- **`shopify_store_credits`** — one row per store: `storeId` (unique FK →
  `shopify_stores.id`), `balance`. Deduct uses the same atomic pattern as
  today's `atomicDeduct`: `UPDATE ... SET balance = balance - $amount WHERE
  store_id = $id AND balance >= $amount`.
- **`shopify_credit_ledger`** — immutable history: `storeId`, `delta`,
  `reason` (`SHOPIFY_TRIAL`, `SHOPIFY_SUBSCRIPTION`, `JOB_DISPATCH`,
  `REFUND`), `jobId` (nullable FK → `jobs.id`), `externalRef` (unique, reuses
  the existing idempotency pattern from `grantShopifyTrialCredits` /
  `syncStoreSubscription`), `createdAt`.

Rationale for a new table pair instead of reusing `credit_ledger`: its
`userId` column is `NOT NULL` today, so store-billed entries can't live
there without loosening a constraint on a live financial table. Physically
separate tables make "credits don't mix" true by construction, and the
migration is purely additive (two new tables, no `ALTER` on existing
financial tables).

### Job creation & billing flow

New `createShopifyStoreJob(app, store, body, opts)` in
`apps/api/src/modules/jobs/create.ts` (alongside, not replacing,
`createJob`), used by `catalog.routes.ts` and `customer.routes.ts` in place
of today's `createJob(app, store.ownerUserId, ...)` calls. It:

- Inserts the `jobs` row with `userId: null`, `shopifyStoreId: store.id`
  (both columns already exist and are already nullable/present — no `jobs`
  table migration).
- Deducts via a new `atomicDeductStore(tx, storeId, amount, jobId)` in a new
  `apps/api/src/modules/credits/shopify-ledger.ts`, mirroring `ledger.ts`'s
  `atomicDeduct` but targeting `shopify_store_credits` /
  `shopify_credit_ledger`.

`requireStoreOwnerWithCredits` (`customer.routes.ts:146-162`) is replaced by
a store-balance check: "does this store have `balance >= cost`" — no more
`ownerUserId` presence check.

`billing.ts`'s `grantShopifyTrialCredits` and `syncStoreSubscription` switch
their transactional inserts from `user_credits` / `credit_ledger` (keyed on
`ownerUserId`) to `shopify_store_credits` / `shopify_credit_ledger` (keyed on
`store.id`) — same `onConflictDoNothing` / `onConflictDoUpdate` idiom, only
the target table and key column change.

### Dispatcher refund + SSE rekeying

`apps/dispatcher/src/job/processor.ts`'s `terminateJob` and
`markShopifyFailed` currently inline their own refund SQL (not calling
`apps/api/src/modules/credits/ledger.ts`) and read `job.userId!`, non-null
asserted with a comment claiming it's guaranteed for Shopify jobs. That
assertion becomes false once `createShopifyStoreJob` starts inserting
`userId: null`. Both functions branch:

- `job.shopifyStoreId` set → refund via a new dispatcher-local equivalent
  targeting `shopify_store_credits` / `shopify_credit_ledger` (reason
  `REFUND`, same pattern as today, new tables).
- Otherwise → existing `userId`-keyed path, unchanged.

SSE: publish side (`processor.ts:2372-2374`, `state.ts:79`) and subscribe
side (`customer.routes.ts:556`) currently agree only because
`jobs.userId === store.ownerUserId` today. Both switch to a
`shopifyStoreId`-based channel when the job has one:
`sse:events:store:${shopifyStoreId}`, falling back to today's
`sse:events:${userId}` for non-Shopify jobs. The dispatcher already has
`shopifyStoreId` on the in-memory job row it's processing — no new query.

Same branch-on-`shopifyStoreId` pattern applies consistently in all three
places (deduct/refund, SSE publish, SSE subscribe).

### Account-link removal

- `apps/shopify/src/components/LinkAccountGate.tsx` deleted;
  `App.tsx:92-98`'s `!me.store.ownerUserId` gate removed — embedded app goes
  straight to `DashboardPage` after install.
- `POST /v1/shopify/store/account/link` and `/unlink`
  (`auth.routes.ts:270-302`) deleted.
- `DashboardPage.tsx`'s `disconnectAccount()` (128-140), the "Disconnect
  account" button (346-348), and its confirm modal (353-371) deleted —
  nothing left to disconnect.
- `GET /v1/shopify/me` (`me.routes.ts:58-141`) stops selecting `user_credits`
  via `ownerUserId`; `creditBalance` comes from `shopify_store_credits`
  keyed on `store.id` directly — always present, no more `null` case for an
  unlinked store.
- `ShopifyMe` type (`apps/shopify/src/types.ts:76-87`) drops
  `store.ownerUserId` from the shape.
- `shopify_stores.ownerUserId` column itself: left in place, unused (see
  Non-goals).

### Dashboard plan-prominence + admin Shopify Stores page

**Merchant dashboard** (`apps/shopify/src/pages/DashboardPage.tsx`): today's
plan/status display (280-296, inline text among other stats) moves to a
prominent badge/card near the top of the page — plan name
(`PLAN_LABELS[planHandle]`) + `subscriptionStatus`, alongside the store's
credit balance (now always present, sourced from `shopify_store_credits` via
`/v1/shopify/me`).

**New admin page** — `apps/admin-web/src/pages/ShopifyStoresPage.tsx` (new
nav entry in `App.tsx`):

- List view: all `shopify_stores` — shop domain, `planHandle`,
  `subscriptionStatus`, credit balance, `installedAt` / `uninstalledAt`.
- Detail view (click a row): that store's `shopify_credit_ledger` history
  (reason, delta, timestamp, `jobId` link) — same shape as the existing
  per-user credit-activity view, scoped to a store instead of a user.
- Backend: new `apps/api/src/modules/admin/shopify-stores.routes.ts` — `GET
  /admin/shopify-stores` (list), `GET /admin/shopify-stores/:id/ledger`
  (paginated history). Read-only (see Non-goals).

This replaces the originally-proposed idea of splitting a user's admin page
into "tryme credit activity" / "Shopify credit activity" tabs — that
doesn't make sense once stores have no relationship to any user. The
existing per-user credit-activity view on the admin Users page is unchanged
and, going forward, will simply never show `SHOPIFY_TRIAL` /
`SHOPIFY_SUBSCRIPTION` reasons again (those move entirely to the new
store-scoped ledger).

### Migration

Two new tables via a normal Drizzle migration — additive only, no `ALTER` on
`user_credits` or `credit_ledger`. No backfill script: every existing
`shopify_stores` row has no `shopify_store_credits` row until its next grant
event. A store that already claimed its one-time trial grant (idempotent via
`externalRef`) does not get a second one — it starts at 0 and waits for its
next billing-sync tick (hourly, or the confirm-redirect) to receive plan
credits under the new system.

## Testing

Integration tests (Vitest, real docker-compose Postgres, matching this
repo's existing pattern — no testcontainers):

- `atomicDeductStore`: balance floor enforcement, concurrent-deduct race
  behavior (same shape as existing `atomicDeduct` tests).
- `grantShopifyTrialCredits` / `syncStoreSubscription` writing to
  `shopify_store_credits` / `shopify_credit_ledger` instead of
  `user_credits` / `credit_ledger`.
- `createShopifyStoreJob` inserting `userId: null` and the correct
  `shopifyStoreId`.
- Dispatcher refund branching (`shopifyStoreId` present vs. absent) —
  extends existing dispatcher job-processor test coverage.
- New `GET /admin/shopify-stores` and `GET
  /admin/shopify-stores/:id/ledger` routes.

Manual verification pass: full install → trial-grant → generate → spend →
refund-on-failure loop against a dev store, confirming SSE progress still
reaches the merchant's embedded dashboard through the rekeyed channel.

## Open follow-up (not part of this spec)

- Admin-triggered manual credit grants/adjustments for Shopify stores, if
  support needs it later.
- Whether to eventually drop the unused `shopify_stores.ownerUserId` column
  in a cleanup pass.
