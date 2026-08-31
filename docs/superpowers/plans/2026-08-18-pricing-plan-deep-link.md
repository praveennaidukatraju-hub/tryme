# Pricing Plan Deep-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `tryme.com` (WordPress) "Buy Now" buttons link to `app.tryme.com/pricing?plan=<slug>` and have the matching plan's Razorpay checkout open automatically, including when the visitor has to log in first.

**Architecture:** Two small, independent changes in `apps/catalogues-web`. (1) The auth middleware currently drops the query string when it bounces an unauthenticated visitor to `/login?next=<path>` — fix it to preserve the full path+query so `?plan=<slug>` survives the login/Google-OAuth round trip untouched (that round trip already treats `next` as an opaque relative URL end-to-end — verified in `google.routes.ts` and the Next `google/callback` route, no changes needed there). (2) The pricing page's data hook reads a `plan` query param once its plan/credit/payment-history queries have all resolved, finds the matching plan, and calls the *existing* `startBuy()` — the same function the on-page buttons call — so all current gating (coupon modal, GSTIN modal, Razorpay) is reused unchanged.

**Tech Stack:** Next.js 15 App Router, TypeScript, `next/navigation` (`useSearchParams`, `useRouter`), TanStack Query.

## Global Constraints

- ESM only, TypeScript 5.6, Node ≥20.11 (`CLAUDE.md`).
- `apps/catalogues-web` has **no automated test suite** (no vitest config, no `test` script in `package.json` — confirmed by inspection). Per `CLAUDE.md`'s testing guidance for frontend work, verification here is: typecheck + manual exercise via the dev server / a production build, not unit tests. Do not add a test framework as part of this plan — out of scope.
- Never use raw hex/hardcoded colors in UI (`C` tokens) — not touched by this plan (no new UI is added), noted only because both files border UI code.
- `NEXT_PUBLIC_BASE_PATH` must be respected in any constructed URL — the pricing hook already exposes a `BASE` constant for this; reuse it.
- Enterprise plan is explicitly out of scope for this plan (no `credit_plans` row exists for it yet); nothing here needs to special-case it.
- New email/password signups (requiring `/verify-email`) are out of scope for the auto-popup — only the login and Google-OAuth round trips are covered.

---

### Task 1: Preserve the query string through the login redirect

**Files:**
- Modify: `apps/catalogues-web/src/middleware.ts:131-134`

**Interfaces:**
- Consumes: nothing new — uses `request.nextUrl.search` (standard `URLSearchParams`-derived string, e.g. `?plan=growth` or `''`), already available on the `NextRequest` passed into `middleware()`.
- Produces: the `next` query param on the `/login` redirect now carries `path + search` instead of just `path`. Task 2 doesn't depend on this directly (it reads `plan` straight off `/pricing`'s own URL), but this is what makes the deep-link survive the login round trip end-to-end.

- [ ] **Step 1: Read the current code to confirm line numbers haven't drifted**

Open `apps/catalogues-web/src/middleware.ts` and find this block (near the end of the `middleware()` function, right before `export const config`):

```ts
  // Use absolute URL to avoid Next.js basePath double-prefix issues
  const loginUrl = new URL(`${BASE_PATH}/login`, request.url);
  loginUrl.searchParams.set('next', path); // path without basePath; router.push handles it
  return redirect(loginUrl);
```

If the surrounding function looks different, search for `loginUrl.searchParams.set('next'` instead — that line is the one to change.

- [ ] **Step 2: Make the change**

Replace the block found in Step 1 with:

```ts
  // Use absolute URL to avoid Next.js basePath double-prefix issues
  const loginUrl = new URL(`${BASE_PATH}/login`, request.url);
  // Preserve the query string too (e.g. ?plan=<slug> for the pricing
  // deep-link) so it survives the login round trip — path without basePath;
  // router.push handles it.
  loginUrl.searchParams.set('next', `${path}${request.nextUrl.search}`);
  return redirect(loginUrl);
```

- [ ] **Step 3: Verify with the dev server**

Start the web app (if not already running):

```bash
pnpm --filter @tryme/web dev
```

In a second terminal, hit `/pricing` with a `plan` query param and no auth cookie:

```bash
curl -s -o /dev/null -D - "http://localhost:3000/pricing?plan=growth" | grep -i "^location:"
```

Expected output (order of encoded characters may vary slightly, but `next` must contain the full encoded path+query):

```
location: http://localhost:3000/login?next=%2Fpricing%3Fplan%3Dgrowth
```

If `location` only contains `next=%2Fpricing` (no `%3Fplan...`), the change in Step 2 wasn't applied correctly — re-check the file.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/middleware.ts
git commit -m "fix(catalogues-web): preserve query string through login redirect

Needed so /pricing?plan=<slug> deep-links survive the login/Google-OAuth
round trip for logged-out visitors."
```

---

### Task 2: Auto-open checkout from the `plan` query param

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts`

**Interfaces:**
- Consumes: `startBuy(plan: CreditPlan)` (already defined in this same file, function declaration — hoisted, callable before its textual definition), `visiblePlans: CreditPlan[]` (already computed in this file from the `plans` query), `BASE` constant (already defined at top of this file, mirrors `NEXT_PUBLIC_BASE_PATH`).
- Produces: no new exports — this is purely an internal effect inside `usePricingData()`. Nothing outside this file needs to change.

- [ ] **Step 1: Add loading flags to the `credits` and `paymentHistory` queries**

These are needed so the auto-open effect can wait for real data before evaluating `startBuy`'s first-time-buyer gating (otherwise a repeat buyer would incorrectly see the first-purchase coupon modal, because the query's pre-load defaults look like "never purchased before").

Find this block (around line 214):

```ts
  const { data: credits } = useQuery<{
    balance: number;
    firstPurchaseBonusPercent: number | null;
    recent: { delta: number; reason: string; createdAt: string }[];
  }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
    staleTime: 60_000,
  });
```

Replace with:

```ts
  const { data: credits, isLoading: creditsLoading } = useQuery<{
    balance: number;
    firstPurchaseBonusPercent: number | null;
    recent: { delta: number; reason: string; createdAt: string }[];
  }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
    staleTime: 60_000,
  });
```

Find this block (around line 231, right after the `me` query):

```ts
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
```

Replace with:

```ts
  const { data: paymentHistory, isLoading: paymentHistoryLoading } = useQuery<{
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
```

(The `plans` query a few lines below already destructures `isLoading: plansLoading` — leave that one as-is, it's reused in Step 3.)

- [ ] **Step 2: Import `useRouter` and `useSearchParams`**

At the top of the file, find:

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Building2, Rocket } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
```

Replace with:

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart2, Building2, Rocket } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import React, { useEffect, useRef, useState } from 'react';
```

- [ ] **Step 3: Add the auto-open effect**

Find the existing "click outside" effect (the last of the three `useEffect` calls near the top of `usePricingData()`, right before `const isNonIn = country !== 'IN';`):

```ts
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node))
        setShowCountry(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isNonIn = country !== 'IN';
```

Insert a new effect between them, so it reads:

```ts
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (countryRef.current && !countryRef.current.contains(e.target as Node))
        setShowCountry(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // WordPress "Buy Now" buttons deep-link to /pricing?plan=<slug> and expect
  // checkout to open automatically — no extra click. Waits for plans,
  // credits, and payment history to finish loading so startBuy's
  // first-time-buyer gating (coupon modal vs. straight to GSTIN/Razorpay)
  // sees real data instead of pre-load defaults. Fires at most once per page
  // load (autoOpenedRef), then strips `plan` from the URL either way so a
  // refresh or back-navigation doesn't reopen the modal or re-check a
  // now-stale slug.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (plansLoading || creditsLoading || paymentHistoryLoading) return;
    const planSlug = searchParams.get('plan');
    if (!planSlug) return;
    autoOpenedRef.current = true;
    const plan = visiblePlans.find((p) => p.slug === planSlug);
    if (plan) startBuy(plan);
    router.replace(`${BASE}/pricing`, { scroll: false });
  }, [
    plansLoading,
    creditsLoading,
    paymentHistoryLoading,
    visiblePlans,
    searchParams,
    router,
    startBuy,
  ]);

  const isNonIn = country !== 'IN';
```

- [ ] **Step 4: Declare `searchParams`, `router`, and `autoOpenedRef`**

Find the existing ref/state declarations near the top of `usePricingData()`:

```ts
export function usePricingData() {
  const qc = useQueryClient();
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'catalogue' | 'tryon'>('catalogue');
  const [salesModal, setSalesModal] = useState<string | null>(null);
  const [country, setCountry] = useState('IN');
  const [showCountry, setShowCountry] = useState(false);
  const [couponModalPlan, setCouponModalPlan] = useState<CreditPlan | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [couponApplying, setCouponApplying] = useState(false);
  const [couponError, setCouponError] = useState('');
  const [couponApplied, setCouponApplied] = useState(false);
  const [couponBonusPercent, setCouponBonusPercent] = useState<number | null>(null);
  const [gstinModalPlan, setGstinModalPlan] = useState<CreditPlan | null>(null);
  const [checkoutGstin, setCheckoutGstin] = useState('');
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES);
  const [ratesLoading, setRatesLoading] = useState(true);
  const countryRef = useRef<HTMLDivElement>(null);
```

Replace with:

```ts
export function usePricingData() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'catalogue' | 'tryon'>('catalogue');
  const [salesModal, setSalesModal] = useState<string | null>(null);
  const [country, setCountry] = useState('IN');
  const [showCountry, setShowCountry] = useState(false);
  const [couponModalPlan, setCouponModalPlan] = useState<CreditPlan | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [couponApplying, setCouponApplying] = useState(false);
  const [couponError, setCouponError] = useState('');
  const [couponApplied, setCouponApplied] = useState(false);
  const [couponBonusPercent, setCouponBonusPercent] = useState<number | null>(null);
  const [gstinModalPlan, setGstinModalPlan] = useState<CreditPlan | null>(null);
  const [checkoutGstin, setCheckoutGstin] = useState('');
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES);
  const [ratesLoading, setRatesLoading] = useState(true);
  const countryRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef(false);
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: no errors. If TypeScript complains that `startBuy` is used before its declaration, confirm it's still declared with `function startBuy(plan: CreditPlan) {` (a hoisted function declaration, not `const startBuy = (plan: CreditPlan) => {`) — do not change that to an arrow function as part of this task.

- [ ] **Step 6: Production build (confirms `useSearchParams` doesn't break prerendering)**

```bash
pnpm --filter @tryme/web build
```

Expected: build succeeds with no `useSearchParams() should be wrapped in a suspense boundary` error. `/pricing` isn't statically prerendered at all (confirm: no `.next/server/app/pricing.html` after the build) — a fully dynamic route has no static shell to fail at prerender time, which is why `useSearchParams` is safe here without an explicit `<Suspense>` wrapper. (`loading.tsx` is unrelated to this: the sibling `apps/catalogues-web/src/app/(app)/catalogues/` route also ships a `loading.tsx` and still needed an explicit `<Suspense>` wrapper around its `useSearchParams` usage — see the `missing-suspense-with-csr-bailout` comment in that route — so `loading.tsx` alone does not grant an automatic Suspense boundary.) If the build *does* emit that error, wrap `PricingPage`'s default export in `apps/catalogues-web/src/app/(app)/pricing/page.tsx` in an explicit `<Suspense>` (see `apps/catalogues-web/src/app/(auth)/login/page.tsx` for the existing pattern in this codebase) before proceeding.

- [ ] **Step 7: Manual verification — already-logged-in visitor**

Requires `pnpm docker:up` running and the API + web dev servers up (`pnpm dev`, or `pnpm --filter @tryme/api dev` + `pnpm --filter @tryme/web dev`).

Find a real, active plan slug (not `free`) in the local dev DB:

```bash
docker exec tryme-postgres psql -U tryon -d tryon_dev -c "SELECT slug, is_active FROM credit_plans WHERE slug != 'free';"
```

Pick one active slug, then:

1. In a browser, log into `http://localhost:3000` with a test user that already has at least one prior successful payment (to skip the coupon-modal branch and go straight to GSTIN → Razorpay) — or use a fresh user and expect the coupon modal to appear first instead, which is also correct behavior.
2. Navigate to `http://localhost:3000/pricing?plan=<slug from above>`.
3. Confirm: the coupon modal or GSTIN modal (whichever applies) opens automatically, without clicking anything on the page.
4. Confirm the URL bar now reads `http://localhost:3000/pricing` (no `?plan=` — it was stripped).
5. Refresh the page. Confirm the modal does **not** reopen (the stripped URL has no `plan` param left to re-trigger it).

- [ ] **Step 8: Manual verification — logged-out visitor**

1. Log out (or use a private/incognito window).
2. Navigate to `http://localhost:3000/pricing?plan=<same slug as Step 7>`.
3. Confirm you land on the login page, and the URL bar shows `next=%2Fpricing%3Fplan%3D<slug>` (or the browser's decoded equivalent, `next=/pricing?plan=<slug>`).
4. Log in.
5. Confirm you're redirected to `/pricing` and the checkout modal opens automatically, same as Step 7.

- [ ] **Step 9: Manual verification — unknown plan slug**

Navigate to `http://localhost:3000/pricing?plan=does-not-exist` while logged in. Confirm the page renders normally (plan cards visible, no modal, no console error), and the URL is cleaned up to `/pricing`.

- [ ] **Step 10: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/pricing/use-pricing-data.ts
git commit -m "feat(catalogues-web): auto-open checkout from /pricing?plan=<slug>

Lets WordPress 'Buy Now' buttons deep-link straight into the existing
startBuy() flow for a specific plan, reusing all current coupon/GSTIN/
Razorpay gating unchanged."
```

---

## Post-plan

Update `docs/progress.md` with a dated entry once both tasks are committed, per `CLAUDE.md`'s progress-tracking convention: what's done, and the two explicit scope exclusions (Enterprise plan slug not yet created; new email/password signups don't get the auto-popup).
