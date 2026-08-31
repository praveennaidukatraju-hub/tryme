# Unify Free Plan into Credit Plans

**Date:** 2026-07-02
**Status:** approved

## Problem

Currently two separate systems control "what a user gets":

1. **Credit Plans tab** (DB `credit_plans` table) — manages paid plans (starter, growth, business) with slug, credits, price, queueStream.
2. **System Config tab** (Redis `config:system`) — manages `freeTrialCredits` (one-time credits for new signups).

These live in separate admin UI tabs, stored in separate backends (DB vs Redis). This also creates ambiguity: users have a `tier` column that defaults to `'FREE'` (a tier concept) but gets overwritten with a plan slug (like `'starter'`) on payment — so the column has two different semantic meanings.

## Goal

Make the free plan a real `credit_plans` row. Every user's `tier` is always a valid `credit_plans.slug`. Single source of truth for what credits a plan grants, whether free or paid.

## Design

### Database

**Migration: seed free plan**

```sql
INSERT INTO credit_plans (slug, name, subtext, credits, base_paise, is_active, is_highlighted, badge, sort_order, queue_stream)
VALUES ('free', 'Free', 'Default plan for new users', 0, 0, true, false, null, 0, 'normal');
```

**Migration: normalize existing users**

```sql
UPDATE users SET tier = 'free' WHERE tier = 'FREE';
```

No new columns. The free plan is identified by `slug = 'free'` convention — the credit plans
API enforces immutability of this row (cannot delete, cannot change slug).

### API Changes

#### Signup (`auth/routes.ts`)

Before:
```ts
const configRaw = await app.redis.get('config:system');
const freeTrialCredits = JSON.parse(configRaw).freeTrialCredits ?? 0;
```

After:
```ts
const [freePlan] = await app.db
  .select({ credits: schema.creditPlans.credits })
  .from(schema.creditPlans)
  .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
const freeCredits = freePlan?.credits ?? 0;
```

User insert also explicitly sets `tier: 'free'` instead of relying on DB default.

#### Credit Plans Admin (`creditPlans.routes.ts`)

DELETE: also block if `plan.slug === 'free'` (return 409). Free plan is undeletable.

PATCH: block changing `slug` of the free plan (return 400).

#### System Config (`config.routes.ts`)

Remove `freeTrialCredits` from the Redis key shape. Keep `creditCostPerJob`, `maxJobsPerDay`, `resolutions`.

#### User Management (`users.routes.ts`)

Change tier validation from `z.enum(['FREE', 'PRO'])` to dynamic slug validation:
- `PATCH /admin/users/:id`: tier value validated against active credit_plans slugs at request time.
- Also update `packages/types/src/admin.ts` `BulkGrantBody` and `UpdateUserBody`.

### Types (`packages/types/src/admin.ts`)

Remove `freeTrialCredits` from `SystemConfigBody`. Update `BulkGrantBody` and `UpdateUserBody` tier validation from hardcoded enum to `z.string()` (API route handles existence check).

### Admin Web Frontend

**SettingsPage.tsx System tab:** Remove the freeTrialCredits number input.

**SettingsPage.tsx Credit Plans tab:** Add a "Free Plan" editor section (non-deletable, slug locked). Shows `credits` and `queueStream` fields. Allows the admin to change how many free credits new users get and what queue priority they receive — without touching System Config.

**UsersPage.tsx (admin):** Tier dropdown fetches `credit_plans.slug` values from `/admin/credit-plans` instead of using a hardcoded FREE/PRO enum.

### Catalogues Web Frontend

**Pricing page (`(app)/pricing/page.tsx`):** Filter out `plan.slug === 'free'` from the plan cards — the free plan shouldn't appear as a purchasable upgrade.

### Signup Flow (after)

```
User registers
  → INSERT users WITH tier = 'free'
  → SELECT credit_plans WHERE slug = 'free'
  → IF plan.credits > 0 THEN grant credits and insert ledger entry
```

No Redis `config:system` involvement. The admin changes the free plan's `credits` column to adjust what new users receive.

### What Stays the Same

- `creditCostPerJob`, `maxJobsPerDay`, `resolutions` remain in Redis `config:system` / System tab — these are system-wide operational configs, not plan attributes.
- Payment promotion still sets `users.tier = payment.planId` (e.g., `'starter'`).
- `jobs/create.ts` join `users.tier = credit_plans.slug` now always matches a row (no more fallback to `'normal'`).
- Google OAuth signup also sets `tier = 'free'` and grants free credits from the plan row.

## Trade-offs

- **Free plan in the CRUD table means it's "plan-like" even though nobody buys it.** The pricing page filters it out, and the admin UI handles it specially (non-deletable slug). If this gets confusing, a future iteration could add `isPurchasable` boolean to `credit_plans`.
- **Removing `freeTrialCredits` from Redis means the free credits value lives only in the DB.** Fine — it's not hot-path config, no caching needed.
- **Migration updates all `FREE` users to `free`.** If the free plan row doesn't exist yet, the migration must run AFTER the seed. The migration runner applies them in order.

## Post-implementation gap fixes (2026-07-02, migration 0080)

Post-review of the shipped implementation found the "tier always matches a valid `credit_plans.slug`" goal wasn't actually enforced. Fixed:

- **No DB constraint backed the invariant.** Added `FOREIGN KEY (tier) REFERENCES credit_plans(slug) ON DELETE RESTRICT` in `0080_users_tier_fk_credit_plans.sql`, after normalizing any orphaned tier values to `'free'`.
- **Deleting a paid plan with active users on it was only blocked if it had payments**, not if users' `tier` pointed to it via bulk-grant or manual admin edit. `creditPlans.routes.ts` DELETE now checks `users.tier` directly (409) in addition to the payments check.
- **Deactivating the free plan (`isActive: false`) was unguarded** — only slug-change and delete were blocked — which would have silently zeroed out free-signup credits with no warning. Now blocked (403) in the PATCH handler.
