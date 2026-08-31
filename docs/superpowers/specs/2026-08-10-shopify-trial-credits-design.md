# Shopify free trial credits — design spec

## Context

Shopify Managed Pricing only supports day-based trials (`trialDays` on the
hosted plan picker) — it has no concept of a credit or usage cap during a
trial. A merchant on a Shopify-configured trial gets full, unmetered access
to whatever the app allows for that trial window; the app itself has to
enforce any consumption limit.

We want merchants to get a small number of free try-on credits to evaluate
the app before committing to a paid plan (Starter/Growth/Pro — see
`docs/superpowers/specs/2026-08-10-shopify-pricing-page-design.md`), without
relying on Shopify's day-based trial for the limiting mechanism.

### Existing building blocks this reuses

- `apps/api/src/modules/shopify/billing.ts` — `syncStoreSubscription` already
  grants credits transactionally against `credit_ledger` /
  `user_credits`, gated on `store.ownerUserId` being set, idempotent via a
  partial unique index on `credit_ledger.external_ref`
  (`packages/db/src/migrations/0148_shopify_subscription_columns.sql`).
- `apps/api/src/modules/shopify/auth.routes.ts` — `POST
  /v1/shopify/store/account/link` is where `shopify_stores.ownerUserId` first
  gets set (store rows are created without an owner at OAuth-install time;
  linking happens later, initiated by the merchant).
- `credit_ledger.reason` is a **plain text column, not an enum** — new reason
  strings need no migration. The existing `'FREE_TRIAL'` reason (web
  email/Google signup flow) has its own *per-user* partial unique index
  (`credit_ledger_free_trial_user_uniq`, migration 0084) — reusing that reason
  for Shopify trial credits would collide with it (a user who already got the
  web signup trial, or who links a second Shopify store, would silently be
  blocked from the Shopify grant). This feature uses a distinct reason,
  `'SHOPIFY_TRIAL'`.
- `apps/api/src/lib/resolution-config.ts` — the established pattern for an
  admin-configurable numeric knob backed by Redis key `config:system`
  (`getTryonCreditCost`, `getSareeMannequinDevCreditCost`,
  `getPixverseCreditCost`, etc.): each is a small `async (app) => number`
  helper that reads `config:system`, pulls its own nested field, and falls
  back to a hardcoded default if the field is missing, malformed, or Redis is
  unreachable. `apps/api/src/modules/admin/config.routes.ts` (`GET`/`PATCH
  /admin/config`) is the admin-facing read/write surface; `SystemConfigBody`
  in `packages/types/src/admin.ts` is the Zod validator. `apps/admin-web/src/pages/SettingsPage.tsx`
  is the admin UI that edits it.

## Goals

- Grant a small, fixed number of free credits to a Shopify store the first
  time it gets linked to an TryMe account, so the merchant can try the
  feature before subscribing.
- Make the credit amount admin-configurable (Settings page), not hardcoded,
  so it can be tuned without a deploy.
- Reuse existing transactional-grant and idempotency idioms — no new
  concurrency mechanism, no schema migration.

## Non-goals

- No change to Shopify's own `trialDays` billing configuration (Partner
  Dashboard) — that's a separate, orthogonal lever the merchant/store owner
  may or may not also configure there.
- No UI feedback (toast/banner) announcing the grant — the balance simply
  reflects it, same as `SHOPIFY_SUBSCRIPTION` grants today.
- No per-plan or time-limited trial credits — this is a flat, one-time amount
  per store, independent of which plan (if any) the store later picks.
- No change to how credits are spent (job creation, `atomicDeduct`) — trial
  credits land in the same `user_credits.balance` pool as everything else.

## Design

### 1. Admin-configurable credit amount

Add a `shopify` sub-object to `SystemConfigBody`
(`packages/types/src/admin.ts`), matching the existing per-feature convention
(`tryon`, `sareeMannequinDev`, `pixverse`):

```ts
shopify: z.object({
  trialCredits: z.number().int().min(0).max(1000),
}),
```

`apps/api/src/modules/admin/config.routes.ts`: add `shopify: { trialCredits:
25 }` to the hardcoded defaults object merged in `GET /admin/config`. `PATCH
/admin/config` needs no route change — it already shallow-merges whatever
body it receives into stored JSON.

`apps/api/src/lib/resolution-config.ts`: add

```ts
export async function getShopifyTrialCredits(app: FastifyInstance): Promise<number> {
  // same read/parse/fallback shape as getTryonCreditCost, default 25
}
```

`apps/admin-web/src/pages/SettingsPage.tsx`: one new numeric `<input>`
following the `maxBatchJobs` pattern (state seeded from `GET /admin/config`,
included in the `PATCH` body on save, same validation-before-enabling-Save
treatment), placed near the existing Shopify-related fields
(`uploadLimits.shopify*MaxBytes`) for discoverability.

### 2. Grant helper

`apps/api/src/modules/shopify/billing.ts`, new function alongside
`syncStoreSubscription`:

```ts
export async function grantShopifyTrialCredits(
  app: FastifyInstance,
  store: Store,
  userId: string,
): Promise<{ creditsGranted: number }>
```

Behavior:

- `amount = await getShopifyTrialCredits(app)`
- `externalRef = \`shopify_trial:${store.id}\``
- In a transaction: insert into `credit_ledger` `{ userId, delta: amount,
  reason: 'SHOPIFY_TRIAL', externalRef }` with `.onConflictDoNothing()`.
- Only if a row was actually inserted, upsert `user_credits`: `{ userId,
  balance: amount }` with `onConflictDoUpdate` adding `amount` to the existing
  balance (identical idiom to the `SHOPIFY_SUBSCRIPTION` grant in
  `syncStoreSubscription`).
- Return `{ creditsGranted: amount }` if granted, `{ creditsGranted: 0 }` if
  the insert was a no-op (already granted for this store).

If `amount === 0` (admin sets trial credits to zero to disable the feature),
skip the DB work entirely and return `{ creditsGranted: 0 }` — no point
writing a zero-delta ledger row.

### 3. Trigger point

`apps/api/src/modules/shopify/auth.routes.ts`, `POST
/v1/shopify/store/account/link` (~line 269-285): immediately after the
`UPDATE shopify_stores SET ownerUserId = ...` that links the store, call
`grantShopifyTrialCredits(app, store, userId)`. Fire-and-forget is not
appropriate — await it inline so a grant failure surfaces the same way any
other error on this route would (the route already fails loudly on other DB
errors; this should behave the same way, not swallow errors silently).

The route's response body is unchanged — this spec deliberately excludes UI
feedback (see Non-goals), so the grant result doesn't need to be surfaced to
the caller. It's still useful for logging/observability, so the route may log
`creditsGranted` at debug level, consistent with existing logging
conventions in that module.

### 4. Idempotency

No new migration. `external_ref` already has a partial unique index scoped to
"not null" (migration 0148), which the `SHOPIFY_SUBSCRIPTION` grant already
relies on for the exact same `.onConflictDoNothing()` pattern. Keying on
`store.id` alone (not store+cycle, unlike the subscription grant) makes this
naturally "one-time per store, ever":

- Unlink then relink the same store → same `externalRef` → no re-grant.
- The same owner linking a *second*, different store → different
  `externalRef` (`store.id` differs) → grants again. This matches the
  one-time-per-store scope chosen for this feature (as opposed to
  one-time-per-user).

### 5. Reason string

`'SHOPIFY_TRIAL'` — new value, no migration required (`reason` is `text`, not
an enum). Distinct from `'FREE_TRIAL'` (web signup) to avoid colliding with
that reason's per-user unique index.

## Testing

- `apps/api/src/lib/resolution-config.test.ts` (or wherever
  `getTryonCreditCost` is tested) — add coverage for
  `getShopifyTrialCredits`: default fallback, reads a configured value,
  falls back on malformed JSON.
- `apps/api/src/modules/shopify/billing.test.ts` — add coverage for
  `grantShopifyTrialCredits`: grants once, second call is a no-op (asserts
  `creditsGranted: 0` and no balance change), zero-config short-circuits
  without a DB write.
- `apps/api/src/modules/shopify/auth.routes.test.ts` (or wherever the
  account-link route is tested) — extend to assert `user_credits.balance`
  increases by the configured trial amount after a successful link.
- `packages/types` — no dedicated test file convention observed for
  `SystemConfigBody` fields individually; covered indirectly by the
  `admin/config.routes.test.ts` round-trip if one exists (verify during
  planning).

## Open follow-up (not part of this spec)

- Whether to eventually surface `creditsGranted` in the account-link response
  for a future UI feedback element — explicitly deferred per Non-goals.
