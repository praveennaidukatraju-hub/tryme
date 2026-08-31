# Pricing Page — Viewport-Tier Responsive Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pricing page's non-responsive, fixed-pixel inline styles with a viewport-tier dispatcher: one shared data/business-logic hook, a reusable `useBreakpoint()` hook, and three presentational layout components (`Mobile`, `Tablet`, `Desktop`) that a thin `page.tsx` picks between.

**Architecture:** `usePricingData()` holds every `useQuery` call, the Razorpay checkout flow, and price formatting — extracted from today's `page.tsx` unchanged. `useBreakpoint()` (new, reusable, lives in `src/hooks/`) resolves one of five viewport tiers via `matchMedia`. `page.tsx` becomes a dispatcher that calls both hooks once and renders `<Mobile>`, `<Tablet>`, or `<Desktop>` — `small-laptop` and `laptop` alias to `Desktop` since the existing 3-column grid already fits above 1024px.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query, TypeScript 5.6. `apps/catalogues-web` has no test runner configured (`typecheck`/`lint` only — confirmed via `package.json`, no vitest/jest anywhere in the package) — verification throughout this plan is `pnpm --filter @tryme/web typecheck`, `pnpm --filter @tryme/web lint`, and manual browser resize checks, consistent with this repo's established convention for frontend-only responsive work.

**Reference spec:** `docs/superpowers/specs/2026-07-28-pricing-page-responsive-tiers-design.md`

---

## Before you start

The current implementation is a single 1,716-line file: `apps/catalogues-web/src/app/(app)/pricing/page.tsx`. Read it once before starting Task 1 — every task below references exact line ranges from that file **as it exists right now, before any task in this plan touches it**. Tasks 1–4 only add new files; nothing removes code from `page.tsx` until Task 5. This means the line numbers cited in Task 4 stay valid through Task 4.

Two deliberate, in-scope deletions happen in this refactor (not cleanup scope-creep — both are noted so you don't wonder if they were missed):
- `function paise(p: number) { ... }` (original line 174) has zero call sites anywhere in the file. Dropped, not moved.
- The disabled `{false && activeTab === 'tryon' && (...)}` block (original lines 745–1279, ~534 lines of dead offline-pricing-card markup kept for a future re-enable) is moved into `layouts/Desktop.tsx` only — **not** duplicated into `Tablet.tsx` or `Mobile.tsx`. It's unreachable dead code regardless of tier (the `false &&` guard never evaluates true), so tripling it into three files would add ~1,000 lines of code that can never render, for zero behavioral benefit.

---

### Task 1: Reusable `useBreakpoint` hook

**Files:**
- Create: `apps/catalogues-web/src/hooks/use-breakpoint.ts`

This hook doesn't depend on anything else in this plan and nothing depends on it yet — it's the first task specifically so it can be verified in isolation.

- [ ] **Step 1: Write the hook**

```ts
import { useLayoutEffect, useState } from 'react';

export type Tier = 'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop';

const QUERIES: Record<Tier, string> = {
  mobile: '(max-width: 639px)',
  tablet: '(min-width: 640px) and (max-width: 1023px)',
  'small-laptop': '(min-width: 1024px) and (max-width: 1279px)',
  laptop: '(min-width: 1280px) and (max-width: 1535px)',
  desktop: '(min-width: 1536px)',
};

/**
 * Resolves the current viewport tier via matchMedia. Returns null on the
 * server and on the client's first render (so SSR and initial hydration
 * match exactly), then resolves synchronously in useLayoutEffect before
 * paint. Listeners stay attached so resizing/rotating live-updates the tier.
 */
export function useBreakpoint(): Tier | null {
  const [tier, setTier] = useState<Tier | null>(null);

  useLayoutEffect(() => {
    const entries = (Object.entries(QUERIES) as [Tier, string][]).map(
      ([t, q]) => [t, window.matchMedia(q)] as const,
    );
    const resolve = () => {
      const match = entries.find(([, mql]) => mql.matches);
      setTier(match ? match[0] : 'desktop');
    };
    resolve();
    for (const [, mql] of entries) mql.addEventListener('change', resolve);
    return () => {
      for (const [, mql] of entries) mql.removeEventListener('change', resolve);
    };
  }, []);

  return tier;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/hooks/use-breakpoint.ts
git commit -m "feat(web): add reusable useBreakpoint viewport-tier hook"
```

---

### Task 2: Extract `usePricingData` — shared data and business logic

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts`

This pulls every non-rendering concern out of today's `PricingPage` component: the 5 `useQuery` calls, country/rate state, the Razorpay `buy()` flow, price formatting, and the "Current Plan Banner" derived values (today computed inline via an IIFE inside the JSX at original lines 456–479 — moved here so it's computed once instead of duplicated per layout). `page.tsx` is **not modified in this task** — this file is created standalone and is unused until Task 5.

- [ ] **Step 1: Write the hook file**

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Building2, Rocket } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { FlagAE, FlagGB, FlagIN, FlagUS } from '@/components/icons';
import { C } from '@/components/tokens';
import { api } from '@/lib/api';

export interface CreditPlan {
  id: string;
  slug: string;
  name: string;
  subtext: string;
  credits: number;
  basePaise: number;
  isActive: boolean;
  isHighlighted: boolean;
  badge: string | null;
  sortOrder: number;
}

export const FLAGS: Record<string, React.ReactElement> = {
  IN: <FlagIN size={16} />,
  US: <FlagUS size={16} />,
  GB: <FlagGB size={16} />,
  AE: <FlagAE size={16} />,
};

const GST_RATE = 0.18;

interface ResolutionConfig {
  enabled: boolean;
  creditCost: number;
}
export interface ResolutionConfigs {
  HD?: ResolutionConfig;
  '2K'?: ResolutionConfig;
  '4K'?: ResolutionConfig;
}

const CURRENCY: Record<string, { code: string; locale: string }> = {
  IN: { code: 'INR', locale: 'en-IN' },
  US: { code: 'USD', locale: 'en-US' },
  GB: { code: 'GBP', locale: 'en-GB' },
  AE: { code: 'AED', locale: 'en-AE' },
};

const FALLBACK_RATES: Record<string, number> = {
  IN: 1,
  US: 0.012,
  GB: 0.0095,
  AE: 0.044,
};

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Per-plan metadata — index matches sortOrder (0=Starter, 1=Growth, 2=Business)
export const PLAN_META = [
  {
    Icon: Rocket,
    subtext: 'Perfect for Small Businesses',
    accent: C.mid,
    iconColor: C.text,
    iconSrc: undefined,
    iconBg: C.mid,
    checkGrad: false,
    icon2k: `${BASE}/assets/2k-b-vec.svg`,
    icon4k: `${BASE}/assets/4k-b-vec.svg`,
    invertUsage: true,
  },
  {
    Icon: BarChart2,
    subtext: 'Best for Growing Businesses',
    accent: C.mint,
    iconColor: undefined,
    iconSrc: `${BASE}/assets/gro-vec.svg`,
    iconBg: C.mid,
    checkGrad: true,
    icon2k: `${BASE}/assets/2k-vec.svg`,
    icon4k: `${BASE}/assets/4k-vec.svg`,
    invertUsage: false,
  },
  {
    Icon: Building2,
    subtext: 'Ideal for Large Businesses',
    accent: C.mid,
    iconColor: C.text,
    iconSrc: `${BASE}/assets/pro-vec.svg`,
    iconBg: C.mid,
    checkGrad: false,
    icon2k: `${BASE}/assets/2k-b-vec.svg`,
    icon4k: `${BASE}/assets/4k-b-vec.svg`,
    invertUsage: true,
  },
] as const;

export const PLAN_FEATURES = [
  [
    'Both 2K & 4K Resolution',
    'Standard AI Models',
    'Standard Backgrounds',
    'Single Image Generation',
    'Product Catalogue Templates',
    'Email Support',
  ],
  [
    'Both 2K & 4K Resolution',
    'Premium AI Models',
    'Premium Backgrounds',
    'Bulk Image Generation',
    'Marketplace Templates',
    'Priority Support',
  ],
  [
    'Both 2K & 4K Resolution',
    'Premium AI Models',
    'Premium Backgrounds',
    'Bulk Image Generation',
    'Marketplace Templates',
    'Dedicated Support',
  ],
] as const;

export const COUNTRIES = [
  { code: 'IN', label: 'India (₹)', name: 'India' },
  { code: 'US', label: 'United States ($)', name: 'USA' },
  { code: 'GB', label: 'United Kingdom (£)', name: 'UK' },
  { code: 'AE', label: 'UAE (د.إ)', name: 'UAE' },
] as const;

function detectCountry(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = navigator.language ?? '';
    if (tz.startsWith('Asia/Kolkata') || tz.startsWith('Asia/Calcutta') || lang === 'en-IN')
      return 'IN';
    if (tz.startsWith('Asia/Dubai') || tz.startsWith('Asia/Muscat')) return 'AE';
    if (tz.startsWith('Europe/London') || lang.startsWith('en-GB')) return 'GB';
    if (tz.startsWith('America/') || lang.startsWith('en-US')) return 'US';
  } catch {
    /* SSR or restricted env */
  }
  return 'IN';
}

function formatPrice(paise: number, country: string, rates: Record<string, number>): string {
  const inr = paise / 100;
  const rate = rates[country] ?? 1;
  const converted = inr * rate;
  const { code, locale } = CURRENCY[country] ?? { code: 'INR', locale: 'en-IN' };
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    maximumFractionDigits: code === 'INR' ? 0 : 2,
    minimumFractionDigits: code === 'INR' ? 0 : 2,
  }).format(converted);
}

type Rzp = { open: () => void };
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => Rzp;
  }
}

function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export function usePricingData() {
  const router = useRouter();
  const qc = useQueryClient();
  const [toast, setToast] = useState('');
  const [buying, setBuying] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'catalogue' | 'tryon'>('catalogue');
  const [salesModal, setSalesModal] = useState<string | null>(null);
  const [country, setCountry] = useState('IN');
  const [showCountry, setShowCountry] = useState(false);
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES);
  const [ratesLoading, setRatesLoading] = useState(true);
  const countryRef = useRef<HTMLDivElement>(null);

  const { data: credits } = useQuery<{
    balance: number;
    recent: { delta: number; reason: string; createdAt: string }[];
  }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
    staleTime: 60_000,
  });

  const { data: me } = useQuery<{ tier: string }>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    staleTime: 60_000,
  });

  const { data: paymentHistory } = useQuery<{
    payments: {
      planId: string;
      planName: string | null;
      credits: number;
      status: string;
      paidAt: string | null;
    }[];
  }>({
    queryKey: ['payment-history'],
    queryFn: () => api.get('/v1/payments/history'),
    staleTime: 5 * 60_000,
  });

  const { data: plans = [], isLoading: plansLoading } = useQuery<CreditPlan[]>({
    queryKey: ['credit-plans'],
    queryFn: () => api.get<CreditPlan[]>('/v1/payments/plans'),
    staleTime: 5 * 60 * 1000,
  });
  const visiblePlans = plans.filter((plan) => plan.slug !== 'free');

  const { data: resolutionData } = useQuery<{ resolutions: ResolutionConfigs }>({
    queryKey: ['resolution-configs'],
    queryFn: () => api.get('/v1/config/resolutions'),
    staleTime: 10 * 60 * 1000,
  });

  const resolutions: ResolutionConfigs = resolutionData?.resolutions ?? {
    HD: { enabled: false, creditCost: 10 },
    '2K': { enabled: true, creditCost: 25 },
    '4K': { enabled: true, creditCost: 40 },
  };

  useEffect(() => {
    setCountry(detectCountry());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('https://api.frankfurter.app/latest?from=INR&to=USD,GBP,AED', {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data: { rates: Record<string, number> }) => {
        setRates({ IN: 1, ...data.rates });
      })
      .catch(() => {})
      .finally(() => setRatesLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node))
        setShowCountry(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isNonIn = country !== 'IN';

  function displayTotal(basePaise: number): string {
    return formatPrice(basePaise + Math.round(basePaise * GST_RATE), country, rates);
  }
  function displayBase(basePaise: number): string {
    return formatPrice(basePaise, country, rates);
  }
  function displayTax(basePaise: number): string {
    return formatPrice(Math.round(basePaise * GST_RATE), country, rates);
  }

  async function buy(plan: CreditPlan) {
    if (buying) return;
    setBuying(plan.slug);
    try {
      const ok = await loadRazorpay();
      if (!ok || !window.Razorpay) {
        setToast('Could not load payment gateway. Please try again.');
        return;
      }

      const order = await api.post<{
        orderId: string;
        amount: number;
        currency: string;
        keyId: string;
        credits: number;
        label: string;
      }>('/v1/payments/orders', { planId: plan.slug });

      await new Promise<void>((resolve, reject) => {
        const RazorpayClass = window.Razorpay as NonNullable<typeof window.Razorpay>;
        const rzp = new RazorpayClass({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: 'Ai Vastra',
          description: `${order.label} — ${plan.credits.toLocaleString('en-IN')} Credits`,
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            try {
              await api.post('/v1/payments/verify', {
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              });
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: { ondismiss: () => reject(new Error('dismissed')) },
          theme: { color: C.pink },
        });
        rzp.open();
      });

      qc.invalidateQueries({ queryKey: ['credits'] });
      setToast(`${plan.credits.toLocaleString('en-IN')} credits added to your account!`);
      setTimeout(() => router.push('/catalogues'), 1500);
    } catch (err) {
      if (err instanceof Error && err.message === 'dismissed') {
        // user closed modal — no toast
      } else {
        setToast((err as Error).message ?? 'Payment failed. Please try again.');
      }
    } finally {
      setBuying(null);
    }
  }

  // Current Plan Banner derived values — computed once here instead of
  // once per layout component.
  const currentTier = me?.tier ?? 'free';
  const balance = credits?.balance ?? 0;
  const currentPaidPlan = plans.find((plan) => plan.slug === currentTier) ?? null;
  const latestPaidForCurrentTier =
    paymentHistory?.payments?.find((p) => p.status === 'paid' && p.planId === currentTier) ??
    null;
  const freeTrialGrant =
    credits?.recent?.find((e) => e.reason === 'FREE_TRIAL' && e.delta > 0)?.delta ?? null;
  const isFreeTier = currentTier === 'free';
  const planName = isFreeTier
    ? 'Free'
    : (currentPaidPlan?.name ?? latestPaidForCurrentTier?.planName ?? currentTier);
  const planCredits: number | null = isFreeTier
    ? freeTrialGrant
    : (currentPaidPlan?.credits ?? latestPaidForCurrentTier?.credits ?? null);
  const pct = planCredits ? Math.min(100, Math.round((balance / planCredits) * 100)) : 100;
  const activatedDate = latestPaidForCurrentTier?.paidAt
    ? new Date(latestPaidForCurrentTier.paidAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return {
    toast,
    buying,
    activeTab,
    setActiveTab,
    salesModal,
    setSalesModal,
    country,
    setCountry,
    showCountry,
    setShowCountry,
    countryRef,
    ratesLoading,
    isNonIn,
    visiblePlans,
    plansLoading,
    resolutions,
    displayBase,
    displayTotal,
    displayTax,
    buy,
    banner: { planName, balance, planCredits, pct, activatedDate },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS, no errors. (This file isn't imported anywhere yet, so this only validates it's internally well-typed.)

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/use-pricing-data.ts
git commit -m "feat(web): extract pricing data/checkout logic into usePricingData hook"
```

---

### Task 3: Shared layout prop type

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/layouts/types.ts`

- [ ] **Step 1: Write the type file**

```ts
import type { usePricingData } from '../use-pricing-data';

export type PricingLayoutProps = ReturnType<typeof usePricingData>;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/layouts/types.ts
git commit -m "feat(web): add shared PricingLayoutProps type for tier layouts"
```

---

### Task 4: `Desktop` layout — move today's JSX, unchanged behavior

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/layouts/Desktop.tsx`
- Reference only (not modified yet): `apps/catalogues-web/src/app/(app)/pricing/page.tsx`

This is a **verbatim move**: today's `page.tsx` return-JSX (original lines 367–1715) becomes the body of a new `Desktop` component that reads its data from props instead of calling hooks directly. Nothing about the rendered output changes.

- [ ] **Step 1: Create the file with this exact header**

```tsx
import { Fragment } from 'react';
import {
  ArrowRight,
  Image,
  ImagePlus,
  Info,
  Shirt,
} from 'lucide-react';
import {
  CheckIcon,
  ChevronDown,
  ChevronRight,
} from '@/components/icons';
import { SupportModal } from '@/components/SupportModal';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { Tooltip } from '@/components/ui/tooltip';
import { COUNTRIES, FLAGS, PLAN_FEATURES, PLAN_META } from '../use-pricing-data';
import type { PricingLayoutProps } from './types';

export function Desktop(props: PricingLayoutProps): React.ReactElement {
  const {
    toast,
    buying,
    activeTab,
    setActiveTab,
    salesModal,
    setSalesModal,
    country,
    setCountry,
    showCountry,
    setShowCountry,
    countryRef,
    ratesLoading,
    isNonIn,
    visiblePlans,
    plansLoading,
    resolutions,
    displayBase,
    buy,
    banner,
  } = props;
```

- [ ] **Step 2: Copy the JSX body from `page.tsx`**

Open the current (untouched) `apps/catalogues-web/src/app/(app)/pricing/page.tsx` and copy lines 367 through 1715 (from `return (` through the line before the component's final closing `}`) directly below the destructuring block from Step 1. This is everything from the outer `<div style={{ flex: 1, overflowY: 'auto', background: C.bg }}>` wrapper through the closing `</div>` that follows the toast notification block.

Within that copied block, make exactly these two changes and nothing else:

**Change A** — the Current Plan Banner IIFE (original lines 456–480) currently recomputes `currentTier`, `balance`, `currentPaidPlan`, `latestPaidForCurrentTier`, `freeTrialGrant`, `isFreeTier`, `planName`, `planCredits`, `pct`, `activatedDate` from `me`/`credits`/`plans`/`paymentHistory`. Replace that entire computation block with a single destructure from the `banner` prop:

Original (delete this):
```jsx
{(() => {
  const currentTier = me?.tier ?? 'free';
  const balance = credits?.balance ?? 0;
  const currentPaidPlan = plans.find((plan) => plan.slug === currentTier) ?? null;
  const latestPaidForCurrentTier =
    paymentHistory?.payments?.find((p) => p.status === 'paid' && p.planId === currentTier) ??
    null;
  const freeTrialGrant =
    credits?.recent?.find((e) => e.reason === 'FREE_TRIAL' && e.delta > 0)?.delta ?? null;
  const isFreeTier = currentTier === 'free';
  const planName = isFreeTier
    ? 'Free'
    : (currentPaidPlan?.name ?? latestPaidForCurrentTier?.planName ?? currentTier);
  const planCredits: number | null = isFreeTier
    ? freeTrialGrant
    : (currentPaidPlan?.credits ?? latestPaidForCurrentTier?.credits ?? null);
  const pct = planCredits ? Math.min(100, Math.round((balance / planCredits) * 100)) : 100;
  const activatedDate = latestPaidForCurrentTier?.paidAt
    ? new Date(latestPaidForCurrentTier.paidAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
```

Replacement (use this instead):
```jsx
{(() => {
  const { planName, balance, planCredits, pct, activatedDate } = banner;

  return (
```

Everything after this `return (` — the entire banner `<div>` markup — is unchanged; it already references `planName`, `balance`, `planCredits`, `pct`, `activatedDate`, which now come from the destructure above instead of being computed inline.

**Change B** — the component's own local hook calls and state (`useState`, `useQuery`, `useEffect`, `useRouter`, `useQueryClient`, `country`/`rates`/`ratesLoading` declarations, `buy`/`displayBase`/`displayTotal`/`displayTax` function definitions, the `COUNTRIES` array literal, `detectCountry`/`formatPrice`/`loadRazorpay`/`Rzp` — original lines 196–301 before the `return (` at line 367) are **not** copied at all — they don't exist in `Desktop.tsx`. Everything from that range is already provided by the `props` destructured in Step 1 or imported from `../use-pricing-data` (`COUNTRIES`, `PLAN_META`, `PLAN_FEATURES`, `FLAGS`).

- [ ] **Step 3: Close the function**

After the copied JSX's closing `</div>` (matching the outer wrapper opened in the copied block), close the component:

```tsx
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS. If you see "X is possibly undefined" or unused-variable errors, check the destructure in Step 1 against what the copied JSX actually references — every identifier the JSX uses that isn't a local `const`/import must appear in that destructure.

- [ ] **Step 5: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS. All `biome-ignore` comments from the original file (e.g. `noNonNullAssertion` on `PLAN_META[idx]`, `noArrayIndexKey` in the disabled offline section's `.map`, `useJsxKeyInIterable` on `cardContent`, `noImgElement` on the SVG icons) must still be present exactly where they were in the original — they were copied verbatim in Step 2, so this should pass without changes.

- [ ] **Step 6: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/layouts/Desktop.tsx
git commit -m "feat(web): add Desktop pricing layout (moved from page.tsx, unchanged)"
```

---

### Task 5: Rewrite `page.tsx` as a dispatcher (Desktop only)

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/pricing/page.tsx` (full replacement)

This is the "big swap" — replace the entire 1,716-line file with a thin dispatcher. At the end of this task the page renders **exactly** what it rendered before (Desktop layout, unconditionally) — tier-awareness is added in Tasks 6 and 7, kept out of this task to isolate the extraction from the new behavior.

- [ ] **Step 1: Replace the entire file contents**

```tsx
'use client';

import { Desktop } from './layouts/Desktop';
import { usePricingData } from './use-pricing-data';

export default function PricingPage(): React.ReactElement {
  const data = usePricingData();
  return <Desktop {...data} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Manual verification**

Run: `pnpm --filter @tryme/web dev`
Open `http://localhost:3000/pricing` (adjust port/base path if your local env differs) at a desktop viewport width (e.g. 1728px). Confirm the page looks and behaves identically to before this task: banner, tab toggle, 3-column pricing cards, country selector, footer note, and the Razorpay "Upgrade" flow all present and functioning. This is a pure refactor — any visual difference at this point is a bug.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/page.tsx
git commit -m "refactor(web): rewrite pricing page.tsx as a thin layout dispatcher"
```

---

### Task 6: `Tablet` layout (2-column grid, stacked banner)

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/layouts/Tablet.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/pricing/page.tsx`

Tablet's country selector is **identical** to Desktop's (a 200px popover has no overflow risk anywhere in the 640–1023px range) — only the banner and the card grid differ. Tablet also doesn't need the disabled offline-pricing section, so it's dropped along with its now-unused imports.

- [ ] **Step 1: Copy `Desktop.tsx` to `Tablet.tsx`**

```bash
cp apps/catalogues-web/src/app/\(app\)/pricing/layouts/Desktop.tsx apps/catalogues-web/src/app/\(app\)/pricing/layouts/Tablet.tsx
```

- [ ] **Step 2: Rename the export and trim now-unused imports/destructure keys**

In `Tablet.tsx`:
- Change `export function Desktop(` → `export function Tablet(`.
- Remove `salesModal` and `setSalesModal` from the props destructure — they're only used by the disabled offline section, which Tablet doesn't render.
- Delete the entire disabled offline-pricing block: `{false && activeTab === 'tryon' && ( ... )}` (the block that starts right after the tab-toggle section and ends right before `{activeTab === 'catalogue' && (`).
- Delete the `{salesModal !== null && (<SupportModal .../>)}` block near the end of the file (right before the toast notification block) — with the offline section gone, nothing in `Tablet.tsx` ever sets `salesModal`, so this can never render.
- Remove now-unused imports: `Fragment` (from `'react'`), `Image`, `ImagePlus`, `Shirt` (from `'lucide-react'`), `SupportModal` (from `'@/components/SupportModal'`).

- [ ] **Step 3: Replace the Current Plan Banner with the stacked version**

Find the banner block (the `{(() => { const { planName, ... } = banner; return ( <div style={{ margin: '24px auto 0', maxWidth: 1080, borderRadius: 16, background: grad, display: 'flex', alignItems: 'stretch', ... }}> ... ) })()}` block — everything from that opening `<div>` through its matching closing `</div>` before the `{/* Tab toggle */}` comment). Replace the entire `<div>...</div>` markup (keep the `const { planName, ... } = banner;` line and the surrounding IIFE as-is) with:

```jsx
    <div
      style={{
        margin: '24px auto 0',
        maxWidth: 1080,
        borderRadius: 16,
        background: grad,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Plan info */}
      <div
        style={{
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div>
          <span
            style={{
              display: 'inline-block',
              padding: '3px 12px',
              borderRadius: 20,
              background: 'rgba(255,255,255,0.25)',
              color: C.white,
              fontSize: 11,
              fontWeight: 700,
              marginBottom: 12,
              letterSpacing: '0.3px',
            }}
          >
            Current Plan
          </span>
          <div
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: '#ffffff',
              lineHeight: 1.2,
              marginBottom: 8,
            }}
          >
            {planName}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'rgba(255,255,255,0.82)',
              lineHeight: '20px',
            }}
          >
            Designed for growing brands creating AI powered fashion catalogues and virtual
            tryons at scale.
          </div>
          {activatedDate && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>
              Plan Activated on {activatedDate}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setActiveTab('catalogue')}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            borderRadius: 10,
            border: 'none',
            background: '#ffffff',
            color: '#141414',
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Upgrade Plan <ChevronRight />
        </button>
      </div>

      {/* Divider — horizontal, stacked layout */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.2)', margin: '0 20px' }} />

      {/* Credits */}
      <div
        style={{
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.7)',
            fontWeight: 600,
            letterSpacing: '0.3px',
          }}
        >
          Credits Remaining
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
          <span style={{ fontSize: 40, fontWeight: 800, color: '#ffffff', lineHeight: 1 }}>
            {balance.toLocaleString('en-IN')}
          </span>
          {planCredits !== null && (
            <span style={{ fontSize: 16, color: 'rgba(255,255,255,0.6)', marginLeft: 2 }}>
              /{planCredits.toLocaleString('en-IN')}
            </span>
          )}
        </div>
        {planCredits !== null && (
          <div
            style={{
              height: 8,
              borderRadius: 100,
              background: 'rgba(255,255,255,0.25)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${pct}%`,
                borderRadius: 100,
                background: C.white,
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        )}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: '16px' }}>
          Credits are shared across AI Catalogue Generation and AI Virtual Tryon.
        </div>
      </div>
    </div>
```

- [ ] **Step 4: Switch the card grid to a 2-column CSS grid**

Find the pricing-cards wrapper: `{activeTab === 'catalogue' && ( <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'stretch', flexWrap: 'wrap', maxWidth: 1080, margin: '0 auto', padding: '0 24px' }}> ... </div> )}`.

Change the wrapper's `style` to:

```jsx
style={{
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 20,
  maxWidth: 1080,
  margin: '0 auto',
  padding: '0 24px',
}}
```

Within that wrapper, every `width: 320` becomes `width: '100%'` — there are three occurrences: the loading-skeleton placeholder div, the highlighted-card outer wrapper, and the non-highlighted-card outer wrapper. Do not change anything else in those three blocks (padding, borderRadius, background, boxShadow, the `cardContent` construction, `meta`/`features`/`accent`/`highlighted` — all identical to Desktop).

- [ ] **Step 5: Wire `Tablet` into the dispatcher**

Replace `apps/catalogues-web/src/app/(app)/pricing/page.tsx` with:

```tsx
'use client';

import { useBreakpoint } from '@/hooks/use-breakpoint';
import { Desktop } from './layouts/Desktop';
import { Tablet } from './layouts/Tablet';
import Loading from './loading';
import { usePricingData } from './use-pricing-data';

export default function PricingPage(): React.ReactElement {
  const data = usePricingData();
  const tier = useBreakpoint();

  if (tier === null) return <Loading />;
  if (tier === 'tablet') return <Tablet {...data} />;
  return <Desktop {...data} />;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 7: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run: `pnpm --filter @tryme/web dev`, open `/pricing`, and resize the browser (or use devtools' device toolbar) to 800px width. Confirm: banner stacks (plan info above credits, horizontal divider), pricing cards render 2-per-row and stretch to fill the available width (no fixed 320px card visible), country selector popover still opens from the topbar exactly as before. Then widen to 1728px and confirm Desktop's 3-column layout still renders unchanged (regression check on Task 5's work).

- [ ] **Step 9: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/layouts/Tablet.tsx apps/catalogues-web/src/app/\(app\)/pricing/page.tsx
git commit -m "feat(web): add Tablet pricing layout with stacked banner and 2-col grid"
```

---

### Task 7: `Mobile` layout (1-column grid, stacked banner, full-width country bar)

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/pricing/layouts/Mobile.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/pricing/page.tsx`

Mobile's country selector can't simply become "full-width" inside `TopBar`'s `right` slot — that slot already carries a phone-call link, a support button, and the user-menu avatar in a fixed-height 76px row (see `apps/catalogues-web/src/components/topbar.tsx`), which is what actually overflows on a 375px viewport, not the popover's own width. `TopBar` is a shared component used across the app, so it's out of scope to redesign here. Instead, Mobile passes nothing into `TopBar`'s `right` prop and renders the country selector as its own full-width bar directly below the `TopBar`, in space the pricing page fully controls.

- [ ] **Step 1: Copy `Tablet.tsx` to `Mobile.tsx`**

```bash
cp apps/catalogues-web/src/app/\(app\)/pricing/layouts/Tablet.tsx apps/catalogues-web/src/app/\(app\)/pricing/layouts/Mobile.tsx
```

- [ ] **Step 2: Rename the export**

Change `export function Tablet(` → `export function Mobile(`.

- [ ] **Step 3: Replace the topbar + country selector section**

Find the block at the top of the returned JSX:

```jsx
{/* Topbar with country selector */}
<div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
  <TopBar
    title="Pricing & Plan"
    subtitle="Create professional fashion catalogues without photoshoots, models, or editing headaches."
    right={
      <div ref={countryRef} style={{ position: 'relative', flexShrink: 0 }}>
        ... (button + popover) ...
      </div>
    }
  />
</div>
```

Replace the entire block (from `{/* Topbar with country selector */}` through the closing `</div>` of the sticky wrapper) with:

```jsx
{/* Topbar — country selector moved below, out of TopBar's cramped right slot */}
<div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
  <TopBar
    title="Pricing & Plan"
    subtitle="Create professional fashion catalogues without photoshoots, models, or editing headaches."
  />
  <div
    ref={countryRef}
    style={{
      position: 'relative',
      borderBottom: `1px solid ${C.border}`,
      background: C.white,
      padding: '10px 16px',
    }}
  >
    <button
      type="button"
      onClick={() => setShowCountry(!showCountry)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: 10,
        width: '100%',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: C.white,
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        color: C.text,
        cursor: 'pointer',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{FLAGS[country]}</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: C.mid }}>
          {COUNTRIES.find((c) => c.code === country)?.name}
        </span>
      </span>
      <ChevronDown size={14} />
    </button>
    {showCountry && (
      <div
        style={{
          position: 'absolute',
          top: '100%',
          left: 16,
          right: 16,
          marginTop: 4,
          background: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          overflow: 'hidden',
          zIndex: 10,
        }}
      >
        {COUNTRIES.map((c) => (
          <button
            key={c.code}
            type="button"
            onClick={() => {
              setCountry(c.code);
              setShowCountry(false);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              fontSize: 13,
              fontWeight: 500,
              color: country === c.code ? C.pink : C.mid,
              cursor: 'pointer',
              background: country === c.code ? 'rgba(245,92,122,0.06)' : 'transparent',
              border: 'none',
              width: '100%',
              fontFamily: 'inherit',
              textAlign: 'left',
            }}
          >
            {FLAGS[c.code]} {c.label}
          </button>
        ))}
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 4: Switch the card grid to a single column**

Find the same pricing-cards wrapper edited in Task 6 Step 4. Change `gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'` to `gridTemplateColumns: '1fr'`, and change the wrapper's `padding: '0 24px'` to `padding: '0 16px'` (tighter edge margins appropriate for a phone screen). Leave everything else (the three `width: '100%'` card wrappers, `cardContent`, `maxWidth: 1080`) unchanged.

- [ ] **Step 5: Wire `Mobile` into the dispatcher**

Replace `apps/catalogues-web/src/app/(app)/pricing/page.tsx` with:

```tsx
'use client';

import { useBreakpoint } from '@/hooks/use-breakpoint';
import { Desktop } from './layouts/Desktop';
import { Mobile } from './layouts/Mobile';
import { Tablet } from './layouts/Tablet';
import Loading from './loading';
import { usePricingData } from './use-pricing-data';

export default function PricingPage(): React.ReactElement {
  const data = usePricingData();
  const tier = useBreakpoint();

  if (tier === null) return <Loading />;
  if (tier === 'mobile') return <Mobile {...data} />;
  if (tier === 'tablet') return <Tablet {...data} />;
  return <Desktop {...data} />;
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 7: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 8: Manual verification**

Run: `pnpm --filter @tryme/web dev`, open `/pricing` at a 375px viewport (devtools device toolbar, e.g. "iPhone SE" or "iPhone 12 Pro"). Confirm: banner stacks correctly with no overflow, the country selector renders as its own full-width bar below the topbar (not clipped, opens/closes correctly, click-outside-to-close still works), pricing cards render one per row at full width, and the Razorpay "Upgrade" flow still opens correctly. Then check 800px (Tablet, still correct) and 1728px (Desktop, still correct) as a final regression pass across all three built layouts.

- [ ] **Step 9: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/layouts/Mobile.tsx apps/catalogues-web/src/app/\(app\)/pricing/page.tsx
git commit -m "feat(web): add Mobile pricing layout with full-width country bar and single-column grid"
```

---

### Task 8: Final verification and progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Full verification pass**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

Run: `pnpm --filter @tryme/web build`
Expected: PASS (catches any SSR-only issues the dev server might not surface, e.g. anything referencing `window` outside an effect).

- [ ] **Step 2: Manual resize sweep**

With `pnpm --filter @tryme/web dev` running and `/pricing` open, check all five tier boundaries: 375px (mobile), 800px (tablet), 1100px (small-laptop — confirm it renders identically to Desktop, since it aliases to the same component), 1400px (laptop — same check), 1728px (desktop). At each width, confirm no horizontal scrollbar appears and no element visibly clips or overlaps another.

- [ ] **Step 3: Add a dated entry to `docs/progress.md`**

Add this entry at the top of the log (above the most recent existing entry), following the file's existing format for section headers:

```markdown
## 2026-07-28 — Pricing page: viewport-tier responsive rebuild

### Done
- Extracted all pricing-page data fetching, Razorpay checkout logic, and price formatting into `usePricingData()` (`apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts`).
- Added a reusable `useBreakpoint()` hook (`apps/catalogues-web/src/hooks/use-breakpoint.ts`) resolving 5 viewport tiers via `matchMedia`, intended as the template for responsive rebuilds of other pages.
- Split the pricing page into `Desktop`/`Tablet`/`Mobile` layout components under `apps/catalogues-web/src/app/(app)/pricing/layouts/`; `small-laptop` and `laptop` tiers alias to `Desktop` since its existing 3-column grid already fits above 1024px.
- Fixed the two real responsive breaks: the Current Plan Banner now stacks instead of clipping into a fixed side-by-side layout, and pricing cards use a CSS grid (2-col tablet, 1-col mobile) instead of relying on `flexWrap` at a fixed 320px card width.
- Moved the country selector to a dedicated full-width bar below the topbar on Mobile only, since the real overflow cause was `TopBar`'s shared `right`-slot row (phone link + support button + user menu), not the popover's own width.

### Failed / Not Done
- (none)

### Open Questions / Decisions
- The dead `{false && activeTab === 'tryon'}` offline-pricing-card block (~534 lines) was kept only in `Desktop.tsx`, not duplicated into `Tablet.tsx`/`Mobile.tsx` — it's unreachable regardless of tier, so this is a size reduction with zero behavioral difference. If it's ever re-enabled, it'll need its own responsive treatment added at that time.
- No test runner exists in `apps/catalogues-web`; verification for this rebuild was `typecheck`/`lint`/`build` plus manual resize checks, consistent with this repo's established convention for frontend-only responsive work.
```

- [ ] **Step 4: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record pricing page viewport-tier responsive rebuild"
```

---

## Self-review notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-28-pricing-page-responsive-tiers-design.md` maps to a task — the shared data hook (Task 2), the reusable breakpoint hook (Task 1), the file plan (Tasks 3–7), the screen-by-screen differences (Tasks 6–7), and the testing plan (folded into every task's verification steps plus Task 8's final sweep).
- **Type consistency:** `PricingLayoutProps` (Task 3) is `ReturnType<typeof usePricingData>` — every property name used in the Task 4/6/7 destructures (`toast`, `buying`, `activeTab`, `setActiveTab`, `salesModal`, `setSalesModal`, `country`, `setCountry`, `showCountry`, `setShowCountry`, `countryRef`, `ratesLoading`, `isNonIn`, `visiblePlans`, `plansLoading`, `resolutions`, `displayBase`, `buy`, `banner`) matches a key in Task 2's hook return object exactly.
- **No placeholders:** every step either gives complete new code or an exact, unambiguous copy-then-edit instruction referencing content fully specified earlier in this same plan (never "similar to Task N, figure out the rest").
