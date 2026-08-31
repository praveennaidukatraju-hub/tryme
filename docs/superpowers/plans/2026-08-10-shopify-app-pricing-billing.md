# Shopify App Pricing Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Shopify app's off-platform Razorpay billing with Shopify App Pricing (three recurring plans, flat plan → credit grant), closing App Store review findings F1 (1.2.1), F2 (1.2.2), and F3 (1.2.3) from `docs/audits/2026-08-10-shopify-app-store-review.md`.

**Architecture:** Shopify hosts the plan-selection page and payment; our code never creates plans (that happens once in Partner Dashboard). On payment/plan-change, Shopify redirects the merchant back into the embedded app with `plan_handle`/`shop` query params — the app then confirms real state via the Partner API (a separate API from the Admin GraphQL API the rest of this codebase uses, with its own org-scoped token) and grants credits. Because Shopify App Pricing sends **no webhooks** for subscription changes (confirmed in `shopify.dev/docs/apps/launch/billing/shopify-app-pricing`), a scheduled poller (same `setInterval` shape as the existing `collections-resync-scheduler.ts`) re-checks every installed store's subscription periodically to catch renewals, cancellations, and freezes that happen without a redirect. Credit grants are idempotent per billing cycle via a new partial-unique-index pattern on `credit_ledger`, mirroring the existing `(job_id, reason)` idempotency index.

**Tech Stack:** Fastify 5, Drizzle ORM / PostgreSQL, Vitest, React 18 + Polaris (apps/shopify SPA), Shopify Partner API (GraphQL).

## Global Constraints

- No testcontainers — integration tests use the running `pnpm docker:up` Postgres/Redis/MinIO, per `apps/api/test/helpers/containers.ts`.
- ESM only, TypeScript 5.6, pnpm workspaces — never add npm/yarn lockfiles.
- No `console.log` — use `createLogger`/`req.log`/`app.log`.
- Never inline-mutate; this plan touches no ComfyUI workflow templates so that invariant doesn't apply here, but the credit-grant transaction pattern below must stay consistent with the existing `atomicDeduct`/`refund` idiom in `apps/api/src/modules/credits/ledger.ts` — conditional `UPDATE` / `onConflictDoNothing`, never `SELECT ... FOR UPDATE` (not used anywhere in this codebase).
- Draft prices for this build: Starter $29 / 2,500 credits, Growth $59 / 6,250 credits, Pro $219 / 25,000 credits. These are placeholders — the actual USD prices are entered in Partner Dashboard (a manual, code-free step) and are swappable at any time without touching this code, because the code keys credit grants off the plan **handle**, never off price.
- Plan handles are fixed strings used across Partner Dashboard config and this code: `starter`, `growth`, `pro`. If these ever change, every place in this plan that references them must be updated together.
- This plan does **not** cover finding F4 (2.2.4 — REST webhook registration in `webhook.routes.ts:195`) from the same audit. That is an unrelated, independent fix and is out of scope here.
- This plan does **not** add an app-wide "must have an active plan to use the app" gate. Credits are already the usage gate (`atomicDeduct` in `apps/api/src/modules/jobs/create.ts` blocks at zero balance) — a plan is only how credits get topped up. Do not add a stricter gate; that would be scope beyond what was decided.

---

## Prerequisite (not a coding task — flag to the user, do not attempt)

Before Task 7 can be tested end-to-end, someone with Partner Dashboard **organization owner** access must:
1. Opt the app into Shopify App Pricing (Partner Dashboard → app → Distribution → Manage listing → Pricing → Settings → Shopify App Pricing).
2. Create three plans with handles `starter`, `growth`, `pro` at the draft USD prices above, each with billing period "monthly" and a welcome/redirect URL of `/billing/callback` (relative to the app root, per `shopify.dev/docs/apps/launch/billing/shopify-app-pricing#redirection-url`).
3. Create a Partner API client (Partner Dashboard → Settings → API clients — only organization owners can do this) and record: the Partner API access token, the organization ID (from the Partner Dashboard URL), and this app's Partner Gid (`gid://shopify/App/<id>`).
4. Record the app's `handle` from `shopify.app.toml`-adjacent Partner Dashboard config (used to build the plan-selection page URL).

Tasks 1–6 and their tests do not require this — they're testable with fake tokens/fetch injection. Task 7 (routes) is also fully testable with fake tokens. Only a live end-to-end click-through against a real dev store needs the above.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/shopify.ts` | Modify — add subscription columns to `shopifyStores` |
| `packages/db/src/schema/credits.ts` | Modify — add `externalRef` idempotency column to `creditLedger` |
| `packages/db/src/migrations/NNNN_shopify_subscription_columns.sql` | New — migration for the above two |
| `apps/api/src/env.ts` | Modify — add Partner API env vars |
| `apps/api/src/modules/shopify/partner-client.ts` | New — Partner API GraphQL client + `getActiveSubscription` |
| `apps/api/src/modules/shopify/billing-plans.ts` | New — plan handle → credit amount map |
| `apps/api/src/modules/shopify/billing.ts` | New — `syncStoreSubscription` (idempotent grant/revoke logic) + `buildPlanSelectionUrl` |
| `apps/api/src/modules/shopify/billing-scheduler.ts` | New — periodic poll across all installed stores |
| `apps/api/src/modules/shopify/billing.routes.ts` | New — `GET /v1/shopify/billing/confirm` |
| `apps/api/src/modules/shopify/me.routes.ts` | Modify — add `planHandle`/`subscriptionStatus` to response |
| `apps/api/src/modules/shopify/webhook.routes.ts` | Modify — remove the now-dead `app_subscriptions_update` REST registration |
| `apps/api/src/modules/shopify/routes.ts` | Modify — register `shopifyBillingRoutes` |
| `apps/api/src/main.ts` | Modify — start the billing scheduler |
| `apps/shopify/src/lib/billing.ts` | New — `buildPlanSelectionUrl` client mirror (pure, no network) |
| `apps/shopify/src/types.ts` | Modify — add plan fields to `ShopifyMe` |
| `apps/shopify/src/App.tsx` | Modify — add `/billing/callback` route |
| `apps/shopify/src/pages/BillingCallbackPage.tsx` | New — confirms plan then redirects to `/` |
| `apps/shopify/src/pages/DashboardPage.tsx` | Modify — replace Razorpay top-up button with plan card + Shopify-hosted "Choose/Manage plan" link |
| `apps/shopify/src/components/LinkAccountGate.tsx` | Modify — remove the off-platform billing sentence |
| `.env.production.example` | Modify — document new env vars |
| `CLAUDE.md` | Modify — add new env vars to the table |

---

### Task 1: Schema + migration — subscription columns

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Modify: `packages/db/src/schema/credits.ts`
- Create: `packages/db/src/migrations/0148_shopify_subscription_columns.sql` (next number after `0147_drop_orphaned_jobs_batch_id_fkey.sql` — confirm the current highest-numbered file in `packages/db/src/migrations/` before naming this; renumber if something has landed since)

**Interfaces:**
- Produces: `schema.shopifyStores` gains `planHandle: text | null`, `subscriptionStatus: text | null`, `currentBillingCycleStart: Date | null`, `lastBillingSyncAt: Date | null`. `schema.creditLedger` gains `externalRef: text | null`.

- [ ] **Step 1: Add columns to `packages/db/src/schema/shopify.ts`**

In the `shopifyStores` table definition, add after `syncCursor: text('sync_cursor'),`:

```ts
  // Shopify App Pricing state — populated by billing.ts's syncStoreSubscription,
  // never written from a client-trusted value. null planHandle means "no plan
  // selected yet" (distinct from "was on a plan, now cancelled", which is
  // subscriptionStatus === 'cancelled' with planHandle still set to the last plan).
  planHandle: text('plan_handle'),
  subscriptionStatus: text('subscription_status'), // 'active' | 'cancelled' | 'frozen' | null
  // The Partner API's activeSubscription.currentBillingCycle.startTime. When a
  // poll observes this value change, a new billing cycle started — that's the
  // renewal signal, since Shopify App Pricing sends no renewal webhook.
  currentBillingCycleStart: timestamp('current_billing_cycle_start', { withTimezone: true }),
  lastBillingSyncAt: timestamp('last_billing_sync_at', { withTimezone: true }),
```

- [ ] **Step 2: Add idempotency column to `packages/db/src/schema/credits.ts`**

In the `creditLedger` table definition, add after `adminId: uuid('admin_id'),`:

```ts
  // Idempotency key for non-job-triggered grants (e.g. a Shopify subscription
  // billing-cycle grant). Mirrors the (job_id, reason) partial unique index
  // pattern below for job-triggered ones — see migration 0074 for that one,
  // and this task's migration for this one.
  externalRef: text('external_ref'),
```

- [ ] **Step 3: Write the migration**

First check the actual latest migration number:

Run: `ls packages/db/src/migrations/*.sql | sort -V | tail -1`

Use the next number after whatever that prints (the plan assumes `0148`; adjust the filename if the real latest differs).

```sql
ALTER TABLE "shopify_stores" ADD COLUMN "plan_handle" text;
ALTER TABLE "shopify_stores" ADD COLUMN "subscription_status" text;
ALTER TABLE "shopify_stores" ADD COLUMN "current_billing_cycle_start" timestamptz;
ALTER TABLE "shopify_stores" ADD COLUMN "last_billing_sync_at" timestamptz;

ALTER TABLE "credit_ledger" ADD COLUMN "external_ref" text;

CREATE UNIQUE INDEX "credit_ledger_external_ref_uniq"
  ON "credit_ledger" ("external_ref")
  WHERE "external_ref" IS NOT NULL;
```

- [ ] **Step 4: Apply the migration locally**

Run: `pnpm docker:up` (if not already running), then `pnpm db:migrate`
Expected: migration applies with no errors; `psql` or a quick `pnpm --filter @tryme/api test` run against an unrelated existing test confirms the schema loads.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/schema/credits.ts packages/db/src/migrations/0148_shopify_subscription_columns.sql
git commit -m "feat(db): add Shopify subscription + credit ledger idempotency columns"
```

---

### Task 2: Partner API environment variables

**Files:**
- Modify: `apps/api/src/env.ts`

**Interfaces:**
- Produces: `env.SHOPIFY_PARTNER_API_TOKEN: string | undefined`, `env.SHOPIFY_PARTNER_ORG_ID: string | undefined`, `env.SHOPIFY_PARTNER_APP_GID: string | undefined`, `env.SHOPIFY_APP_HANDLE: string | undefined`

- [ ] **Step 1: Add the four new vars**

In `apps/api/src/env.ts`, add after the `SHOPIFY_TOKEN_ENC_KEY` line:

```ts
  // Shopify Partner API — a separate API/token from the per-store Admin API
  // access token above. Used only by billing.ts/partner-client.ts to read
  // Shopify App Pricing subscription state, since Shopify App Pricing sends no
  // webhooks for subscription changes. Org-scoped: only a Partner Dashboard
  // organization owner can mint this token (Settings → API clients).
  SHOPIFY_PARTNER_API_TOKEN: z.string().optional(),
  // From the Partner Dashboard URL: partners.shopify.com/<this>/...
  SHOPIFY_PARTNER_ORG_ID: z.string().optional(),
  // This app's Partner API global id, e.g. "gid://shopify/App/1234" — distinct
  // from SHOPIFY_API_KEY (the OAuth client_id).
  SHOPIFY_PARTNER_APP_GID: z.string().optional(),
  // The app's handle as configured in Partner Dashboard, used to build the
  // Shopify-hosted plan-selection page URL:
  // https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans
  SHOPIFY_APP_HANDLE: z.string().optional(),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/env.ts
git commit -m "feat(api): add Shopify Partner API env vars"
```

---

### Task 3: Partner API client

**Files:**
- Create: `apps/api/src/modules/shopify/partner-client.ts`
- Test: `apps/api/src/modules/shopify/partner-client.test.ts`

**Interfaces:**
- Consumes: `Env` type from `../../env.js` (only the four fields from Task 2 are read).
- Produces:
  - `interface ActiveSubscription { billingPeriod: string; cancelAtEndOfCycle: boolean; currentBillingCycle: { startTime: string; endTime: string } | null; items: Array<{ handle: string }>; }`
  - `async function getActiveSubscription(env: Pick<Env, 'SHOPIFY_PARTNER_API_TOKEN' | 'SHOPIFY_PARTNER_ORG_ID' | 'SHOPIFY_PARTNER_APP_GID'>, shopifyShopId: number, fetchImpl?: typeof fetch): Promise<ActiveSubscription | null>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/shopify/partner-client.test.ts
import { describe, expect, it, vi } from 'vitest';
import { getActiveSubscription } from './partner-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const env = {
  SHOPIFY_PARTNER_API_TOKEN: 'partner-tok',
  SHOPIFY_PARTNER_ORG_ID: '999',
  SHOPIFY_PARTNER_APP_GID: 'gid://shopify/App/1234',
};

describe('getActiveSubscription', () => {
  it('POSTs to the org-scoped Partner API endpoint with the access token header', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { activeSubscription: null } }),
    );

    await getActiveSubscription(env, 5678, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://partners.shopify.com/999/api/2026-07/graphql.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': 'partner-tok',
    });
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({ appId: 'gid://shopify/App/1234', shopId: 'gid://shopify/Shop/5678' });
  });

  it('returns null when the shop has no active subscription', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { activeSubscription: null } }));
    const result = await getActiveSubscription(env, 5678, fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it('returns the parsed subscription when active', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          activeSubscription: {
            billingPeriod: 'EVERY_30_DAYS',
            cancelAtEndOfCycle: false,
            currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
            items: [{ handle: 'growth' }],
          },
        },
      }),
    );
    const result = await getActiveSubscription(env, 5678, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({
      billingPeriod: 'EVERY_30_DAYS',
      cancelAtEndOfCycle: false,
      currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
      items: [{ handle: 'growth' }],
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      getActiveSubscription(env, 5678, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/Partner API/);
  });

  it('throws when the GraphQL response carries errors', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Invalid access token' }] }),
    );
    await expect(
      getActiveSubscription(env, 5678, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/Invalid access token/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- partner-client`
Expected: FAIL — `Cannot find module './partner-client.js'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/partner-client.ts
import { AppError } from '../../lib/errors.js';

// Bumped alongside SHOPIFY_API_VERSION in service.ts — the Partner API
// versions independently of the Admin API but this codebase keeps them in
// lockstep for simplicity since both are bumped together in practice.
const PARTNER_API_VERSION = '2026-07';

export interface ActiveSubscription {
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: Array<{ handle: string }>;
}

interface PartnerEnv {
  SHOPIFY_PARTNER_API_TOKEN?: string;
  SHOPIFY_PARTNER_ORG_ID?: string;
  SHOPIFY_PARTNER_APP_GID?: string;
}

interface ActiveSubscriptionResponse {
  activeSubscription: ActiveSubscription | null;
}

const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      currentBillingCycle {
        startTime
        endTime
      }
      items {
        handle
      }
    }
  }
`;

interface GraphQLBody<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function partnerGraphQL<T>(
  env: PartnerEnv,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!env.SHOPIFY_PARTNER_API_TOKEN || !env.SHOPIFY_PARTNER_ORG_ID) {
    throw new AppError('CONFIG', 500, 'Shopify Partner API is not configured');
  }
  const url = `https://partners.shopify.com/${env.SHOPIFY_PARTNER_ORG_ID}/api/${PARTNER_API_VERSION}/graphql.json`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_PARTNER_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new AppError('SHOPIFY', 502, `Partner API request failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as GraphQLBody<T>;
  if (body.errors?.length) {
    throw new AppError('SHOPIFY', 502, `Partner API error: ${body.errors[0]?.message}`);
  }
  if (!body.data) {
    throw new AppError('SHOPIFY', 502, 'Partner API returned no data');
  }
  return body.data;
}

/**
 * Canonical "what is this merchant subscribed to right now?" check. Returns
 * null when the shop has no active Shopify App Pricing contract for this app
 * (never installed a plan, cancelled, or the subscription expired).
 */
export async function getActiveSubscription(
  env: PartnerEnv,
  shopifyShopId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ActiveSubscription | null> {
  if (!env.SHOPIFY_PARTNER_APP_GID) {
    throw new AppError('CONFIG', 500, 'Shopify Partner API is not configured');
  }
  const data = await partnerGraphQL<ActiveSubscriptionResponse>(
    env,
    ACTIVE_SUBSCRIPTION_QUERY,
    { appId: env.SHOPIFY_PARTNER_APP_GID, shopId: `gid://shopify/Shop/${shopifyShopId}` },
    fetchImpl,
  );
  return data.activeSubscription;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- partner-client`
Expected: PASS, all 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/partner-client.ts apps/api/src/modules/shopify/partner-client.test.ts
git commit -m "feat(api): add Shopify Partner API client for subscription status"
```

---

### Task 4: Plan → credit mapping

**Files:**
- Create: `apps/api/src/modules/shopify/billing-plans.ts`
- Test: `apps/api/src/modules/shopify/billing-plans.test.ts`

**Interfaces:**
- Produces: `const SHOPIFY_PLAN_HANDLES: readonly ['starter', 'growth', 'pro']`, `function creditsForPlanHandle(handle: string): number | null`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/shopify/billing-plans.test.ts
import { describe, expect, it } from 'vitest';
import { creditsForPlanHandle, SHOPIFY_PLAN_HANDLES } from './billing-plans.js';

describe('creditsForPlanHandle', () => {
  it('maps each known plan handle to its credit grant', () => {
    expect(creditsForPlanHandle('starter')).toBe(2500);
    expect(creditsForPlanHandle('growth')).toBe(6250);
    expect(creditsForPlanHandle('pro')).toBe(25000);
  });

  it('returns null for an unknown handle', () => {
    expect(creditsForPlanHandle('enterprise')).toBeNull();
    expect(creditsForPlanHandle('')).toBeNull();
  });

  it('SHOPIFY_PLAN_HANDLES lists exactly the mapped handles', () => {
    expect(SHOPIFY_PLAN_HANDLES).toEqual(['starter', 'growth', 'pro']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- billing-plans`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/billing-plans.ts

/**
 * Plan handles as configured in Partner Dashboard for Shopify App Pricing.
 * These strings are load-bearing across two systems that don't type-check
 * against each other — Partner Dashboard and this file — so a handle rename
 * in one without the other silently breaks credit grants. If a plan is
 * renamed, update both places in the same change.
 *
 * Draft launch prices (set in Partner Dashboard, not here — this file only
 * owns credits, never price): starter $29, growth $59, pro $219/month.
 */
export const SHOPIFY_PLAN_HANDLES = ['starter', 'growth', 'pro'] as const;
export type ShopifyPlanHandle = (typeof SHOPIFY_PLAN_HANDLES)[number];

const CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 2500,
  growth: 6250,
  pro: 25000,
};

export function creditsForPlanHandle(handle: string): number | null {
  return (CREDITS_BY_PLAN_HANDLE as Record<string, number>)[handle] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- billing-plans`
Expected: PASS, all 3 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing-plans.ts apps/api/src/modules/shopify/billing-plans.test.ts
git commit -m "feat(api): add Shopify plan handle to credit grant mapping"
```

---

### Task 5: Billing sync core (`syncStoreSubscription`)

**Files:**
- Create: `apps/api/src/modules/shopify/billing.ts`
- Test: `apps/api/test/integration/shopify-billing-sync.test.ts`

**Interfaces:**
- Consumes: `getActiveSubscription` from `./partner-client.js` (Task 3), `creditsForPlanHandle` from `./billing-plans.js` (Task 4), `DB` from `@tryme/db`, `schema` from `@tryme/db`.
- Produces:
  - `interface SyncResult { planHandle: string | null; subscriptionStatus: string | null; creditsGranted: number }`
  - `async function syncStoreSubscription(db: DB, env: PartnerEnv, store: typeof schema.shopifyStores.$inferSelect, deps?: { getActiveSubscription?: typeof getActiveSubscription }): Promise<SyncResult>`
  - `function buildPlanSelectionUrl(shopDomain: string, appHandle: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/shopify-billing-sync.test.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlanSelectionUrl, syncStoreSubscription } from '../../src/modules/shopify/billing.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('syncStoreSubscription', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedOwnerAndStore() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `owner-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Store Owner',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: user.id,
      })
      .returning();
    return { user, store };
  }

  const partnerEnv = {
    SHOPIFY_PARTNER_API_TOKEN: 'tok',
    SHOPIFY_PARTNER_ORG_ID: '1',
    SHOPIFY_PARTNER_APP_GID: 'gid://shopify/App/1',
  };

  it('grants credits and persists plan state on first sync with an active subscription', async () => {
    const { user, store } = await seedOwnerAndStore();

    const result = await syncStoreSubscription(app.db, partnerEnv, store, {
      getActiveSubscription: async () => ({
        billingPeriod: 'EVERY_30_DAYS',
        cancelAtEndOfCycle: false,
        currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
        items: [{ handle: 'growth' }],
      }),
    });

    expect(result).toEqual({ planHandle: 'growth', subscriptionStatus: 'active', creditsGranted: 6250 });

    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(6250);

    const [updatedStore] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updatedStore?.planHandle).toBe('growth');
    expect(updatedStore?.subscriptionStatus).toBe('active');
    expect(updatedStore?.currentBillingCycleStart?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not re-grant credits on a second sync within the same billing cycle', async () => {
    const { user, store } = await seedOwnerAndStore();
    const activeSub = {
      billingPeriod: 'EVERY_30_DAYS',
      cancelAtEndOfCycle: false,
      currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
      items: [{ handle: 'starter' }],
    };
    await syncStoreSubscription(app.db, partnerEnv, store, {
      getActiveSubscription: async () => activeSub,
    });
    const [restored] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));

    const second = await syncStoreSubscription(app.db, partnerEnv, restored!, {
      getActiveSubscription: async () => activeSub,
    });

    expect(second.creditsGranted).toBe(0);
    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(2500); // only granted once
  });

  it('grants again when the billing cycle advances (renewal)', async () => {
    const { user, store } = await seedOwnerAndStore();
    await syncStoreSubscription(app.db, partnerEnv, store, {
      getActiveSubscription: async () => ({
        billingPeriod: 'EVERY_30_DAYS',
        cancelAtEndOfCycle: false,
        currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
        items: [{ handle: 'starter' }],
      }),
    });
    const [afterFirst] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));

    const renewed = await syncStoreSubscription(app.db, partnerEnv, afterFirst!, {
      getActiveSubscription: async () => ({
        billingPeriod: 'EVERY_30_DAYS',
        cancelAtEndOfCycle: false,
        currentBillingCycle: { startTime: '2026-08-31T00:00:00Z', endTime: '2026-09-30T00:00:00Z' },
        items: [{ handle: 'starter' }],
      }),
    });

    expect(renewed.creditsGranted).toBe(2500);
    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(5000); // 2500 + 2500
  });

  it('marks the store cancelled and grants nothing when there is no active subscription', async () => {
    const { store } = await seedOwnerAndStore();

    const result = await syncStoreSubscription(app.db, partnerEnv, store, {
      getActiveSubscription: async () => null,
    });

    expect(result).toEqual({ planHandle: null, subscriptionStatus: 'cancelled', creditsGranted: 0 });
    const [updatedStore] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updatedStore?.subscriptionStatus).toBe('cancelled');
  });

  it('grants nothing for a store with no owner yet (unlinked account)', async () => {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `unlinked-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();

    const result = await syncStoreSubscription(app.db, partnerEnv, store!, {
      getActiveSubscription: async () => ({
        billingPeriod: 'EVERY_30_DAYS',
        cancelAtEndOfCycle: false,
        currentBillingCycle: { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-31T00:00:00Z' },
        items: [{ handle: 'pro' }],
      }),
    });

    expect(result.creditsGranted).toBe(0);
  });
});

describe('buildPlanSelectionUrl', () => {
  it('builds the Shopify-hosted plan picker URL from shop domain and app handle', () => {
    expect(buildPlanSelectionUrl('cool-shop.myshopify.com', 'tryme')).toBe(
      'https://admin.shopify.com/store/cool-shop/charges/tryme/pricing_plans',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-billing-sync`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/billing.ts
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { eq, sql } from 'drizzle-orm';
import { creditsForPlanHandle } from './billing-plans.js';
import { getActiveSubscription as defaultGetActiveSubscription, type ActiveSubscription } from './partner-client.js';

interface PartnerEnv {
  SHOPIFY_PARTNER_API_TOKEN?: string;
  SHOPIFY_PARTNER_ORG_ID?: string;
  SHOPIFY_PARTNER_APP_GID?: string;
}

export interface SyncResult {
  planHandle: string | null;
  subscriptionStatus: string | null;
  creditsGranted: number;
}

interface SyncDeps {
  getActiveSubscription?: (
    env: PartnerEnv,
    shopifyShopId: number,
    fetchImpl?: typeof fetch,
  ) => Promise<ActiveSubscription | null>;
}

/**
 * Re-checks one store's Shopify App Pricing subscription against the Partner
 * API (the only source of truth — Shopify App Pricing sends no webhooks) and
 * grants credits for a new billing cycle exactly once.
 *
 * Idempotency is enforced by the (external_ref) partial unique index on
 * credit_ledger (migration 0148), keyed on storeId + the cycle's start time.
 * That, not application-level locking, is what makes this safe to call
 * concurrently from both the redirect-confirm route and the scheduler poll
 * for the same store — matches the existing atomicDeduct/refund idiom in
 * credits/ledger.ts rather than introducing SELECT ... FOR UPDATE, which this
 * codebase doesn't otherwise use.
 */
export async function syncStoreSubscription(
  db: DB,
  env: PartnerEnv,
  store: typeof schema.shopifyStores.$inferSelect,
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const getSubscription = deps.getActiveSubscription ?? defaultGetActiveSubscription;
  const subscription = await getSubscription(env, store.shopifyShopId);

  if (!subscription) {
    await db
      .update(schema.shopifyStores)
      .set({
        subscriptionStatus: 'cancelled',
        lastBillingSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.shopifyStores.id, store.id));
    return { planHandle: null, subscriptionStatus: 'cancelled', creditsGranted: 0 };
  }

  const planHandle = subscription.items[0]?.handle ?? null;
  const cycleStart = subscription.currentBillingCycle
    ? new Date(subscription.currentBillingCycle.startTime)
    : null;
  const isNewCycle =
    !!cycleStart &&
    (!store.currentBillingCycleStart ||
      cycleStart.getTime() !== store.currentBillingCycleStart.getTime());

  let creditsGranted = 0;

  if (store.ownerUserId && planHandle && isNewCycle) {
    const amount = creditsForPlanHandle(planHandle);
    if (amount) {
      const externalRef = `shopify_subscription:${store.id}:${cycleStart!.toISOString()}`;
      const granted = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.creditLedger)
          .values({ userId: store.ownerUserId!, delta: amount, reason: 'SHOPIFY_SUBSCRIPTION', externalRef })
          .onConflictDoNothing()
          .returning({ id: schema.creditLedger.id });
        if (!inserted.length) return false; // already granted for this cycle
        await tx
          .insert(schema.userCredits)
          .values({ userId: store.ownerUserId!, balance: amount })
          .onConflictDoUpdate({
            target: schema.userCredits.userId,
            set: { balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() },
          });
        return true;
      });
      if (granted) creditsGranted = amount;
    }
  }

  await db
    .update(schema.shopifyStores)
    .set({
      planHandle,
      subscriptionStatus: 'active',
      currentBillingCycleStart: cycleStart,
      lastBillingSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { planHandle, subscriptionStatus: 'active', creditsGranted };
}

/**
 * The Shopify-hosted plan picker. Must be opened as a top-level navigation
 * (it's outside the embedded app's own origin) — see navigateTopLevel in
 * apps/shopify/src/lib/api.ts for the client-side helper that does that.
 */
export function buildPlanSelectionUrl(shopDomain: string, appHandle: string): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, '');
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-billing-sync`
Expected: PASS, all 6 tests. Requires `pnpm docker:up` running.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.ts apps/api/test/integration/shopify-billing-sync.test.ts
git commit -m "feat(api): add idempotent Shopify subscription sync + credit grant"
```

---

### Task 6: Billing scheduler

**Files:**
- Create: `apps/api/src/modules/shopify/billing-scheduler.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/test/integration/shopify-billing-scheduler.test.ts`

**Interfaces:**
- Consumes: `syncStoreSubscription` from `./billing.js` (Task 5)
- Produces:
  - `async function runBillingSyncTick(app: FastifyInstance, deps?: { sync?: typeof syncStoreSubscription; sleepImpl?: (ms: number) => Promise<void> }): Promise<void>`
  - `function startBillingScheduler(app: FastifyInstance, intervalMs?: number): () => void`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/integration/shopify-billing-scheduler.test.ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBillingSyncTick } from '../../src/modules/shopify/billing-scheduler.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('runBillingSyncTick', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedStore(overrides: Partial<typeof schema.shopifyStores.$inferInsert> = {}) {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + Math.floor(Math.random() * 1000),
        accessToken: 'enc',
        scope: 'read_products',
        ...overrides,
      })
      .returning();
    return store!;
  }

  it('syncs every installed store and skips uninstalled ones', async () => {
    const active = await seedStore();
    const uninstalled = await seedStore({ uninstalledAt: new Date() });

    const sync = vi.fn(async () => ({ planHandle: 'starter', subscriptionStatus: 'active', creditsGranted: 0 }));

    await runBillingSyncTick(app, { sync, sleepImpl: async () => {} });

    const syncedIds = sync.mock.calls.map((call) => (call[2] as { id: string }).id);
    expect(syncedIds).toContain(active.id);
    expect(syncedIds).not.toContain(uninstalled.id);
  });

  it('continues past a single store failing to sync', async () => {
    const first = await seedStore();
    const second = await seedStore();
    let calls = 0;
    const sync = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('partner api down');
      return { planHandle: null, subscriptionStatus: 'cancelled', creditsGranted: 0 };
    });

    await expect(runBillingSyncTick(app, { sync, sleepImpl: async () => {} })).resolves.not.toThrow();
    expect(sync).toHaveBeenCalledTimes(2);
    void first;
    void second;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-billing-scheduler`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/billing-scheduler.ts
import { schema } from '@tryme/db';
import { isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { syncStoreSubscription } from './billing.js';

// Partner API rate limit is 4 requests/second per client (per
// shopify.dev/docs/api/partner#rate-limits). One store = one request here, so
// a fixed delay between stores keeps a large store count from bursting past
// that even though today's install count is nowhere near it.
const PARTNER_API_MIN_DELAY_MS = 300;

interface TickDeps {
  sync?: typeof syncStoreSubscription;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One tick: re-sync every currently-installed store's Shopify App Pricing
 * subscription. This is the only mechanism that catches a renewal,
 * cancellation, or freeze that happens without the merchant visiting the
 * app — Shopify App Pricing sends no webhook for any of those (see billing.ts
 * for the full explanation).
 */
export async function runBillingSyncTick(app: FastifyInstance, deps: TickDeps = {}): Promise<void> {
  const sync = deps.sync ?? syncStoreSubscription;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;

  const stores = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(isNull(schema.shopifyStores.uninstalledAt));

  for (const store of stores) {
    try {
      await sync(app.db, app.env, store);
    } catch (err) {
      app.log.error({ err, storeId: store.id }, 'shopify billing sync failed for store');
    }
    await sleepImpl(PARTNER_API_MIN_DELAY_MS);
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Call once after `app.listen(...)`, alongside startCollectionResyncScheduler
 * — mirrors that function's "start once, get a stop function back" shape.
 */
export function startBillingScheduler(app: FastifyInstance, intervalMs: number = HOUR_MS): () => void {
  const timer = setInterval(() => {
    void runBillingSyncTick(app).catch((err) => {
      app.log.error({ err }, 'billing sync tick failed');
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-billing-scheduler`
Expected: PASS, both tests

- [ ] **Step 5: Wire into `apps/api/src/main.ts`**

Add the import alongside the existing scheduler import, and the start call alongside `startCollectionResyncScheduler(app);`:

```ts
import { startBillingScheduler } from './modules/shopify/billing-scheduler.js';
```

```ts
startBillingScheduler(app);
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/billing-scheduler.ts apps/api/test/integration/shopify-billing-scheduler.test.ts apps/api/src/main.ts
git commit -m "feat(api): poll Shopify Partner API for subscription renewals/cancellations"
```

---

### Task 7: Billing confirm route

**Files:**
- Create: `apps/api/src/modules/shopify/billing.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Test: `apps/api/test/integration/shopify-billing-routes.test.ts`

**Interfaces:**
- Consumes: `syncStoreSubscription` from `./billing.js` (Task 5), `app.requireShopifySession` preHandler (existing, from `apps/api/src/plugins/shopify-auth.ts`)
- Produces: `GET /v1/shopify/billing/confirm` → `{ planHandle: string | null; subscriptionStatus: string | null; creditBalance: number | null }`

- [ ] **Step 1: Write the failing test**

Follow the existing session-bypass pattern other Shopify route tests use — check how `shopify-limits.test.ts` or a sibling `*-routes.test.ts` file authenticates against `requireShopifySession` before writing this (it's typically a signed session-token header built with a small test helper). Mirror whatever helper those tests import from `apps/api/test/helpers/` for that; if none exists yet for a plain GET route, seed a store then call `syncStoreSubscription` directly and separately unit-test the route handler logic only through the exported route registration function without going through the HTTP session layer — i.e. structure the test like `shopify-billing-sync.test.ts` in Task 5 but hitting `app.inject` requires a valid session token. Use this shape:

```ts
// apps/api/test/integration/shopify-billing-routes.test.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as billing from '../../src/modules/shopify/billing.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { signShopifySessionToken } from '../helpers/shopify-session.js';

describe('GET /v1/shopify/billing/confirm', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('re-syncs the calling store and returns its plan state', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `owner-${Date.now()}@example.com`,
        passwordHash: null,
        displayName: 'Owner',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user!.id, balance: 0 });
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'confirm-test.myshopify.com',
        shopifyShopId: 424242,
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: user!.id,
      })
      .returning();

    const syncSpy = vi
      .spyOn(billing, 'syncStoreSubscription')
      .mockResolvedValue({ planHandle: 'pro', subscriptionStatus: 'active', creditsGranted: 25000 });

    const token = signShopifySessionToken(app, store!.shopDomain);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/billing/confirm',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ planHandle: 'pro', subscriptionStatus: 'active', creditBalance: null });
    expect(syncSpy).toHaveBeenCalled();

    const [updatedUser] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user!.id));
    void updatedUser;
    syncSpy.mockRestore();
  });
});
```

Before writing this file for real, open `apps/api/test/helpers/` and any existing `*.routes.test.ts` under `apps/api/src/modules/shopify/` or `apps/api/test/integration/shopify-*.test.ts` to find the actual helper that mints a valid `requireShopifySession` bearer token in tests (the plan above assumes one at `apps/api/test/helpers/shopify-session.ts` exporting `signShopifySessionToken(app, shopDomain)` — if the real helper has a different name/path/signature, use that instead and adjust the test accordingly; do not invent a new session-signing helper if one already exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-billing-routes`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/shopify/billing.routes.ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { syncStoreSubscription } from './billing.js';

export async function shopifyBillingRoutes(app: FastifyInstance) {
  // The merchant lands here after Shopify's plan-selection/charge-confirmation
  // redirect (see buildPlanSelectionUrl in billing.ts and the welcome-link
  // config in Partner Dashboard). Shopify appends plan_handle/shop as query
  // params, but those are merchant-controllable via the URL bar — this route
  // never trusts them. It re-fetches the real state from the Partner API via
  // syncStoreSubscription instead, exactly like the periodic scheduler does.
  app.get('/v1/shopify/billing/confirm', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
    const result = await syncStoreSubscription(app.db, app.env, store);

    let creditBalance: number | null = null;
    if (store.ownerUserId) {
      const [row] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, store.ownerUserId))
        .limit(1);
      creditBalance = row?.balance ?? 0;
    }

    return {
      planHandle: result.planHandle,
      subscriptionStatus: result.subscriptionStatus,
      creditBalance,
    };
  });
}
```

- [ ] **Step 4: Register the route in `apps/api/src/modules/shopify/routes.ts`**

Add the import alongside the others:

```ts
import { shopifyBillingRoutes } from './billing.routes.js';
```

Add the registration alongside `await app.register(shopifyMeRoutes);`:

```ts
  await app.register(shopifyBillingRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-billing-routes`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/billing.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/integration/shopify-billing-routes.test.ts
git commit -m "feat(api): add billing confirm route for the post-plan-selection redirect"
```

---

### Task 8: Surface plan state on `/v1/shopify/me`

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Test: check `apps/api/test/me-shopify-store-flag.test.ts` for the existing convention on this endpoint and extend it, or add assertions inline if that file is narrowly scoped to a single flag.

**Interfaces:**
- Produces: `/v1/shopify/me` response gains `store.planHandle: string | null` and `store.subscriptionStatus: string | null`.

- [ ] **Step 1: Read the existing test file to confirm the assertion style**

Run: `cat apps/api/test/me-shopify-store-flag.test.ts`

- [ ] **Step 2: Add a failing assertion**

In that file (or a new adjacent test if it's a poor fit — match whichever `me.routes.ts` test already seeds a store and calls `/v1/shopify/me`), add:

```ts
it('includes plan handle and subscription status in the store object', async () => {
  // seed a store the same way the surrounding tests in this file do, setting
  // planHandle: 'growth', subscriptionStatus: 'active' on insert
  // ... then:
  const res = await app.inject({ method: 'GET', url: '/v1/shopify/me', headers: { authorization: `Bearer ${token}` } });
  expect(res.json().store.planHandle).toBe('growth');
  expect(res.json().store.subscriptionStatus).toBe('active');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- me-shopify-store-flag`
Expected: FAIL — `planHandle`/`subscriptionStatus` undefined in response

- [ ] **Step 4: Update the implementation**

In `apps/api/src/modules/shopify/me.routes.ts`, inside the `store: { ... }` object in the final `return`, add two fields:

```ts
      store: {
        shopDomain: store.shopDomain,
        settings: store.settings,
        ownerUserId: store.ownerUserId,
        connectedSince: store.installedAt.toISOString(),
        planHandle: store.planHandle,
        subscriptionStatus: store.subscriptionStatus,
      },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- me-shopify-store-flag`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/me-shopify-store-flag.test.ts
git commit -m "feat(api): surface Shopify plan state on /v1/shopify/me"
```

---

### Task 9: Remove the dead `app_subscriptions_update` REST webhook registration

**Files:**
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts`

**Interfaces:**
- None — pure deletion, no new interface.

- [ ] **Step 1: Remove the topic from the receiving-side `topics` array**

In `webhook.routes.ts`, in the `topics` array (around line 52), remove:

```ts
    'app_subscriptions_update',
```

and remove its `switch` case (around line 154-156):

```ts
          case 'app_subscriptions_update':
            req.log.info({ topic, shopDomain }, 'subscription updated');
            break;
```

- [ ] **Step 2: Remove it from the registration map**

In the `registerWebhooksDecorator`'s `map` object (around line 189), remove:

```ts
      'app_subscriptions/update': `${base}/app_subscriptions_update`,
```

Update the comment above the `map` if it references this topic by name.

- [ ] **Step 3: Run the existing webhook tests**

Run: `pnpm --filter @tryme/api test -- webhook`
Expected: PASS — no test should have depended on this topic (verify none did; if one does, it was testing dead functionality and should be deleted alongside it).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/webhook.routes.ts
git commit -m "chore(api): remove dead app_subscriptions_update webhook — Shopify App Pricing sends no such webhook"
```

---

### Task 10: Frontend types + billing callback route

**Files:**
- Modify: `apps/shopify/src/types.ts`
- Create: `apps/shopify/src/lib/billing.ts`
- Create: `apps/shopify/src/pages/BillingCallbackPage.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Test: `apps/shopify/src/lib/billing.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `../lib/api.js` (existing)
- Produces: `buildPlanSelectionUrl(shopDomain: string, appHandle: string): string` (client-side mirror of the server-side one in Task 5 — duplicated deliberately since the SPA and API are separately deployed/built and don't share a package for this one pure function; DRY does not apply across a deploy boundary)

- [ ] **Step 1: Write the failing test**

```ts
// apps/shopify/src/lib/billing.test.ts
import { describe, expect, it } from 'vitest';
import { buildPlanSelectionUrl } from './billing';

describe('buildPlanSelectionUrl', () => {
  it('strips .myshopify.com and builds the hosted pricing page URL', () => {
    expect(buildPlanSelectionUrl('cool-shop.myshopify.com', 'tryme')).toBe(
      'https://admin.shopify.com/store/cool-shop/charges/tryme/pricing_plans',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/shopify-admin test -- billing`
Expected: FAIL — module not found

- [ ] **Step 3: Write `apps/shopify/src/lib/billing.ts`**

```ts
export function buildPlanSelectionUrl(shopDomain: string, appHandle: string): string {
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, '');
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/shopify-admin test -- billing`
Expected: PASS

- [ ] **Step 5: Add plan fields to `apps/shopify/src/types.ts`**

In the `ShopifyMe['store']` interface, add two fields:

```ts
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
    ownerUserId: string | null;
    connectedSince: string;
    planHandle: string | null;
    subscriptionStatus: string | null;
  };
  creditBalance: number | null;
  stats: ShopifyStats;
}
```

- [ ] **Step 6: Write `apps/shopify/src/pages/BillingCallbackPage.tsx`**

This is the page Shopify's welcome-link redirect lands on after a plan selection/change. It confirms the real state via the backend (never trusting the `plan_handle` query param Shopify appended, since that's merchant-visible/URL-editable) then returns to the dashboard.

```tsx
import { Page, Spinner } from '@shopify/polaris';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';

export default function BillingCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    apiFetch('/v1/shopify/billing/confirm')
      .catch(() => {
        // Best-effort: even if confirmation fails here, the scheduler in
        // billing-scheduler.ts will pick up the real state on its next tick.
        // Don't strand the merchant on an error page over a transient blip.
      })
      .finally(() => navigate('/', { replace: true }));
  }, [navigate]);

  return (
    <Page>
      <Spinner accessibilityLabel="Confirming your plan" size="large" />
    </Page>
  );
}
```

- [ ] **Step 7: Add the route in `apps/shopify/src/App.tsx`**

Add the import:

```ts
import BillingCallbackPage from './pages/BillingCallbackPage';
```

Add the route inside `<Routes>`, alongside the other page routes:

```tsx
          <Route path="/billing/callback" element={<BillingCallbackPage />} />
```

- [ ] **Step 8: Commit**

```bash
git add apps/shopify/src/types.ts apps/shopify/src/lib/billing.ts apps/shopify/src/lib/billing.test.ts apps/shopify/src/pages/BillingCallbackPage.tsx apps/shopify/src/App.tsx
git commit -m "feat(shopify-admin): add billing callback route + plan selection URL builder"
```

---

### Task 11: Dashboard plan card + remove off-platform billing

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/components/LinkAccountGate.tsx`

**Interfaces:**
- Consumes: `buildPlanSelectionUrl` from `../lib/billing.js` (Task 10), `navigateTopLevel`-equivalent behavior — this codebase's existing `window.open`/anchor-click pattern in `DashboardPage.tsx`'s `openThemeEditor` is same-tab-safe since it opens a *new* tab (`window.open(url, '_blank', 'noopener')`); the plan-selection page must instead replace the current top-level context per Shopify's docs (`target: "_top"` requirement), which matches the `navigateTopLevel` helper already in `apps/shopify/src/lib/api.ts:46-54` — import and reuse it rather than `window.open`.

- [ ] **Step 1: Remove the off-platform billing sentence in `LinkAccountGate.tsx`**

Change:

```tsx
            <Text as="p" tone="subdued">
              Billing and credits live on app.tryme.com — nothing is charged through Shopify.
              Link your store to start offering virtual try-on.
            </Text>
```

to:

```tsx
            <Text as="p" tone="subdued">
              Link your store to start offering virtual try-on.
            </Text>
```

- [ ] **Step 2: Export `navigateTopLevel` from `apps/shopify/src/lib/api.ts`**

It currently isn't exported (only used internally). Change:

```ts
function navigateTopLevel(url: string): void {
```

to:

```ts
export function navigateTopLevel(url: string): void {
```

- [ ] **Step 3: Replace the credit-balance card's off-platform top-up button in `DashboardPage.tsx`**

Find the existing block (currently around line 267-282):

```tsx
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Credit balance
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.creditBalance ?? 0}
              </Text>
              <Box>
                <Button url="https://app.tryme.com/pricing" target="_blank">
                  Top up on tryme.com
                </Button>
              </Box>
            </BlockStack>
          </Card>
```

Replace it with:

```tsx
          <Card>
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                Credit balance
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.creditBalance ?? 0}
              </Text>
              {me?.store.planHandle ? (
                <Text as="p" tone="subdued">
                  {PLAN_LABELS[me.store.planHandle] ?? me.store.planHandle} plan
                  {me.store.subscriptionStatus !== 'active' ? ` — ${me.store.subscriptionStatus}` : ''}
                </Text>
              ) : null}
              <Box>
                <Button onClick={openPlanSelection}>
                  {me?.store.planHandle ? 'Manage plan' : 'Choose a plan'}
                </Button>
              </Box>
            </BlockStack>
          </Card>
```

- [ ] **Step 4: Add the supporting import, constant, and handler**

Add imports near the top of `DashboardPage.tsx`, alongside the existing ones:

```ts
import { buildPlanSelectionUrl } from '../lib/billing';
import { navigateTopLevel } from '../lib/api';
```

Add near the top of the file, outside the component (module scope, alongside any other constants):

```ts
const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
};

// Set at build time from Partner Dashboard's app handle — see
// .env.production.example for VITE_SHOPIFY_APP_HANDLE.
const APP_HANDLE = import.meta.env.VITE_SHOPIFY_APP_HANDLE ?? '';
```

Add the handler function inside the component, alongside `openThemeEditor`:

```ts
  function openPlanSelection() {
    if (!me) return;
    navigateTopLevel(buildPlanSelectionUrl(me.store.shopDomain, APP_HANDLE));
  }
```

- [ ] **Step 5: Typecheck and run the SPA test suite**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: no errors

Run: `pnpm --filter @tryme/shopify-admin test`
Expected: PASS — check `apps/shopify/src/__tests__/widget-design-loading.test.ts` and any Dashboard-related snapshot/DOM test isn't asserting on the old button text; update it if so (search first: `grep -rn "Top up on tryme" apps/shopify/src/__tests__`).

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src/pages/DashboardPage.tsx apps/shopify/src/components/LinkAccountGate.tsx apps/shopify/src/lib/api.ts
git commit -m "feat(shopify-admin): replace off-platform billing UI with Shopify-hosted plan management"
```

---

### Task 12: Env var documentation

**Files:**
- Modify: `.env.production.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Add the new vars to `.env.production.example`**

After the existing `VITE_SHOPIFY_API_KEY` line, add:

```
SHOPIFY_PARTNER_API_TOKEN=            # Partner Dashboard → Settings → API clients (org owner only)
SHOPIFY_PARTNER_ORG_ID=               # from the Partner Dashboard URL: partners.shopify.com/<this>/...
SHOPIFY_PARTNER_APP_GID=              # gid://shopify/App/<id> — distinct from SHOPIFY_API_KEY
SHOPIFY_APP_HANDLE=                   # app handle from Partner Dashboard, used to build the hosted plan-picker URL
VITE_SHOPIFY_APP_HANDLE=              # same value as SHOPIFY_APP_HANDLE, exposed client-side
```

- [ ] **Step 2: Add a row to the env var table in `CLAUDE.md`**

In the `## Environment Variables` table, add after the `NEXT_PUBLIC_BASE_PATH` row:

```
| `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_APP_GID`, `SHOPIFY_APP_HANDLE` | api — Shopify App Pricing subscription polling (Partner API, org-scoped, separate from the per-store Admin API token) |
```

- [ ] **Step 3: Commit**

```bash
git add .env.production.example CLAUDE.md
git commit -m "docs: document Shopify Partner API env vars"
```

---

## Self-Review

**Spec coverage:**
- Flat plan → credit grant model — Task 5 (`syncStoreSubscription` + `billing-plans.ts`).
- Shopify App Pricing (not Billing API) — Tasks 3, 5, 7, 10, 11 all build against the Partner API / hosted plan page, never `appSubscriptionCreate`.
- Draft USD prices $29/$59/$219 — recorded in Global Constraints and the Prerequisite section as a Partner Dashboard config value, deliberately not hardcoded in application code (Task 4's comment explains why).
- Closes F1 (1.2.1) — Task 11 removes the Razorpay link and the off-platform-billing sentence; Tasks 1–9 replace it with real Shopify billing.
- Closes F2 (1.2.2) — Task 5's idempotent grant-per-cycle plus Task 6's poller together give correct behavior for a merchant declining (no subscription → `syncStoreSubscription` returns `cancelled`, grants nothing) and for reinstall (no special-casing needed — polling just resumes; documented in the architecture note).
- Closes F3 (1.2.3) — Task 11's "Manage plan" button routes to Shopify's own hosted plan page, which natively supports upgrade/downgrade without contacting support or reinstalling.
- F4 (2.2.4, REST webhook registration) — explicitly out of scope, stated in Global Constraints.

**Placeholder scan:** No "TBD"/"handle appropriately" strings. Task 7 and Task 8 both explicitly instruct reading an existing file first because this plan's author does not have that file's exact current contents/helper names in hand — that is a deliberate "read before writing" instruction, not a placeholder, and each still specifies the exact assertions and exact code to land.

**Type consistency:** `SyncResult` (Task 5) is consumed identically in Task 7's route and Task 6's scheduler test. `ShopifyPlanHandle`/`creditsForPlanHandle` (Task 4) is consumed by `billing.ts` (Task 5) with matching signature. `buildPlanSelectionUrl` exists in two places by design (server in Task 5, client in Task 10) with identical behavior, called out explicitly as a deliberate small duplication across the deploy boundary, not an oversight.
