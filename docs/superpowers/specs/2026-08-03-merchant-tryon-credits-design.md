# Merchant Tryon Credits — Design

## Scope

Android-app and kiosk merchant-tagged users (`users` row + `merchants`
profile, gated by `requireMerchant` / `requireKioskDevice`) only. Shopify
merchant billing (store owner's personal `userCredits`) is untouched — out of
scope.

Merchant-tagged users only ever create tryon-type jobs through this path (no
widget/saree/video), so this design only needs to cover the tryon cost path.
The merchant catalogue-manager flows (`createMerchantCatalogJob`,
`createMerchantSareeMannequinJob` in
`apps/api/src/modules/merchant/create-job.ts`) are a separate feature —
turning a flat garment photo into a catalogue product image — already billed
against `userCredits` today, and are **not** touched by this design.

## Problem

The actual android-app customer-facing tryon (`POST /v1/merchant/tryon/jobs`
→ `createMerchantTryonJob` in
`apps/api/src/modules/merchant/create-tryon-job.ts`) charges **nothing**
today:

```ts
// Unlimited try-ons for now: creditsCharged is always 0 and no billing helper is called.
```

The `merchants` schema comment
(`packages/db/src/schema/merchant.ts:34-36`) confirms this is deliberate-but-
temporary: `'android_google'` self-serve signups are flagged as "Try-ons are
free, so these accounts are the ones to watch for GPU abuse."

Kiosk device jobs (`apps/api/src/modules/kiosk/create-job.ts`) already deduct
from `merchantCredits` via `atomicMerchantDeduct`, but at a hardcoded
`KIOSK_JOB_COST = 10` — not the admin-configured Virtual Try-On Pricing value
(`config:system.tryon.creditCost`, read via `getTryonCreditCost(app)`) that
regular users and the merchant catalogue flows already use.

Merchant dashboard balance (`apps/api/src/modules/merchant/me.routes.ts`)
displays `userCredits`, not `merchantCredits` — irrelevant to what kiosk (and,
after this change, android tryon) actually charges against.

New merchants get `merchantCredits.balance: 0` on creation
(`apps/api/src/modules/merchant/onboarding.routes.ts:87`,
`apps/api/src/modules/admin/merchants.routes.ts:211`) — no free-credit grant
exists for merchants (unlike regular users, who get a `credit_plans` "free"
plan on signup).

## Design

### 1. Config: `config:system.merchantFreeCredits`

Add a new flat field to the existing Redis-backed `config:system` JSON blob
(`apps/api/src/lib/resolution-config.ts`, `apps/api/src/modules/admin/config.routes.ts`,
`packages/types/src/admin.ts`'s `SystemConfigBody`), alongside `tryon.creditCost`
— flat, not nested, matching the existing `merchantCatalogDefaults` /
`merchantCatalogAspectRatio` naming convention in that same schema. Falls back
to a hardcoded `MERCHANT_FREE_CREDITS` default (0) if unset, same pattern as
`SIMPLE_TRYON_COST`.

Exposed in Settings → System tab (`apps/admin-web/src/pages/SettingsPage.tsx`),
in the same section as Virtual Try-On Pricing, as an editable "Merchant Free
Credits" field, `SUPER_ADMIN`-only PATCH like the rest of `config:system`.

### 2. Free-credit grant on merchant creation

In `apps/api/src/modules/merchant/onboarding.routes.ts` (self-serve android
onboarding, `requireDeviceUser`), the transaction that inserts the `merchants`
row already inserts `merchantCredits.values({ merchantId, balance: 0 })` right
after (line 87). Change:

- `balance` → the resolved `config:system.merchantFreeCredits` value.
- Insert a matching `merchantCreditLedger` row, `reason: 'FREE_TRIAL'`
  (matching the existing user-credit convention), `delta` = the granted
  amount.

No separate idempotency guard is needed beyond what's already there: the
transaction 409s on an existing `merchants` row for that `userId` before
reaching the insert, so a merchant can't be created (and therefore can't be
granted) twice.

Admin-created merchants (`apps/api/src/modules/admin/merchants.routes.ts:211`,
also currently `balance: 0`) are **left unchanged** — admin already has
`merchantAdminGrant` for manual top-up at creation time if desired. Applying
the same auto-grant there is a candidate follow-up, not part of this design.

### 3. Bill the android tryon path, fix kiosk's cost source

- **Android** (`apps/api/src/modules/merchant/create-tryon-job.ts`,
  `createMerchantTryonJob`): compute `cost = await getTryonCreditCost(app)`,
  set `jobs.creditsCharged` to `cost` (currently hardcoded `0`), and call
  `atomicMerchantDeduct(tx, merchantId, cost, jobId)` inside the existing
  transaction — same pattern `createKioskJob` already uses. If the merchant
  has insufficient balance, `atomicMerchantDeduct` throws `AppError`
  (`INSUFFICIENT_CREDITS`, 402), rolling back the whole transaction — no job
  row is left behind, consistent with every other credit-gated job-creation
  path in the repo.
- **Kiosk** (`apps/api/src/modules/kiosk/jobs.routes.ts:186`): replace
  `cost: KIOSK_JOB_COST` with `cost: await getTryonCreditCost(app)`. Delete
  the now-unused `KIOSK_JOB_COST` constant
  (`apps/api/src/modules/kiosk/create-job.ts:7`). Kiosk already deducts from
  `merchantCredits` via `atomicMerchantDeduct` — no table change needed there.
- Update the stale `signupSource` comment in
  `packages/db/src/schema/merchant.ts:34-36` ("Try-ons are free...") since it
  will no longer be true.

**Refunds need no code change.** The dispatcher already routes every job with
`jobs.merchantId` set — which both kiosk and android-tryon jobs have — to its
merchant/widget processing path (`apps/dispatcher/src/job/processor.ts:187-190`,
`if (job.merchantId || job.shopifyStoreId)`), whose terminal-failure handler
(`markWidgetFailed`) already refunds `merchantCredits` idempotently. This
already applies correctly to kiosk today and will automatically cover android
tryon once `creditsCharged` is non-zero — nothing to wire up.

### 4. Dashboard balance

`apps/api/src/modules/merchant/me.routes.ts` currently sources the displayed
balance from `userCredits` for the merchant's `userId`. Switch to
`merchantCredits.balance` (joined on `merchants.id = merchantCredits.merchantId`
instead of the current `userCredits` join) so the balance shown matches what
tryon jobs actually charge against.

### 5. Buy credits — no change needed

`apps/api/src/modules/merchant/payments.routes.ts` (Razorpay top-up via
`MERCHANT_PLAN_BILLING`, `packages/types/src/widget.ts`) already tops up
`merchantCredits`. Works unmodified once billing is unified onto that table —
no separate build needed here.

## Out of scope

- Shopify store-owner billing (`userCredits`-based) — untouched.
- Merchant catalogue-manager generation (`createMerchantCatalogJob`,
  `createMerchantSareeMannequinJob`) — already billed via `userCredits`, not
  part of this change.
- Making `MERCHANT_PLAN_BILLING` (top-up plans) admin-configurable / DB-backed
  — stays hardcoded as today.
- Auto free-credit grant on admin-created merchants — admin already has manual
  grant; not building auto-grant there in this pass.

## Testing

- Vitest integration test (per repo convention, fresh Postgres/MinIO per file,
  docker-compose must be up):
  - Onboarding grants the configured free-credit amount into `merchantCredits`
    + a `FREE_TRIAL` ledger row.
  - Android tryon (`POST /v1/merchant/tryon/jobs`) deducts
    `config:system.tryon.creditCost` from `merchantCredits`, and 402s with no
    job row created when the merchant balance is insufficient.
  - Kiosk job creation deducts the same `config:system.tryon.creditCost`
    value (not the old hardcoded 10) from `merchantCredits`.
  - `/v1/merchant/me` returns `merchantCredits.balance`, not `userCredits`.
