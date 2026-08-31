# Shopify in-app pricing page

## Context

Shopify App Store rejected the app (ref 126765) under requirement 1.2.1 for off-platform
billing. That's already fixed on `feat/shopify-app-store-compliance` (Shopify-hosted plan
picker via `buildPlanSelectionUrl`, Admin GraphQL subscription reads). Separately, the
merchant supplied `shopify-packages.pdf` — a 3-tier feature/pricing table (Starter/Growth/Pro)
— and asked for the app's billing surface to use that data. Today the app has no feature
comparison anywhere; `DashboardPage` just shows a "Choose a plan" button that jumps straight
to Shopify's hosted picker, which shows price and name but not the feature checklist from the
PDF.

Source data (`shopify-packages.pdf`):

| Feature | Starter | Growth – Best Value | Pro |
|---|---|---|---|
| Price / Month (USD) | $29 | $59 | $229 |
| Credits Included | 1,925 | 5,000 | 22,000 |
| Virtual Try-Ons | 385 | 1,000 | 4,400 |
| Products | Unlimited | Unlimited | Unlimited |
| AI Virtual Try-On | ✓ | ✓ | ✓ |
| Outfit Builder | ✓ | ✓ | ✓ |
| Customer Photo Upload | ✓ | ✓ | ✓ |
| Shopify Integration | ✓ | ✓ | ✓ |
| Try-On Button | ✓ | ✓ | ✓ |
| Multiple Garment Categories | ✓ | ✓ | ✓ |
| Realistic AI Rendering | ✓ | ✓ | ✓ |
| Try-On History | ✓ | ✓ | ✓ |
| Try-On Analytics | Basic | Advanced | Advanced |
| Mobile & Desktop Support | ✓ | ✓ | ✓ |
| Custom Branding | — | ✓ | ✓ |
| White-Label Experience | — | — | ✓ |
| Support | Email | Priority Email | Dedicated Support |

Existing `apps/api/src/modules/shopify/billing-plans.ts` (credit-granting logic, separate from
display copy) is out of sync with this sheet: it grants 2,500 / 6,250 / 25,000 credits per
cycle for starter/growth/pro, versus the PDF's 1,925 / 5,000 / 22,000. Its comment also states
Pro is $219/month versus the PDF's $229.

## Goals

- New in-app `/pricing` page in `apps/shopify` rendering the full 3-tier comparison table from
  the PDF, reachable from `DashboardPage`'s existing plan card.
- Reconcile `billing-plans.ts` credit grants and price comment to match the PDF.
- No change to how the actual Shopify charge happens — still Shopify's hosted picker, per the
  1.2.1 fix already in place.

## Non-goals

- No change to Partner Dashboard's configured charge amounts — flagged as a manual follow-up
  (Partner Dashboard may still charge $219/month for Pro instead of $229; can't verify or fix
  from the repo).
- No per-tier deep link into Shopify's hosted picker — Shopify's `pricing_plans` page doesn't
  support selecting a specific tier via URL, so every tier's button lands on the same hosted
  URL.
- No new persistent nav item — reachable only via the Dashboard plan card, per existing
  navigation surface (`AppNavMenu`/`NAV_ITEMS`) staying untouched.

## Design

### 1. Data layer — `apps/shopify/src/lib/planFeatures.ts`

Static const array, one entry per `ShopifyPlanHandle` (`starter` | `growth` | `pro`), holding
display copy only:

```ts
interface PlanFeatureSet {
  handle: 'starter' | 'growth' | 'pro';
  label: string;
  bestValue?: boolean;
  priceUsd: number;
  credits: number;
  virtualTryOns: number;
  analyticsTier: 'Basic' | 'Advanced';
  customBranding: boolean;
  whiteLabel: boolean;
  support: string;
}
```

A separate constant list holds the shared feature bullets (AI Virtual Try-On, Outfit Builder,
Customer Photo Upload, Shopify Integration, Try-On Button, Multiple Garment Categories,
Realistic AI Rendering, Try-On History, Mobile & Desktop Support, Unlimited Products) — these
are identical across all three tiers per the PDF, so they render once per column without a
per-tier boolean.

This file is presentation copy, intentionally decoupled from `billing-plans.ts`
(`packages/api`), which is the credit-granting source of truth. Keeping them separate means a
future copy change (e.g. a new feature bullet) can't accidentally touch credit grants, and vice
versa.

### 2. `PricingPage.tsx`

New route `/pricing` in `App.tsx`. Fetches `/v1/shopify/me` on mount (same per-page pattern as
`AnalyticsPage`/`SettingsPage` — no shared/global store for this). Renders `planFeatures` as a
3-column `InlineGrid`/`Card` layout, mirroring the visual style already used in
`DashboardPage`'s stat cards:

- Growth column gets a "Best Value" `Badge`.
- If the fetched `me.store.planHandle` matches a tier, that column shows a "Current plan"
  `Badge` instead of a selection button.
- Every other column's button calls the shared plan-selection helper (see below).
- Caption under the button row: "You'll confirm your plan on Shopify's page next" — sets
  expectation that clicking doesn't charge immediately in place, since all three buttons route
  to the same hosted picker URL.

Loading/error states follow the same `SkeletonPage`/`Banner` pattern as `DashboardPage`.

### 3. Shared plan-selection helper — `apps/shopify/src/lib/billing.ts`

Today `DashboardPage.openPlanSelection` inlines the "missing app handle → show error" guard
alongside the redirect. `PricingPage` needs identical behavior, so this logic moves into
`lib/billing.ts`:

```ts
export function resolvePlanSelectionUrl(
  shopDomain: string,
  appHandle: string,
): { url: string } | { error: string } {
  if (!appHandle) {
    return {
      error:
        'Plan selection is unavailable — this build is missing its Shopify app handle. Contact support@tryme.com.',
    };
  }
  return { url: buildPlanSelectionUrl(shopDomain, appHandle) };
}
```

Both `DashboardPage` and `PricingPage` call this, then either `setError(result.error)` or
`navigateTopLevel(result.url)`. `buildPlanSelectionUrl` itself is unchanged.

### 4. Dashboard wiring

`DashboardPage`'s "Choose a plan" / "Manage plan" button changes from calling
`openPlanSelection()` (which redirected straight to Shopify) to `navigate('/pricing')`. The
in-app pricing page becomes the single entry point for plan selection; the actual Shopify
redirect now only fires from `PricingPage`'s per-tier buttons.

### 5. Backend correctness fix — `billing-plans.ts`

```ts
const CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 1925,
  growth: 5000,
  pro: 22000,
};
```

Update the file's doc comment: "starter $29, growth $59, pro $229/month" (was $219).

### 6. Tests

- `billing-plans.test.ts`: update expected credit values to 1925/5000/22000.
- `lib/billing.test.ts`: add cases for `resolvePlanSelectionUrl` (missing handle → error object;
  present handle → url object), alongside the existing `buildPlanSelectionUrl` cases.
- No component test for `PricingPage` — no existing page in `apps/shopify/src/pages` has one;
  this follows that pattern.

## Open follow-up (not in scope here)

Confirm in Partner Dashboard that the Pro plan's actual configured charge is $229/month, not
$219 — the repo's `billing-plans.ts` comment was wrong and is being fixed here, but the
Partner Dashboard price itself can't be read or changed from this repo.
