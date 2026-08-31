# Shopify plan credits — admin-configurable design

## Context

`apps/api/src/modules/shopify/billing-plans.ts` hardcodes the credit grant
for each Shopify Managed Pricing plan:

```ts
const CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 1925,
  growth: 5000,
  pro: 22000,
};
```

`syncStoreSubscription` (`apps/api/src/modules/shopify/billing.ts`) reads
this synchronously via `creditsForPlanName(planHandle)` and grants that many
credits per billing cycle. Changing an amount today requires editing this
file and redeploying — the same gap that recently caused
`apps/api/test/integration/shopify-billing-sync.test.ts` to drift out of
sync with the actual values and fail 7 tests (fixed in commit `090c7b67`,
unrelated to this feature but the direct motivation for closing this gap).

This spec follows the same pattern already shipped for Shopify trial
credits (`docs/superpowers/specs/2026-08-10-shopify-trial-credits-design.md`):
a Redis-backed `config:system` value, read through a small helper in
`apps/api/src/lib/resolution-config.ts`, editable from
`apps/admin-web/src/pages/SettingsPage.tsx`.

## Goals

- Make the per-plan credit amount (starter/growth/pro) admin-configurable,
  without a deploy, via the existing Settings page.
- Preserve current behavior exactly when no override is configured — same
  default values, same "unknown plan name grants nothing" behavior.
- Reuse the existing `config:system` / `GET`+`PATCH /admin/config` surface
  and its established per-feature sub-object convention (`tryon`,
  `sareeMannequinDev`, `pixverse`, `shopify.trialCredits`).

## Non-goals

- Not making the plan handle set (starter/growth/pro) itself configurable —
  these must match Partner Dashboard plan names exactly (case-insensitively)
  and are load-bearing across two systems already; adding/renaming plans
  from Settings is a materially bigger change (touches
  `SHOPIFY_PLAN_HANDLES`, `normalizePlanName` matching, and the in-app
  pricing page's `PLAN_FEATURE_SETS`) and was explicitly descoped.
- Not syncing the Shopify-admin frontend's own display copy of these numbers
  (`apps/shopify/src/lib/planFeatures.ts`, used by the in-app pricing page)
  to this backend config. That's a separate display-vs-billing concern; the
  pricing page already has its own PDF-sourced values and updating it to
  read live config is out of scope unless requested separately.
- No change to how/when credits get granted (still per-billing-cycle,
  gated on `ownerUserId` + `ACTIVE` status, same idempotency via
  `external_ref`) — only where the amount comes from.

## Design

### 1. `billing-plans.ts` — export the default map

Rename `CREDITS_BY_PLAN_HANDLE` to `DEFAULT_CREDITS_BY_PLAN_HANDLE` and
export it. `creditsForPlanName`, `normalizePlanName`, and
`SHOPIFY_PLAN_HANDLES` are unchanged — `creditsForPlanName` keeps working
exactly as before (pure, sync, defaults-only) and its existing test file
(`billing-plans.test.ts`) needs no changes.

### 2. `resolution-config.ts` — new config-aware reader

```ts
export async function getShopifyPlanCredits(
  app: FastifyInstance,
  planName: string,
): Promise<number | null> {
  const handle = normalizePlanName(planName);
  if (!SHOPIFY_PLAN_HANDLES.includes(handle as ShopifyPlanHandle)) return null;
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const credits = cfg.shopify?.planCredits?.[handle];
    return typeof credits === 'number'
      ? credits
      : DEFAULT_CREDITS_BY_PLAN_HANDLE[handle as ShopifyPlanHandle];
  } catch {
    return DEFAULT_CREDITS_BY_PLAN_HANDLE[handle as ShopifyPlanHandle];
  }
}
```

Imports `DEFAULT_CREDITS_BY_PLAN_HANDLE`, `normalizePlanName`,
`SHOPIFY_PLAN_HANDLES`, `type ShopifyPlanHandle` from
`../modules/shopify/billing-plans.js` — this lib file already imports
Shopify-specific domain constants for `getShopifyTrialCredits`, so this is
consistent with the existing direction of dependency (lib depends on pure
domain data, not the reverse).

Returns `null` for an unrecognized plan name (unchanged behavior — the
caller logs an error and grants nothing), otherwise always a number: the
admin override if configured and valid, else the hardcoded default.

### 3. `billing.ts` — swap the call site

In `syncStoreSubscription`, replace:

```ts
const amount = planHandle ? creditsForPlanName(planHandle) : null;
```

with:

```ts
const amount = planHandle ? await getShopifyPlanCredits(app, planHandle) : null;
```

Drop the now-unused `creditsForPlanName` import from `./billing-plans.js`
(the file still imports `normalizePlanName` from there, used elsewhere in
the same function). Add `getShopifyPlanCredits` to the existing import from
`../../lib/resolution-config.js` (already imports `getShopifyTrialCredits`
there).

### 4. Config schema

Extend the `shopify` object in `SystemConfigBody`
(`packages/types/src/admin.ts`):

```ts
shopify: z
  .object({
    trialCredits: z.number().int().min(0).max(1000).optional(),
    planCredits: z
      .object({
        starter: z.number().int().positive().max(1_000_000),
        growth: z.number().int().positive().max(1_000_000),
        pro: z.number().int().positive().max(1_000_000),
      })
      .partial()
      .optional(),
  })
  .optional(),
```

Two deliberate deltas from the currently-shipped schema:

- `trialCredits` becomes `.optional()` (it wasn't before). This is a small
  consistency fix bundled into the same edit — every other field in this
  object, and every sibling config sub-object (`tryon`, `pixverse`,
  `uploadLimits.*`), is independently optional so a partial `PATCH` doesn't
  need to resend unrelated fields. The admin-web Settings form will
  continue to always send both together in practice (Task in the plan
  covers this), but the schema itself shouldn't require it.
- `planCredits` fields use `.positive()`, not `.min(0)` like `trialCredits`
  — a paid plan granting 0 credits per cycle isn't a meaningful state (the
  trial's 0 has a real meaning: "disable the free-trial giveaway"; a paid
  plan's amount doesn't have an equivalent "disabled" case), and this
  matches the existing convention for `tryon.creditCost` /
  `pixverse.creditCost` / `sareeMannequinDev.creditCost`, all `.positive()`.

### 5. `config.routes.ts` — default-filling

`GET /admin/config` needs a nested merge, not a flat `??`, so a partial
`planCredits` override (e.g. only `starter` configured) still default-fills
`growth`/`pro` — same pattern already used for `uploadLimits`:

```ts
cfg.shopify = {
  trialCredits: cfg.shopify?.trialCredits ?? DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits,
  planCredits: { ...DEFAULT_CREDITS_BY_PLAN_HANDLE, ...cfg.shopify?.planCredits },
};
```

Requires importing `DEFAULT_CREDITS_BY_PLAN_HANDLE` from
`../shopify/billing-plans.js` in `apps/api/src/modules/admin/config.routes.ts`
(new cross-module import; `modules/admin` importing a pure constant from
`modules/shopify` introduces no cycle — `billing-plans.ts` imports nothing).

`PATCH /admin/config` needs no route change — already shallow-merges the
validated body into stored JSON, same as every other field.

### 6. Admin Settings UI

`apps/admin-web/src/pages/SettingsPage.tsx`: add three numeric inputs
(Starter / Growth / Pro), state shape `{ starter: number; growth: number;
pro: number }`, in the same section as (or immediately below) the existing
"Shopify Free Trial" block added for trial credits. Same load-from-`GET`,
include-in-`PATCH`-body, and Save-button-validation wiring as every other
numeric field on this page (`maxBatchJobs` is the reference pattern).

## Testing

- `apps/api/test/resolution-config.test.ts` — add coverage for
  `getShopifyPlanCredits`: default per handle (starter/growth/pro), reads a
  configured override, returns `null` for an unrecognized plan name, falls
  back to default on malformed config.
- `apps/api/test/integration/shopify-billing-sync.test.ts` — existing tests
  keep passing unchanged (defaults are identical to today's hardcoded
  values). Add one new test: `syncStoreSubscription` grants the
  admin-overridden amount when `config:system` has a `shopify.planCredits`
  override, set/cleared within the test (same `try`/`finally` pattern as the
  `grantShopifyTrialCredits` zero-config test already in this file).
- `apps/api/test/integration/admin-config.test.ts` — extend the existing
  "GET /admin/config default-fills shopify trial credits" test (or add a
  sibling) to cover `shopify.planCredits` default-fill and partial-override
  round-trip (set only `starter`, confirm `growth`/`pro` still default).
- No test change needed in `billing-plans.test.ts` — `creditsForPlanName`'s
  behavior and exports (aside from the renamed-and-exported default map,
  which that file doesn't reference by name) are unchanged.
- No admin-web test — this repo has no test suite for `apps/admin-web`;
  verified via `pnpm --filter @tryme/admin build` (typecheck + bundle) as
  established for the trial-credits UI task.

## Open follow-up (not part of this spec)

- Whether to eventually feed `apps/shopify/src/lib/planFeatures.ts`'s
  display numbers from this same config, so the in-app pricing page can't
  drift from actual billing amounts the way the test file just did —
  explicitly deferred per Non-goals.
