# Shopify credit top-up (one-time purchase) — design

**Date:** 2026-08-17
**Status:** SUPERSEDED — but the underlying idea was revived on 2026-08-19; see
`2026-08-19-shopify-credit-wallet-design.md`
**Branch:** `feature/shopify-credit-topup`

## Correction (2026-08-19)

Two claims below are wrong and were re-verified against shopify.dev:

1. **"Shopify sends no webhook for a one-time purchase"** (under "Approach").
   False. `APP_PURCHASES_ONE_TIME_UPDATE` is a documented webhook topic. The
   merchant-facing confirm route does not have to be the only grant path.
2. **The implied cost of leaving App Pricing.** Switching to Manual Pricing is
   supported from Partner Dashboard settings and, per Shopify staff, requires
   **no app re-review**. The blocker below is real — Shopify staff confirmed
   the App Pricing restriction covers one-time charges, not just recurring ones
   — but the price of removing it was overestimated here.

The reasoning that survived intact: snapshot config at purchase time, price is
code and credits are admin-tunable, and the cannibalization constraint on pack
pricing. All three carry forward into the wallet design.

## Why this was abandoned

This design depends on `appPurchaseOneTimeCreate`, which is a **manual pricing
(Billing API)** mutation. Verified against shopify.dev (not assumed): Shopify
App Pricing's own limitations page lists exactly three supported models —
fixed recurring, usage-based, and combinations of the two — and one-time
purchases are not among them. The `appPurchaseOneTimeCreate` docs live
exclusively under `/docs/apps/launch/billing/manual-pricing/`, never under
`/shopify-app-pricing/`. Most tellingly, Shopify's own migration guide tells
apps that used one-time charges for PAYG to **replace them with a usage
meter** when moving onto App Pricing — there is no "keep issuing new one-time
charges" path once on App Pricing.

This app is on Shopify App Pricing (`subscription-client.ts`,
`buildPlanSelectionUrl`, the hosted plan picker). Building this feature would
have meant running two billing systems side by side, or migrating the three
existing plans off App Pricing entirely — losing the hosted picker, proration,
and trial automation Shopify currently provides for free — just to add prepaid
packs.

Decision: stay on App Pricing, solve the underlying problem (merchant runs out
of credits mid-cycle) with **usage-based pricing** instead, which is native to
App Pricing and needs none of that trade-off. See
`docs/superpowers/specs/2026-08-17-shopify-payg-design.md`.

The content below is kept for the record — the problem framing and the
"snapshot config at purchase time" / "price is code, credits are admin-tunable"
reasoning are still valid ideas, just not implementable on this billing system.

## Problem

Shopify merchants get credits once per billing cycle from their subscription
plan (starter / growth / pro, see `billing-plans.ts`). A merchant who burns
through a cycle's credits early has exactly two options today: wait for the
renewal, or upgrade to a bigger monthly plan they may not want year-round.
Neither converts a merchant who is actively trying to run more try-ons *right
now*, which is the moment they are most willing to pay.

Top-up adds a third: buy a one-off pack of credits without touching the
subscription.

## Approach

Shopify's Admin GraphQL exposes `appPurchaseOneTimeCreate`, a one-time charge
that is entirely independent of the App Pricing subscription. It returns a
`confirmationUrl` the merchant approves on Shopify's own page, exactly like the
plan picker does — so the shape of this feature is a near-copy of the existing
subscription confirm flow, and reuses every piece of it that already works:

- `grantStore(db, storeId, amount, reason, externalRef)` — already idempotent
  via the `external_ref` partial unique index on `shopify_credit_ledger`
  (migration 0150). No new locking, no new idempotency mechanism.
- The "redirect params are merchant-controllable, re-fetch the truth from
  Shopify" rule established in `billing.routes.ts`.
- The `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` gate. `AppPurchaseOneTime` carries the
  same `test` boolean as `AppSubscription`, and the abuse it guards against is
  identical in shape (free dev store → free credits → repeat), so it gets the
  same knob rather than a second one.

Shopify sends **no webhook** for a one-time purchase, same as App Pricing. The
merchant-facing confirm route is therefore the primary grant path, with the same
retry treatment `BillingCallbackPage.tsx` already gives the subscription case.

### Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Pricing shape | Fixed packs | Mirrors `DEFAULT_CREDITS_BY_PLAN_HANDLE`. A free-form dollar amount needs a credits-per-dollar rate that silently drifts out of line with plan pricing. |
| Eligibility | Active paid subscription only | Top-up is an add-on, not an alternative to subscribing. Keeps "a paying store" as the single precondition and stops top-up becoming a way to route around plans entirely. |
| UI surface | `apps/shopify` embedded admin | Where merchants already see plan and credit state. |
| Test-charge gate | Reuse `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` | Same risk, same environments, one knob. |
| Pack set | Fixed three, ids and prices in code | Mirrors `planCredits`. A fourth pack is a deploy, which is the right friction for something that changes what a merchant is billed. |
| Who tunes credits | Admin panel, per pack | Lets pack generosity be tuned against real GPU cost without a deploy — the same reason `planCredits` is already admin-tunable. |
| Who tunes price | Nobody, code only | The price is the number sent to Shopify in the charge mutation. Config that can change what a merchant is charged is a different risk class from config that changes what they receive. |

## Flow

```
apps/shopify (SPA)              apps/api                        Shopify Admin API
"Buy 500 credits" ──POST──▶ /v1/shopify/billing/topup
                             ├─ requireShopifySession
                             ├─ store.subscriptionStatus === 'active'?
                             ├─ resolve pack → credits + priceUsd (server-side)
                             ├─ INSERT shopify_topup_purchases (PENDING)
                             ├─ appPurchaseOneTimeCreate ─────────▶ confirmationUrl, purchase GID
                             ├─ UPDATE row with shopifyPurchaseId
                             └─ 200 { confirmationUrl }
navigateTopLevel(confirmationUrl) ────────────────────────────────▶ merchant approves on Shopify
                             ◀───────────────────── returnUrl: /shopify-admin/topup/callback?purchase=<our-uuid>
GET /v1/shopify/billing/topup/confirm?purchase=<our-uuid>
                             ├─ load row, assert row.storeId === session store
                             ├─ node(id: row.shopifyPurchaseId) → status, test
                             ├─ ACTIVE && test-gate passes → grantStore(externalRef)
                             ├─ UPDATE row.status
                             └─ 200 { status, creditsGranted, creditBalance }
```

The `purchase` query param is our own row UUID, never the Shopify GID, and it is
only ever used as a lookup key — the credits granted come from the row, and the
purchase's real state comes from Shopify. A merchant editing that param can at
worst point at another row, which the `storeId` check rejects.

## Data model

New migration adding `shopify_topup_purchases`. It is a separate table rather
than extra columns on `shopify_credit_ledger` because a purchase has state
*before* any credits exist — the ledger only ever records grants that happened.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | our key; the only id that appears in a URL |
| `store_id` | uuid fk → `shopify_stores` (cascade) | checked on confirm |
| `shopify_purchase_id` | text, nullable | the `AppPurchaseOneTime` GID; null between INSERT and the mutation returning |
| `pack_id` | text | e.g. `topup_500` |
| `credits` | integer | what to grant, snapshotted from config at purchase time — see "Credits are snapshotted" below |
| `price_usd` | integer (cents) | what we asked Shopify to charge, for reconciliation |
| `status` | text | `PENDING` \| `ACTIVE` \| `DECLINED` \| `EXPIRED` — last status observed at Shopify — or `FAILED`, which is ours and means the charge was never created |
| `created_at` / `updated_at` | timestamptz | |

Index on `store_id`. Abandoned `PENDING` rows are harmless (no credits, no
charge) and are left alone; a sweep is out of scope.

### Credits are snapshotted, not re-read

`credits` is written at INSERT, before the merchant ever sees Shopify's
confirmation page, and the grant reads **that column** — never the config, and
never anything in Shopify's response (Shopify knows the price, not the credits).

This is load-bearing because credits are admin-editable while a purchase can sit
unconfirmed indefinitely: the merchant may approve the charge a second later or
leave the tab open for an hour. Re-reading config at confirm time would mean an
admin editing a pack silently changes what an already-paying merchant receives,
with no record of the number they were shown when they agreed to pay. The row is
that record.

The price is snapshotted for the same reason, though the exposure is smaller —
price only changes on deploy.

## Components

### `apps/api/src/modules/shopify/topup-packs.ts` (new)

Mirrors `billing-plans.ts`: a `TOPUP_PACKS` record of pack id →
`{ credits, priceUsd, label }`, plus a lookup that returns `null` for an
unknown id. Unlike plan names, pack ids are ours end to end — Shopify never
echoes one back — so this needs no case-insensitive matching and no
Partner Dashboard coordination.

Credits per pack follow the `getShopifyPlanCredits` precedent exactly — a new
`getShopifyTopupCredits(app, packId)` in `resolution-config.ts` reads
`shopify.topupCredits[packId]` from the `config:system` Redis key and falls back
to the code default for a known pack, returning `null` for an unknown one.
**Price has no such override** — it is sent to Shopify in the charge mutation, so
it comes from code and only from code.

#### Pack sizing

A try-on costs `SIMPLE_TRYON_COST` = 5 credits (`packages/types/src/jobs.ts`,
itself admin-tunable via `tryon.creditCost`). Two consequences:

- Every pack's credit count is a multiple of 5, so a pack never leaves an
  unspendable remainder.
- **Try-ons are the merchant-facing unit.** The Shopify UI leads with "100
  try-ons", not "500 credits" — credits are an internal accounting unit and no
  merchant has an intuition for what 500 of them buys. The charge name sent to
  Shopify follows suit ("TryMe — 100 try-ons").

Note the coupling: an admin who raises `tryon.creditCost` to 6 silently makes
every pack buy fewer try-ons than its label claims. The label is derived from
the live cost at render time rather than hardcoded, so it stays honest; the
`credits` figure is what is actually granted and never moves.

#### Default packs

| Pack | Price | Try-ons | Credits | ¢/credit | vs starter |
|---|---|---|---|---|---|
| `topup_500` | $10 | 100 | 500 | 2.00 | 1.33× |
| `topup_1250` | $24 | 250 | 1250 | 1.92 | 1.27× |
| `topup_2500` | $45 | 500 | 2500 | 1.80 | 1.20× |

Against the plans (1.51 starter, 1.18 growth, 1.04 pro ¢/credit), every pack is
deliberately more expensive per credit than every plan. **Starter's 1.51¢ is the
binding constraint** — it is the cheapest plan, so a pack priced below it would
make subscribing pointless. The ladder is anchored 1.20–1.33× above it.

The largest pack is 500 try-ons for $45; growth gives 1000 for $59. A merchant
who needs volume is always better off subscribing, which is the intended funnel:
top-up bridges a gap mid-cycle, it does not replace a plan. No fourth, larger
pack for that reason — someone repeatedly buying 500+ try-ons should be
upgrading, and making that easy to avoid would cost more MRR than the pack earns.

Two known limits of this pricing, recorded so they are not rediscovered as bugs:

- **Flat pricing means each tier pays a different multiple.** A pro merchant
  (1.04¢) buying the $45 pack pays 1.73× their own plan rate, against starter's
  1.20×. The best customers get the worst deal. Accepted for v1 — pro carries
  4400 try-ons and rarely runs dry — but it is the thing to revisit if pro
  merchants start topping up regularly. The fix, if needed, is a per-tier pack
  set, not a change to these numbers.
- **Margin is unverified.** GPU cost per try-on is not recorded anywhere in this
  repo, so these prices are set against plan pricing, not against cost. If a
  try-on costs more than roughly $0.04, the small pack is where the margin
  actually is and the discount curve should flatten.

Shopify rejects an application charge under $0.50 USD, so every pack must stay
above that floor — a constraint worth a comment rather than a runtime check,
since prices are static and none is close.

### `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx` (extended)

Three more number inputs, below the existing per-plan ones, in the tab that
already edits `trialCredits` and `planCredits`. Same `PATCH /admin/config`
(SUPER_ADMIN only), same Redis key, same save button — `shopify.topupCredits`
sits alongside `shopify.planCredits` in the payload, and `GET /admin/config`
merges it over `DEFAULT_TOPUP_CREDITS` the way it already does for
`DEFAULT_CREDITS_BY_PLAN_HANDLE`. `SystemConfigBody` in `packages/types/src/admin.ts`
gains the matching optional object.

Each pack row shows its fixed price as static text (it is not editable and must
not look editable) and a live-computed **¢/credit** next to the input.

**Cannibalization warning.** Because price is fixed and credits float, an admin
raising a pack's credits far enough makes it cheaper per credit than subscribing
— at which point the rational merchant buys top-ups forever and never takes a
plan. The tab computes every pack's ¢/credit against the cheapest plan's and
shows an amber inline warning when a pack undercuts it, naming the plan it beats.

The warning does **not** block the save: promotional pricing and deliberate
testing are legitimate, and a hard block would need an override escape hatch
that is itself another way to get this wrong. Making the consequence visible at
the moment of the edit is the whole goal — today the number can be changed with
no signal at all that it crossed a line that matters.

This is presentation-layer only. It is not a security control and the API does
not re-check it; it guards against an honest mistake by a SUPER_ADMIN who
already has full authority over these values.

### `apps/api/src/modules/shopify/topup.ts` (new)

Business logic, `deps`-injectable exactly like `syncStoreSubscription`:

- `createTopupPurchase(app, store, packId, deps?)` → `{ confirmationUrl }`
- `confirmTopupPurchase(app, store, rowId, deps?)` → `{ status, creditsGranted }`

Both talk to Shopify through `shopifyGraphQL` with `getValidAccessToken`, same
as `subscription-client.ts`.

**Validated GraphQL** (checked against the schema; repo targets `2026-07`, both
operations validated clean against `2026-04` and are long-stable):

```graphql
mutation CreateTopupPurchase($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
  appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
    confirmationUrl
    appPurchaseOneTime {
      id
      status
      test
    }
    userErrors {
      field
      message
    }
  }
}
```

```graphql
query TopupPurchaseStatus($id: ID!) {
  node(id: $id) {
    ... on AppPurchaseOneTime {
      id
      status
      test
      name
      price {
        amount
        currencyCode
      }
    }
  }
}
```

`node(id:)` is used rather than paginating
`currentAppInstallation.oneTimePurchases` — `AppPurchaseOneTime` implements
`Node`, so a store with a long purchase history costs one lookup, not a page
walk.

The external ref is `shopify_topup:<shopifyPurchaseId>`, keyed on Shopify's own
id so a double confirm, a refresh, or a retry after a timeout all collapse to
one grant through the existing unique index.

### `apps/api/src/modules/shopify/topup.routes.ts` (new)

- `POST /v1/shopify/billing/topup` — body `{ packId }`, `requireShopifySession`.
- `GET /v1/shopify/billing/topup/confirm` — query `{ purchase }`,
  `requireShopifySession`.

Registered from `modules/shopify/routes.ts` alongside `shopifyBillingRoutes`.
Request/response shapes go in `packages/types` per the repo's Zod convention.

### `apps/shopify` (frontend)

- `src/lib/topupPacks.ts` — display copy only, mirroring `planFeatures.ts` and
  carrying the same comment about why display copy is deliberately separate from
  the credit-granting source of truth.
- `PricingPage.tsx` — a "Need more credits?" card below the plan grid, one
  button per pack. Buttons disabled with an explanatory note when
  `me.store.subscriptionStatus !== 'active'`, so the eligibility rule is visible
  rather than a surprise 4xx.
- `TopupCallbackPage.tsx` — new route `/topup/callback`, a near-copy of
  `BillingCallbackPage.tsx` including its retry loop and its refusal to fail
  silently. Distinct copy: a declined purchase is a normal outcome here and must
  read as "no charge was made", not as an error.

## Error handling

| Case | Behaviour |
|---|---|
| Unknown `packId` | 400, no row inserted |
| `subscriptionStatus !== 'active'` | 403 `TOPUP_REQUIRES_PLAN`, no row inserted |
| `userErrors` from the mutation | 502, row marked `FAILED`, message surfaced to the SPA. Deliberately not `DECLINED` — that word means the merchant saw the charge and said no, and conflating it with "Shopify never accepted our request" would make the two indistinguishable when reconciling later |
| Confirm sees `PENDING` | Not an error. Merchant closed the tab; return status, grant nothing, do not log at error level |
| Confirm sees `DECLINED` / `EXPIRED` | Same — record status, grant nothing |
| `test: true` and gate off | `app.log.warn` mirroring `billing.ts`'s wording, no grant |
| Row's `storeId` ≠ session store | 404, not 403 — do not confirm the existence of another store's row |
| Double confirm | Idempotent via `external_ref`; second call reports `creditsGranted: 0` with the same final balance |
| Subscription cancelled between purchase and confirm | Grant proceeds. The merchant paid; retroactively refusing the credits would be worse than the inconsistency. Matches how `syncStoreSubscription` already tolerates state moving under it |

## Testing

Unit:
- `topup-packs.test.ts` — lookup, unknown id → null, every pack above the $0.50
  floor, every pack's credits a multiple of `SIMPLE_TRYON_COST`, and every
  default pack priced above every plan on a ¢/credit basis. That last one is a
  regression test on the pricing *intent* rather than the mechanics: it is what
  catches someone later editing a default into a value that quietly undercuts
  starter. Mirrors `billing-plans.test.ts`.
- `getShopifyTopupCredits` — admin override wins, code default when unset,
  `null` for an unknown pack, code default when the stored value is malformed
  (matching `getShopifyPlanCredits`'s try/catch behaviour).

Integration (`apps/api/test/integration/`), `deps`-injected Shopify client so no
network is touched:
- create: happy path writes a `PENDING` row and returns the confirmation URL
- create: blocked when the store has no active subscription
- create: unknown pack id rejected, no row written
- confirm: `ACTIVE` grants once and increments `shopify_store_credits`
- confirm: a second call grants nothing and leaves the balance unchanged
- confirm: `PENDING` / `DECLINED` grant nothing
- confirm: `test: true` with the gate off warns and grants nothing
- confirm: another store's row id returns 404
- confirm: an admin changing the pack's configured credits **after** the row was
  written still grants the snapshotted amount, not the new one — the guarantee
  in "Credits are snapshotted" is the one thing here a future refactor could
  quietly undo

## Out of scope

- Auto-top-up / low-balance auto-recharge. Needs stored consent and a recurring
  authorization; a separate design.
- Refunding a top-up. Handled manually through Shopify's own partner tooling.
- Sweeping abandoned `PENDING` rows.
- Top-up for non-Shopify users — `apps/api/src/modules/payments/` (Razorpay)
  already covers that path and is untouched here.
