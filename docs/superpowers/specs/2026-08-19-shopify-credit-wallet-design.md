# Shopify prepaid credit wallet — design

**Date:** 2026-08-19
**Status:** approved, not yet implemented
**Branch:** `feature/shopify-credit-wallet`
**Supersedes:** `2026-08-17-shopify-payg-design.md` (implemented, to be removed by this work)
**Revives:** `2026-08-17-shopify-credit-topup-design.md` (was blocked; the blocker is removable — see below)

## Problem

The Shopify surface currently bills through **Shopify App Pricing**: three
monthly plans (starter / growth / pro) that grant credits once per billing
cycle, plus a standalone "Pay as you go" plan metered per try-on through the
App Events API. Both are implemented and merged.

Neither matches the product we actually want to sell. The intended model is a
**prepaid wallet**: four credit packs a merchant buys whenever they need them,
with no monthly commitment and no expiry — a merchant may spend a $10 pack in
ten days or in forty, and that is their business, not ours to schedule.

Every cycle-scoped mechanism in the current billing code exists to serve a
model we are abandoning.

## Why this is now possible (and wasn't on 2026-08-17)

`2026-08-17-shopify-credit-topup-design.md` designed this feature and abandoned
it, correctly, because `appPurchaseOneTimeCreate` is unavailable on App
Pricing. That fact is unchanged. What changed is the *cost of removing the
constraint*, and one factual error in that spec.

Re-verified against shopify.dev and Shopify staff replies on 2026-08-19:

| Claim | Source | Status |
|---|---|---|
| App Pricing supports only recurring, usage-based, and combinations | App Pricing docs | Confirmed |
| "Shopify App Pricing doesn't support one-time purchases" | App Pricing docs | Confirmed |
| The restriction covers one-time charges too, not just recurring | Shopify staff, community thread 32762: *"In practice, the restriction applies to all Billing API charge creation, including one-time charges."* | Confirmed — closes the loophole we might otherwise have tried |
| Switching App Pricing → Manual Pricing is possible | Shopify staff, community thread 16280 | Confirmed, from Partner Dashboard settings |
| That switch requires app re-review | Shopify staff: *"No — you won't need to be reviewed if you change to manual pricing."* | **False.** No review needed |
| "Shopify sends no webhook for a one-time purchase" (our spec, line 66) | `APP_PURCHASES_ONE_TIME_UPDATE` is a documented topic | **False.** Our spec was wrong; the webhook exists |
| Manual Pricing usage charges need per-charge merchant approval | Manual pricing docs: merchant approves `cappedAmount` once, then `appUsageRecordCreate` bills without separate approval up to that cap | **False.** This is what makes balance-triggered auto-refill possible |

The original spec rejected leaving App Pricing because we would lose the hosted
plan picker, proration, and trial automation. With no monthly plans, all three
are worth nothing:

- The hosted picker has no plans to host.
- Proration applies to plan changes that no longer exist.
- Trial automation was never used — `grantShopifyTrialCredits` is our own,
  independent of Shopify's `trialDays`.

And there are **no live paying Shopify stores**, so there is no dual-system
transition period and nothing to grandfather. The switch is close to free
today and gets more expensive with every real merchant.

## Approach

Switch the app to **Manual Pricing (Billing API)** in Partner Dashboard. Two
purchase paths feed one non-expiring credit balance.

| Path | Mutation | Merchant experience |
|---|---|---|
| **Manual top-up** | `appPurchaseOneTimeCreate` | Picks a pack, approves on Shopify's hosted page, credits land. Repeat at will. |
| **Auto-refill** (opt-in) | `appSubscriptionCreate` with `appUsagePricing` + `cappedAmount`, then `appUsageRecordCreate` per refill | Approves a monthly ceiling **once**. Balance drops below their trigger → next pack charged with no approval screen → credits land. Never runs out. |

### Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Billing system | Manual Pricing (Billing API) | The only system that supports one-time purchases at all. Cost of switching is near zero right now. |
| Credit expiry | Never | The defining property of the model. Removes every cycle window from the codebase. |
| Auto-refill trigger | Balance threshold, merchant-set, freely disableable | A monthly subscription would reintroduce exactly the monthly cadence this model exists to avoid. The merchant owns both the threshold and the on/off switch — this is a standing authorization to charge them, so it must be as easy to revoke as it was to grant. |
| Billable unit | Try-ons only, 5 credits | One unit, one price. See the catalogue-path conflict below. |
| Free tier | 25 credits (5 try-ons), once per store | Already implemented and already set to 25 — no change. |
| Auto-refill incentive | **Bonus credits, +10%** | Auto-refill must be strictly better than repeat manual buying or nobody hands over a standing authorization. Bonus credits read as a reward; a lower price would anchor merchants to a cheaper headline number for the manual packs too. |
| Pack prices | Code only, never admin-tunable | The price is the number sent to Shopify in the charge mutation. Config that changes what a merchant is *charged* is a different risk class from config that changes what they *receive*. Carried over from the superseded spec. |
| Pack credits | Admin-tunable, snapshotted at purchase | Lets generosity be tuned against real GPU cost without a deploy, while the purchase row records what the merchant was actually promised. Carried over. |
| Test-charge gate | Reuse `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` | `AppPurchaseOneTime` and `AppSubscription` both carry `test`, and the abuse is identical in shape (free dev store → free credits → repeat). One knob, existing name kept to avoid churning `.env` files on the VPS for a rename. |

## Pricing

### Billable unit

**Try-ons only, 5 credits each.** That is the single unit the Shopify packs are
sold in — `getTryonCreditCost`, defaulting to `SIMPLE_TRYON_COST = 5`
(`packages/types/src/jobs.ts:112`), admin-tunable via `tryon.creditCost`.

### Free tier

**25 credits, once per store** — 5 try-ons. Already implemented and already set
to exactly this: `DEFAULT_SHOPIFY_TRIAL_CONFIG = { trialCredits: 25 }`
(`resolution-config.ts:39`), granted by `grantShopifyTrialCredits` at install,
idempotent on `shopify_trial:<storeId>` so unlinking and relinking a store does
not re-grant. No work required; recorded here so it is not rediscovered as a
gap.

### Manual packs

Every pack is a multiple of 5 credits, so a pack never leaves an unspendable
remainder.

| Pack id | Price | Credits | Try-ons | ¢/credit | $/try-on |
|---|---|---|---|---|---|
| `pack_10` | $10 | 800 | 160 | 1.25 | $0.0625 |
| `pack_25` | $25 | 2,250 | 450 | 1.11 | $0.0556 |
| `pack_50` | $50 | 4,800 | 960 | 1.04 | $0.0521 |
| `pack_100` | $100 | 10,000 | 2,000 | 1.00 | $0.0500 |

Monotonic volume discount, no tier undercutting another. These are USD prices
directly — not converted from the ₹1,000 / ₹2,500 / ₹5,000 / ₹10,000 table they
derive from. Rounding $10.45 → $10 while keeping 800 credits is a ~4.3%
discount across the ladder, taken deliberately in exchange for clean shelf
prices.

Shopify rejects an application charge under $0.50 USD. No pack is close; worth
a code comment rather than a runtime check, since prices are static.

**Shopify takes no revenue share below $1M annual app revenue**, so these are
gross margins against GPU cost, not net of a platform cut.

### The catalogue-generation feature is removed

Four routes exist today that spend credits at a rate the pack pricing does not
describe: `POST /v1/shopify/catalog/generate` deducts `plan.cost` from
`resolveTryonPlan` — **25 / 35 / 40 credits** for HD / 2K / 4K
(`RESOLUTION_COSTS`, `packages/types/src/jobs.ts:3`), not 5. A merchant sold
"160 try-ons for $10" could exhaust the pack in 20–32 images.

**Decision: remove the feature.** Try-ons are the only billable unit, so the
only other thing in the app that can spend credits has to go.

This is cheaper than it looks, and the reason is worth recording: **the feature
has no merchant-facing UI and is unreachable in practice.** The embedded SPA
calls thirteen endpoints and none is `/v1/shopify/catalog/*`; the only match for
"catalog" anywhere in `apps/shopify/src` is a description string on a dashboard
onboarding card. Since all four routes sit behind `requireShopifySession` — and
App Bridge session tokens only work inside the Shopify admin iframe — the SPA is
the only caller that could exist, and it isn't one. This is dead code, not a
product rollback.

Removed:

| Item | Note |
|---|---|
| `catalog.routes.ts` | `POST /catalog/generate`, `GET /catalog/jobs`, `POST /catalog/jobs/:id/publish` |
| `catalog-options.routes.ts` | `GET /catalog/options` |
| `catalog-job.ts` | `createShopifyStoreCatalogJob` |
| `catalog-publish.ts` | `createProductMedia` |
| `shopify_catalog_jobs` | table + schema export; referenced only by `catalog.routes.ts` |
| `test/shopify-catalog-publish.test.ts` | |
| Both registrations in `routes.ts` | |

**Not touched:** `resolveTryonPlan` (`jobs/create.ts`) is shared with the main
web app and stays exactly as it is — only the Shopify caller goes.
`products.sync.ts`, `collections.sync.ts` and `/v1/shopify/products*` are the
widget product-enablement surface, unrelated to catalogue generation, and are
untouched.

**Drop the table only after confirming it is empty in production.** A read-only
`SELECT count(*) FROM shopify_catalog_jobs` against prod is permitted and
required first. If rows exist, the jobs they track were real and billed, and
the drop becomes a data decision rather than a cleanup — raise it rather than
proceeding.

### Auto-refill packs (+10%)

| Pack id | Price | Credits | Try-ons | Bonus vs manual |
|---|---|---|---|---|
| `pack_10` | $10 | 880 | 176 | +80 |
| `pack_25` | $25 | 2,475 | 495 | +225 |
| `pack_50` | $50 | 5,280 | 1,056 | +480 |
| `pack_100` | $100 | 11,000 | 2,200 | +1,000 |

An exact +10% lands on a multiple of 5 for every pack, so no rounding rule is
needed and the "no unspendable remainder" property holds unchanged.

The bonus is a property of the *purchase path*, not a second pack catalogue —
same ids, same prices, the `source` column decides which credit figure applies.

## Data model

### `shopify_stores` — columns removed

`plan_handle`, `subscription_status`, `current_subscription_id`,
`current_period_end`, `last_billing_sync_at`, `billing_mode`,
`payg_spend_cap_usd_cents`, `subscription_is_test`.

All of these exist to track an App Pricing subscription cycle. With no cycle,
none has a meaning. Dropping rather than leaving them nullable-and-unused is
safe precisely because there are no live paying stores; a column left behind
would be read by someone eventually and would mean nothing.

### `shopify_stores` — columns added

| Column | Type | Notes |
|---|---|---|
| `autorefill_pack_id` | text, nullable | null = auto-refill off. Which pack to buy on trigger. |
| `autorefill_trigger_credits` | integer, nullable | Balance at or below which a refill fires. Defaults to 20% of the chosen pack's credits at opt-in; merchant-editable. |
| `autorefill_subscription_id` | text, nullable | The `AppSubscription` GID carrying the usage pricing line. |
| `autorefill_capped_amount_cents` | integer, nullable | The ceiling the merchant approved. Mirrors Shopify's value; Shopify remains authoritative. |
| `autorefill_status` | text, nullable | `PENDING` \| `ACTIVE` \| `CANCELLED` \| `DECLINED` \| `CAP_REACHED` |

`autorefill_status = 'CAP_REACHED'` is ours, not Shopify's: it records that a
refill was refused because the cycle's capped amount was exhausted, so the UI
and the alerting can say something specific instead of silently falling back to
manual.

### `shopify_credit_purchases` (new)

One row per purchase attempt, on either path. Separate from
`shopify_credit_ledger` because a purchase has state *before* any credits exist
— the ledger only ever records grants that happened.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | our key; the only id that appears in a URL |
| `store_id` | uuid fk → `shopify_stores` (cascade) | checked on confirm |
| `shopify_charge_id` | text, nullable | `AppPurchaseOneTime` or `AppUsageRecord` GID; null between INSERT and the mutation returning |
| `source` | text | `manual` \| `autorefill` — also decides which credit figure applied |
| `pack_id` | text | `pack_10` … `pack_100` |
| `credits` | integer | **snapshotted at INSERT**, never re-read from config |
| `price_usd_cents` | integer | what we asked Shopify to charge, for reconciliation |
| `status` | text | `PENDING` \| `ACTIVE` \| `DECLINED` \| `EXPIRED` \| `FAILED` |
| `created_at` / `updated_at` | timestamptz | |

Index on `store_id`. Partial unique index on `(store_id)` where
`status = 'PENDING' AND source = 'autorefill'` — at most one auto-refill can be
in flight per store, which is half the double-charge guard (see Race safety).

`FAILED` is ours and means the charge was never created. Deliberately distinct
from `DECLINED`, which means the merchant saw the charge and said no —
conflating them makes the two indistinguishable when reconciling later.

### Credits are snapshotted, not re-read

`credits` is written at INSERT, before the merchant sees Shopify's confirmation
page, and the grant reads **that column** — never config, never Shopify's
response (Shopify knows the price, not the credits).

This is load-bearing because credits are admin-editable while a purchase can
sit unconfirmed indefinitely. Re-reading config at confirm time would let an
admin edit silently change what an already-paying merchant receives, with no
record of the number they were shown when they agreed to pay. The row is that
record.

### `shopify_usage_events` — dropped

App Events meters only bill against an App Pricing metered plan. Leaving App
Pricing makes the entire table dead.

### Unchanged

`shopify_store_credits`, `shopify_credit_ledger`, and `grantStore`'s
`external_ref` partial unique index (migration 0150). A wallet fits these
better than cycle grants ever did — `grantStore` is already exactly the
idempotent, externally-keyed grant primitive both purchase paths need, and
`atomicDeductStore` / `refundStoreAndMarkFailed` need no change at all.

## Flows

### Manual top-up

```
apps/shopify (SPA)              apps/api                        Shopify Admin API
"Buy 2,250 credits" ──POST──▶ /v1/shopify/billing/purchase
                               ├─ requireShopifySession
                               ├─ resolve pack → credits + price (server-side)
                               ├─ INSERT shopify_credit_purchases (PENDING, source=manual)
                               ├─ appPurchaseOneTimeCreate ──────▶ confirmationUrl, charge GID
                               ├─ UPDATE row with shopify_charge_id
                               └─ 200 { confirmationUrl }
navigateTopLevel(confirmationUrl) ──────────────────────────────▶ merchant approves
                               ◀────────── returnUrl: /shopify-admin/billing/callback?purchase=<our-uuid>
GET /v1/shopify/billing/purchase/confirm?purchase=<our-uuid>
                               ├─ load row, assert row.storeId === session store
                               ├─ node(id: shopify_charge_id) → status, test
                               ├─ ACTIVE && test-gate passes → grantStore(externalRef)
                               └─ 200 { status, creditsGranted, creditBalance }
```

The `purchase` param is our own row UUID, never the Shopify GID, and is only
ever a lookup key — credits come from the row, the charge's real state comes
from Shopify. A merchant editing it can at worst point at another row, which
the `storeId` check rejects with a 404 (not 403 — do not confirm another
store's row exists).

### Auto-refill enrolment

```
"Turn on auto-refill" ──POST──▶ /v1/shopify/billing/autorefill
                                ├─ body { packId, triggerCredits, cappedAmountCents }
                                ├─ appSubscriptionCreate ────────▶ confirmationUrl
                                │    line item: appUsagePricing { cappedAmount, terms }
                                │    recurring line: $0/month
                                ├─ persist autorefill_* columns (status=PENDING)
                                └─ 200 { confirmationUrl }
merchant approves the cap once ─────────────────────────────────▶ returnUrl → confirm route
                                └─ status=ACTIVE
```

**Open verification item — do not guess at implementation time.** Whether
Shopify permits a subscription whose only recurring line is $0 with a usage
line attached is not stated in the docs I could reach. If a $0 base is
rejected, the fallback is a nominal base (e.g. $1/month) folded into the first
refill's credits, which changes the pricing table above and must be raised
before it is built, not worked around silently. This is the same class of
assumption that sank the original top-up spec.

### Auto-refill trigger

Fires from the existing credit-deduction path, not a scheduler: the moment
`atomicDeductStore` returns a balance at or below `autorefill_trigger_credits`,
enqueue a refill. Checking on deduct rather than polling means the trigger is
evaluated exactly when the only thing that can cause it has happened.

```
atomicDeductStore returns balance <= autorefill_trigger_credits
  └─ enqueue refill (out-of-band; never blocks the job the merchant is waiting on)
       ├─ pg_advisory_xact_lock on store id
       ├─ re-read balance; still <= trigger?  (else no-op)
       ├─ INSERT shopify_credit_purchases (PENDING, source=autorefill)
       │    → unique index rejects if one is already in flight
       ├─ appUsageRecordCreate(subscriptionLineItemId, price, description)
       ├─ success → grantStore(externalRef = charge GID) + status ACTIVE
       └─ cap exceeded → status FAILED, store.autorefill_status = CAP_REACHED, alert
```

### Grant paths converge

Three ways a grant can arrive, all collapsing to one `grantStore` call keyed on
the Shopify charge GID:

1. **Confirm route** — merchant returns from the approval page. Primary path.
2. **`APP_PURCHASES_ONE_TIME_UPDATE` webhook** — safety net for a merchant who
   approves and closes the tab. This is the piece the superseded spec wrongly
   said did not exist, and it is why a manual top-up no longer depends on the
   merchant making it back to our URL.
3. **Auto-refill tick** — grants directly on a successful usage record.

Idempotency via `external_ref` means all three can race safely; whichever lands
first wins, the others report `creditsGranted: 0` with the same final balance.

## Race safety

Auto-refill is the one genuinely new concurrency risk — every other path is a
merchant clicking a button. Two concurrent try-ons can both drive the balance
under the trigger and both attempt a refill, which would double-charge.

Two guards, deliberately belt-and-braces because the failure mode is charging a
merchant twice:

1. `pg_advisory_xact_lock` keyed on store id — the same idiom
   `lockAndRecheckShopperLimits` already uses (`limits.ts`), with a re-read of
   the balance inside the lock.
2. The partial unique index on one in-flight `autorefill` purchase per store —
   a database-level backstop that holds even if the lock is ever bypassed by a
   refactor.

The advisory lock alone would be sufficient today. The index is what keeps it
sufficient after someone moves this code.

## Components

### API

| File | Change |
|---|---|
| `modules/shopify/packs.ts` | **new** — `CREDIT_PACKS` (id → price, credits, autorefillCredits, label), lookup returning null for unknown ids. Mirrors `billing-plans.ts` but pack ids are ours end to end, so no case-insensitive matching and no Partner Dashboard coordination. |
| `modules/shopify/purchase.ts` | **new** — `createPurchase`, `confirmPurchase`, `deps`-injectable like `syncStoreSubscription`. |
| `modules/shopify/autorefill.ts` | **new** — enrolment, trigger evaluation, `appUsageRecordCreate`. |
| `modules/shopify/purchase.routes.ts` | **new** — `POST /v1/shopify/billing/purchase`, `GET /v1/shopify/billing/purchase/confirm`, and for auto-refill `POST` (enrol), `PATCH` (change pack or threshold), `DELETE` (disable) `/v1/shopify/billing/autorefill`. `DELETE` cancels the Shopify subscription via `appSubscriptionCancel` **and** clears the local `autorefill_*` columns — a merchant who turns it off must not keep an approved charge authorization sitting live at Shopify. |
| `modules/shopify/webhook.routes.ts` | extend — `APP_PURCHASES_ONE_TIME_UPDATE`, `APP_SUBSCRIPTIONS_UPDATE`, `APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT`. |
| `lib/resolution-config.ts` | `getShopifyPackCredits(app, packId, source)` replacing `getShopifyPlanCredits`. |

### Deleted

`payg.ts`, `payg.routes.ts`, `app-events-client.ts`, `usage-scheduler.ts`,
`subscription-client.ts`, `billing-scheduler.ts`, `billing-plans.ts`,
`billing.ts`'s `syncStoreSubscription` and `buildPlanSelectionUrl`, the
`shopify_usage_events` table, and the `SHOPIFY_APP_EVENTS_*` env vars.

`billing-scheduler.ts` exists only because App Pricing sends no webhooks.
Manual Pricing does, so the hourly poller has nothing left to poll.

Plus the catalogue-generation feature listed above.

`grantShopifyTrialCredits` **stays** unchanged — it is the 25-credit free tier.

### Dispatcher

The `shopify_usage_events` insert added by `feat(dispatcher): write
shopify_usage_events row on PAYG job completion` is removed. The dispatcher
returns to being entirely unaware of Shopify billing.

### Frontend (`apps/shopify`)

- `PricingPage.tsx` — rewritten around four pack cards and an auto-refill
  panel. The PAYG card and spend-cap control go away.
- `BillingCallbackPage.tsx` — reused, extended to cover both purchase types.
  A declined purchase is a normal outcome and must read as "no charge was
  made", not an error.
- `src/lib/packs.ts` — display copy only, mirroring `planFeatures.ts`.

### Admin (`apps/admin-web`)

`ShopifyCreditsTab.tsx` — per-pack credit inputs replacing per-plan ones, for
both manual and auto-refill figures, with a live ¢/credit readout beside each.
Prices render as static text and must not look editable.

## Low-balance alerting

Folded in rather than deferred, because with no monthly grant, running low is
the normal steady state rather than an edge case — and the banner is now the
primary conversion surface, not a warning.

**Threshold model: burn-rate runway.** "At your current rate you'll run out in
~4 days," from trailing 7-day job counts (`jobs`, already indexed by store and
`created_at`). Warn under 7 days, critical under 2, plus a hard zero state. A
store with no history falls back to a percentage-of-last-pack rule.

A flat credit threshold was rejected: 50 credits is 10 try-ons, which against a
10,000-credit pack is no warning at all.

**Channels:** Polaris banners in the embedded admin, plus a transactional email
on each threshold crossing. `shopify_stores` has no merchant email column and
`owner_user_id` is nullable with `ON DELETE SET NULL`, so it cannot be the
basis — fetch `shop { email }` via Admin GraphQL and cache it on the store row.
A per-crossing "already notified" marker stops it firing on every evaluation.

**Auto-refill stores invert the message.** Not "you're running out" but "you're
at 78% of your $100 monthly ceiling" — fed directly by Shopify's
`APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT` webhook, which fires at 90%, plus
our own earlier threshold. A store at `CAP_REACHED` gets a critical banner
naming the specific cause and a one-click path to raise the cap.

**Zero balance does not lock the admin.** A merchant at zero can still
legitimately manage products, view analytics and edit widget design, and the
actual failure is on the storefront, not in the admin. Blocking the whole app
punishes them for a billing state they are in the middle of fixing.

## Error handling

| Case | Behaviour |
|---|---|
| Unknown `packId` | 400, no row inserted |
| `userErrors` from a charge mutation | 502, row `FAILED`, message surfaced to the SPA |
| Confirm sees `PENDING` | Not an error — merchant closed the tab. Return status, grant nothing, do not log at error level |
| Confirm sees `DECLINED` / `EXPIRED` | Record status, grant nothing |
| `test: true` and gate off | `app.log.warn` mirroring `billing.ts`'s existing wording, no grant |
| Row's `storeId` ≠ session store | 404, not 403 |
| Double confirm | Idempotent via `external_ref`; second call reports `creditsGranted: 0` |
| Auto-refill exceeds `cappedAmount` | Row `FAILED`, store `CAP_REACHED`, merchant alerted, manual top-up still available |
| Auto-refill subscription cancelled by merchant in Shopify admin | `APP_SUBSCRIPTIONS_UPDATE` webhook → `autorefill_status = 'CANCELLED'`, banner explains it |
| Concurrent refill attempts | Advisory lock + partial unique index; second attempt no-ops |
| Job fails after deduct | Existing `refundStoreAndMarkFailed`, unchanged |

## Cutover

No live paying stores, so this is a clean single-system cutover, not a
migration:

1. Partner Dashboard → switch the app from Shopify App Pricing to Manual
   Pricing. No app review required.
2. Register the three webhook topics.
3. Ship the migration (drop the App Pricing / PAYG columns and
   `shopify_usage_events`, add `shopify_credit_purchases` and the
   `autorefill_*` columns).
4. Deploy API + SPA together — the SPA's pricing page and the API's routes
   change in the same breath.

Test-store rows carrying `SHOPIFY_SUBSCRIPTION_TEST` ledger entries are left in
place. They are historically accurate and the distinct `reason` string keeps
them separable from real grants forever, which is exactly why it exists.

## Implementation phasing

Three phases, each independently shippable. This is deliberate: phase 3 is
blocked on an unverified Shopify behaviour (Open Question 2), and holding
phases 1 and 2 hostage to it would be wrong.

**Phase 1 — switch and packs.** Partner Dashboard switch, migration, manual
top-up purchase + confirm + webhook, pack config, SPA pricing page, admin
credits tab, and every deletion listed above — the App Pricing/PAYG billing
code and the catalogue-generation feature. Ships a complete working billing
system on its own: merchants buy packs manually and nothing else exists.

**Phase 2 — alerting.** Burn-rate runway, banners, shop-email fetch and
caching, threshold-crossing emails. Highest value *before* auto-refill exists,
because in phase 1 running out is a hard stop with no automatic recovery.

**Phase 3 — auto-refill.** Enrolment, capped-amount subscription, usage
records, the trigger path and its concurrency guards, plus the `CAP_REACHED`
handling and the inverted alerting copy. **No longer gated** — Open Question 2
resolved on 2026-08-19. Plan:
`docs/superpowers/plans/2026-08-19-shopify-credit-wallet-phase3.md`.

The `source` column on `shopify_credit_purchases` and the auto-refill credit
figures land in phase 1 even though nothing writes them until phase 3 — adding
a column later to a table that already has rows is more disruptive than
carrying an unused one for two phases.

## Testing

**Unit**
- `packs.test.ts` — lookup, unknown id → null, every pack above the $0.50
  floor, every pack's credits a multiple of `SIMPLE_TRYON_COST` (so no pack
  leaves a remainder), auto-refill credits strictly greater than manual for
  every pack, and a monotonically improving ¢/credit ladder. That last one is a
  regression test on pricing *intent*: it catches someone later editing a
  default into a value where a smaller pack beats a larger one.
- `getShopifyPackCredits` — admin override wins, code default when unset, null
  for unknown pack, code default when the stored value is malformed.
- Burn-rate runway — steady burn, zero history, a burst that shouldn't panic
  the estimate.

**Integration** (`deps`-injected Shopify client, no network)
- purchase: happy path writes `PENDING` and returns the confirmation URL
- purchase: unknown pack rejected, no row written
- confirm: `ACTIVE` grants once and increments `shopify_store_credits`
- confirm: second call grants nothing, balance unchanged
- confirm: `PENDING` / `DECLINED` grant nothing
- confirm: `test: true` with the gate off warns and grants nothing
- confirm: another store's row id returns 404
- confirm: an admin changing pack credits **after** the row was written still
  grants the snapshotted amount — the one guarantee a future refactor could
  quietly undo
- webhook: `APP_PURCHASES_ONE_TIME_UPDATE` grants for a merchant who never
  returned to the confirm route, and does not double-grant if they later do
- auto-refill: deduct crossing the trigger fires exactly one refill
- auto-refill: two concurrent deducts crossing the trigger fire exactly one
  refill (the double-charge test — the reason both guards exist)
- auto-refill: a refill beyond `cappedAmount` sets `CAP_REACHED` and grants
  nothing
- auto-refill: bonus credits applied on the auto path, base credits on manual

## Out of scope

- Migrating existing App Pricing subscriptions. There are none.
- Refunding a purchase — handled manually through Shopify's partner tooling.
- Sweeping abandoned `PENDING` purchase rows (harmless: no credits, no charge).
- Per-merchant negotiated pricing.
- Top-up for non-Shopify users — `modules/payments/` (Razorpay) covers that and
  is untouched.
- Machine-readable alerting (Slack/PagerDuty) on a `CAP_REACHED` event.
  `app.log.error` for v1; wiring an alert is an ops task.

## Open questions

1. **Is `shopify_catalog_jobs` empty in production?** The only remaining
   question on the catalogue removal, and the only one that could turn a code
   deletion into a data decision. Read-only check, permitted against prod. If
   rows exist, stop and raise it.
2. ~~**Does Shopify permit a $0 recurring line with a usage line attached?**~~
   **RESOLVED 2026-08-19, and the question turned out to be moot.** Verified on
   shopify.dev: *"You can create usage-only subscriptions by including just
   `appUsagePricingDetails` in your `lineItems` without
   `appRecurringPricingDetails`."* No recurring line is needed at all, not even
   a $0 one, so the nominal-base-fee fallback is not required and the pricing
   table is unchanged. Three further facts from the same pass, now folded into
   the phase 3 plan:
   - `appUsageRecordCreate` accepts a native `idempotencyKey` (max 255 chars).
     This is a stronger double-charge guard than the two app-side ones this
     design specified, and it is the only one that survives a timeout on a
     charge Shopify actually accepted. All three are kept — they guard
     different failures.
   - Cap exhaustion returns a `userErrors` entry, not an exception, so it must
     be detected by inspecting the payload rather than by catching.
   - Raising the cap uses `appSubscriptionLineItemUpdate` and **requires fresh
     merchant approval** via a returned `confirmationUrl`. `CAP_REACHED` is
     therefore not self-healing; recovery is a merchant-facing flow.
   - One schema gap this surfaced: `appUsageRecordCreate` addresses the
     **line item**, not the subscription. `autorefill_line_item_id` is added in
     phase 3's own migration.
3. **GPU cost per try-on is not recorded anywhere in this repo**, so the packs
   are priced against each other rather than against cost. Shopify takes no cut
   below $1M annual revenue, so the full $0.05–$0.0625 per try-on is gross
   margin — but if a try-on costs more than roughly $0.03 to serve, the $10
   pack is where the margin actually is and the discount curve should flatten.
4. **Does auto-refill need a cooldown?** A merchant with a low trigger and a
   high cap could refill several times in a day. Probably correct behaviour —
   they are using the product — but it is worth a deliberate answer rather than
   discovering it in a support ticket. Phase 3.
