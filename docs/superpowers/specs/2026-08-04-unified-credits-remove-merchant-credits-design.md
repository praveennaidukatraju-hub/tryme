# Unified Credits — Remove the Separate Merchant Credit Pool — Design

## Scope

Collapse the parallel merchant credit system (`merchant_credits`,
`merchant_credit_ledger`, `config:system.merchantFreeCredits`) into the
existing personal system (`user_credits`, `credit_ledger`). After this change
there is exactly one balance and one ledger per human, regardless of whether
they spend it in Studio, in the catalogue manager, on the Android merchant
app, or at a kiosk — and regardless of whether they bought the credits through
the personal pricing page or the merchant portal.

`merchants` stays as a profile table (company name, kiosk config, catalogue
settings). `merchant_payments` stays as the merchant-specific Razorpay
checkout record with its own pricing (`MERCHANT_PLAN_BILLING`) — only the
destination of its credit grant changes.

Supersedes `2026-08-03-merchant-tryon-credits-design.md` §1 (the
`merchantFreeCredits` config knob), §2 (the merchant free-credit grant), §4
(dashboard balance source), §5 (payment credit destination), and the choice of
`merchantCredits` as the target table in §3. That spec's remaining decisions
stand unchanged: merchant tryon *is* billed rather than free, and kiosk *does*
read the admin-configured `config:system.tryon.creditCost` rather than a
hardcoded value. Only the pool those charges land against changes.

## Problem

The two-pool split was never an intentional product decision. The stated
intent was that "merchant" is a tag on a user account, not a separate
financial entity. What exists instead is a full parallel financial system:
its own balance table, its own ledger, its own Razorpay flow, its own
free-trial config knob, and its own set of deduct/refund/grant helpers.

The split has already caused one production incident. `POST
/v1/merchant/tryon/jobs` returned `402 INSUFFICIENT_CREDITS` for accounts
that visibly had credits — because the credits were in `user_credits` and the
charge hit `merchant_credits`. The admin panel made this worse: it labelled
the merchant balance "Catalogue credits", which is precisely backwards
(catalogue generation spends `user_credits` via `createMerchantCatalogJob`;
the merchant pool is what kiosk and Android tryon spend).

Production data confirms the second pool has no independent economic
existence: every non-zero `merchant_credits` balance was manually granted by a
super admin. `merchant_payments` has never processed a real transaction.

Secondary cost of the split: the merchant helpers in
`apps/api/src/modules/merchant/ledger.ts` are a near-duplicate of
`apps/api/src/modules/credits/ledger.ts`, but a *worse* duplicate — they skip
the `creditsDeductedTotal` / `creditsRefundedTotal` Prometheus counters, and
`merchantRefund` guards idempotency with a racy SELECT-then-INSERT where
`refund` uses a unique index. The same duplication is repeated in the
dispatcher (`processor.ts`, `sweeper.ts`).

## Design

### 1. `merchant/ledger.ts` becomes a thin adapter

Keep all three exported signatures taking `merchantId`, so no call site
changes (`merchant/create-tryon-job.ts`, `kiosk/create-job.ts`,
`merchant/tryon.routes.ts`, `kiosk/jobs.routes.ts`,
`admin/merchants.routes.ts`). Each helper resolves `merchants.userId` and
delegates to the existing personal-credit helper:

| Before | After |
|--------|-------|
| `atomicMerchantDeduct` | resolve `userId` → `atomicDeduct` |
| `merchantRefund` | resolve `userId` → `refund` |
| `merchantAdminGrant` | resolve `userId` → `adminGrant` |

The merchant→user mapping lives in exactly one file. If the `merchants` row is
missing or has no `userId`, throw rather than silently no-op — a charge that
cannot be attributed must fail the transaction.

Two consequences worth stating: merchant spend starts appearing in the
Prometheus credit counters it currently bypasses, and merchant refunds inherit
`credit_ledger`'s unique `(job_id, reason) WHERE job_id IS NOT NULL` index,
replacing the racy check.

### 2. Kiosk jobs keep `userId: null`

`createKioskJob` writes `jobs.userId = null` today; that stays. The merchant's
user account is the *billing* owner, not the *job* owner, and the distinction
matters: `/v1/jobs/*` filters purely on `jobs.userId` with no source filter, so
backfilling `userId` onto kiosk jobs would leak anonymous customer kiosk
results into the merchant's personal Studio catalogue. Billing attribution is
resolved inside the ledger adapter instead.

(`createMerchantTryonJob` already sets `userId = merchantUserId` and continues
to — unchanged behaviour, not introduced here.)

### 3. Read paths repoint to `user_credits` / `credit_ledger`

All joined through `merchants.userId`:

- `merchant/me.routes.ts` — displayed balance. This reverts §4 of the
  2026-08-03 spec, which is correct again now that both sides are the same
  number.
- `admin/merchants.routes.ts` — list `creditBalance`, detail `creditBalance`,
  the 20-row ledger on the detail view, and the `newBalance` returned by the
  grant endpoint.
- `admin/users.routes.ts` — `merchant.creditBalance`.

### 4. `merchant/payments.routes.ts`

`grantMerchantCredits` writes to `user_credits` + `credit_ledger` (keyed by
the merchant's `userId`, `reason: 'PAYMENT'`), and the post-verify balance read
follows. The order-creation route, `MERCHANT_PLAN_BILLING` pricing, GST
calculation, signature verification, and webhook handling are all unchanged —
merchants keep their own checkout and their own plans, the money just lands in
the one pool.

Idempotency is unchanged in shape: the `merchant_payments.status = 'paid'`
check still guards against double-crediting on webhook replay.

### 5. Remove `merchantFreeCredits` entirely

A user receives their free-trial grant once, at signup, from the existing
`credit_plans` row with `slug: 'free'`. Becoming a merchant adds a tag; it does
not entitle them to a second grant. Accordingly:

- `merchant/onboarding.routes.ts` — drop the `merchant_credits` insert and the
  `FREE_TRIAL` ledger row. No credit grant happens at merchant onboarding.
- Delete `getMerchantFreeCredits` (`lib/resolution-config.ts`),
  `DEFAULT_MERCHANT_FREE_CREDITS`, and `MERCHANT_FREE_CREDITS`
  (`packages/types/src/jobs.ts`).
- Remove the `merchantFreeCredits` key from `SystemConfigBody`
  (`packages/types/src/admin.ts`) and from `admin/config.routes.ts`.
- Remove the "Merchant Free Credits" field from
  `apps/admin-web/src/pages/SettingsPage.tsx`.

This reverts §1 and §2 of the 2026-08-03 spec.

`admin/merchants.routes.ts` create-merchant also drops its
`merchant_credits` seed insert; the optional `initialCredits` grant still works
through the adapter.

### 6. Dispatcher

Delete `refundMerchantCredits` (`processor.ts`). Route widget/kiosk terminal
failures through the existing user-credit refund immediately below it,
resolving `merchantId → merchants.userId` when `jobs.userId` is null. Collapse
the merchant branch in `sweeper.ts` into its adjacent `else if (job.userId)`
branch the same way.

### 7. admin-web

With one pool, the "Tryon credits" row on `UsersPage.tsx` shows the same
number as the personal balance directly above it, and the grant modal added
on `fix/merchant-tryon-credit-grant` duplicates a flow that already exists:
the "Credit balance" stat card opens an "Adjust credits" modal posting to
`/admin/credits/grant` and `/admin/credits/deduct`. That existing path is
strictly better — gated to `SUPER_ADMIN, MODERATOR, ADMIN` rather than
`SUPER_ADMIN` alone, and it supports deduct.

So the row and the merchant-specific modal are both deleted, reverting that
branch's UI. This is the intended outcome: that work existed to expose an
orphaned second pool, and the pool is going away.
`POST /admin/merchants/:id/credits` remains on the server — still used by
`MerchantsPage.tsx` and the `initialCredits` path in merchant creation.
`UserMerchant.creditBalance` is removed from `apps/admin-web/src/types.ts`.

### 8. Schema

Drop `merchant_credits` and `merchant_credit_ledger` (see Rollout for
ordering). `merchant_payments` is retained.

## Rollout

Two releases. Backfill and drop are deliberately separated, because this is
live money and the source data must survive long enough to reconcile against.

**Release 1 — code + backfill.** All changes above, plus a data-only
migration that, for each `merchant_credits` row, additively folds the balance
into the owning user's `user_credits` (insert-or-add — some merchants have no
`user_credits` row yet) and writes one `credit_ledger` row with
`reason: 'MERCHANT_CREDITS_MIGRATION'` and `delta` = the migrated amount, for
audit continuity. Both tables remain in place, now unread and unwritten.

**Release 2 — drop.** After production balances have been eyeballed and
kiosk/tryon traffic confirmed drawing down `user_credits`, a second migration
drops `merchant_credits` and `merchant_credit_ledger`.

Between the backfill committing and the new code going live there is a
minutes-long window in which a merchant could spend from the old pool after it
was already copied. That over-credits them by a job or two and never
under-credits. The reverse ordering (drop or switch code first) would strand
balances, so this ordering is required, not incidental.

Migrations ship through the normal push → CI/CD → `db:migrate:prod` path. No
raw SQL against production, per the 2026-07-27 incident constraint in
CLAUDE.md.

### Known blockers

1. **`pnpm db:generate` is broken in this repo.** Snapshots for migrations
   0128–0142 were never committed, so drizzle-kit diffs against the stale
   `0127_snapshot.json` and regenerates schema that already exists. Both
   migrations here will be hand-written (SQL + `_journal.json` entries) rather
   than attempting to reconstruct fifteen missing snapshots.
2. **`fix/merchant-tryon-credit-grant` is pushed but unmerged**, and this work
   edits the same `UsersPage.tsx` region. Merge it first, then branch from
   there.
3. **The drizzle snapshot `prevId` fix for 0121/0122 is stashed on `main`** and
   still needs to be landed or dropped.

## Out of scope

- Shopify store-owner billing — already `user_credits`-based, untouched.
- Merchant catalogue generation (`createMerchantCatalogJob`,
  `createMerchantSareeMannequinJob`) — already `user_credits`-based, untouched.
- Making `MERCHANT_PLAN_BILLING` admin-configurable or DB-backed. Merchant
  plans stay hardcoded, as today.
- Reconciling merchant plan pricing against `credit_plans` pricing. Two
  price lists for one pool is intentional for now — different customer
  segments, same currency.
- Backfilling the fifteen missing drizzle snapshots (blocker 1) beyond what is
  needed to ship these two migrations.

## Testing

`apps/api/test/helpers/merchant.ts` seeds merchant credits and roughly twelve
integration files depend on it; repointing that helper at `user_credits`
carries most of the suite. New coverage:

- `POST /v1/merchant/tryon/jobs` deducts `config:system.tryon.creditCost` from
  `user_credits`, and 402s with no job row when the balance is insufficient.
- Kiosk job creation deducts from `user_credits` while still writing
  `jobs.userId = null`.
- A kiosk job's terminal failure refunds the merchant's `user_credits`, and
  refunding twice is a no-op (unique index, not the old racy check).
- `/v1/merchant/me` returns the unified balance.
- Merchant onboarding grants nothing and creates no ledger row.
- Backfill migration: additive against an existing `user_credits` row, and
  correct when no such row exists; writes exactly one
  `MERCHANT_CREDITS_MIGRATION` ledger entry per merchant.

## Post-deploy verification

Spot-check that the two largest production balances (Rahul Goolla ≈ 99,860;
Nice Interactive = 100,000) landed *on top of* their existing personal
balances rather than replacing them, each with a matching
`MERCHANT_CREDITS_MIGRATION` ledger row. Then confirm a live kiosk or Android
tryon draws the balance down by `config:system.tryon.creditCost`.
