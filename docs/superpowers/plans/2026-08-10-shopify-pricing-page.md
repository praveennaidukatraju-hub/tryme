# Shopify In-App Pricing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/pricing` page to the Shopify-embedded admin app (`apps/shopify`) that renders the 3-tier feature/pricing comparison from `shopify-packages.pdf`, reachable from the Dashboard's plan card, and reconcile `billing-plans.ts`'s credit grants with that same source data.

**Architecture:** Static display-copy data file (`lib/planFeatures.ts`) feeds a new Polaris `Page` component (`PricingPage.tsx`) routed at `/pricing`. The existing "missing app handle" guard-and-redirect logic in `DashboardPage.openPlanSelection` moves into a shared `lib/billing.ts` helper (`resolvePlanSelectionUrl`) so both `DashboardPage` (which now just navigates to `/pricing`) and `PricingPage` (which performs the actual Shopify-hosted-picker redirect) share one implementation. Separately, `apps/api/src/modules/shopify/billing-plans.ts`'s credit-granting numbers get corrected to match the PDF — this is unrelated backend logic, not wired to the new page.

**Tech Stack:** React + TypeScript, Polaris (`@shopify/polaris`, `@shopify/polaris-icons`), react-router-dom, Vitest.

## Global Constraints

- Display copy (`planFeatures.ts`) must stay decoupled from `billing-plans.ts` (credit-granting source of truth) — no shared import between them.
- No per-tier deep link to Shopify's hosted picker — Shopify's `pricing_plans` URL doesn't support selecting a specific tier; every tier's button uses the same URL from `buildPlanSelectionUrl`.
- No new persistent nav item — `/pricing` is reachable only via the Dashboard plan card button.
- Follow existing per-page data-fetch pattern (`apiFetch<ShopifyMe>('/v1/shopify/me')` inside a `useEffect`, no shared/global store).
- No component test for `PricingPage` — no existing page under `apps/shopify/src/pages` has one.

---

### Task 1: Fix `billing-plans.ts` credit grants to match the PDF

**Files:**
- Modify: `apps/api/src/modules/shopify/billing-plans.ts`
- Test: `apps/api/src/modules/shopify/billing-plans.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `creditsForPlanName('starter'|'growth'|'pro')` now returns `1925`/`5000`/`22000` (was `2500`/`6250`/`25000`). No signature change — later tasks don't depend on this file.

- [x] **Step 1: Update the failing test expectations first**

In `apps/api/src/modules/shopify/billing-plans.test.ts`, change the first two `it` blocks:

```ts
describe('creditsForPlanName', () => {
  it('maps each known plan name to its credit grant', () => {
    expect(creditsForPlanName('starter')).toBe(1925);
    expect(creditsForPlanName('growth')).toBe(5000);
    expect(creditsForPlanName('pro')).toBe(22000);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    // Shopify echoes back the plan's Partner Dashboard display name verbatim,
    // and we do not control how it gets capitalized there.
    expect(creditsForPlanName('Starter')).toBe(1925);
    expect(creditsForPlanName('GROWTH')).toBe(5000);
    expect(creditsForPlanName('  Pro  ')).toBe(22000);
  });
```

Leave the remaining two `it` blocks (`'returns null for an unknown name...'` and the `SHOPIFY_PLAN_HANDLES` one) and the `normalizePlanName` describe block unchanged.

- [x] **Step 2: Run the test to verify it now fails**

Run: `pnpm --filter @tryme/api test -- billing-plans`
Expected: FAIL — `creditsForPlanName('starter')` returns `2500`, not `1925` (and similarly for growth/pro).

- [x] **Step 3: Update the implementation**

In `apps/api/src/modules/shopify/billing-plans.ts`, replace the credits map and the doc comment's price line:

```ts
const CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 1925,
  growth: 5000,
  pro: 22000,
};
```

And update line 16 of the file's leading comment from:

```
 * Draft launch prices (set in Partner Dashboard, not here — this file only
 * owns credits, never price): starter $29, growth $59, pro $219/month.
```

to:

```
 * Draft launch prices (set in Partner Dashboard, not here — this file only
 * owns credits, never price): starter $29, growth $59, pro $229/month.
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- billing-plans`
Expected: PASS, all 6 assertions in `billing-plans.test.ts` green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing-plans.ts apps/api/src/modules/shopify/billing-plans.test.ts
git commit -m "fix(api): reconcile Shopify plan credit grants with the pricing sheet"
```

---

### Task 2: Extract `resolvePlanSelectionUrl` shared helper

**Files:**
- Modify: `apps/shopify/src/lib/billing.ts`
- Test: `apps/shopify/src/lib/billing.test.ts`

**Interfaces:**
- Consumes: nothing new (wraps the existing `buildPlanSelectionUrl` in the same file).
- Produces: `resolvePlanSelectionUrl(shopDomain: string, appHandle: string): { url: string } | { error: string }`. Task 3 (`PricingPage`) and Task 5 (`DashboardPage` wiring) both call this.

- [x] **Step 1: Write the failing tests**

In `apps/shopify/src/lib/billing.test.ts`, add a new `describe` block below the existing one:

```ts
import { buildPlanSelectionUrl, resolvePlanSelectionUrl } from './billing';

describe('resolvePlanSelectionUrl', () => {
  it('returns the hosted pricing page URL when an app handle is present', () => {
    expect(resolvePlanSelectionUrl('cool-shop.myshopify.com', 'tryme')).toEqual({
      url: 'https://admin.shopify.com/store/cool-shop/charges/tryme/pricing_plans',
    });
  });

  it('returns an error instead of a dead-end URL when the app handle is missing', () => {
    expect(resolvePlanSelectionUrl('cool-shop.myshopify.com', '')).toEqual({
      error:
        'Plan selection is unavailable — this build is missing its Shopify app handle. Contact support@tryme.com.',
    });
  });
});
```

(Update the existing top import line accordingly — `buildPlanSelectionUrl` and `resolvePlanSelectionUrl` both come from `./billing`.)

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/shopify-admin test -- billing.test`
Expected: FAIL — `resolvePlanSelectionUrl` is not exported from `./billing`.

- [x] **Step 3: Implement `resolvePlanSelectionUrl`**

In `apps/shopify/src/lib/billing.ts`, append below `buildPlanSelectionUrl`:

```ts
export function resolvePlanSelectionUrl(
  shopDomain: string,
  appHandle: string,
): { url: string } | { error: string } {
  // Without the build arg the URL collapses to .../charges//pricing_plans,
  // which Shopify answers with a 404 — a dead-end the merchant cannot
  // diagnose. Fail loudly here instead of navigating them off the app.
  if (!appHandle) {
    return {
      error:
        'Plan selection is unavailable — this build is missing its Shopify app handle. Contact support@tryme.com.',
    };
  }
  return { url: buildPlanSelectionUrl(shopDomain, appHandle) };
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/shopify-admin test -- billing.test`
Expected: PASS, both new assertions plus the pre-existing `buildPlanSelectionUrl` test green.

- [x] **Step 5: Commit**

```bash
git add apps/shopify/src/lib/billing.ts apps/shopify/src/lib/billing.test.ts
git commit -m "refactor(shopify-admin): extract shared plan-selection URL resolver"
```

---

### Task 3: Add `planFeatures.ts` display-copy data

**Files:**
- Create: `apps/shopify/src/lib/planFeatures.ts`
- Test: `apps/shopify/src/lib/planFeatures.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PLAN_FEATURE_SETS: PlanFeatureSet[]` (3 entries, handles `'starter' | 'growth' | 'pro'` in that order) and `SHARED_FEATURE_BULLETS: string[]`. Task 4 (`PricingPage`) imports both.

- [x] **Step 1: Write the failing test**

Create `apps/shopify/src/lib/planFeatures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PLAN_FEATURE_SETS, SHARED_FEATURE_BULLETS } from './planFeatures';

describe('PLAN_FEATURE_SETS', () => {
  it('lists exactly starter, growth, pro in that order', () => {
    expect(PLAN_FEATURE_SETS.map((p) => p.handle)).toEqual(['starter', 'growth', 'pro']);
  });

  it('matches the pricing sheet for each tier', () => {
    const [starter, growth, pro] = PLAN_FEATURE_SETS;
    expect(starter).toMatchObject({
      priceUsd: 29,
      credits: 1925,
      virtualTryOns: 385,
      analyticsTier: 'Basic',
      customBranding: false,
      whiteLabel: false,
      support: 'Email',
    });
    expect(growth).toMatchObject({
      priceUsd: 59,
      credits: 5000,
      virtualTryOns: 1000,
      analyticsTier: 'Advanced',
      customBranding: true,
      whiteLabel: false,
      support: 'Priority Email',
      bestValue: true,
    });
    expect(pro).toMatchObject({
      priceUsd: 229,
      credits: 22000,
      virtualTryOns: 4400,
      analyticsTier: 'Advanced',
      customBranding: true,
      whiteLabel: true,
      support: 'Dedicated Support',
    });
  });
});

describe('SHARED_FEATURE_BULLETS', () => {
  it('lists the 10 features identical across every tier', () => {
    expect(SHARED_FEATURE_BULLETS).toEqual([
      'Unlimited products',
      'AI Virtual Try-On',
      'Outfit Builder',
      'Customer Photo Upload',
      'Shopify Integration',
      'Try-On Button',
      'Multiple Garment Categories',
      'Realistic AI Rendering',
      'Try-On History',
      'Mobile & Desktop Support',
    ]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/shopify-admin test -- planFeatures`
Expected: FAIL — cannot find module `./planFeatures`.

- [x] **Step 3: Implement the data file**

Create `apps/shopify/src/lib/planFeatures.ts`:

```ts
export interface PlanFeatureSet {
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

// Mirrors shopify-packages.pdf. Display copy only — the credit-granting
// source of truth is apps/api/src/modules/shopify/billing-plans.ts, kept
// deliberately separate so a copy change here can't silently change what a
// merchant is actually granted.
export const PLAN_FEATURE_SETS: PlanFeatureSet[] = [
  {
    handle: 'starter',
    label: 'Starter',
    priceUsd: 29,
    credits: 1925,
    virtualTryOns: 385,
    analyticsTier: 'Basic',
    customBranding: false,
    whiteLabel: false,
    support: 'Email',
  },
  {
    handle: 'growth',
    label: 'Growth',
    bestValue: true,
    priceUsd: 59,
    credits: 5000,
    virtualTryOns: 1000,
    analyticsTier: 'Advanced',
    customBranding: true,
    whiteLabel: false,
    support: 'Priority Email',
  },
  {
    handle: 'pro',
    label: 'Pro',
    priceUsd: 229,
    credits: 22000,
    virtualTryOns: 4400,
    analyticsTier: 'Advanced',
    customBranding: true,
    whiteLabel: true,
    support: 'Dedicated Support',
  },
];

// Identical across every tier per the pricing sheet — rendered once per
// column rather than as a per-tier boolean.
export const SHARED_FEATURE_BULLETS = [
  'Unlimited products',
  'AI Virtual Try-On',
  'Outfit Builder',
  'Customer Photo Upload',
  'Shopify Integration',
  'Try-On Button',
  'Multiple Garment Categories',
  'Realistic AI Rendering',
  'Try-On History',
  'Mobile & Desktop Support',
];
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/shopify-admin test -- planFeatures`
Expected: PASS, all assertions green.

- [x] **Step 5: Commit**

```bash
git add apps/shopify/src/lib/planFeatures.ts apps/shopify/src/lib/planFeatures.test.ts
git commit -m "feat(shopify-admin): add plan feature comparison data"
```

---

### Task 4: Build `PricingPage.tsx` and route it at `/pricing`

**Files:**
- Create: `apps/shopify/src/pages/PricingPage.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `PLAN_FEATURE_SETS`, `SHARED_FEATURE_BULLETS` from `../lib/planFeatures` (Task 3); `resolvePlanSelectionUrl` from `../lib/billing` (Task 2); `apiFetch`, `navigateTopLevel` from `../lib/api`; `ShopifyMe` from `../types`.
- Produces: `PricingPage` default export, mounted at route path `/pricing` in `App.tsx`. Task 5 (`DashboardPage`) navigates here.

- [x] **Step 1: Create `PricingPage.tsx`**

```tsx
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  SkeletonPage,
  Text,
} from '@shopify/polaris';
import { CheckIcon } from '@shopify/polaris-icons';
import { useEffect, useState } from 'react';
import { apiFetch, navigateTopLevel } from '../lib/api';
import { resolvePlanSelectionUrl } from '../lib/billing';
import { PLAN_FEATURE_SETS, SHARED_FEATURE_BULLETS } from '../lib/planFeatures';
import type { ShopifyMe } from '../types';

// Set at build time from Partner Dashboard's app handle — see
// .env.production.example for VITE_SHOPIFY_APP_HANDLE.
const APP_HANDLE = import.meta.env.VITE_SHOPIFY_APP_HANDLE ?? '';

function FeatureRow({ label, included }: { label: string; included: boolean }) {
  return (
    <InlineStack gap="200" blockAlign="center">
      {included ? (
        <Icon source={CheckIcon} tone="success" />
      ) : (
        <Text as="span" tone="subdued">
          —
        </Text>
      )}
      <Text as="span" tone={included ? undefined : 'subdued'}>
        {label}
      </Text>
    </InlineStack>
  );
}

export default function PricingPage() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function choosePlan() {
    if (!me) return;
    const result = resolvePlanSelectionUrl(me.store.shopDomain, APP_HANDLE);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    navigateTopLevel(result.url);
  }

  if (loading) {
    return (
      <SkeletonPage primaryAction>
        <SkeletonBodyText />
      </SkeletonPage>
    );
  }

  return (
    <Page title="Plans & pricing" subtitle="Choose the plan that fits your store.">
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error}</Banner>}

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          {PLAN_FEATURE_SETS.map((plan) => {
            const isCurrent = me?.store.planHandle === plan.handle;
            return (
              <Card key={plan.handle}>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingLg">
                        {plan.label}
                      </Text>
                      {plan.bestValue && <Badge tone="success">Best value</Badge>}
                      {isCurrent && <Badge>Current plan</Badge>}
                    </InlineStack>
                    <Text as="p" variant="heading2xl">
                      ${plan.priceUsd}
                      <Text as="span" tone="subdued" variant="bodyMd">
                        {' '}
                        / month
                      </Text>
                    </Text>
                    <Text as="p" tone="subdued">
                      {plan.credits.toLocaleString()} credits · {plan.virtualTryOns.toLocaleString()}{' '}
                      virtual try-ons
                    </Text>
                  </BlockStack>

                  <Box>
                    {isCurrent ? (
                      <Badge tone="info">Your current plan</Badge>
                    ) : (
                      <Button variant="primary" onClick={choosePlan}>
                        Choose {plan.label}
                      </Button>
                    )}
                  </Box>

                  <BlockStack gap="150">
                    {SHARED_FEATURE_BULLETS.map((label) => (
                      <FeatureRow key={label} label={label} included />
                    ))}
                    <FeatureRow
                      label={`${plan.analyticsTier} try-on analytics`}
                      included
                    />
                    <FeatureRow label="Custom branding" included={plan.customBranding} />
                    <FeatureRow label="White-label experience" included={plan.whiteLabel} />
                    <FeatureRow label={`${plan.support} support`} included />
                  </BlockStack>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>

        <Text as="p" tone="subdued">
          You'll confirm your plan on Shopify's page next.
        </Text>
      </BlockStack>
    </Page>
  );
}
```

- [x] **Step 2: Route it in `App.tsx`**

In `apps/shopify/src/App.tsx`, add the import alongside the other page imports (alphabetical, between `ManagePage` and `SettingsPage`):

```ts
import PricingPage from './pages/PricingPage';
```

And add the route alongside the other routes, between `/analytics` and `/widget-design`:

```tsx
<Route path="/pricing" element={<PricingPage />} />
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual smoke check**

Run: `pnpm --filter @tryme/shopify-admin dev`, open the printed dev URL, navigate to `/pricing` directly (the dev nav in `AppNavMenu`/`NAV_ITEMS` won't list it — that's expected, see Global Constraints). Confirm all 3 columns render with the correct price/credits/try-ons/features, Growth shows "Best value", and clicking a non-current plan's button either navigates top-level to the Shopify hosted picker or — if `VITE_SHOPIFY_APP_HANDLE` isn't set in the local dev env — shows the critical banner instead of a silent failure.

- [x] **Step 5: Commit**

```bash
git add apps/shopify/src/pages/PricingPage.tsx apps/shopify/src/App.tsx
git commit -m "feat(shopify-admin): add in-app pricing comparison page"
```

---

### Task 5: Wire the Dashboard plan card to `/pricing`

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `useNavigate` (already imported at line 19).
- Produces: nothing new — this is the last task, removes now-dead code.

- [x] **Step 1: Remove the now-unused imports and constant**

In `apps/shopify/src/pages/DashboardPage.tsx`, change line 20 from:

```ts
import { apiFetch, navigateTopLevel } from '../lib/api';
import { buildPlanSelectionUrl } from '../lib/billing';
```

to:

```ts
import { apiFetch } from '../lib/api';
```

(drop the `buildPlanSelectionUrl` import line entirely).

Remove lines 32–34 (the `APP_HANDLE` constant and its leading comment):

```ts
// Set at build time from Partner Dashboard's app handle — see
// .env.production.example for VITE_SHOPIFY_APP_HANDLE.
const APP_HANDLE = import.meta.env.VITE_SHOPIFY_APP_HANDLE ?? '';
```

- [x] **Step 2: Remove `openPlanSelection` and repoint the button**

Delete the `openPlanSelection` function (lines 133–146):

```ts
  function openPlanSelection() {
    if (!me) return;
    // Without the build arg the URL collapses to .../charges//pricing_plans,
    // which Shopify answers with a 404 — a dead-end the merchant cannot
    // diagnose. Fail loudly here instead of navigating them off the app.
    if (!APP_HANDLE) {
      setError(
        'Plan selection is unavailable — this build is missing its Shopify app handle. Contact support@tryme.com.',
      );
      return;
    }
    setError(null);
    navigateTopLevel(buildPlanSelectionUrl(me.store.shopDomain, APP_HANDLE));
  }
```

Change the button (around line 312) from:

```tsx
                <Button onClick={openPlanSelection}>
```

to:

```tsx
                <Button onClick={() => navigate('/pricing')}>
```

- [x] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin exec tsc --noEmit`
Expected: no errors (confirms no other reference to `openPlanSelection`, `APP_HANDLE`, `navigateTopLevel`, or `buildPlanSelectionUrl` was left behind in this file).

- [ ] **Step 4: Manual smoke check**

With `pnpm --filter @tryme/shopify-admin dev` still running, open the Dashboard, click "Choose a plan" / "Manage plan", confirm it now lands on `/pricing` in-app instead of redirecting straight off to Shopify.

- [x] **Step 5: Commit**

```bash
git add apps/shopify/src/pages/DashboardPage.tsx
git commit -m "refactor(shopify-admin): route Dashboard plan card through the new pricing page"
```

---

## Follow-up (not part of this plan)

Confirm in Partner Dashboard that the Pro plan's actual configured charge is $229/month, not $219 — Task 1 fixes the repo's stale comment and credit grant, but the Partner Dashboard price itself can't be read or changed from this repo.
