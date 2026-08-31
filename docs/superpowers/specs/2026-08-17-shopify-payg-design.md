# Shopify pay-as-you-go (usage-based) billing — design

**Date:** 2026-08-17
**Status:** IMPLEMENTED (merged via PR #190), then SUPERSEDED on 2026-08-19 —
to be removed by `2026-08-19-shopify-credit-wallet-design.md`
**Branch:** `feature/shopify-payg-billing`
**Supersedes:** `2026-08-17-shopify-credit-topup-design.md` (blocked — see that file)

## Why this is being removed (2026-08-19)

Nothing here was wrong. The App Events integration, the reconciliation check
against `AppUsagePricing` (which catches the API's always-202 behaviour), and
the app-side spend cap all worked as designed and were verified in review.

The product model changed underneath it. The Shopify surface is moving to
non-expiring prepaid credit packs with no monthly commitment, which means
leaving Shopify App Pricing for Manual Pricing — and App Events meters only
bill against an App Pricing metered plan. Everything in this spec is therefore
being deleted, not migrated.

One correction worth recording: this spec's "Open verification item" about the
App Events `client_id`/`client_secret` being a distinct credential was the
right instinct, and the same discipline applied on 2026-08-19 is what caught
that the *superseded* top-up spec had asserted a non-existent webhook gap.

## Problem

Shopify merchants get credits once per billing cycle from a subscription plan
(starter / growth / pro). A merchant who burns through a cycle's credits early
has to wait for renewal or upgrade to a bigger plan. A separate class of
merchant — one who doesn't want a monthly commitment at all — has no option
except a plan they may barely use.

A prepaid top-up (buy a pack, spend it later) was the first design explored for
this, but it depends on `appPurchaseOneTimeCreate`, a manual-pricing (Billing
API) mutation. Verified against shopify.dev: Shopify App Pricing's own
limitations page lists exactly three supported models — fixed recurring,
usage-based, and combinations of the two — and one-time purchases aren't among
them. The one-time-purchase docs live exclusively under
`/docs/apps/launch/billing/manual-pricing/`, and Shopify's own migration guide
tells apps that used one-time charges for PAYG to **replace them with a usage
meter** when moving onto App Pricing. This app is already on App Pricing
(`subscription-client.ts`, the hosted plan picker); building on the Billing API
would mean a second billing system or abandoning that hosted automation for the
three existing plans.

Usage-based pricing is native to App Pricing and needs none of that trade-off.
This design uses it to solve both problems above with one mechanism: a
standalone "Pay as you go" plan, metered per try-on, no monthly base.

## Approach

Shopify App Pricing's usage-based pricing works through the **App Events API**:
define a meter in Partner Dashboard (fixed/graduated/volume pricing), then POST
billing events to Shopify as usage happens. Shopify aggregates and invoices; no
confirm flow, no polling for individual charges.

### Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Shape | Standalone 4th plan, $0 base + meter | What was actually asked for — a real alternative to subscribing, not an overage add-on to existing plans. Simpler: one new `plan_handle`, zero interaction with existing plans' credit grants. |
| Price | $0.10 / try-on | 1.33× starter's $0.075/try-on — the same premium multiple the (superseded) top-up packs landed on. No monthly commitment justifies the premium; still legible to a merchant. |
| Spend cap | Merchant self-serve, admin override | Shopify usage meters have **no cap support today** (confirmed in App Pricing's limitations page), so this is entirely app-side. Merchant sets their own ceiling in the SPA; admin panel can view/override per store as a support tool, not the primary path. |
| Credits ledger | Not touched at all | PAYG stores never write to `shopify_store_credits` / `shopify_credit_ledger`. Billing is priced and capped in dollars directly — a deliberate divergence from every other billing path in this app, not an oversight. |

## Flow

```
Merchant picks "Pay as you go" on Shopify's hosted plan picker
  (Partner Dashboard: $0/mo recurring + `tryon_generated` meter, fixed $0.10/unit)
                              │
syncStoreSubscription (existing, extended)
  planHandle === 'payg' → billingMode='usage', persist subscriptionIsTest
  NO credit grant — creditsForPlanName path is skipped entirely for this handle
                              │
Job creation (apps/api/src/modules/shopify/customer.routes.ts)
  billingMode === 'usage'
    → skip requireStoreHasCredits / atomicDeductStore entirely
    → check: Σ this-cycle shopify_usage_events.priceUsd < store.paygSpendCapUsd
    → else reject with a distinct "spend cap reached" error
                              │
Dispatcher marks the job SUCCEEDED (existing path — no new external call)
  → INSERT shopify_usage_events (storeId, jobId, priceUsd, status='PENDING')
    A job that fails never gets a row. No refund mechanism is needed — not
    reporting achieves the same effect as prepaid's transactional refund,
    for free, because this is postpaid.
                              │
usage-scheduler tick (new, ~3 min — tighter than the hourly billing sync,
  because spend-cap accuracy matters more here than subscription-status drift)
  refresh the app-level JWT (Redis-cached, refreshed short of its 60-min expiry)
  PENDING rows → POST App Events, idempotency_key = "usage:<jobId>" → mark REPORTED
                              │
reconciliation (folded into the existing hourly runBillingSyncTick, PAYG stores only)
  Σ REPORTED this cycle   vs.   AppUsagePricing.balanceUsed (existing per-store
                                 Admin GraphQL client — same one syncStoreSubscription uses)
  mismatch beyond ordinary async-processing lag → app.log.error
```

### Why the reconciliation tick is load-bearing, not a nice-to-have

The App Events API **always returns 202**, even when the event fails billing
validation (wrong event handle, no active metered subscription, meter
misconfigured in Partner Dashboard). There is no synchronous error and no
webhook for a billing validation failure — Shopify's own docs say to check the
Dev Dashboard logs, which is a human-only surface, not something this app can
poll. That means marking a row `REPORTED` only ever means "we sent it," never
"Shopify billed it."

`AppUsagePricing.balanceUsed`, read through the **already-existing** per-store
Admin GraphQL client, is the only machine-readable signal that closes that gap.
Comparing our own reported total against Shopify's actual billed total is what
would catch, for example, a meter's `event_handle` being typo'd in Partner
Dashboard — a mistake that would otherwise run silently for an entire billing
cycle with every event returning a normal 202.

## Auth layers

Three, only one of them new:

| Layer | Auth | Used for |
|---|---|---|
| Admin GraphQL (existing) | per-store offline token, `getValidAccessToken` | subscription sync (unchanged) · **new:** one-time `shop { id }` lookup, cached · **new:** reconciliation read of `balanceUsed` |
| App Events API (**new**) | app-level JWT via `client_credentials` (`client_id` + `client_secret` → token, 60-min expiry) — **one shared token for the whole app**, not per-store | write-only: reporting usage |
| Dispatcher | unchanged — DB-only | stays completely unaware of Shopify; only ever writes a local Postgres row |

**Open verification item, not to be guessed at implementation time:** the App
Events `client_id`/`client_secret` pair is generated in the **Dev Dashboard**,
which per Shopify's docs may be a distinct credential from `SHOPIFY_API_KEY` /
`SHOPIFY_API_SECRET` (the OAuth client id/secret this app already uses for
install/token-exchange). Do not assume they're the same value — confirm in the
Partner/Dev Dashboard before wiring `usage-scheduler.ts`, the same way the
one-time-purchase assumption in the superseded spec should have been confirmed
before being written down.

## Data model

New columns on `shopify_stores`:

| Column | Type | Notes |
|---|---|---|
| `billing_mode` | text, `'prepaid' \| 'usage'` | set by `syncStoreSubscription` from `planHandle`; `'prepaid'` is the default for every existing store |
| `shopify_shop_id` | text, nullable | numeric `gid://shopify/Shop/…`, lazily fetched and cached on first usage report — App Events needs it and it isn't otherwise stored |
| `payg_spend_cap_usd` | integer (cents) | merchant-set; seeded with a default (e.g. $50) the moment a store's `billingMode` first becomes `'usage'` |
| `subscription_is_test` | boolean | persists a field `syncStoreSubscription` already reads (`subscription.test`) but currently discards; needed to gate usage reporting the same way `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` already gates credit grants |

New table `shopify_usage_events`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `store_id` | uuid fk → `shopify_stores` (cascade) | |
| `job_id` | uuid, unique | one row per successful job; the unique constraint is the idempotency backstop if the dispatcher's insert ever runs twice |
| `price_usd` | integer (cents) | snapshotted from the code constant at insert time, same "never re-read config later" reasoning as the superseded top-up spec's credits column |
| `status` | text, `'PENDING' \| 'REPORTED'` | |
| `created_at` / `reported_at` | timestamptz | |

Index on `(store_id, created_at)` — both the spend-cap check and reconciliation
query by store and cycle window.

**PAYG stores never appear in `shopify_credit_ledger`.** This is intentional:
mixing a dollar-denominated postpaid model into a credits-denominated prepaid
ledger would make every existing ledger query (`atomicDeductStore`,
`refundStoreAndMarkFailed`, admin reporting) need to reason about a currency it
wasn't built for. Keeping them fully separate costs one more table.

## Components

### `apps/api/src/modules/shopify/payg.ts` (new)

- `PAYG_PRICE_PER_TRYON_USD = 0.10` — the code-side mirror of the Partner
  Dashboard meter price, same "two systems, no type-check between them" warning
  `billing-plans.ts` already carries for plan names. If the Partner Dashboard
  price is ever changed, this constant must change in the same PR or the
  spend-cap check and the actual bill silently diverge.
- `EVENT_HANDLE = 'tryon_generated'` — must match the meter handle configured
  in Partner Dashboard exactly (case-sensitive, per App Events docs).
- `checkPaygSpendCap(app, store)` — sums `shopify_usage_events.price_usd` for
  the current cycle window (aligned to `store.currentPeriodEnd`, the same field
  the subscription sync already tracks) and compares to `paygSpendCapUsd`.
- `reportUsageEvent(app, store, jobId)` — the App Events POST, called from the
  scheduler, not from the request path.

### `apps/api/src/modules/shopify/app-events-client.ts` (new)

- `getAppEventsToken(app)` — client_credentials exchange, caches the JWT in
  Redis with a TTL a few minutes short of the real 60-minute expiry so a
  refresh always happens before Shopify would reject it.
- `getOrFetchShopifyShopId(app, store)` — one Admin GraphQL `shop { id }` call
  per store, ever; persists the result.

### `apps/api/src/modules/shopify/usage-scheduler.ts` (new)

Mirrors `billing-scheduler.ts`'s shape exactly (`runUsageReportTick` /
`startUsageScheduler`, same "skip this tick if the previous one is still
running" guard) — a ~3-minute interval instead of hourly, since a stale
spend-cap check has a direct dollar cost in a way a stale subscription-status
check doesn't.

### Reconciliation

Extends the existing `runBillingSyncTick` (or a step alongside it) for stores
with `billingMode === 'usage'`: reads `balanceUsed` via the existing
`getActiveSubscription`-style Admin GraphQL call, compares to the sum of
`REPORTED` rows for the current cycle, logs a mismatch beyond a small tolerance
(async processing lag).

### Job creation (`apps/api/src/modules/shopify/customer.routes.ts`)

The existing `requireStoreHasCredits(app, store, jobCost)` /
`atomicDeductStore(tx, storeId, jobCost, jobId)` pair is wrapped in a branch on
`store.billingMode`. `'prepaid'` keeps today's exact behavior. `'usage'` calls
`checkPaygSpendCap` instead and performs no deduction — there is nothing to
deduct from.

### Dispatcher (`apps/dispatcher/src/job/processor.ts`)

On the existing SUCCEEDED transition, for a job whose store has
`billingMode === 'usage'`: one additional `INSERT` into `shopify_usage_events`,
in the same transaction as the status update. No new dependency, no new
outbound call — the dispatcher's "never talks to Shopify" boundary is
unchanged, because writing a Postgres row isn't talking to Shopify.

### `apps/shopify` (frontend)

- `PricingPage.tsx` — a fourth card, "Pay as you go," `$0/mo + $0.10 per
  try-on`, no credits/virtualTryOns fields (those are meaningless for this
  plan) — a distinct rendering branch, not a `PlanFeatureSet` with fields
  awkwardly repurposed.
- New settings control for `paygSpendCapUsd` — number input, bounded (min ~$5),
  visible only when `billingMode === 'usage'`.
- Spend-this-cycle indicator, read from the same balance the API already
  computes for the cap check — a PAYG merchant should always be able to see
  "$X of $Y spent this cycle" without guessing.

## Error handling

| Case | Behaviour |
|---|---|
| Job fails before SUCCEEDED | No usage row ever inserted — never charged |
| App Events POST fails (network/auth) | Row stays `PENDING`, retried next tick |
| App Events accepts (202) but billing rejects it server-side | Undetectable synchronously by design of the API. Caught only by the reconciliation tick — this is why that tick is not optional |
| `subscriptionIsTest && SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS !== true` | Usage rows are still created (job ran, cost was real GPU time) but never reported — mirrors the existing credit-grant test gate exactly |
| Merchant at/over spend cap | Dispatch rejected before enqueue, with a message distinct from "insufficient credits" — a PAYG merchant has no credits to be insufficient |
| `shopifyShopId` lookup fails | Scheduler skips that store's pending rows this tick, retries next tick; does not block other stores |
| JWT fetch fails | Whole tick no-ops with a warn log; every row stays `PENDING` and is retried next tick — matches the "skip if still running" guard already used for the billing sync |

## Testing

Unit:
- `checkPaygSpendCap` — under cap allows, at/over cap rejects, cycle window
  boundary (a job from the *previous* cycle must not count against the current
  cap).
- App Events token cache — reuses a live token, refreshes before expiry, single
  in-flight refresh under concurrent callers (no thundering herd on expiry).

Integration:
- Job creation: `billingMode='usage'` skips the credit check entirely; a store
  at its cap is rejected; a store under its cap dispatches with no ledger row
  written anywhere.
- Dispatcher: a SUCCEEDED job for a `'usage'` store writes exactly one
  `shopify_usage_events` row; a FAILED job writes none.
- Usage scheduler: `deps`-injected App Events client (no network) — `PENDING` →
  `REPORTED` on success, stays `PENDING` on failure, idempotency on a row
  reported twice (second call is a no-op given the unique `job_id`).
- Reconciliation: a manufactured mismatch between reported total and a mocked
  `balanceUsed` produces the error log.
- Test-subscription gate: `subscriptionIsTest=true` with the flag off creates
  rows but the scheduler never reports them.

## Out of scope

- Graduated/volume pricing tiers (bulk discounts within PAYG). Fixed pricing
  only for v1 — a PAYG merchant who wants a discount for volume is the exact
  merchant who should be looking at growth/pro instead.
- Switching a store between `'prepaid'` and `'usage'` mid-cycle with partial
  proration logic beyond what Shopify's own plan-change handling provides.
- Admin-configurable price. Same reasoning as the superseded top-up spec: price
  is what's sent (indirectly, via the meter definition matching this constant)
  to Shopify's billing, so it's code-only, not Redis-config-tunable.
- A machine-readable alert (Slack, PagerDuty) on a reconciliation mismatch.
  `app.log.error` only for v1; wiring an alert is an ops task, not a design
  question.
