# Shopify Credit Wallet — Phase 2: Low-Balance Alerting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a Shopify merchant they are about to run out of credits, in time to do something about it, through both the embedded admin and email.

**Architecture:** A merchant's runway is computed from what they actually spent — the trailing 7-day sum of `jobs.credits_charged` — rather than from a flat credit threshold, because a flat threshold cannot be right for both an 800-credit and a 10,000-credit balance. An hourly scheduler evaluates every store, and emails only when the alert level gets *worse* than the last one recorded, so a merchant sitting at "warning" for a week receives one email, not 168. The same computation is returned by `/v1/shopify/me` so the SPA can render banners without a second endpoint.

**Tech Stack:** Fastify 5, Drizzle ORM on PostgreSQL 16, Resend (via `apps/api/src/lib/mailer.ts`), Vitest, React + Polaris.

**Spec:** `docs/superpowers/specs/2026-08-19-shopify-credit-wallet-design.md` § "Low-balance alerting"

**Depends on:** Phase 1 (`docs/superpowers/plans/2026-08-19-shopify-credit-wallet-phase1.md`) must be merged first. This plan assumes `billing-scheduler.ts` and `subscription-client.ts` are already deleted, `/v1/shopify/me` no longer returns `planHandle` / `subscriptionStatus` / `billingMode`, and `shopify_credit_purchases` exists.

## Global Constraints

- **Package manager is pnpm.** Never introduce npm or yarn lockfiles.
- **ESM only** — relative imports inside a package carry the `.js` extension.
- **No `console.log`.** Use `app.log` with child loggers bound to `storeId`.
- **Never send a merchant more than one email per level change.** The whole feature is worthless if it becomes noise the merchant filters.
- **Never block job creation on alerting.** Alerting is observational; a failure in it must never refuse a shopper's try-on.
- **Zero balance must not lock the embedded admin.** A merchant at zero can still legitimately manage products, view analytics, and edit widget design, and the actual failure is on the storefront. Blocking the whole app punishes them for a billing state they are in the middle of fixing.
- **A merchant who has never run a job is not "low" — they are onboarding.** Never alert a store with zero lifetime jobs.
- **No schema or data changes against production.** Migrations run locally, then through CI/CD.
- **Secrets discipline:** never print a credential. `RESEND_API_KEY` is passed by name into the mailer, never logged.
- **Alert thresholds (exact):** `warning` under 7 days of runway, `critical` under 2 days, `empty` at a zero balance.
- **Cold-start fallback (no spend in the trailing window):** `critical` under 50 credits, `warning` under 200 credits, `ok` otherwise.
- **A try-on costs 5 credits** (`SIMPLE_TRYON_COST`) — always derive try-on counts from it, never hardcode.
- **Unit tests:** `pnpm --filter @tryme/api test:unit`
- **Integration tests:** from `apps/api`, `npx vitest run --config vitest.integration.config.ts <pattern>` — requires `pnpm docker:up`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/api/src/modules/shopify/runway.ts` | Burn-rate and alert-level computation. The single definition of "low". |
| `apps/api/src/modules/shopify/runway.test.ts` | Threshold and cold-start unit tests. |
| `apps/api/src/modules/shopify/alert-scheduler.ts` | Hourly tick: evaluate, escalate, email, record. |
| `packages/db/src/migrations/0161_shopify_alerting.sql` | `shop_email`, `last_alert_level`, `last_alert_at`. |
| `apps/api/test/integration/shopify-alerting.test.ts` | Escalation, de-duplication, and recovery behaviour. |

**Modified**

| File | Change |
|---|---|
| `packages/db/src/schema/shopify.ts` | Three new columns on `shopify_stores`. |
| `apps/api/src/modules/shopify/auth.routes.ts` | Persist `shop.email`, which is already fetched and currently discarded. |
| `apps/api/src/lib/mailer.ts` | `sendLowCreditsEmail`. |
| `apps/api/src/modules/shopify/me.routes.ts` | Return the runway block. |
| `apps/api/src/main.ts` | Start the alert scheduler. |
| `apps/shopify/src/types.ts` | `runway` on `ShopifyMe`. |
| `apps/shopify/src/pages/DashboardPage.tsx` | Runway banner. |
| `apps/shopify/src/pages/PricingPage.tsx` | Runway detail on the balance card. |

---

### Task 1: Runway computation

**Files:**
- Create: `apps/api/src/modules/shopify/runway.ts`
- Create: `apps/api/src/modules/shopify/runway.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `schema.shopifyStoreCredits`; `SIMPLE_TRYON_COST` from `@tryme/types`.
- Produces:
  - `type AlertLevel = 'ok' | 'warning' | 'critical' | 'empty'`
  - `ALERT_LEVEL_RANK: Record<AlertLevel, number>`
  - `interface Runway { balance: number; tryOnsRemaining: number; dailyBurnCredits: number; daysRemaining: number | null; level: AlertLevel; lifetimeJobs: number }`
  - `deriveLevel(input: { balance: number; dailyBurnCredits: number; lifetimeJobs: number }): { level: AlertLevel; daysRemaining: number | null }`
  - `computeRunway(app: FastifyInstance, storeId: string): Promise<Runway>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/shopify/runway.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALERT_LEVEL_RANK, deriveLevel } from './runway.js';

describe('deriveLevel', () => {
  it('is empty at a zero balance regardless of burn', () => {
    expect(deriveLevel({ balance: 0, dailyBurnCredits: 100, lifetimeJobs: 50 }).level).toBe('empty');
    expect(deriveLevel({ balance: 0, dailyBurnCredits: 0, lifetimeJobs: 50 }).level).toBe('empty');
  });

  it('is ok with plenty of runway', () => {
    // 1000 credits at 50/day = 20 days
    const result = deriveLevel({ balance: 1000, dailyBurnCredits: 50, lifetimeJobs: 100 });
    expect(result.level).toBe('ok');
    expect(result.daysRemaining).toBe(20);
  });

  it('warns under seven days of runway', () => {
    // 300 credits at 50/day = 6 days
    expect(deriveLevel({ balance: 300, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe(
      'warning',
    );
  });

  it('is critical under two days of runway', () => {
    // 75 credits at 50/day = 1.5 days
    expect(deriveLevel({ balance: 75, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe(
      'critical',
    );
  });

  it('treats exactly seven days as ok, not warning', () => {
    // Boundary is strict: the merchant has a full week, which is the point.
    expect(deriveLevel({ balance: 350, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe('ok');
  });

  // A store that has never generated anything is onboarding, not running dry.
  // Alerting it would make the very first thing we email a merchant a warning
  // about a problem they don't have.
  it('never alerts a store with no lifetime jobs', () => {
    const result = deriveLevel({ balance: 25, dailyBurnCredits: 0, lifetimeJobs: 0 });
    expect(result.level).toBe('ok');
    expect(result.daysRemaining).toBeNull();
  });

  describe('cold start — has run jobs, but none in the trailing window', () => {
    it('reports no runway estimate rather than infinity', () => {
      expect(deriveLevel({ balance: 500, dailyBurnCredits: 0, lifetimeJobs: 10 }).daysRemaining)
        .toBeNull();
    });

    it('falls back to absolute credits', () => {
      expect(deriveLevel({ balance: 500, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe('ok');
      expect(deriveLevel({ balance: 199, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe(
        'warning',
      );
      expect(deriveLevel({ balance: 49, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe(
        'critical',
      );
    });
  });

  it('ranks levels so escalation can be compared numerically', () => {
    expect(ALERT_LEVEL_RANK.ok).toBeLessThan(ALERT_LEVEL_RANK.warning);
    expect(ALERT_LEVEL_RANK.warning).toBeLessThan(ALERT_LEVEL_RANK.critical);
    expect(ALERT_LEVEL_RANK.critical).toBeLessThan(ALERT_LEVEL_RANK.empty);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test:unit -- runway`
Expected: FAIL — `Cannot find module './runway.js'`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/shopify/runway.ts`:

```ts
import { schema } from '@tryme/db';
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { and, count, eq, gte, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * How close a store is to running out. Ordered — see ALERT_LEVEL_RANK — so the
 * scheduler can ask "is this worse than what we last told them?" numerically
 * rather than with a chain of comparisons that would need editing every time a
 * level is added.
 */
export type AlertLevel = 'ok' | 'warning' | 'critical' | 'empty';

export const ALERT_LEVEL_RANK: Record<AlertLevel, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  empty: 3,
};

/** Days of runway at or below which each level starts. */
const WARNING_DAYS = 7;
const CRITICAL_DAYS = 2;

/**
 * Absolute-credit fallbacks, used only when there is no spend in the trailing
 * window to divide by. 200 credits is 40 try-ons and 50 is 10 — deliberately
 * generous, because a store with no recent activity is the one most likely to
 * get a burst it hasn't planned for.
 */
const COLD_START_WARNING_CREDITS = 200;
const COLD_START_CRITICAL_CREDITS = 50;

/** Trailing window the burn rate is averaged over. */
export const BURN_WINDOW_DAYS = 7;

export interface Runway {
  balance: number;
  tryOnsRemaining: number;
  /** Trailing-window average, credits per day. Zero when nothing was spent. */
  dailyBurnCredits: number;
  /** Null when there is no burn to divide by — never Infinity. */
  daysRemaining: number | null;
  level: AlertLevel;
  lifetimeJobs: number;
}

/**
 * The single definition of "low". Pure, so the thresholds are testable without
 * a database — which matters because these numbers are the whole feature and a
 * regression in them is silent.
 *
 * A flat credit threshold was rejected: 50 credits is 10 try-ons, which against
 * a 10,000-credit balance is no warning at all, and against an 800-credit one
 * is constant noise.
 */
export function deriveLevel(input: {
  balance: number;
  dailyBurnCredits: number;
  lifetimeJobs: number;
}): { level: AlertLevel; daysRemaining: number | null } {
  const { balance, dailyBurnCredits, lifetimeJobs } = input;

  if (balance <= 0) return { level: 'empty', daysRemaining: 0 };

  // A store that has never run a job is mid-onboarding. Its balance is the
  // free-tier grant and it has no spend history to judge against, so any alert
  // here is about a problem the merchant does not yet have.
  if (lifetimeJobs === 0) return { level: 'ok', daysRemaining: null };

  if (dailyBurnCredits <= 0) {
    // Ran jobs at some point, but nothing in the trailing window. There is no
    // rate to divide by, so daysRemaining stays null rather than becoming
    // Infinity, and the level comes from absolute credits instead.
    if (balance < COLD_START_CRITICAL_CREDITS) return { level: 'critical', daysRemaining: null };
    if (balance < COLD_START_WARNING_CREDITS) return { level: 'warning', daysRemaining: null };
    return { level: 'ok', daysRemaining: null };
  }

  const daysRemaining = balance / dailyBurnCredits;
  if (daysRemaining < CRITICAL_DAYS) return { level: 'critical', daysRemaining };
  if (daysRemaining < WARNING_DAYS) return { level: 'warning', daysRemaining };
  return { level: 'ok', daysRemaining };
}

/**
 * Burn is the trailing-window sum of what was actually charged, not a job
 * count times an assumed price — `jobs.credits_charged` is the real number and
 * survives an admin retuning `tryon.creditCost` mid-window.
 *
 * FAILED jobs are excluded because they are refunded, so their net spend is
 * zero; counting them would overstate burn and warn merchants early on the
 * strength of work they were never billed for.
 *
 * Uses the existing `jobs_shopify_store_created_idx` on
 * (shopify_store_id, created_at) — no new index required.
 */
export async function computeRunway(app: FastifyInstance, storeId: string): Promise<Runway> {
  const windowStart = new Date(Date.now() - BURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [creditRow] = await app.db
    .select({ balance: schema.shopifyStoreCredits.balance })
    .from(schema.shopifyStoreCredits)
    .where(eq(schema.shopifyStoreCredits.storeId, storeId))
    .limit(1);
  const balance = creditRow?.balance ?? 0;

  const [spendRow] = await app.db
    .select({
      spent: sql<number>`COALESCE(SUM(${schema.jobs.creditsCharged}), 0)::int`,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        ne(schema.jobs.status, 'FAILED'),
        gte(schema.jobs.createdAt, windowStart),
      ),
    );

  const [lifetimeRow] = await app.db
    .select({ n: count() })
    .from(schema.jobs)
    .where(eq(schema.jobs.shopifyStoreId, storeId));

  const dailyBurnCredits = (spendRow?.spent ?? 0) / BURN_WINDOW_DAYS;
  const lifetimeJobs = lifetimeRow?.n ?? 0;
  const { level, daysRemaining } = deriveLevel({ balance, dailyBurnCredits, lifetimeJobs });

  return {
    balance,
    tryOnsRemaining: Math.floor(balance / SIMPLE_TRYON_COST),
    dailyBurnCredits,
    daysRemaining,
    level,
    lifetimeJobs,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test:unit -- runway`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/runway.ts apps/api/src/modules/shopify/runway.test.ts
git commit -m "feat(shopify): burn-rate runway and alert-level computation"
```

---

### Task 2: Migration and shop-email persistence

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Create: `packages/db/src/migrations/0161_shopify_alerting.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `apps/api/src/modules/shopify/auth.routes.ts:56-86`

**Interfaces:**
- Consumes: `AlertLevel` (Task 1), stored as plain text.
- Produces: `shopifyStores.shopEmail`, `shopifyStores.lastAlertLevel`, `shopifyStores.lastAlertAt`.

**Note:** `shop { email }` is *already* fetched at install (`SHOP_DETAILS`, `auth.routes.ts:105`) and lands on `ShopDetails.email` — `upsertShopifyStore` simply discards it. No new GraphQL query and no scope change is needed; this task only stops throwing it away.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, add to `shopifyStores`, immediately before `createdAt`:

```ts
  // The shop owner's contact email, from shop.email at install. Already
  // fetched by SHOP_DETAILS and previously discarded. This is the only address
  // we can reach a merchant on: owner_user_id is nullable and ON DELETE SET
  // NULL, so it cannot be the basis for a billing notification.
  shopEmail: text('shop_email'),
  // The worst alert level we have already emailed this store about. The
  // scheduler emails only when the current level ranks worse than this, so a
  // merchant sitting at 'warning' for a week gets one email rather than 168.
  // Rewritten every tick regardless, so a store that recovers (bought credits)
  // is automatically eligible to be alerted again later.
  lastAlertLevel: text('last_alert_level'),
  lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
```

- [ ] **Step 2: Write the migration**

Create `packages/db/src/migrations/0161_shopify_alerting.sql`:

```sql
ALTER TABLE "shopify_stores" ADD COLUMN "shop_email" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "last_alert_level" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "last_alert_at" timestamp with time zone;
```

- [ ] **Step 3: Register it in the journal**

Append to `entries` in `packages/db/src/migrations/meta/_journal.json`:

```json
		{
			"idx": 161,
			"version": "7",
			"when": 1787065200000,
			"tag": "0161_shopify_alerting",
			"breakpoints": true
		}
```

- [ ] **Step 4: Persist the email in both upsert branches**

In `apps/api/src/modules/shopify/auth.routes.ts`, add `shopEmail: shop.email` to the UPDATE `.set({...})` (after `ianaTimezone`, line 63) and to the INSERT `.values({...})` (after `ianaTimezone`, line 81).

Refreshing it on every reinstall is deliberate: a merchant who changed their shop contact email should be reachable at the new one, and reinstall is the only moment we re-read it.

- [ ] **Step 5: Apply and verify**

```bash
pnpm docker:up
pnpm db:migrate
docker exec -i tryme-postgres psql -U postgres -d tryme -c "\d shopify_stores" | grep -E "shop_email|last_alert"
```

Expected: all three columns listed.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/0161_shopify_alerting.sql packages/db/src/migrations/meta/_journal.json apps/api/src/modules/shopify/auth.routes.ts
git commit -m "feat(db): persist shop email and alert state on shopify_stores"
```

---

### Task 3: Low-credits email

**Files:**
- Modify: `apps/api/src/lib/mailer.ts`

**Interfaces:**
- Consumes: `AlertLevel`, `Runway` (Task 1).
- Produces: `sendLowCreditsEmail(apiKey, from, to, params): Promise<void>` where `params` is `{ shopDomain: string; appUrl: string; level: 'warning' | 'critical' | 'empty'; balance: number; tryOnsRemaining: number; daysRemaining: number | null }`.

- [ ] **Step 1: Add the template and sender**

Append to `apps/api/src/lib/mailer.ts`:

```ts
function lowCreditsHtml(p: {
  appUrl: string;
  level: 'warning' | 'critical' | 'empty';
  balance: number;
  tryOnsRemaining: number;
  daysRemaining: number | null;
}): string {
  const accent = p.level === 'warning' ? '#b26a00' : '#b42318';
  const heading =
    p.level === 'empty'
      ? "You're out of try-on credits"
      : p.level === 'critical'
        ? 'Your try-on credits run out in about a day'
        : 'Your try-on credits are running low';

  // Only stated when there is a real burn rate behind it. Saying "about 0 days"
  // because nothing has been generated recently would be wrong and alarming.
  const runwayLine =
    p.daysRemaining != null && p.level !== 'empty'
      ? `<p style="font-size:14px;color:#555;margin:0 0 8px;">At your current rate that's about <strong>${Math.max(1, Math.round(p.daysRemaining))} more day${Math.round(p.daysRemaining) === 1 ? '' : 's'}</strong>.</p>`
      : '';

  const body =
    p.level === 'empty'
      ? 'Try-on has stopped for shoppers on your store. Adding credits turns it straight back on — nothing else needs reconfiguring.'
      : 'When your balance reaches zero, the try-on button stops working for shoppers on your store. Topping up now avoids that.';

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:${accent};padding:20px 32px;">
      <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0;">${heading}</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:14px;color:#555;margin:0 0 8px;">
        Your store has <strong style="color:#1a1a1a;">${p.balance.toLocaleString()} credits</strong> left —
        about <strong style="color:#1a1a1a;">${p.tryOnsRemaining.toLocaleString()} try-ons</strong>.
      </p>
      ${runwayLine}
      <p style="font-size:14px;color:#555;margin:16px 0 28px;">${body}</p>
      <a href="${p.appUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">Add credits</a>
      <p style="font-size:12px;color:#999;margin:32px 0 0;">Credits never expire — anything you buy stays on your account until you use it.</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendLowCreditsEmail(
  apiKey: string,
  from: string,
  to: string,
  params: {
    shopDomain: string;
    appUrl: string;
    level: 'warning' | 'critical' | 'empty';
    balance: number;
    tryOnsRemaining: number;
    daysRemaining: number | null;
  },
): Promise<void> {
  const subject =
    params.level === 'empty'
      ? `${params.shopDomain} is out of try-on credits`
      : params.level === 'critical'
        ? `${params.shopDomain}: try-on credits run out in about a day`
        : `${params.shopDomain}: try-on credits running low`;

  await send(apiKey, { from, to, subject, html: lowCreditsHtml(params) });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/mailer.ts
git commit -m "feat(api): low-credits notification email for Shopify merchants"
```

---

### Task 4: Alert scheduler

**Files:**
- Create: `apps/api/src/modules/shopify/alert-scheduler.ts`
- Create: `apps/api/test/integration/shopify-alerting.test.ts`
- Modify: `apps/api/src/main.ts`

**Interfaces:**
- Consumes: `computeRunway`, `ALERT_LEVEL_RANK`, `AlertLevel` (Task 1); `shopEmail` / `lastAlertLevel` / `lastAlertAt` (Task 2); `sendLowCreditsEmail` (Task 3); `buildPostInstallRedirect` from `./auth.routes.js`.
- Produces:
  - `runAlertTick(app: FastifyInstance, deps?: { sendEmail?: ... }): Promise<void>`
  - `startAlertScheduler(app: FastifyInstance, intervalMs?: number): () => void`

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/shopify-alerting.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAlertTick } from '../../src/modules/shopify/alert-scheduler.js';
import { buildTestApp } from '../helpers/api.js';
import { setupTestContainers, teardownTestContainers } from '../helpers/containers.js';

let ctx: Awaited<ReturnType<typeof setupTestContainers>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;
let sent: Array<{ to: string; level: string }>;

const deps = () => ({
  sendEmail: async (_app: unknown, args: { to: string; level: string }) => {
    sent.push({ to: args.to, level: args.level });
  },
});

/** Puts the store at a chosen balance with a burn history that yields `days` of runway. */
async function seedStore(balance: number, creditsSpentInWindow: number, jobCount = 3) {
  await app.db.delete(schema.jobs).where(eq(schema.jobs.shopifyStoreId, store.id));
  await app.db
    .insert(schema.shopifyStoreCredits)
    .values({ storeId: store.id, balance })
    .onConflictDoUpdate({
      target: schema.shopifyStoreCredits.storeId,
      set: { balance },
    });
  if (jobCount > 0) {
    const per = Math.floor(creditsSpentInWindow / jobCount);
    await app.db.insert(schema.jobs).values(
      Array.from({ length: jobCount }, () => ({
        shopifyStoreId: store.id,
        status: 'COMPLETED' as const,
        creditsCharged: per,
      })),
    );
  }
  await app.db
    .update(schema.shopifyStores)
    .set({ lastAlertLevel: null, lastAlertAt: null })
    .where(eq(schema.shopifyStores.id, store.id));
}

beforeAll(async () => {
  ctx = await setupTestContainers();
  app = await buildTestApp(ctx);
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'alerting-test.myshopify.com',
      shopifyShopId: 55501,
      accessToken: 'enc:token',
      scope: 'read_products',
      shopEmail: 'owner@alerting-test.example',
    })
    .returning();
});

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  await app.close();
  await teardownTestContainers(ctx);
});

describe('alert scheduler', () => {
  it('emails once when a store first crosses into warning', async () => {
    // 350 credits, 350 spent over the 7-day window = 50/day = 7 days... just under.
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe('warning');
    expect(sent[0].to).toBe('owner@alerting-test.example');
  });

  it('does not email again while the level is unchanged', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);

    sent = [];
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);
  });

  it('emails again when the level escalates', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent[0].level).toBe('warning');

    sent = [];
    // Same burn, far less balance — now under two days.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 50 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe('critical');
  });

  it('re-arms after a merchant recovers, so a later decline alerts again', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());

    sent = [];
    // Merchant buys a pack.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 5000 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);

    const [recovered] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(recovered.lastAlertLevel).toBe('ok');

    // ...then burns back down.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 300 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
  });

  it('never emails a store that has never run a job', async () => {
    await seedStore(25, 0, 0);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);
  });

  it('skips a store with no shop email and does not block the others', async () => {
    const [noEmail] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'no-email-test.myshopify.com',
        shopifyShopId: 55502,
        accessToken: 'enc:token',
        scope: 'read_products',
        shopEmail: null,
      })
      .returning();
    await app.db.insert(schema.shopifyStoreCredits).values({ storeId: noEmail.id, balance: 10 });
    await app.db
      .insert(schema.jobs)
      .values({ shopifyStoreId: noEmail.id, status: 'COMPLETED', creditsCharged: 100 });

    await seedStore(300, 350);
    await runAlertTick(app, deps());

    // The email-less store produced no send, but the healthy one still did.
    expect(sent.every((s) => s.to === 'owner@alerting-test.example')).toBe(true);
    expect(sent.length).toBeGreaterThan(0);

    await app.db.delete(schema.shopifyStores).where(eq(schema.shopifyStores.id, noEmail.id));
  });

  it('ignores uninstalled stores', async () => {
    await seedStore(300, 350);
    await app.db
      .update(schema.shopifyStores)
      .set({ uninstalledAt: new Date() })
      .where(eq(schema.shopifyStores.id, store.id));

    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);

    await app.db
      .update(schema.shopifyStores)
      .set({ uninstalledAt: null })
      .where(eq(schema.shopifyStores.id, store.id));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-alerting
```

Expected: FAIL — `Cannot find module '../../src/modules/shopify/alert-scheduler.js'`

- [ ] **Step 3: Write the scheduler**

Create `apps/api/src/modules/shopify/alert-scheduler.ts`:

```ts
import { schema } from '@tryme/db';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendLowCreditsEmail } from '../../lib/mailer.js';
import { buildPostInstallRedirect } from './auth.routes.js';
import { type AlertLevel, ALERT_LEVEL_RANK, computeRunway } from './runway.js';

/**
 * Deep link to the embedded app, for the email's "Add credits" button.
 *
 * SHOPIFY_API_KEY is optional in the env schema, and buildPostInstallRedirect
 * would happily produce `.../apps/` with an empty handle — a link that 404s the
 * merchant at the exact moment we are asking them to spend money. Fall back to
 * the shop's app list, which is one extra click but always works.
 */
function appLinkFor(app: FastifyInstance, shopDomain: string): string {
  const apiKey = app.env.SHOPIFY_API_KEY;
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, '');
  return apiKey
    ? buildPostInstallRedirect(shopDomain, apiKey)
    : `https://admin.shopify.com/store/${storeHandle}/apps`;
}

interface SendEmailArgs {
  to: string;
  shopDomain: string;
  appUrl: string;
  level: 'warning' | 'critical' | 'empty';
  balance: number;
  tryOnsRemaining: number;
  daysRemaining: number | null;
}

async function defaultSendEmail(app: FastifyInstance, args: SendEmailArgs): Promise<void> {
  await sendLowCreditsEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, args.to, {
    shopDomain: args.shopDomain,
    appUrl: args.appUrl,
    level: args.level,
    balance: args.balance,
    tryOnsRemaining: args.tryOnsRemaining,
    daysRemaining: args.daysRemaining,
  });
}

interface TickDeps {
  sendEmail?: (app: FastifyInstance, args: SendEmailArgs) => Promise<void>;
}

/**
 * Evaluates every installed store's runway and emails the ones that have got
 * worse since we last told them.
 *
 * Escalation, not state: the email fires only when the current level ranks
 * strictly worse than `last_alert_level`. `last_alert_level` is then rewritten
 * unconditionally — including down to 'ok' — so a merchant who tops up is
 * automatically re-armed and will be warned again the next time they decline.
 * Storing "have we ever warned this store" instead would alert once per install
 * and then go quiet forever.
 *
 * One pass, continue past a single failure, never throw — mirrors the shape of
 * the billing sync tick this replaces.
 */
export async function runAlertTick(app: FastifyInstance, deps: TickDeps = {}): Promise<void> {
  const sendEmail = deps.sendEmail ?? defaultSendEmail;

  const stores = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(isNull(schema.shopifyStores.uninstalledAt));

  for (const store of stores) {
    try {
      const runway = await computeRunway(app, store.id);
      const previous = (store.lastAlertLevel ?? 'ok') as AlertLevel;
      const worsened = ALERT_LEVEL_RANK[runway.level] > ALERT_LEVEL_RANK[previous];

      if (worsened && runway.level !== 'ok') {
        if (!store.shopEmail) {
          // Nothing we can do about it here — the address is captured at
          // install and refreshed on reinstall. Logged rather than silent so a
          // store that can never be reached is visible to an operator.
          app.log.warn(
            { storeId: store.id, shopDomain: store.shopDomain, level: runway.level },
            'low-credit alert not sent — store has no shop email on record',
          );
        } else {
          await sendEmail(app, {
            to: store.shopEmail,
            shopDomain: store.shopDomain,
            appUrl: appLinkFor(app, store.shopDomain),
            level: runway.level,
            balance: runway.balance,
            tryOnsRemaining: runway.tryOnsRemaining,
            daysRemaining: runway.daysRemaining,
          });
          app.log.info(
            { storeId: store.id, level: runway.level, balance: runway.balance },
            'low-credit alert sent',
          );
        }
      }

      await app.db
        .update(schema.shopifyStores)
        .set({
          lastAlertLevel: runway.level,
          // Only stamped when something was actually sent, so this stays a
          // record of "when we last contacted them" rather than "when the
          // scheduler last ran", which the logs already tell us.
          ...(worsened && runway.level !== 'ok' && store.shopEmail
            ? { lastAlertAt: new Date() }
            : {}),
        })
        .where(eq(schema.shopifyStores.id, store.id));
    } catch (err) {
      app.log.error({ err, storeId: store.id }, 'low-credit alert evaluation failed');
    }
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly is deliberate. Unlike a spend cap, where staleness has a direct dollar
 * cost, a runway measured in days does not become materially wrong inside an
 * hour — and a tighter interval would only increase the chance of emailing a
 * merchant twice about the same decline.
 *
 * Call once after `app.listen(...)`.
 */
export function startAlertScheduler(
  app: FastifyInstance,
  intervalMs: number = ONE_HOUR_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      app.log.warn('alert tick still running — skipping this interval');
      return;
    }
    running = true;
    void runAlertTick(app)
      .catch((err) => {
        app.log.error({ err }, 'alert tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Wire it into startup**

In `apps/api/src/main.ts`, add the import and the call where `startBillingScheduler(app)` used to be:

```ts
import { startAlertScheduler } from './modules/shopify/alert-scheduler.js';
```

```ts
startAlertScheduler(app);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-alerting
```

Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/alert-scheduler.ts apps/api/test/integration/shopify-alerting.test.ts apps/api/src/main.ts
git commit -m "feat(shopify): hourly low-credit alert scheduler with escalation-only email"
```

---

### Task 5: Runway in the API response and SPA banners

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/pages/PricingPage.tsx`

**Interfaces:**
- Consumes: `computeRunway` (Task 1).
- Produces: `/v1/shopify/me` gains `runway: { balance, tryOnsRemaining, dailyBurnCredits, daysRemaining, level }`.

- [ ] **Step 1: Return the runway from /me**

In `apps/api/src/modules/shopify/me.routes.ts`, add the import:

```ts
import { computeRunway } from './runway.js';
```

Replace the existing `creditBalance` lookup (the `creditRow` select and the `creditBalance` const) with:

```ts
    // Supersedes the bare balance lookup: the SPA needs the level and the
    // runway to render a banner, and computing it here keeps one definition of
    // "low" shared with the scheduler instead of duplicating thresholds in the
    // frontend where they would drift.
    const runway = await computeRunway(app, store.id);
```

Then in the returned object, replace `creditBalance,` with:

```ts
      creditBalance: runway.balance,
      runway: {
        balance: runway.balance,
        tryOnsRemaining: runway.tryOnsRemaining,
        dailyBurnCredits: runway.dailyBurnCredits,
        daysRemaining: runway.daysRemaining,
        level: runway.level,
      },
```

`creditBalance` is kept as-is so no existing SPA consumer breaks.

- [ ] **Step 2: Extend the SPA type**

In `apps/shopify/src/types.ts`, add to `ShopifyMe` alongside `creditBalance`:

```ts
  runway: {
    balance: number;
    tryOnsRemaining: number;
    dailyBurnCredits: number;
    daysRemaining: number | null;
    level: 'ok' | 'warning' | 'critical' | 'empty';
  };
```

- [ ] **Step 3: Add a shared banner component**

Create the component inline at the top of `apps/shopify/src/pages/DashboardPage.tsx` (below the imports), and export it so the pricing page can reuse it:

```tsx
export function LowCreditsBanner({ runway }: { runway: ShopifyMe['runway'] }) {
  if (runway.level === 'ok') return null;

  const days =
    runway.daysRemaining != null ? Math.max(1, Math.round(runway.daysRemaining)) : null;

  // Deliberately not a blocking modal, and the app is not disabled at zero: a
  // merchant at zero can still manage products, read analytics and edit the
  // widget, and the actual breakage is on the storefront, not in here.
  return (
    <Banner
      tone={runway.level === 'warning' ? 'warning' : 'critical'}
      title={
        runway.level === 'empty'
          ? 'You’re out of credits — try-on is paused for shoppers'
          : days != null
            ? `Low credits — about ${days} day${days === 1 ? '' : 's'} left`
            : 'Low credits'
      }
      action={{ content: 'Buy credits', url: '/pricing' }}
    >
      <Text as="p">
        {runway.balance.toLocaleString()} credits ({runway.tryOnsRemaining.toLocaleString()}{' '}
        try-ons)
        {runway.dailyBurnCredits > 0
          ? ` at about ${Math.round(runway.dailyBurnCredits)} credits/day.`
          : '.'}
      </Text>
    </Banner>
  );
}
```

- [ ] **Step 4: Render it on the dashboard**

In `apps/shopify/src/pages/DashboardPage.tsx`, immediately after the existing `{error && <Banner tone="critical">{error}</Banner>}` line, add:

```tsx
        {me && <LowCreditsBanner runway={me.runway} />}
```

- [ ] **Step 5: Render it on the pricing page**

In `apps/shopify/src/pages/PricingPage.tsx`, import the component:

```tsx
import { LowCreditsBanner } from './DashboardPage';
```

and add it immediately after the existing `{error && <Banner tone="critical">{error}</Banner>}` line:

```tsx
        {me && <LowCreditsBanner runway={me.runway} />}
```

Then enrich the balance card's subtitle so a merchant sees their runway without needing a banner. Replace the "About N try-ons remaining" line with:

```tsx
            <Text as="p" tone="subdued">
              About {tryOnsFromCredits(balance).toLocaleString()} try-ons remaining
              {me?.runway.daysRemaining != null
                ? ` — roughly ${Math.max(1, Math.round(me.runway.daysRemaining))} days at your current rate`
                : ''}
            </Text>
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/shopify-admin typecheck
cd apps/api && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/shopify/src
git commit -m "feat(shopify-admin): low-credit runway banners in the embedded admin"
```

---

## Verification Checklist

Run before opening the PR into `dev`:

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — clean
- [ ] `pnpm --filter @tryme/api test:unit` — pass
- [ ] `cd apps/api && npx vitest run --config vitest.integration.config.ts` — pass
- [ ] `pnpm docker:reset && pnpm docker:up && pnpm db:migrate` succeeds from empty
- [ ] Manual: seed a dev store with a low balance and recent jobs, run one `runAlertTick`, confirm exactly one email arrives and a second tick sends nothing
- [ ] Manual: confirm the embedded admin is fully usable at a zero balance — products, analytics, and widget design all still work

## Known Limits (accepted for this phase)

- **A store that never installs the app again keeps a stale `shop_email`.** The address is captured at install and refreshed on reinstall only. A merchant who changes their Shopify contact email mid-life will not be picked up until they reinstall. Refreshing it on a schedule is a cheap follow-up if it turns out to matter.
- **Burn rate is a flat 7-day mean.** A merchant whose traffic is spiky (a weekend sale) will be warned late going into the spike and early coming out of it. A weighted or trend-aware estimate is a refinement, not a correction, and is not worth the complexity until the flat mean is shown to mislead.
- **No in-app notification history.** A merchant who deletes the email has no way to see it again inside the app. The banner covers the current state, which is the part that matters.
- **`lastAlertAt` is written but nothing reads it.** It exists so that a future rate limit ("never more than one email per 24h regardless of escalation") can be added without a migration. Do not add that rule speculatively.

## Out of Scope

- **Phase 3 — auto-refill.** When it lands, the banner copy inverts for enrolled stores: not "you're running out" but "you're at N% of your monthly ceiling", fed by Shopify's `APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT` webhook, plus a `CAP_REACHED` critical state. The `LowCreditsBanner` component is the place that changes.
- **Storefront degradation.** Hiding the try-on button when a store is out of credits, instead of letting shoppers hit a generic error, is a theme-extension change and a separate piece of work.
- **Slack/PagerDuty alerting** on a store hitting zero. `app.log` only.
