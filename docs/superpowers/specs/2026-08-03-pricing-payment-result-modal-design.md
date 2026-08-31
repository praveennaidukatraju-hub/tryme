# Pricing Page — Premium Payment Result Modal

**Status:** Approved design, not yet implemented.
**Date:** 2026-08-03

## 1. Problem Statement

After a Razorpay purchase on `/pricing`, the user sees a bare single-line dark toast at the bottom of the screen ("1,250 credits added to your account!") for 1.5s before being auto-redirected to `/catalogues`. It gives no visibility into what was actually charged (base price vs GST) or what was actually credited (base credits vs the QR-campaign bonus added in commit `193b4250`), and it disappears too fast to read even if it did.

The same toast state is also reused, with a different message, for two unrelated failure cases (Razorpay script failed to load; `/v1/payments/verify` failed) — those need to keep working, just wrapped in the same visual chrome for consistency.

This is a pure frontend redesign. No backend or schema changes: `plan.credits`, `firstPurchaseBonusPercent` (from `GET /v1/credits`), and `creditsGranted` (from `POST /v1/payments/verify`, added in `193b4250`) already carry everything the breakdown needs.

## 2. Current State (verified against code)

- `apps/catalogues-web/src/app/(app)/pricing/use-pricing-data.ts` holds a single `toast: string` state (`use-pricing-data.ts:180`), set from three call sites inside `buy()` (`use-pricing-data.ts:279-345`):
  - `setToast('Could not load payment gateway. Please try again.')` when `loadRazorpay()` fails (`:285`)
  - `setToast(\`${creditsGranted...} credits added to your account!\`)` on success, immediately followed by `setTimeout(() => router.push('/catalogues'), 1500)` (`:334-335`)
  - `setToast((err as Error).message ?? 'Payment failed. Please try again.')` on any other thrown error (`:340`) — except the Razorpay-modal-dismissed case, which is silently swallowed (`:337-338`)
- The Razorpay checkout description line (`:307-309`) already conditionally mentions the bonus percent — this stays unchanged, it's a different UI surface (Razorpay's own modal, not ours).
- The `toast` string is rendered identically in three places — `Desktop.tsx:1360-1377`, and the equivalent blocks in `Mobile.tsx` and `Tablet.tsx` — a `position: fixed`, bottom-center, dark pill `<div>`, no icon, no button, no backdrop.
- `SupportModal.tsx` (`apps/catalogues-web/src/components/SupportModal.tsx`) is this app's existing centered-modal pattern and is the visual/structural reference for the new component: `rgba(0,0,0,0.35)` backdrop `<div role="presentation">` that closes on click, a centered card (`position: fixed; top/left 50%; transform: translate(-50%,-50%)`, `borderRadius: 14`, `boxShadow: 0 16px 48px rgba(0,0,0,0.18)`), a focus-trap + Escape-to-close `useEffect`, an X close button (`lucide-react`), and a tinted-circle ✓ for its own done-state (`:219`, `background: color-mix(in srgb, #7C3AED 8%, transparent)`). All colors/spacing come from `C`/`grad` in `@/components/tokens` — no new dependency.
- Price breakdown numbers already exist as formatted strings via `displayBase(basePaise)`, `displayTax(basePaise)`, `displayTotal(basePaise)` (`use-pricing-data.ts:269-277`, `GST_RATE = 0.18` at `:29`) — these are the same helpers the pricing cards themselves use, so the modal's numbers will match what the user saw before paying.
- `firstPurchaseBonusPercent` is already fetched via the `credits` query (`use-pricing-data.ts:190-199`) and is in scope inside `buy()` for the description-line logic at `:307` — reusable as-is for the breakdown.

## 3. Design

### 3.1 Data shape

New discriminated union, defined alongside `CreditPlan` in `use-pricing-data.ts`:

```ts
export type PaymentResult =
  | {
      kind: 'success';
      planName: string;
      base: string; // formatted, e.g. "₹1,000"
      tax: string;
      total: string;
      baseCredits: number;
      bonusPercent: number | null; // null => no bonus line, single "Credits added" line
      bonusCredits: number;
      totalCredits: number;
    }
  | {
      kind: 'error';
      message: string;
      onRetry: () => void;
    };
```

`toast: string` state is replaced by `paymentResult: PaymentResult | null`, returned from `usePricingData()` in place of `toast`.

### 3.2 `buy()` changes

Same three call sites, same control flow — only the payload passed changes:

- Gateway-load failure (`:285`): `setPaymentResult({ kind: 'error', message: 'Could not load payment gateway. Please try again.', onRetry: () => void buy(plan) })`; `return` as today.
- Success (`:333-335`): remove the `setTimeout(... router.push ...)` — navigation now happens only from the modal's "Continue" button, not automatically. Build the breakdown from values already in scope:
  ```ts
  const bonusPercent = firstPurchaseBonusPercent;
  const bonusCredits = bonusPercent ? creditsGranted - plan.credits : 0;
  setPaymentResult({
    kind: 'success',
    planName: plan.name,
    base: displayBase(plan.basePaise),
    tax: displayTax(plan.basePaise),
    total: displayTotal(plan.basePaise),
    baseCredits: plan.credits,
    bonusPercent,
    bonusCredits,
    totalCredits: creditsGranted,
  });
  ```
  `qc.invalidateQueries({ queryKey: ['credits'] })` stays where it is.
- Other thrown errors (`:340`, dismissed-modal case at `:337` unchanged — still silent): `setPaymentResult({ kind: 'error', message: (err as Error).message ?? 'Payment failed. Please try again.', onRetry: () => void buy(plan) })`.

`buying` state and its `finally` reset (`:342-344`) are untouched — "Try Again" calls the same `buy(plan)`, which still respects the `if (buying) return` guard at the top.

### 3.3 New component — `PaymentResultModal.tsx`

New file, colocated with the feature (not in the shared `components/` folder, since it's pricing-only): `apps/catalogues-web/src/app/(app)/pricing/PaymentResultModal.tsx`.

```ts
function PaymentResultModal({ result, onClose }: { result: PaymentResult; onClose: () => void }): React.ReactElement
```

Structure, reusing `SupportModal`'s exact chrome (backdrop, centered card, focus trap, Escape-to-close, `lucide-react` X button — copy that `useEffect` verbatim, it's self-contained):

**Success body:**
1. Tinted circle + ✓ (same `color-mix(in srgb, #7C3AED 8%, transparent)` treatment as `SupportModal`'s done-state).
2. Header: `Payment Successful — {planName}`.
3. "Price" line-group: `Plan price` → `base`, `GST (18%)` → `tax`, then a visually-heavier divider line `Total paid` → `total`.
4. Divider.
5. "Credits" line-group:
   - If `bonusPercent` is set: `Plan credits` → `baseCredits`, `Bonus credits (+{bonusPercent}%)` → `+{bonusCredits}`, then `Total credited` → `totalCredits` in bold `C.pink` text (the one visual accent in an otherwise plain black-and-white receipt — draws the eye to the payoff number without introducing a new gradient-text technique).
   - If `bonusPercent` is null: single line, `Credits added` → `totalCredits`, same bold `C.pink` treatment.
6. One primary button, full-width-ish, `grad` background (matches `SupportModal`'s submit button style): `Continue`. `onClick`: `router.push('/catalogues')` then `onClose()`.

No auto-dismiss timer. Backdrop click and Escape both call `onClose()` only (same as clicking X) — they do **not** trigger navigation. Only the explicit "Continue" button navigates.

**Error body:**
1. Tinted circle with a `!` glyph (same treatment as the success ✓, but tinted with the existing error color already in this codebase, `#DC2626`, seen in `SupportModal.tsx:367` — deliberately not an X, to avoid visual confusion with the corner close button).
2. `message` text, unchanged copy from today.
3. Two buttons side by side, same styling as `SupportModal`'s Cancel/Submit pair: secondary outline **Close** (`onClose()` only), primary `grad` **Try Again** (`onRetry()` then `onClose()`).

Backdrop click and Escape both call `onClose()` — never `onRetry()`; retry must be an explicit button click.

### 3.4 Wiring into the three layouts

`Desktop.tsx`, `Mobile.tsx`, `Tablet.tsx` each currently destructure `toast` from the hook and render the inline `<div>` at `Desktop.tsx:1360-1377` (and equivalents). Each changes to:
- destructure `paymentResult` instead of `toast`
- replace the inline `<div>` block with:
  ```tsx
  {paymentResult && (
    <PaymentResultModal result={paymentResult} onClose={() => setPaymentResult(null)} />
  )}
  ```

This deletes three duplicated ~18-line inline blocks in favor of one shared component — net code reduction despite the richer UI.

## 4. Error handling / edge cases

- Razorpay-modal-user-dismissed (`ondismiss` → `reject(new Error('dismissed'))`, caught at `:337`): stays completely silent, no modal — this is a user-initiated cancel, not a failure worth interrupting them over. Unchanged from today.
- Double-submit protection: unchanged — `if (buying) return` at the top of `buy()`, `buying` reset in `finally`. "Try Again" is just another call to `buy(plan)` and goes through the same guard.
- If `firstPurchaseBonusPercent` was non-null when `buy()` started but the backend's own eligibility check (`payments/routes.ts`'s `grantPurchaseCredits`) disagrees by the time `/v1/payments/verify` responds (e.g. a second concurrent purchase completed first) — `creditsGranted` from the response is still the source of truth for `totalCredits`/`bonusCredits`; the modal never recomputes the bonus itself, it only ever displays what the backend actually granted. This matches the existing Razorpay-description-line behavior, which has the same limitation today and is out of scope for this change.
- Non-IN currencies: `displayBase`/`displayTax`/`displayTotal` already handle currency conversion + GST at a flat 18% regardless of country (existing behavior, unchanged) — the modal just displays whatever these helpers return, same as the pricing cards do today.

## 5. Explicitly out of scope

- No changes to `/v1/payments/orders`, `/v1/payments/verify`, or any other backend route — all data needed already exists.
- No changes to the Razorpay checkout modal's own `description` line (`:307-309`).
- No animation library or new dependency — reuses `SupportModal`'s existing inline-style + `useEffect` focus-trap pattern.
- No auto-dismiss timer on the success modal (explicitly decided against, to give the user time to actually read the breakdown — this was the whole point of the redesign).
