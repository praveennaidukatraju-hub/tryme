# Pricing plan deep-link (WordPress "Buy Now" → auto checkout)

## Purpose

`tryme.com` (WordPress, outside this repo) will get "Buy Now" buttons per
credit plan. Clicking one should land the visitor on `app.tryme.com` and
open the Razorpay checkout for that specific plan automatically — no extra
click required once they arrive, regardless of whether they were already
logged in.

## Mechanism

A fixed, static URL per WordPress button, using the plan's `slug` (from
`credit_plans`, same values shown in admin → Settings → Plans):

```
https://app.tryme.com/pricing?plan=<slug>
```

No script or dynamic URL construction needed on the WordPress side — each
button just links to its own plain URL.

On `apps/catalogues-web`'s pricing page, once `/v1/payments/plans`,
`/v1/credits`, and `/v1/payments/history` have all resolved, the page reads
`plan` from the URL, finds the matching plan, and calls the **existing**
`startBuy(plan)` — the same function the on-page buttons already call. This
preserves current gating (first-time coupon modal, GSTIN modal, then
Razorpay) rather than bypassing it. Fires once per page load (ref-guarded),
and the `plan` param is stripped from the URL via `router.replace` afterward
so a refresh or back-navigation doesn't reopen the modal.

If `plan` doesn't match any known slug (typo, renamed/deactivated plan), the
page just renders normally with no popup and no error — silent fallback.

## Logged-out visitors: preserving intent through login

`/pricing` sits behind the auth middleware. Today, the middleware's redirect
to `/login` carries only the bare pathname in `?next=`, dropping any query
string — so `?plan=growth` would currently be lost.

**Change:** `apps/catalogues-web/src/middleware.ts` forwards the full
`path + search` as `next` (e.g. `next=%2Fpricing%3Fplan%3Dgrowth`) instead of
just `path`.

No other auth-flow code changes needed — verified that `next` is already
treated as an opaque relative path+query string everywhere it's threaded:

- `apps/catalogues-web/src/app/(auth)/login/page.tsx` reads `next` and does
  `router.push(nextPath)` — works with a path+query string as-is.
- `GoogleBtn` (`apps/catalogues-web/src/components/ui/google-btn.tsx`)
  forwards `next` verbatim to `/v1/auth/google/init`.
- `apps/api/src/modules/auth/google.routes.ts` round-trips `next` through a
  short-lived cookie across the Google OAuth redirect, untouched.
- `apps/catalogues-web/src/app/api/auth/google/callback/route.ts` does
  `new URL(`${BASE_PATH}${next}`, webOrigin)` — already handles a query
  string in `next`.

So: WP button → `/login?next=/pricing%3Fplan%3Dgrowth` (or Google OAuth,
same path) → login succeeds → lands back on `/pricing?plan=growth` → popup
opens automatically. Already-logged-in visitors skip straight to step 3.

## Out of scope

- **Enterprise plan**: not part of this pass — no `credit_plans` row for it
  yet. Adding it is a separate, later task; this feature works unchanged
  once that row exists (just another slug).
- **New email/password signups**: registration requires email verification
  via a magic-link page (`/verify-email`), a separate page load — often from
  an email client — where carrying the `plan` intent across isn't practical.
  A brand-new visitor who registers via email/password lands on `/studio` as
  today, no auto-popup; they can visit pricing normally afterward. Google
  sign-up *is* covered (no email-verification step, same-tab round trip).

## Files touched

- `apps/catalogues-web/src/middleware.ts` — preserve query string in the
  `next` redirect param.
- `apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts` — read
  `plan` query param, auto-call `startBuy` once dependent queries have
  resolved, strip the param from the URL after firing.

## Testing

- Middleware: unauthenticated request to `/pricing?plan=growth` redirects to
  `/login?next=%2Fpricing%3Fplan%3Dgrowth`.
- Pricing page (logged in): loading `/pricing?plan=growth` with `growth` a
  valid, active plan slug calls `startBuy` for that plan exactly once; the
  `plan` param is gone from the URL afterward.
- Pricing page: unknown/inactive slug in `plan` renders normally, no popup.
- Manual: full logged-out round trip via email/password login and via
  Google OAuth, confirming the popup opens after redirect back to pricing.
