# Gartex Expo QR Signup Campaign — 25% Bonus Credits

**Status:** Approved design, not yet implemented.
**Date:** 2026-08-01

## 1. Problem Statement

Tryme is running a demo booth at the Gartex Expo in Delhi, Aug 6–8, 2026. A QR code at the booth will point visitors at the catalogues-web signup page. Anyone who signs up via that QR code should get two bonuses that ordinary signups don't get:

1. **+25% credits on the first plan they purchase** (e.g. a 100-credit plan grants 125).
2. **+25% on the free signup-bonus credits** every new user already gets.

The bonus must be scoped *only* to QR-sourced signups — a normal signup (no QR) gets today's behavior unchanged. The campaign needs to be creatable/editable from the admin panel (code, bonus %, date window, active flag) so future in-person events can reuse the same mechanism without a deploy.

## 2. Current State (verified against code)

Two existing credit-grant points, both already keyed off a "reason" ledger convention (`creditLedger.reason`, freeform `text`, no enum — confirmed via `apps/api/src/modules/admin/credit-analysis.routes.ts:240`, which just displays whatever string is stored):

**Free signup credits (`FREE_TRIAL`)** — granted once, at *profile completion*, not at registration:
- Email/password path: `POST /v1/auth/register` (`apps/api/src/modules/auth/routes.ts:328-360`) creates the user with `userCredits.balance = 0` and no ledger row. The actual `FREE_TRIAL` grant happens later, in `PATCH /v1/me` (`apps/api/src/modules/auth/routes.ts:571-696`), gated on `phone` + `email` both being present (`routes.ts:665`, `const complete = ...`). The web app enforces this via a phone-completion modal (`apps/catalogues-web/src/components/profile-completion-modal.tsx` + `profile-gate.tsx`) shown right after signup. The amount comes from `credit_plans` where `slug = 'free'` (`routes.ts:668-672`).
- Google OAuth path: `google-upsert.ts`'s `resolveFreeCredits()` (`apps/api/src/modules/auth/google-upsert.ts:11-17`) reads the same `free` plan row, and `upsertGoogleUser()`'s brand-new-account branch (`google-upsert.ts:78-106`) grants it immediately at account creation (no phone gate — Google accounts are pre-verified).

**Purchase credits (`PAYMENT`)** — granted in `POST /v1/payments/verify` (`apps/api/src/modules/payments/routes.ts:166-278`) and mirrored in the Razorpay webhook handler (`payments/routes.ts:284-437`). Both do: conditional `UPDATE payments SET status='paid' WHERE status='created'` (race guard — only one caller wins), then credit `payment.credits` (== `plan.credits` at order-creation time) to `userCredits`, insert one `creditLedger` row with `reason: 'PAYMENT'`, and promote `users.tier` to the plan slug. The two call sites already duplicate this block near-verbatim.

Nothing in the codebase today tracks *where* a signup came from for the purpose of crediting bonuses. (`merchants.signup_source`, added in migration `0134_merchant_signup_source.sql`, is an unrelated concept — a plain `admin | android_google` enum for merchant onboarding-channel analytics, not a credit-bonus mechanism, and lives on a different table.)

## 3. Design

### 3.1 Data model

New table, `packages/db/src/schema/campaigns.ts`:

```ts
export const signupCampaigns = pgTable('signup_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(), // matches the ?src= value on the signup URL
  name: text('name').notNull(), // admin-facing label, e.g. "Gartex Expo Delhi 2026"
  bonusPercent: integer('bonus_percent').notNull(), // applied to both free-credit and first-purchase grants
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`users` (`packages/db/src/schema/users.ts`) gets one new nullable column, added the same way `packages/db/src/schema/users.ts` already imports sibling tables (`kioskDevices`, `merchants`) — import `signupCampaigns` from `./campaigns.js`:

```ts
signupCampaignId: uuid('signup_campaign_id').references(() => signupCampaigns.id, { onDelete: 'set null' }),
```

Set exactly once, at signup, never updated afterward. This is deliberate: it's what both bonus grants key off later, so a user's attribution must survive the campaign itself being deactivated or its date window passing (the campaign row is only checked *at signup time*, not at grant time).

`packages/db/src/schema/index.ts` needs the new `campaigns.ts` re-exported alongside the other schema files (follow the existing pattern in that file).

Migration: per `CLAUDE.md`'s migration-index rule, check `_journal.json` for the current head immediately before creating this migration (`0136_merchant_demo_data.sql` / idx 136 as of this writing) and number sequentially from there — do not hardcode `0137` if the branch has moved on.

### 3.2 Attribution — who gets tagged, and how

The QR points at `https://app.tryme.com/register?src=gartex2026` (or whatever `code` the admin sets — see 3.5).

**Email/password** (`apps/catalogues-web/src/app/(auth)/register/page.tsx`):
- Read `src` from the URL via `useSearchParams()`.
- Add `signupSource: z.string().max(64).optional()` to `RegisterBody` (`packages/types/src/auth.ts:2-11`).
- Include it in the `onSubmit` POST body (`register/page.tsx:105-127`) when present.
- The BFF route (`apps/catalogues-web/src/app/api/auth/register/route.ts`) already forwards the whole JSON body verbatim — no change needed there.
- `POST /v1/auth/register` (`auth/routes.ts:328-360`) resolves `signupSource` against `signup_campaigns`: must exist, `isActive = true`, and `now` between `startAt` and `endAt`. Match → store the campaign's `id` in `users.signupCampaignId` on insert. No match (wrong/expired/unknown code, or no `src` at all) → `signupCampaignId` stays `null`, registration proceeds identically to today. Never surface a distinct error for an invalid code — a wrong code is indistinguishable from "no code" to the caller.

**Google OAuth** (mirrors the existing `next` param round-trip exactly):
- `GoogleBtn` (`apps/catalogues-web/src/components/ui/google-btn.tsx`) gains an optional `src` prop; the register page passes its own `src` query param through to it.
- `GET /v1/auth/google/init` (`google.routes.ts:27-63`) accepts `&src=`, and — mirroring the existing `google_next` cookie (`google.routes.ts:46-55`) exactly, same `httpOnly`/`sameSite`/`maxAge`/`path` — sets a `google_src` cookie.
- `GET /v1/auth/google/callback` (`google.routes.ts:66-129`) reads `google_src` back (mirrors `google_next` at line 70), resolves it against `signup_campaigns` the same way as the register route, and passes the resolved campaign id into `upsertGoogleUser()`.
- `upsertGoogleUser()` (`google-upsert.ts:27-133`) gains a new parameter, `campaignId: string | null`, used **only** in the brand-new-account branch (`google-upsert.ts:78-93`, the `else` that runs when there's no existing OAuth link and no email match) — set on the `users` insert. The existing-link (case 1) and link-by-email (case 2) branches never touch it — attribution is signup-only, never retroactively applied to an existing account signing in with Google for the first time.

### 3.3 Free-credit boost

Both `FREE_TRIAL` grant sites gain the same shape of change: look up the user's `signupCampaignId`; if set, join to `signup_campaigns` for `bonusPercent` and compute `freeCredits = Math.round(baseFreeCredits * (1 + bonusPercent / 100))` instead of the plain base amount. The ledger `reason` stays `'FREE_TRIAL'` — it's the same grant, just a bigger number; there's no separate bonus event to distinguish here (unlike the purchase case, see 3.4).

- `PATCH /v1/me` (`auth/routes.ts:668-691`): already runs inside a transaction (`tx`) with `req.userId` available — add a `select` on `users.signupCampaignId` (can be combined with the existing `updated` row returned from the `UPDATE ... RETURNING` at `routes.ts:640-662` by adding `signupCampaignId` to that `returning()` list, avoiding an extra query).
- `google-upsert.ts` new-account branch (`google-upsert.ts:93-105`): the caller (`google.routes.ts:108`, and the analogous native `/v1/auth/device-login/google` route) already computes `freeCredits` via `resolveFreeCredits(app)` *before* calling `upsertGoogleUser`, i.e. before it's known whether this will turn out to be a brand-new account. That's fine to leave as-is: pass the *campaign-boosted* `freeCredits` value unconditionally (computed from the already-resolved `campaignId` from the cookie) — it's only ever read inside the new-account branch, so boosting it has no effect on the existing-link/link-by-email branches. Add a small helper, `resolveFreeCredits(app, campaignId: string | null)`, that does the boost math when `campaignId` is non-null.

  Note: the native `/v1/auth/device-login/google` route (Android app) has no QR/`src` concept — call it with `campaignId: null` there, unchanged behavior.

### 3.4 First-purchase boost

Unlike the free-credit case, this needs its own ledger line (`reason: 'CAMPAIGN_BONUS'`) so it's auditable separately from the base plan credit — `credit-analysis.routes.ts` already displays ledger rows generically by `reason` (`credit-analysis.routes.ts:240`), so this needs no changes there to show up correctly.

Both `POST /v1/payments/verify` (`payments/routes.ts:217-261`, inside the transaction) and the webhook handler (`payments/routes.ts:357-399`) already duplicate the grant block near-identically. Extract a single local helper in `payments/routes.ts`, e.g.:

```ts
async function grantPurchaseCredits(
  tx: DbOrTx,
  userId: string,
  payment: { id: string; planId: string; credits: number },
): Promise<void> {
  // base PAYMENT grant (existing logic, moved here unchanged)
  ...
  // first-purchase campaign bonus
  const [priorPaid] = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(
      eq(schema.payments.userId, userId),
      eq(schema.payments.status, 'paid'),
      ne(schema.payments.id, payment.id),
    ))
    .limit(1);
  if (priorPaid) return; // not their first purchase — no bonus

  const [user] = await tx
    .select({ campaignId: schema.users.signupCampaignId })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user?.campaignId) return;

  const [campaign] = await tx
    .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
    .from(schema.signupCampaigns)
    .where(eq(schema.signupCampaigns.id, user.campaignId));
  if (!campaign) return;

  const bonus = Math.round(payment.credits * (campaign.bonusPercent / 100));
  if (bonus <= 0) return;

  await tx.update(schema.userCredits)
    .set({ balance: sql`${schema.userCredits.balance} + ${bonus}`, updatedAt: new Date() })
    .where(eq(schema.userCredits.userId, userId));
  await tx.insert(schema.creditLedger)
    .values({ userId, delta: bonus, reason: 'CAMPAIGN_BONUS' });
}
```

Call it from both `/verify` (replacing `payments/routes.ts:238-254`) and the webhook (replacing `payments/routes.ts:377-393`), after each site's existing conditional `UPDATE payments SET status='paid' WHERE status='created'` has confirmed *this* call won the race (`updated.length > 0` — `routes.ts:232-234` and `:371-373`). The `priorPaid` check runs inside that same already-guarded transaction, so there's no separate race window: two concurrent purchases from the same brand-new user can't both see zero prior paid payments, because the second one's transaction can't start its own `priorPaid` select until the first transaction (which flips this payment's own row to `paid` before returning) commits — Postgres's read-committed default is sufficient here since each purchase is a distinct `payments` row with its own `status='created'→'paid'` guard serializing entry into this helper.

Applies once — to whichever of this user's plan purchases clears first. Not gated by the campaign's date window or `isActive` flag (per 3.1, attribution is permanent at signup); a user who signs up during the expo and purchases a plan a month later still gets the bonus on that first purchase.

### 3.5 Admin CRUD + UI

New file `apps/api/src/modules/admin/signupCampaigns.routes.ts`, structurally identical to `apps/api/src/modules/admin/creditPlans.routes.ts`: `requireAdmin(['SUPER_ADMIN'])` guard, inline Zod body schema, `GET/POST/PATCH/DELETE /admin/signup-campaigns`. Fields: `code` (regex-validated lowercase-alnum-hyphen like `creditPlans`' `slug`), `name`, `bonusPercent` (`z.number().int().min(0).max(100)`), `startAt`/`endAt` (`z.coerce.date()`), `isActive`. `DELETE` should block (409) if any `users.signupCampaignId` references the row — same pattern as `creditPlans.routes.ts:107-118` blocking deletion of a plan with users still on it — deactivate instead.

Register in `apps/api/src/server.ts` next to `adminCreditPlansRoutes` (`server.ts:312`).

Admin UI: new `SignupCampaign` interface in `apps/admin-web/src/types.ts` (mirrors `CreditPlan`, `types.ts:313-328`). New tab in `apps/admin-web/src/pages/SettingsPage.tsx`: add `'signup-campaigns'` to the `SettingsSection` union (`SettingsPage.tsx:28`) and to `SETTING_SECTIONS` (`SettingsPage.tsx:30-36`), then a list + create/edit modal following the existing `PlanModal` pattern (`SettingsPage.tsx:61+`) — table of code/name/bonus%/window/active, modal form for the same fields.

### 3.6 Seeding the actual campaign

This design does not include a data migration seeding the `gartex2026` row — per the admin-configurable decision, whoever runs the campaign creates it through the new admin UI after this ships (code `gartex2026`, name "Gartex Expo Delhi 2026", `bonusPercent: 25`, `startAt`/`endAt` spanning Aug 6–8, 2026 IST, `isActive: true`). The physical QR code should not be printed/finalized until that row exists and has been smoke-tested end-to-end (see 5).

## 4. Edge cases & invariants

- **Unknown/expired/inactive code** → silent no-op attribution, normal signup. Never a distinct error response (avoids leaking which codes are valid).
- **Campaign deactivated or window lapses after signup** → already-attributed users keep their bonus eligibility for both the free-credit grant (if not yet claimed — profile completion could happen after the campaign ends) and their first purchase (no deadline). Only the *signup-time* check is gated by `isActive`/window.
- **Double-submit race on `/verify` + webhook for the same payment** → already handled by the existing `status='created'` conditional-update guard; the new bonus logic sits inside the same transaction, so it can't double-grant (see 3.4).
- **User's second, third, ... purchase** → no bonus; `priorPaid` check in 3.4 catches it.
- **`bonusPercent` change on an active campaign after some users already signed up but haven't purchased yet** → their first-purchase bonus uses whatever `bonusPercent` is on the campaign row *at purchase time* (3.4 reads it live), not what it was at signup. Acceptable — the free-credit bonus, by contrast, is computed once at profile-completion time and never recomputed.
- **Abuse (fake signups farming `?src=gartex2026` for free credits)** — not a new attack surface; it's the existing `FREE_TRIAL` abuse surface (register rate limit already 10/min, `FREE_TRIAL` already requires phone-number profile completion for the email/password path). No new anti-fraud work in this design.

## 5. Testing plan

New Vitest integration tests (existing harness — fresh Postgres DB per file, `pnpm docker:up` running):

- Register with a valid `src` → `users.signupCampaignId` set correctly.
- Register with unknown/expired/inactive `src` → `signupCampaignId` null, 201 response unchanged.
- `PATCH /v1/me` profile completion for a campaign-attributed user → `FREE_TRIAL` ledger delta is `baseFreeCredits * 1.25` (rounded), not the base amount.
- Google callback with `google_src` cookie set on a brand-new account → same boosted `FREE_TRIAL`; existing-account Google login with the cookie set → no attribution, no boost.
- First plan purchase for a campaign-attributed user → two ledger rows (`PAYMENT` for `plan.credits`, `CAMPAIGN_BONUS` for the 25% bonus); balance reflects both.
- Second purchase by the same user → only `PAYMENT`, no second `CAMPAIGN_BONUS` row.
- Purchase by a non-attributed user → unchanged today's behavior, no `CAMPAIGN_BONUS` row ever.
- Admin CRUD: create/edit/deactivate a campaign; delete blocked (409) once a user references it.

Manual smoke test before the QR is printed: create the real campaign row via the admin UI staging environment, walk through `?src=gartex2026` → register → complete profile → verify boosted `FREE_TRIAL` → purchase a plan → verify `PAYMENT` + `CAMPAIGN_BONUS` both land.

## 6. Out of scope

- Any new anti-fraud/rate-limiting beyond what already exists on signup.
- A distinct `bonusPercent` for the free-credit grant vs. the purchase grant (single field drives both, per the original ask — both are 25%).
- Campaign-level analytics/reporting UI beyond what `credit-analysis.routes.ts` already surfaces generically by ledger `reason`.
- Threading campaign attribution through `/v1/auth/device-login/google` (native Android) — QR-driven signups are web-only for this campaign.
