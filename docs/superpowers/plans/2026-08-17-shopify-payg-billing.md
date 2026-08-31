# Shopify Pay-As-You-Go Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone "Pay as you go" Shopify App Pricing plan — $0/month base plus a $0.10-per-try-on usage meter — as a fourth option alongside starter/growth/pro, billed through the App Events API with no credits ledger involvement.

**Architecture:** A merchant selects "Pay as you go" on Shopify's hosted plan picker (unchanged UI, one more Partner-Dashboard-configured plan). `syncStoreSubscription` detects the plan and flips the store to `billingMode: 'usage'`. Job creation skips the credit ledger entirely for these stores and instead checks a local, Postgres-tracked spend cap. The dispatcher writes one local row per successfully completed job — no new external dependency there. A new scheduler reports those rows to Shopify's App Events API (a separate, app-level JWT auth, distinct from every other Shopify integration point in this app) and a reconciliation step folded into the existing hourly billing sync compares what was reported against what Shopify actually billed, closing the gap created by the App Events API never returning a synchronous billing error.

**Tech Stack:** Fastify 5, Drizzle ORM / PostgreSQL, Redis (ioredis), Vitest, React + Polaris (apps/shopify), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-17-shopify-payg-design.md`

## Global Constraints

- PAYG stores never write to `shopify_store_credits` or `shopify_credit_ledger` — billing is priced and capped in dollars directly (spec: "Credits ledger — Not touched at all").
- Price (`PAYG_PRICE_PER_TRYON_USD = 0.10`) is a code constant only, never admin-Redis-configurable — it must match the Partner Dashboard meter price exactly, the same "two systems, no type-check" risk `billing-plans.ts` already documents for plan names.
- The App Events `event_handle` is `tryon_generated` and must match the Partner Dashboard meter handle exactly (case-sensitive).
- The App Events endpoint is `https://api.shopify.com/app/unstable/events` and the token endpoint is `https://api.shopify.com/auth/access_token` — `unstable` is, as of this plan, the only documented API version; confirmed via WebFetch against shopify.dev, not assumed.
- **Open item, confirm before Task 5 is deployed (not before it is coded):** whether the App Events `client_id`/`client_secret` is the same credential as `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` or a separate Dev Dashboard key. Task 5 introduces distinct env vars (`SHOPIFY_APP_EVENTS_CLIENT_ID`/`_SECRET`) precisely so this doesn't have to be resolved before writing code — only before setting them in a real environment.
- `shopify_stores.shopifyShopId` already exists (`bigint`, `notNull`, populated at install) — do not add a new column or lookup for it; use it directly to build `gid://shopify/Shop/${shopifyShopId}`.
- A job that fails before `COMPLETED` must never produce a `shopify_usage_events` row — this is how "no refund needed" holds for a postpaid model.
- Every new Postgres access goes through Drizzle (`schema.*`), matching the rest of this codebase — no raw SQL except where the codebase itself already uses `sql\`...\`` (aggregate sums).

---

## Task 1: Schema — `billingMode`/spend cap columns and `shopify_usage_events` table

**Files:**
- Modify: `packages/db/src/schema/shopify.ts:85-131` (the `shopifyStores` table)
- Modify: `packages/db/src/schema/shopify.ts` (add new table, near `shopifyCreditLedger` at line 141)
- Create (generated): `packages/db/src/migrations/0156_shopify_payg_billing.sql` + matching `meta/` snapshot/journal entries
- Test: `apps/api/test/integration/shopify-payg-schema.test.ts`

**Interfaces:**
- Produces: `schema.shopifyStores.billingMode` (`'prepaid' | 'usage'`, not null, default `'prepaid'`), `schema.shopifyStores.paygSpendCapUsdCents` (integer, nullable), `schema.shopifyStores.subscriptionIsTest` (boolean, not null, default `false`); `schema.shopifyUsageEvents` table with columns `id, storeId, jobId, priceUsdCents, status, createdAt, reportedAt`.

- [ ] **Step 1: Add the new columns to `shopifyStores`**

Edit `packages/db/src/schema/shopify.ts`, inside the `shopifyStores` pgTable definition, immediately after the `lastBillingSyncAt` line (currently line 128):

```typescript
  lastBillingSyncAt: timestamp('last_billing_sync_at', { withTimezone: true }),
  // PAYG billing. 'prepaid' (default) is every existing store — deducts from
  // shopify_store_credits as today. 'usage' means this store is on the
  // Pay-as-you-go plan: no credits ledger involvement at all, billed in USD
  // through Shopify's App Events API instead. Set by syncStoreSubscription
  // from the synced plan handle, never client-trusted.
  billingMode: text('billing_mode').notNull().default('prepaid'),
  // Merchant-set monthly spend ceiling for billingMode='usage' stores, in USD
  // cents. Enforced entirely app-side — Shopify usage meters have no cap
  // support. Null until the store first becomes 'usage', at which point
  // syncStoreSubscription seeds a default.
  paygSpendCapUsdCents: integer('payg_spend_cap_usd_cents'),
  // Persists AppSubscription.test, which syncStoreSubscription already reads
  // but previously discarded. Gates PAYG usage reporting the same way
  // SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS already gates credit grants — a dev
  // store's test charges must never be reported as real usage in production.
  subscriptionIsTest: boolean('subscription_is_test').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

- [ ] **Step 2: Add the `shopifyUsageEvents` table**

In the same file, immediately after the `shopifyCreditLedger` table definition (ends around line 156 after this edit — search for the `CREATE UNIQUE INDEX`-equivalent Drizzle block, i.e. right after `export const shopifyCreditLedger = pgTable(...)` closes):

```typescript
// One row per successfully COMPLETED job for a billingMode='usage' store.
// A job that fails is never inserted here — for a postpaid model, "don't
// report" achieves the same effect as a prepaid refund, with no separate
// mechanism needed. Written by the dispatcher (job/processor.ts) on the
// same COMPLETED transition every other job type already goes through;
// reported to Shopify's App Events API asynchronously by usage-scheduler.ts.
export const shopifyUsageEvents = pgTable(
  'shopify_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull().unique(),
    // Snapshotted from PAYG_PRICE_PER_TRYON_USD at insert time — never
    // re-derived later, same "the row is the record of what was promised"
    // reasoning the superseded top-up spec used for its credits column.
    priceUsdCents: integer('price_usd_cents').notNull(),
    status: text('status').notNull().default('PENDING'), // 'PENDING' | 'REPORTED'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
  },
  (table) => ({
    storeCreatedIdx: index('shopify_usage_events_store_created_idx').on(
      table.storeId,
      table.createdAt,
    ),
  }),
);
```

- [ ] **Step 3: Generate the migration**

Run from repo root:
```bash
pnpm db:generate
```
This produces `packages/db/src/migrations/0156_<name>.sql` and updates `packages/db/src/migrations/meta/_journal.json` plus a new snapshot file automatically — do not hand-write these.

- [ ] **Step 4: Apply the migration locally**

```bash
pnpm docker:up
pnpm db:migrate
```

- [ ] **Step 5: Write the schema test**

Create `apps/api/test/integration/shopify-payg-schema.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('shopify PAYG schema', () => {
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

  it('defaults a new store to prepaid billing mode with no spend cap', async () => {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-schema-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();
    expect(store?.billingMode).toBe('prepaid');
    expect(store?.paygSpendCapUsdCents).toBeNull();
    expect(store?.subscriptionIsTest).toBe(false);
  });

  it('enforces one usage_events row per job via the unique constraint', async () => {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-schema-2-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now() + 1,
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    const [job] = await (app.db.insert(schema.jobs).values as never)({
      shopifyStoreId: store?.id,
      customerPhotoKey: 'x',
      status: 'QUEUED',
      creditsCharged: 0,
    }).returning();

    await app.db.insert(schema.shopifyUsageEvents).values({
      storeId: store?.id as string,
      jobId: job?.id as string,
      priceUsdCents: 10,
    });

    await expect(
      app.db.insert(schema.shopifyUsageEvents).values({
        storeId: store?.id as string,
        jobId: job?.id as string,
        priceUsdCents: 10,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run the test**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-payg-schema
```
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations apps/api/test/integration/shopify-payg-schema.test.ts
git commit -m "feat(shopify): add PAYG billing_mode/spend-cap columns and shopify_usage_events table"
```

---

## Task 2: `payg.ts` — pricing constants and spend-cap check

**Files:**
- Create: `apps/api/src/modules/shopify/payg.ts`
- Test: `apps/api/test/integration/shopify-payg-cap.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyUsageEvents`, `schema.shopifyStores.$inferSelect` (Task 1)
- Produces: `PAYG_PRICE_PER_TRYON_USD_CENTS = 10`, `EVENT_HANDLE = 'tryon_generated'`, `DEFAULT_PAYG_SPEND_CAP_USD_CENTS = 5000`, `MIN_PAYG_SPEND_CAP_USD_CENTS = 500`, `cyclyWindowStart(store): Date`, `checkPaygSpendCap(app, store): Promise<void>` (throws `AppError('PAYG_CAP_REACHED', 402, ...)`), `getPaygSpendThisCycleCents(app, store): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/shopify-payg-cap.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPaygSpendCap, getPaygSpendThisCycleCents } from '../../src/modules/shopify/payg.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('PAYG spend cap', () => {
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
        shopDomain: `payg-cap-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + Math.floor(Math.random() * 100000),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
        paygSpendCapUsdCents: 100, // $1.00 = 10 try-ons at $0.10 each
        ...overrides,
      })
      .returning();
    return store!;
  }

  async function seedUsageRow(storeId: string, priceUsdCents: number, createdAt?: Date) {
    const [job] = await (app.db.insert(schema.jobs).values as never)({
      shopifyStoreId: storeId,
      customerPhotoKey: 'x',
      status: 'COMPLETED',
      creditsCharged: 0,
    }).returning();
    await app.db.insert(schema.shopifyUsageEvents).values({
      storeId,
      jobId: job?.id as string,
      priceUsdCents,
      createdAt,
    });
  }

  it('allows dispatch when under the cap', async () => {
    const store = await seedStore();
    await seedUsageRow(store.id, 50);
    await expect(checkPaygSpendCap(app, store)).resolves.not.toThrow();
  });

  it('rejects dispatch at or over the cap', async () => {
    const store = await seedStore();
    await seedUsageRow(store.id, 60);
    await seedUsageRow(store.id, 40); // exactly at the $1.00 cap
    await expect(checkPaygSpendCap(app, store)).rejects.toThrow('PAYG_CAP_REACHED');
  });

  it('excludes usage from before the current billing cycle', async () => {
    const store = await seedStore({ currentPeriodEnd: new Date(Date.now() + 86400000) });
    const lastCycle = new Date(Date.now() - 40 * 86400000);
    await seedUsageRow(store.id, 90, lastCycle);
    const spend = await getPaygSpendThisCycleCents(app, store);
    expect(spend).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-payg-cap
```
Expected: FAIL — `Cannot find module '../../src/modules/shopify/payg.js'`

- [ ] **Step 3: Write `payg.ts`**

Create `apps/api/src/modules/shopify/payg.ts`:

```typescript
import { schema } from '@tryme/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

/**
 * The code-side mirror of the Partner Dashboard meter price. Must match it
 * exactly — this is what the spend cap is checked against, and if it drifts
 * from what Shopify actually bills, the cap stops meaning what it says. If
 * the Partner Dashboard price ever changes, this constant changes in the
 * same PR.
 */
export const PAYG_PRICE_PER_TRYON_USD_CENTS = 10;

/** Must match the meter handle configured in Partner Dashboard exactly — case-sensitive. */
export const EVENT_HANDLE = 'tryon_generated';

export const DEFAULT_PAYG_SPEND_CAP_USD_CENTS = 5000; // $50
export const MIN_PAYG_SPEND_CAP_USD_CENTS = 500; // $5

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The start of the current billing cycle window. Mirrors currentPeriodEnd's
 * role in syncStoreSubscription's isNewCycle check: usage from before this
 * point belongs to a previous cycle and must not count against the current
 * cap. Falls back to a rolling 30-day window when currentPeriodEnd hasn't
 * been synced yet (e.g. the very first tick after a store selects PAYG).
 */
export function cycleWindowStart(store: typeof schema.shopifyStores.$inferSelect): Date {
  if (store.currentPeriodEnd) {
    return new Date(store.currentPeriodEnd.getTime() - THIRTY_DAYS_MS);
  }
  return new Date(Date.now() - THIRTY_DAYS_MS);
}

/**
 * Sum of this-cycle shopify_usage_events for one store, in USD cents.
 * Includes both PENDING and REPORTED rows — a row not yet reported to
 * Shopify is still a real cost that already happened and must still count
 * against the cap; only the App Events call is deferred, not the spend.
 */
export async function getPaygSpendThisCycleCents(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
): Promise<number> {
  const [row] = await app.db
    .select({ total: sql<number>`COALESCE(SUM(${schema.shopifyUsageEvents.priceUsdCents}), 0)::int` })
    .from(schema.shopifyUsageEvents)
    .where(
      and(
        eq(schema.shopifyUsageEvents.storeId, store.id),
        gte(schema.shopifyUsageEvents.createdAt, cycleWindowStart(store)),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Throws PAYG_CAP_REACHED (402) if dispatching one more try-on would meet or
 * exceed the store's spend cap. Checked against the local running total, not
 * a live Shopify read — a per-job GraphQL round trip before every dispatch
 * isn't worth the latency, same reasoning as why credits are checked locally
 * today. Accurate to within reporting lag, not to the millisecond.
 */
export async function checkPaygSpendCap(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
): Promise<void> {
  const cap = store.paygSpendCapUsdCents ?? DEFAULT_PAYG_SPEND_CAP_USD_CENTS;
  const spent = await getPaygSpendThisCycleCents(app, store);
  if (spent + PAYG_PRICE_PER_TRYON_USD_CENTS > cap) {
    throw new AppError('PAYG_CAP_REACHED', 402, 'monthly spend cap reached');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-payg-cap
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/payg.ts apps/api/test/integration/shopify-payg-cap.test.ts
git commit -m "feat(shopify): PAYG pricing constants and spend-cap check"
```

---

## Task 3: `subscription-client.ts` — read `balanceUsed` for reconciliation

**Files:**
- Modify: `apps/api/src/modules/shopify/subscription-client.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL` (existing, `service.js`), `getValidAccessToken` (existing, `token.js`)
- Produces: `ActiveSubscription.lineItems[].usageBalanceUsdCents?: number | null` (new optional field, so the existing `sub()` test fixture keeps typechecking unmodified), same `getActiveSubscription(app, store): Promise<ActiveSubscription | null>` signature — no breaking change for existing callers in `billing.ts`

- [ ] **Step 1: Extend the query and type**

In `apps/api/src/modules/shopify/subscription-client.ts`, replace the `ACTIVE_SUBSCRIPTIONS_QUERY` and the `ActiveSubscription` interface's `lineItems` field:

```typescript
export interface ActiveSubscription {
  id: string;
  name: string;
  status: AppSubscriptionStatus;
  currentPeriodEnd: string | null;
  test: boolean;
  lineItems: Array<{
    id: string;
    // Optional, not `| null` at the required-key level: the existing
    // sub() test fixture in shopify-billing-sync.test.ts (and every new
    // override built on it in Task 4) constructs lineItems literals that
    // predate this field and must keep typechecking without adding it.
    usageBalanceUsdCents?: number | null;
  }>;
}

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        test
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppUsagePricing {
                balanceUsed {
                  amount
                }
              }
            }
          }
        }
      }
    }
  }
`;
```

The GraphQL shape here was validated against the Admin API schema (2026-04) before this plan was written — `AppUsagePricing.balanceUsed` is a `MoneyV2`, whose `amount` field is a decimal-string; parsing happens where it's consumed (Task 4), not here.

- [ ] **Step 2: Parse `balanceUsed` off the raw response into the typed field**

Immediately after the `data.currentAppInstallation?.activeSubscriptions ?? []` line, before the function returns, map each subscription's line items to extract the parsed cents value. Replace the body of `getActiveSubscription` from the `const subscriptions = ...` line onward:

```typescript
  const rawSubscriptions = data.currentAppInstallation?.activeSubscriptions ?? [];
  const subscriptions: ActiveSubscription[] = rawSubscriptions.map((raw) => {
    // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL response before mapping to the typed shape
    const r = raw as any;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      currentPeriodEnd: r.currentPeriodEnd,
      test: r.test,
      lineItems: (r.lineItems ?? []).map((li: { id: string; plan?: { pricingDetails?: { __typename?: string; balanceUsed?: { amount?: string } } } }) => ({
        id: li.id,
        usageBalanceUsdCents:
          li.plan?.pricingDetails?.__typename === 'AppUsagePricing' &&
          li.plan.pricingDetails.balanceUsed?.amount
            ? Math.round(Number.parseFloat(li.plan.pricingDetails.balanceUsed.amount) * 100)
            : null,
      })),
    };
  });
  const [first] = subscriptions;
  if (!first) return null;
  return subscriptions.find((s) => s.status === 'ACTIVE') ?? first;
```

Also update the `ActiveSubscriptionsResponse` interface's implicit shape isn't strictly typed against the raw GraphQL response elsewhere in this file, so no further type changes are needed — `shopifyGraphQL<ActiveSubscriptionsResponse>` already returns `unknown`-shaped JSON that this mapping normalizes.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/subscription-client.ts
git commit -m "feat(shopify): read AppUsagePricing.balanceUsed for PAYG reconciliation"
```

---

## Task 4: `billing.ts` — `billingMode`, `subscriptionIsTest`, spend-cap seeding, reconciliation

**Files:**
- Modify: `apps/api/src/modules/shopify/billing.ts`
- Test: `apps/api/test/integration/shopify-billing-sync.test.ts`

**Interfaces:**
- Consumes: `ActiveSubscription` (Task 3, now with `lineItems[].usageBalanceUsdCents`), `getPaygSpendThisCycleCents` (Task 2)
- Produces: `SyncResult` gains `billingMode: 'prepaid' | 'usage'`; `syncStoreSubscription` now also writes `billingMode`, `paygSpendCapUsdCents` (seeded once), `subscriptionIsTest`, and logs a reconciliation mismatch for `'usage'` stores

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/integration/shopify-billing-sync.test.ts`, inside the existing `describe('syncStoreSubscription', ...)` block (reuses the file's existing `sub()` helper and `seedStore()`):

```typescript
  it('sets billingMode to usage and seeds a default spend cap for the PAYG plan', async () => {
    const store = await seedStore();
    const result = await syncStoreSubscription(app, store, {
      getActiveSubscription: async () =>
        sub({ name: 'Pay as you go', lineItems: [{ id: 'gid://shopify/AppSubscriptionLineItem/1' }] }),
    });
    expect(result.billingMode).toBe('usage');
    const [updated] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updated?.billingMode).toBe('usage');
    expect(updated?.paygSpendCapUsdCents).not.toBeNull();
  });

  it('does not re-seed the spend cap on a later sync once it has been set', async () => {
    const store = await seedStore();
    await syncStoreSubscription(app, store, {
      getActiveSubscription: async () => sub({ name: 'Pay as you go' }),
    });
    const [afterFirst] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    await app.db
      .update(schema.shopifyStores)
      .set({ paygSpendCapUsdCents: 12345 })
      .where(eq(schema.shopifyStores.id, store.id));
    const [beforeResync] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));

    await syncStoreSubscription(app, beforeResync!, {
      getActiveSubscription: async () => sub({ name: 'Pay as you go' }),
    });
    const [afterResync] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(afterFirst?.paygSpendCapUsdCents).not.toBeNull();
    expect(afterResync?.paygSpendCapUsdCents).toBe(12345);
  });

  it('persists subscriptionIsTest from the synced subscription', async () => {
    const store = await seedStore();
    await syncStoreSubscription(app, store, {
      getActiveSubscription: async () => sub({ test: true }),
    });
    const [updated] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updated?.subscriptionIsTest).toBe(true);
  });

  it('falls back to prepaid billingMode for a non-PAYG plan', async () => {
    const store = await seedStore();
    const result = await syncStoreSubscription(app, store, {
      getActiveSubscription: async () => sub({ name: 'Growth' }),
    });
    expect(result.billingMode).toBe('prepaid');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-billing-sync
```
Expected: FAIL — `result.billingMode` is `undefined`, new columns aren't written.

- [ ] **Step 3: Extend `billing.ts`**

Add near the top of `apps/api/src/modules/shopify/billing.ts`, alongside the existing imports:

```typescript
import { DEFAULT_PAYG_SPEND_CAP_USD_CENTS } from './payg.js';

const PAYG_PLAN_NAME = 'pay as you go'; // normalizePlanName'd match against Partner Dashboard's plan display name
```

Extend the `SyncResult` interface (currently `{ planHandle, subscriptionStatus, creditsGranted }`):

```typescript
export interface SyncResult {
  planHandle: string | null;
  subscriptionStatus: string | null;
  creditsGranted: number;
  billingMode: 'prepaid' | 'usage';
}
```

In `syncStoreSubscription`, after `const planHandle = normalizePlanName(subscription.name) || null;` (existing line), add:

```typescript
  const billingMode: 'prepaid' | 'usage' = planHandle === PAYG_PLAN_NAME ? 'usage' : 'prepaid';
```

Immediately before the function's final `await app.db.update(schema.shopifyStores).set({...})` call, insert the spend-cap seeding (only ever set once — a later resync must not clobber a merchant's own edit):

```typescript
  // Seed a default spend cap the first time a store becomes 'usage' — never
  // overwrite an existing value, which could be a merchant's own edit made
  // between syncs.
  const spendCapPatch =
    billingMode === 'usage' && store.paygSpendCapUsdCents === null
      ? { paygSpendCapUsdCents: DEFAULT_PAYG_SPEND_CAP_USD_CENTS }
      : {};
```

Update the final `.set({...})` call to include the new fields (merge into the existing object literal that currently has `planHandle, subscriptionStatus, ...marker, lastBillingSyncAt, updatedAt`):

```typescript
  await app.db
    .update(schema.shopifyStores)
    .set({
      planHandle,
      subscriptionStatus,
      billingMode,
      subscriptionIsTest: subscription.test,
      ...spendCapPatch,
      ...marker,
      lastBillingSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { planHandle, subscriptionStatus, creditsGranted, billingMode };
```

Also handle the early-return branch (no active subscription at all — currently returns `{ planHandle: null, subscriptionStatus: 'cancelled', creditsGranted: 0 }` after setting `subscriptionStatus: 'cancelled'`). Update that `.set()` call to also write `billingMode: 'prepaid'` (a store with no subscription can't be billed by usage) and update the returned object to include `billingMode: 'prepaid'`.

Finally, add the reconciliation check. After the main `.set()` call above (i.e., at the very end of `syncStoreSubscription`, before the final `return`), add:

```typescript
  // Reconciliation: the App Events API always returns 202 even when billing
  // validation fails server-side, with no webhook for that failure — this is
  // the only machine-readable signal that closes the gap between "we sent
  // it" and "Shopify actually billed it". A mismatch here means something is
  // silently wrong (a misconfigured meter handle, an unmetered plan) and is
  // otherwise invisible.
  if (billingMode === 'usage') {
    const reportedLineItem = subscription.lineItems.find((li) => li.usageBalanceUsdCents != null);
    if (reportedLineItem?.usageBalanceUsdCents != null) {
      const ourTotal = await getPaygSpendThisCycleCentsForReconciliation(app, store.id, periodEnd);
      const mismatch = Math.abs(reportedLineItem.usageBalanceUsdCents - ourTotal);
      if (mismatch > 50) {
        // > 50 cents tolerance absorbs ordinary async-processing lag between
        // an event being reported and Shopify's balance reflecting it.
        app.log.error(
          { storeId: store.id, shopifyBalanceCents: reportedLineItem.usageBalanceUsdCents, ourTotalCents: ourTotal },
          'PAYG usage reconciliation mismatch — check Partner Dashboard meter configuration',
        );
      }
    }
  }
```

Add the small helper this calls, above `syncStoreSubscription`:

```typescript
import { and, eq, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

async function getPaygSpendThisCycleCentsForReconciliation(
  app: FastifyInstance,
  storeId: string,
  periodEnd: Date | null,
): Promise<number> {
  const windowStart = periodEnd
    ? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [row] = await app.db
    .select({ total: sql<number>`COALESCE(SUM(${schema.shopifyUsageEvents.priceUsdCents}), 0)::int` })
    .from(schema.shopifyUsageEvents)
    .where(
      and(
        eq(schema.shopifyUsageEvents.storeId, storeId),
        eq(schema.shopifyUsageEvents.status, 'REPORTED'),
        gte(schema.shopifyUsageEvents.createdAt, windowStart),
      ),
    );
  return row?.total ?? 0;
}
```

(`and`, `eq`, `gte`, `sql` are already imported once at the top of the file from the existing `import { eq } from 'drizzle-orm';` line — merge these into that single import statement rather than duplicating it.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-billing-sync
```
Expected: PASS (all tests in the file, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.ts apps/api/test/integration/shopify-billing-sync.test.ts
git commit -m "feat(shopify): billingMode detection, spend-cap seeding, PAYG usage reconciliation"
```

---

## Task 5: `app-events-client.ts` — App Events JWT auth and event POST

**Files:**
- Create: `apps/api/src/modules/shopify/app-events-client.ts`
- Modify: `apps/api/src/env.ts`
- Test: `apps/api/test/integration/shopify-app-events-client.test.ts`

**Interfaces:**
- Consumes: `app.redis` (existing Fastify decoration), `app.env.SHOPIFY_APP_EVENTS_CLIENT_ID` / `_SECRET` (new)
- Produces: `getAppEventsToken(app, deps?): Promise<string>`, `reportUsageEvent(app, params: { shopifyShopId: number; jobId: string }, deps?): Promise<'reported' | 'failed'>`

- [ ] **Step 1: Add env vars**

In `apps/api/src/env.ts`, add alongside the existing `SHOPIFY_*` block (near `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS`):

```typescript
  // App Events API (PAYG usage reporting) credentials. NOT assumed to be the
  // same as SHOPIFY_API_KEY/SHOPIFY_API_SECRET — the App Events docs describe
  // these as generated separately in the Dev Dashboard. Confirm which is
  // correct before setting these in any real environment; see the plan's
  // Global Constraints for why this isn't resolved here.
  SHOPIFY_APP_EVENTS_CLIENT_ID: z.string().optional(),
  SHOPIFY_APP_EVENTS_CLIENT_SECRET: z.string().optional(),
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/integration/shopify-app-events-client.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAppEventsToken, reportUsageEvent } from '../../src/modules/shopify/app-events-client.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('App Events client', () => {
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

  it('fetches and caches a token, reusing it on a second call', async () => {
    const fetchToken = vi.fn(async () => ({ access_token: 'tok-1', expires_in: 3599 }));
    const first = await getAppEventsToken(app, { fetchToken });
    const second = await getAppEventsToken(app, { fetchToken });
    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('reports a usage event with the correct idempotency key and returns reported on 202', async () => {
    const postEvent = vi.fn(async () => ({ ok: true, status: 202 }));
    const result = await reportUsageEvent(
      app,
      { shopifyShopId: 12345, jobId: '11111111-1111-1111-1111-111111111111' },
      { getToken: async () => 'tok-x', postEvent },
    );
    expect(result).toBe('reported');
    expect(postEvent).toHaveBeenCalledWith(
      'tok-x',
      expect.objectContaining({
        shop_id: 'gid://shopify/Shop/12345',
        event_handle: 'tryon_generated',
        idempotency_key: 'usage:11111111-1111-1111-1111-111111111111',
      }),
    );
  });

  it('returns failed when the POST does not succeed', async () => {
    const postEvent = vi.fn(async () => ({ ok: false, status: 500 }));
    const result = await reportUsageEvent(
      app,
      { shopifyShopId: 12345, jobId: '22222222-2222-2222-2222-222222222222' },
      { getToken: async () => 'tok-x', postEvent },
    );
    expect(result).toBe('failed');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-app-events-client
```
Expected: FAIL — module not found.

- [ ] **Step 4: Write `app-events-client.ts`**

Create `apps/api/src/modules/shopify/app-events-client.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { EVENT_HANDLE } from './payg.js';

const TOKEN_URL = 'https://api.shopify.com/auth/access_token';
const EVENTS_URL = 'https://api.shopify.com/app/unstable/events';
const REDIS_TOKEN_KEY = 'shopify:app-events:token';
// Refresh 5 minutes before Shopify's real 60-minute expiry so a token is
// never used past the point Shopify would reject it.
const REFRESH_MARGIN_SECONDS = 300;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

async function defaultFetchToken(app: FastifyInstance): Promise<TokenResponse> {
  const clientId = app.env.SHOPIFY_APP_EVENTS_CLIENT_ID;
  const clientSecret = app.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError('SHOPIFY', 500, 'App Events client credentials are not configured');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    throw new AppError('SHOPIFY', 502, `App Events token request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

interface GetTokenDeps {
  fetchToken?: (app: FastifyInstance) => Promise<TokenResponse>;
}

/**
 * App-level JWT for the App Events API — one shared token for the whole app,
 * unlike every other Shopify integration point here (which uses a per-store
 * offline token). Cached in Redis so concurrent callers across requests share
 * one token instead of each fetching their own.
 */
export async function getAppEventsToken(app: FastifyInstance, deps: GetTokenDeps = {}): Promise<string> {
  const cached = await app.redis.get(REDIS_TOKEN_KEY);
  if (cached) return cached;

  const fetchToken = deps.fetchToken ?? defaultFetchToken;
  const { access_token, expires_in } = await fetchToken(app);
  const ttl = Math.max(60, expires_in - REFRESH_MARGIN_SECONDS);
  await app.redis.set(REDIS_TOKEN_KEY, access_token, 'EX', ttl);
  return access_token;
}

interface PostEventResult {
  ok: boolean;
  status: number;
}

async function defaultPostEvent(
  token: string,
  body: { shop_id: string; event_handle: string; timestamp: string; idempotency_key: string; attributes: { value: number } },
): Promise<PostEventResult> {
  const res = await fetch(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

interface ReportUsageEventDeps {
  getToken?: (app: FastifyInstance) => Promise<string>;
  postEvent?: typeof defaultPostEvent;
}

/**
 * Reports one try-on as usage. A 202 here means "Shopify accepted the
 * request", never "Shopify billed it" — the App Events API has no
 * synchronous billing-validation error. Confirming an event was actually
 * billed is what the reconciliation check in billing.ts is for.
 */
export async function reportUsageEvent(
  app: FastifyInstance,
  params: { shopifyShopId: number; jobId: string },
  deps: ReportUsageEventDeps = {},
): Promise<'reported' | 'failed'> {
  const getToken = deps.getToken ?? getAppEventsToken;
  const postEvent = deps.postEvent ?? defaultPostEvent;

  const token = await getToken(app);
  const result = await postEvent(token, {
    shop_id: `gid://shopify/Shop/${params.shopifyShopId}`,
    event_handle: EVENT_HANDLE,
    timestamp: new Date().toISOString(),
    idempotency_key: `usage:${params.jobId}`,
    attributes: { value: 1 },
  });
  return result.ok ? 'reported' : 'failed';
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-app-events-client
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/app-events-client.ts apps/api/src/env.ts apps/api/test/integration/shopify-app-events-client.test.ts
git commit -m "feat(shopify): App Events API client with cached app-level JWT"
```

---

## Task 6: `usage-scheduler.ts` — report PENDING rows on a tick

**Files:**
- Create: `apps/api/src/modules/shopify/usage-scheduler.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/test/integration/shopify-usage-scheduler.test.ts`

**Interfaces:**
- Consumes: `reportUsageEvent` (Task 5), `schema.shopifyUsageEvents`, `schema.shopifyStores`
- Produces: `runUsageReportTick(app, deps?): Promise<void>`, `startUsageScheduler(app, intervalMs?): () => void`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/shopify-usage-scheduler.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUsageReportTick } from '../../src/modules/shopify/usage-scheduler.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('runUsageReportTick', () => {
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
  beforeEach(async () => {
    await app.db.delete(schema.shopifyUsageEvents);
    await app.db.delete(schema.jobs);
    await app.db.delete(schema.shopifyStores);
  });

  async function seedPendingRow() {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `usage-tick-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + Math.floor(Math.random() * 100000),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    const [job] = await (app.db.insert(schema.jobs).values as never)({
      shopifyStoreId: store?.id,
      customerPhotoKey: 'x',
      status: 'COMPLETED',
      creditsCharged: 0,
    }).returning();
    const [row] = await app.db
      .insert(schema.shopifyUsageEvents)
      .values({ storeId: store?.id as string, jobId: job?.id as string, priceUsdCents: 10 })
      .returning();
    return { store: store!, row: row! };
  }

  it('marks a row REPORTED when the report call succeeds', async () => {
    const { row } = await seedPendingRow();
    await runUsageReportTick(app, { report: async () => 'reported' });
    const [updated] = await app.db
      .select()
      .from(schema.shopifyUsageEvents)
      .where(eq(schema.shopifyUsageEvents.id, row.id));
    expect(updated?.status).toBe('REPORTED');
    expect(updated?.reportedAt).not.toBeNull();
  });

  it('leaves a row PENDING when the report call fails', async () => {
    const { row } = await seedPendingRow();
    await runUsageReportTick(app, { report: async () => 'failed' });
    const [updated] = await app.db
      .select()
      .from(schema.shopifyUsageEvents)
      .where(eq(schema.shopifyUsageEvents.id, row.id));
    expect(updated?.status).toBe('PENDING');
  });

  it('does not report rows for a test subscription when the allow-test gate is off', async () => {
    const { row, store } = await seedPendingRow();
    await app.db
      .update(schema.shopifyStores)
      .set({ subscriptionIsTest: true })
      .where(eq(schema.shopifyStores.id, store.id));
    const report = vi.fn(async () => 'reported' as const);
    await runUsageReportTick(app, { report });
    expect(report).not.toHaveBeenCalled();
    const [updated] = await app.db
      .select()
      .from(schema.shopifyUsageEvents)
      .where(eq(schema.shopifyUsageEvents.id, row.id));
    expect(updated?.status).toBe('PENDING');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-usage-scheduler
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `usage-scheduler.ts`**

Create `apps/api/src/modules/shopify/usage-scheduler.ts`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { reportUsageEvent } from './app-events-client.js';

interface TickDeps {
  report?: (
    app: FastifyInstance,
    params: { shopifyShopId: number; jobId: string },
  ) => Promise<'reported' | 'failed'>;
}

/**
 * Reports every PENDING shopify_usage_events row to Shopify's App Events
 * API. Mirrors billing-scheduler.ts's runBillingSyncTick shape — one pass
 * over rows, continue past a single failure, no throw.
 */
export async function runUsageReportTick(app: FastifyInstance, deps: TickDeps = {}): Promise<void> {
  const report = deps.report ?? reportUsageEvent;

  const pending = await app.db
    .select({
      id: schema.shopifyUsageEvents.id,
      jobId: schema.shopifyUsageEvents.jobId,
      storeId: schema.shopifyUsageEvents.storeId,
      shopifyShopId: schema.shopifyStores.shopifyShopId,
      subscriptionIsTest: schema.shopifyStores.subscriptionIsTest,
    })
    .from(schema.shopifyUsageEvents)
    .innerJoin(schema.shopifyStores, eq(schema.shopifyStores.id, schema.shopifyUsageEvents.storeId))
    .where(eq(schema.shopifyUsageEvents.status, 'PENDING'));

  for (const row of pending) {
    // Mirrors syncStoreSubscription's SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS gate:
    // a test-subscription store's usage rows exist (the job ran, cost real
    // GPU time) but must never be reported as real revenue in an environment
    // that doesn't allow it.
    if (row.subscriptionIsTest && app.env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS !== true) {
      continue;
    }
    try {
      const result = await report(app, { shopifyShopId: row.shopifyShopId, jobId: row.jobId });
      if (result === 'reported') {
        await app.db
          .update(schema.shopifyUsageEvents)
          .set({ status: 'REPORTED', reportedAt: new Date() })
          .where(eq(schema.shopifyUsageEvents.id, row.id));
      }
    } catch (err) {
      app.log.error({ err, usageEventId: row.id }, 'PAYG usage event report failed — will retry next tick');
    }
  }
}

const THREE_MINUTES_MS = 3 * 60 * 1000;

/** Call once after `app.listen(...)`, mirrors startBillingScheduler's shape exactly. */
export function startUsageScheduler(app: FastifyInstance, intervalMs: number = THREE_MINUTES_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      app.log.warn('usage report tick still running — skipping this interval');
      return;
    }
    running = true;
    void runUsageReportTick(app)
      .catch((err) => {
        app.log.error({ err }, 'usage report tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-usage-scheduler
```
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into `main.ts`**

In `apps/api/src/main.ts`, add the import alongside the other scheduler imports:

```typescript
import { startUsageScheduler } from './modules/shopify/usage-scheduler.js';
```

And add the call alongside `startBillingScheduler(app);`:

```typescript
startBillingScheduler(app);
startUsageScheduler(app);
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/usage-scheduler.ts apps/api/src/main.ts apps/api/test/integration/shopify-usage-scheduler.test.ts
git commit -m "feat(shopify): usage-report scheduler tick, wired into main.ts"
```

---

## Task 7: `packages/types` — PAYG spend-cap request schema

**Files:**
- Modify: `packages/types/src/widget.ts`

**Interfaces:**
- Produces: `PaygSpendCapBody` (Zod schema + inferred type), exported from `@tryme/types`

- [ ] **Step 1: Add the schema**

In `packages/types/src/widget.ts`, add near the other Shopify-customer-facing schemas (after `ShopifyCustomerPhotoPreviewRequest`, around line 456):

```typescript
import { MIN_PAYG_SPEND_CAP_USD_CENTS } from './payg-constants.js';

export const PaygSpendCapBody = z.object({
  spendCapUsdCents: z.number().int().min(MIN_PAYG_SPEND_CAP_USD_CENTS).max(100_000_00),
});
export type PaygSpendCapBody = z.infer<typeof PaygSpendCapBody>;
```

Since `packages/types` cannot depend on `apps/api`, the two constants this schema needs (`MIN_PAYG_SPEND_CAP_USD_CENTS`) must live in `packages/types` itself, not be imported from `apps/api/src/modules/shopify/payg.ts`. Create a small new file:

Create `packages/types/src/payg-constants.ts`:

```typescript
// Shared between packages/types (request validation) and apps/api
// (apps/api/src/modules/shopify/payg.ts re-exports these rather than
// redefining them, so the two never drift).
export const MIN_PAYG_SPEND_CAP_USD_CENTS = 500; // $5
export const DEFAULT_PAYG_SPEND_CAP_USD_CENTS = 5000; // $50
```

Update `apps/api/src/modules/shopify/payg.ts` (Task 2) to import these instead of redefining them — replace its own `export const DEFAULT_PAYG_SPEND_CAP_USD_CENTS = 5000;` and `export const MIN_PAYG_SPEND_CAP_USD_CENTS = 500;` lines with:

```typescript
export { DEFAULT_PAYG_SPEND_CAP_USD_CENTS, MIN_PAYG_SPEND_CAP_USD_CENTS } from '@tryme/types';
```

- [ ] **Step 2: Export from the package index**

`packages/types/src/index.ts` re-exports every schema file via `export * from './widget.js';` (and one line per other file). Add the matching line for the new file:

```typescript
export * from './payg-constants.js';
```

`widget.ts`'s own `export * from './widget.js';` line already covers the `PaygSpendCapBody` addition from Step 1 — no separate line needed for that.

- [ ] **Step 3: Typecheck both packages**

```bash
pnpm --filter @tryme/types typecheck
pnpm --filter @tryme/api typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/widget.ts packages/types/src/payg-constants.ts packages/types/src/index.ts apps/api/src/modules/shopify/payg.ts
git commit -m "feat(types): PAYG spend-cap request schema and shared constants"
```

---

## Task 8: `customer.routes.ts` — branch job creation on `billingMode`

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:305-306,441,451-458,460,502-509`
- Test: `apps/api/test/integration/shopify-customer.test.ts`

**Interfaces:**
- Consumes: `checkPaygSpendCap` (Task 2)
- Produces: no signature changes — `job_inputs.params` gains a `billingMode` key for `'usage'` stores; `jobs.creditsCharged` is `0` for those jobs

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/integration/shopify-customer.test.ts`, inside the
existing `describe('shopify customer routes', ...)` block, reusing its
existing `seedStore`, `seedDefaultFunnelTemplate`, `seedGarment`, and
`uploadCustomerPhoto` helpers exactly as the file's own
`'pins the default template workflow onto the job params'` test (line ~199)
already does — the only difference is setting `billingMode: 'usage'` on the
seeded store and never crediting it:

```typescript
  it('skips the credit ledger and pins billingMode for a usage-mode store', async () => {
    await seedDefaultFunnelTemplate();
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-job-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 91);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 91 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.creditsCharged).toBe(0);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputs.params as { billingMode?: string }).billingMode).toBe('usage');

    const ledgerRows = await app.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.jobId, jobId));
    expect(ledgerRows).toHaveLength(0);
  });

  it('rejects job creation when a usage-mode store is at its spend cap', async () => {
    await seedDefaultFunnelTemplate();
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-cap-job-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + 1,
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
        paygSpendCapUsdCents: 10,
      })
      .returning();
    const [existingJob] = await (app.db.insert(schema.jobs).values as never)({
      shopifyStoreId: store.id,
      customerPhotoKey: 'x',
      status: 'COMPLETED',
      creditsCharged: 0,
    }).returning();
    await app.db.insert(schema.shopifyUsageEvents).values({
      storeId: store.id,
      jobId: existingJob.id,
      priceUsdCents: 10, // already at the $0.10 cap
    });

    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 92);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 92 },
    });
    expect(res.statusCode).toBe(402);

    const jobs = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.shopifyStoreId, store.id));
    expect(jobs).toHaveLength(1); // only the pre-seeded one — nothing new was inserted
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-customer
```
Expected: FAIL — assertions on `billingMode`/`PAYG_CAP_REACHED` don't hold yet.

- [ ] **Step 3: Modify `customer.routes.ts`**

Add the import at the top of the file, alongside the existing local imports:

```typescript
import { checkPaygSpendCap } from './payg.js';
```

Replace lines 305-306:

```typescript
      const jobCost = await getTryonCreditCost(app);
      await requireStoreHasCredits(app, store, jobCost);
```

with:

```typescript
      const jobCost = store.billingMode === 'usage' ? 0 : await getTryonCreditCost(app);
      if (store.billingMode === 'usage') {
        await checkPaygSpendCap(app, store);
      } else {
        await requireStoreHasCredits(app, store, jobCost);
      }
```

In the `job_inputs` insert (currently around line 445-459), add `billingMode` into the `params` object only when relevant — replace:

```typescript
            params: {
              kind: 'shopify',
              shopifyProductId,
              // Resolved above and pinned here so the dispatcher trusts it rather
              // than re-resolving — a default promoted mid-flight can't change the
              // workflow under a job whose credits are already deducted.
              workflowTemplateId,
            },
```

with:

```typescript
            params: {
              kind: 'shopify',
              shopifyProductId,
              // Resolved above and pinned here so the dispatcher trusts it rather
              // than re-resolving — a default promoted mid-flight can't change the
              // workflow under a job whose credits are already deducted.
              workflowTemplateId,
              // Pinned at creation, same reasoning as workflowTemplateId: the
              // dispatcher must never re-check the store's live billingMode,
              // since a plan change mid-flight could otherwise change how a
              // job in progress gets billed.
              ...(store.billingMode === 'usage' ? { billingMode: 'usage' as const } : {}),
            },
```

Replace the deduction call, currently:

```typescript
          await atomicDeductStore(tx as never, storeId, jobCost, jobId);
```

with:

```typescript
          if (store.billingMode !== 'usage') {
            await atomicDeductStore(tx as never, storeId, jobCost, jobId);
          }
```

And in the enqueue-failure recovery branch (currently around line 502-509, inside `if (jobCommitted) { ... refundStoreAndMarkFailed(...) ... }`), guard the refund the same way — replace:

```typescript
            const { compensated } = await refundStoreAndMarkFailed(
              app.db,
              storeId,
              jobCost,
              jobId,
              'REFUND_ENQUEUE_FAIL',
              'ENQUEUE_FAIL',
            );
```

with a branch that, for `'usage'` stores, only transitions the job to FAILED without touching the ledger at all — this needs a small addition. Rather than forking `refundStoreAndMarkFailed` (which both refunds and transitions), for a `'usage'` store there is nothing to refund, only the FAILED transition matters. Add this local branch immediately before the existing call:

```typescript
            let compensated: boolean;
            if (store.billingMode === 'usage') {
              const [claimed] = await app.db
                .update(schema.jobs)
                .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
                .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'QUEUED')))
                .returning({ id: schema.jobs.id });
              compensated = Boolean(claimed);
            } else {
              ({ compensated } = await refundStoreAndMarkFailed(
                app.db,
                storeId,
                jobCost,
                jobId,
                'REFUND_ENQUEUE_FAIL',
                'ENQUEUE_FAIL',
              ));
            }
```

(Remove the now-duplicate original `const { compensated } = await refundStoreAndMarkFailed(...)` call this replaces.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-customer
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "feat(shopify): route PAYG job creation around the credit ledger"
```

---

## Task 9: Dispatcher — write `shopify_usage_events` on `COMPLETED`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:2085-2323` (`processShopifyJob`)
- Test: `apps/dispatcher/test/integration/shopify-payg.test.ts`

**Interfaces:**
- Consumes: `params.billingMode` (Task 8, read from the same `params` argument already passed into `processShopifyJob`)
- Produces: one `schema.shopifyUsageEvents` insert per successfully COMPLETED job for a `'usage'`-pinned job; none for a failed one

- [ ] **Step 1: Write the failing test**

Create `apps/dispatcher/test/integration/shopify-payg.test.ts`, mirroring `apps/dispatcher/test/integration/shopify.test.ts`'s exact setup (same `seedShopifyJob`-style helper, same `comfy-mock` usage, same worker registration):

```typescript
import { schema } from '@tryme/db';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-shopify-payg';
const PERSON_NODE_ID = '20';
const GARMENT_NODE_ID = '21';
const OUTPUT_NODE_ID = '10';

describe('dispatcher PAYG usage-event write', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();
    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['shopify'] },
    ]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({});
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  async function seedPaygShopifyJob() {
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-dispatch-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `payg-tpl-${Date.now()}`,
        label: 'PAYG test template',
        jsonContent: {
          [PERSON_NODE_ID]: { inputs: { image: '' } },
          [GARMENT_NODE_ID]: { inputs: { image: '' } },
          [OUTPUT_NODE_ID]: { class_type: 'SaveImage', inputs: {} },
        },
        faceNodeId: 'x',
        poseNodeId: 'x',
        bgNodeId: 'x',
        upperNodeIds: ['x'],
        facePhasePromptNode: 'x',
        garmentPhasePromptNode: 'x',
        workflowType: 'tryon',
        tryonPersonNodeId: PERSON_NODE_ID,
        tryonGarmentNodeId: GARMENT_NODE_ID,
        tryonOutputNodeId: OUTPUT_NODE_ID,
      })
      .returning();

    // biome-ignore lint/suspicious/noExplicitAny: db insert mocking
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      shopifyStoreId: store?.id,
      customerPhotoKey: `widget-inputs/${store?.id}/photo.jpg`,
      status: 'QUEUED',
      creditsCharged: 0,
    }).returning();

    // biome-ignore lint/suspicious/noExplicitAny: db insert mocking
    await (env.db.insert(schema.jobInputs).values as any)({
      jobId: job?.id,
      upperGarmentKey: `shopify-garments/${store?.id}/garment.jpg`,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { kind: 'shopify', workflowTemplateId: template?.id, billingMode: 'usage' },
    });

    for (const key of [
      `widget-inputs/${store?.id}/photo.jpg`,
      `shopify-garments/${store?.id}/garment.jpg`,
    ]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job?.id as string, storeId: store?.id as string };
  }

  it('writes exactly one shopify_usage_events row on successful completion', async () => {
    const { jobId, storeId } = await seedPaygShopifyJob();
    await env.redis.xadd('jobs:normal', '*', 'jobId', jobId, 'type', 'WIDGET_TRYON');
    await processJob(env.cfg);

    const rows = await env.db
      .select()
      .from(schema.shopifyUsageEvents)
      .where(eq(schema.shopifyUsageEvents.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storeId).toBe(storeId);
    expect(rows[0]?.status).toBe('PENDING');
    expect(rows[0]?.priceUsdCents).toBe(10);
  });

  it('writes no usage_events row when the job fails', async () => {
    const { jobId } = await seedPaygShopifyJob();
    comfy.setOptions({ fail: true });
    await env.redis.xadd('jobs:normal', '*', 'jobId', jobId, 'type', 'WIDGET_TRYON');
    await processJob(env.cfg);

    const rows = await env.db
      .select()
      .from(schema.shopifyUsageEvents)
      .where(eq(schema.shopifyUsageEvents.jobId, jobId));
    expect(rows).toHaveLength(0);
  });
});
```

`ComfyMockOptions.fail` (declared in `apps/dispatcher/test/helpers/comfy-mock.ts`)
is the existing flag this repo's other dispatcher tests already use to force
a ComfyUI failure — confirmed by reading that file, not guessed.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/dispatcher && npx vitest run test/integration/shopify-payg.test.ts
```
Expected: FAIL — no rows are ever written (the insert doesn't exist yet).

- [ ] **Step 3: Modify `processShopifyJob`**

In `apps/dispatcher/src/job/processor.ts`, `processShopifyJob` currently receives `params` as its 4th argument (confirmed at the call site in `processWidgetJob`, which routes here on `rawParams.kind === 'shopify'`). After the successful `finalizeOutput` call (the block currently reading, around line 2307-2323):

```typescript
    const { resultKey } = await finalizeOutput({
      imageBytes,
      jobId,
      userId: '',
      shopifyStoreId,
      jobWatermark: job.watermark,
      db,
      pub,
      s3,
      r2Bucket,
      jobLog,
    });

    await redis.xack(stream, 'dispatcher-cg', messageId);
    await setWorkerStatus(redis, w.id, 'IDLE');
    recordJobOutcome('success', startedAt, job.source);
    jobLog.info({ resultKey }, 'shopify job completed successfully');
```

insert the usage-event write between `finalizeOutput` and the `xack` — after the job is durably COMPLETED, before acknowledging the stream message:

```typescript
    const { resultKey } = await finalizeOutput({
      imageBytes,
      jobId,
      userId: '',
      shopifyStoreId,
      jobWatermark: job.watermark,
      db,
      pub,
      s3,
      r2Bucket,
      jobLog,
    });

    // billingMode is pinned into params at creation time (same reasoning as
    // workflowTemplateId above) — never re-queried here, so a plan change
    // mid-flight can't change how a job already in progress gets billed.
    // Best-effort: a failed insert here logs but must not prevent the
    // already-COMPLETED job from being ack'd — the merchant already got
    // their result either way, and a missed usage row is a lost-revenue
    // risk, not a correctness one.
    if (params.billingMode === 'usage') {
      try {
        await db.insert(schema.shopifyUsageEvents).values({
          storeId: shopifyStoreId,
          jobId,
          priceUsdCents: PAYG_PRICE_PER_TRYON_USD_CENTS,
        });
      } catch (err) {
        jobLog.error({ err, jobId, shopifyStoreId }, 'PAYG usage_events insert failed');
      }
    }

    await redis.xack(stream, 'dispatcher-cg', messageId);
    await setWorkerStatus(redis, w.id, 'IDLE');
    recordJobOutcome('success', startedAt, job.source);
    jobLog.info({ resultKey }, 'shopify job completed successfully');
```

Add the import at the top of `apps/dispatcher/src/job/processor.ts`, alongside the existing local imports:

```typescript
import { PAYG_PRICE_PER_TRYON_USD_CENTS } from '../lib/payg-constants.js';
```

Since the dispatcher has never imported anything from `apps/api`, this constant needs its own copy in the dispatcher package rather than an import across app boundaries. Create `apps/dispatcher/src/lib/payg-constants.ts`:

```typescript
// Kept in sync by hand with apps/api/src/modules/shopify/payg.ts's
// PAYG_PRICE_PER_TRYON_USD_CENTS — the two packages don't share a runtime
// dependency, so this is a deliberate duplication, not an import. If the
// price ever changes, both files change in the same PR.
export const PAYG_PRICE_PER_TRYON_USD_CENTS = 10;
```

Also confirm `processShopifyJob`'s existing 4th parameter is typed loosely enough to read `.billingMode` — check its signature (already established at line 2085-2095 as `params: Record<string, unknown>`) and access it as `(params as { billingMode?: string }).billingMode === 'usage'` if `params` isn't already typed with an index signature permissive enough for direct property access.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/dispatcher && npx vitest run test/integration/shopify-payg.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/src/lib/payg-constants.ts apps/dispatcher/test/integration/shopify-payg.test.ts
git commit -m "feat(dispatcher): write shopify_usage_events row on PAYG job completion"
```

---

## Task 10: Merchant-facing PAYG routes — spend-cap PATCH, `/me` extension

**Files:**
- Create: `apps/api/src/modules/shopify/payg.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `apps/api/src/modules/shopify/me.routes.ts:113-121`
- Test: `apps/api/test/integration/shopify-payg-routes.test.ts`

**Interfaces:**
- Consumes: `PaygSpendCapBody` (Task 7), `getPaygSpendThisCycleCents` (Task 2)
- Produces: `PATCH /v1/shopify/billing/payg-cap`; `/v1/shopify/me` response gains `store.billingMode`, `store.paygSpendCapUsdCents`, `paygSpendThisCycleUsdCents`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/shopify-payg-routes.test.ts`, reusing the
exact `signSessionToken`/`buildTestApp(c, { SHOPIFY_API_SECRET, SHOPIFY_API_KEY })`
pattern `shopify-billing-routes.test.ts` already establishes for
`requireShopifySession`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { signSessionToken } from '../helpers/shopify-session.js';

const API_SECRET = 'test-secret';
const API_KEY = 'test-key';

describe('PATCH /v1/shopify/billing/payg-cap', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c, { SHOPIFY_API_SECRET: API_SECRET, SHOPIFY_API_KEY: API_KEY });
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedStore() {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-cap-route-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    return store!;
  }

  it('rejects a cap below the minimum', async () => {
    const store = await seedStore();
    const token = signSessionToken(store.shopDomain, API_SECRET, API_KEY);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/billing/payg-cap',
      headers: { authorization: `Bearer ${token}` },
      payload: { spendCapUsdCents: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates the store cap for an authenticated usage-mode store', async () => {
    const store = await seedStore();
    const token = signSessionToken(store.shopDomain, API_SECRET, API_KEY);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/billing/payg-cap',
      headers: { authorization: `Bearer ${token}` },
      payload: { spendCapUsdCents: 2500 },
    });
    expect(res.statusCode).toBe(200);
    const [updated] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updated?.paygSpendCapUsdCents).toBe(2500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-payg-routes
```
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Write `payg.routes.ts`**

Create `apps/api/src/modules/shopify/payg.routes.ts`:

```typescript
import { schema } from '@tryme/db';
import { PaygSpendCapBody } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifyPaygRoutes(app: FastifyInstance) {
  app.patch(
    '/v1/shopify/billing/payg-cap',
    { preHandler: app.requireShopifySession, schema: { body: PaygSpendCapBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { spendCapUsdCents } = req.body as PaygSpendCapBody;

      await app.db
        .update(schema.shopifyStores)
        .set({ paygSpendCapUsdCents: spendCapUsdCents, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));

      return { paygSpendCapUsdCents: spendCapUsdCents };
    },
  );
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/shopify/routes.ts`, add the import alongside the others:

```typescript
import { shopifyPaygRoutes } from './payg.routes.js';
```

And register it alongside `shopifyBillingRoutes`:

```typescript
  await app.register(shopifyBillingRoutes);
  await app.register(shopifyPaygRoutes);
```

- [ ] **Step 5: Extend `/v1/shopify/me`**

In `apps/api/src/modules/shopify/me.routes.ts`, add the import:

```typescript
import { getPaygSpendThisCycleCents } from './payg.js';
```

Add, after the existing `const creditBalance = creditRow?.balance ?? 0;` block:

```typescter
    const paygSpendThisCycleUsdCents =
      store.billingMode === 'usage' ? await getPaygSpendThisCycleCents(app, store) : 0;
```

And extend the `store` object in the final returned response (currently `{ shopDomain, settings, connectedSince, planHandle, subscriptionStatus }`):

```typescript
      store: {
        shopDomain: store.shopDomain,
        settings: store.settings,
        connectedSince: store.installedAt.toISOString(),
        planHandle: store.planHandle,
        subscriptionStatus: store.subscriptionStatus,
        billingMode: store.billingMode,
        paygSpendCapUsdCents: store.paygSpendCapUsdCents,
      },
      creditBalance,
      paygSpendThisCycleUsdCents,
```

(Note the typo guard: write `typescript`, not `typescter`, in the actual edit — the fenced label above is illustrative only.)

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-payg-routes
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/payg.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/src/modules/shopify/me.routes.ts apps/api/test/integration/shopify-payg-routes.test.ts
git commit -m "feat(shopify): merchant PAYG spend-cap route and /me extension"
```

---

## Task 11: Admin override route for a store's spend cap

**Files:**
- Modify: `apps/api/src/modules/admin/shopify-stores.routes.ts`
- Test: `apps/api/test/integration/admin-shopify-stores.test.ts`

**Interfaces:**
- Produces: `PATCH /admin/shopify-stores/:id/payg-cap` — support-tool override, `SUPER_ADMIN` only (matches this file's existing role pattern for anything that changes billing-relevant state, stricter than the file's read-only `RO` guard used for `GET` routes)

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/admin-shopify-stores.test.ts`, inside its
existing `describe` block, reusing the file's own `adminAuth`/`nonAdminAuth`
headers already built in its `beforeAll` (see that file's imports of
`adminAuthHeader` and `createVerifiedUserToken`):

```typescript
  it('lets a SUPER_ADMIN override a store spend cap', async () => {
    const nonce = crypto.randomUUID();
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-admin-${nonce}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1_000_000_000),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify-stores/${store.id}/payg-cap`,
      headers: adminAuth,
      payload: { spendCapUsdCents: 10000 },
    });
    expect(res.statusCode).toBe(200);
    const [updated] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(updated?.paygSpendCapUsdCents).toBe(10000);
  });

  it('rejects a non-SUPER_ADMIN caller', async () => {
    const nonce = crypto.randomUUID();
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `payg-admin-reject-${nonce}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1_000_000_000),
        accessToken: 'enc',
        scope: 'read_products',
        billingMode: 'usage',
      })
      .returning();
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify-stores/${store.id}/payg-cap`,
      headers: nonAdminAuth,
      payload: { spendCapUsdCents: 10000 },
    });
    expect(res.statusCode).toBe(403);
  });
```

This file's existing top-of-`describe` `import { eq } from 'drizzle-orm';`
and `crypto` global (used elsewhere in the same file's `beforeAll`) already
cover both imports these tests need — no new imports required in this file.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-shopify-stores
```
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Add the route**

In `apps/api/src/modules/admin/shopify-stores.routes.ts`, add the import:

```typescript
import { PaygSpendCapBody } from '@tryme/types';
```

Add, inside `adminShopifyStoresRoutes`, after the existing `RO` constant declaration:

```typescript
  const WRITE = requireAdmin(['SUPER_ADMIN']);

  app.patch(
    '/admin/shopify-stores/:id/payg-cap',
    {
      preHandler: WRITE,
      schema: { params: z.object({ id: z.string().uuid() }), body: PaygSpendCapBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { spendCapUsdCents } = req.body as PaygSpendCapBody;
      const [updated] = await app.db
        .update(schema.shopifyStores)
        .set({ paygSpendCapUsdCents: spendCapUsdCents, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, id))
        .returning({ id: schema.shopifyStores.id, paygSpendCapUsdCents: schema.shopifyStores.paygSpendCapUsdCents });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'store not found');
      return updated;
    },
  );
```

Add the `AppError` import at the top of the file if not already present:

```typescript
import { AppError } from '../../lib/errors.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-shopify-stores
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/shopify-stores.routes.ts apps/api/test/integration/admin-shopify-stores.test.ts
git commit -m "feat(admin): SUPER_ADMIN override for a store's PAYG spend cap"
```

---

## Task 12: Frontend — PAYG plan card, spend-cap control, spend indicator

**Files:**
- Modify: `apps/shopify/src/lib/planFeatures.ts`
- Modify: `apps/shopify/src/pages/PricingPage.tsx`
- Modify: `apps/shopify/src/types.ts:76-86` (`ShopifyMe`)

**Interfaces:**
- Consumes: `ShopifyMe.store.billingMode`, `.paygSpendCapUsdCents`, `ShopifyMe.paygSpendThisCycleUsdCents` (Task 10)

- [ ] **Step 1: Extend `ShopifyMe`**

In `apps/shopify/src/types.ts`, update the `ShopifyMe` interface (currently lines 76-86):

```typescript
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
    connectedSince: string;
    planHandle: string | null;
    subscriptionStatus: string | null;
    billingMode: 'prepaid' | 'usage';
    paygSpendCapUsdCents: number | null;
  };
  creditBalance: number;
  paygSpendThisCycleUsdCents: number;
  stats: ShopifyStats;
}
```

- [ ] **Step 2: Add PAYG display copy**

In `apps/shopify/src/lib/planFeatures.ts`, add after the `PLAN_FEATURE_SETS` array:

```typescript
// Display copy only — the price-per-try-on source of truth is
// apps/api/src/modules/shopify/payg.ts's PAYG_PRICE_PER_TRYON_USD_CENTS,
// kept separate for the same reason PLAN_FEATURE_SETS is separate from
// billing-plans.ts.
export const PAYG_PRICE_PER_TRYON_USD = 0.1;
export const PAYG_MIN_SPEND_CAP_USD = 5;
```

- [ ] **Step 3: Add the PAYG card and spend-cap control to `PricingPage.tsx`**

In `apps/shopify/src/pages/PricingPage.tsx`, add the import:

```typescript
import { useState } from 'react';
import { PAYG_MIN_SPEND_CAP_USD, PAYG_PRICE_PER_TRYON_USD } from '../lib/planFeatures';
import { TextField } from '@shopify/polaris';
```

(Merge `useState` into the existing `import { useEffect, useState } from 'react';` line rather than duplicating it — check the current import first.)

Add local state for the spend-cap input, alongside the existing `me`/`error`/`loading` state:

```typescript
  const [capInput, setCapInput] = useState('');
  const [capSaving, setCapSaving] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);

  async function saveSpendCap() {
    const dollars = Number.parseFloat(capInput);
    if (Number.isNaN(dollars) || dollars < PAYG_MIN_SPEND_CAP_USD) {
      setCapError(`Minimum is $${PAYG_MIN_SPEND_CAP_USD}`);
      return;
    }
    setCapSaving(true);
    setCapError(null);
    try {
      await apiFetch('/v1/shopify/billing/payg-cap', {
        method: 'PATCH',
        body: JSON.stringify({ spendCapUsdCents: Math.round(dollars * 100) }),
      });
      const refreshed = await apiFetch<ShopifyMe>('/v1/shopify/me');
      setMe(refreshed);
    } catch (err) {
      setCapError((err as Error).message);
    } finally {
      setCapSaving(false);
    }
  }
```

(`ShopifyMe` needs importing if not already — check the existing `import type { ShopifyMe } from '../types';` line at the top of the file.)

Add, after the existing `<InlineGrid columns={{ xs: 1, md: 3 }} gap="400">...</InlineGrid>` block that renders `PLAN_FEATURE_SETS`, a distinct PAYG section — not forced into that grid, since a `$0/mo + $0.10/try-on` card has no `credits`/`virtualTryOns` fields to render and forcing it into `PlanFeatureSet`'s shape would mean fake values for fields that don't apply:

```typescript
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingLg">
                Pay as you go
              </Text>
              {me?.store.billingMode === 'usage' && <Badge>Your current plan</Badge>}
            </InlineStack>
            <Text as="p" tone="subdued">
              No monthly commitment — ${PAYG_PRICE_PER_TRYON_USD.toFixed(2)} per try-on, billed
              through your Shopify invoice.
            </Text>
            {me?.store.billingMode !== 'usage' && (
              <Box>
                <Button variant="primary" onClick={choosePlan}>
                  Choose Pay as you go
                </Button>
              </Box>
            )}
            {me?.store.billingMode === 'usage' && (
              <BlockStack gap="200">
                <Text as="p">
                  ${((me.paygSpendThisCycleUsdCents ?? 0) / 100).toFixed(2)} spent this cycle of $
                  {((me.store.paygSpendCapUsdCents ?? 0) / 100).toFixed(2)} cap
                </Text>
                <InlineStack gap="200" blockAlign="end">
                  <TextField
                    label="Monthly spend cap (USD)"
                    type="number"
                    autoComplete="off"
                    value={capInput}
                    onChange={setCapInput}
                    placeholder={((me.store.paygSpendCapUsdCents ?? 0) / 100).toString()}
                  />
                  <Button onClick={saveSpendCap} disabled={capSaving} loading={capSaving}>
                    Save
                  </Button>
                </InlineStack>
                {capError && (
                  <Text as="p" tone="critical">
                    {capError}
                  </Text>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
```

`choosePlan` is the same handler the existing `PLAN_FEATURE_SETS` cards already call — Shopify's hosted picker shows every configured plan regardless of which button triggered the navigation, so no new navigation logic is needed, only a new button.

- [ ] **Step 4: Start the dev server and verify manually**

```bash
pnpm --filter @tryme/shopify dev
```
Load the Pricing page in a dev store's embedded admin. Confirm: the PAYG card renders below the three existing plan cards; clicking "Choose Pay as you go" navigates to Shopify's hosted picker (same as the existing plan buttons); after Partner Dashboard has the PAYG plan configured and a dev-store test selection is made, confirm the spend-cap control and spend indicator render once `billingMode` flips to `'usage'`.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/shopify typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src/lib/planFeatures.ts apps/shopify/src/pages/PricingPage.tsx apps/shopify/src/types.ts
git commit -m "feat(shopify-admin): PAYG plan card, spend-cap control, spend indicator"
```

---

## Task 13: Partner Dashboard configuration (operational, not code)

**Files:** none — this task is an operational prerequisite, recorded here so it isn't lost between the code being merged and the feature actually working.

- [ ] **Step 1: Configure the PAYG plan in Partner Dashboard**

Add a fourth Shopify App Pricing plan named exactly `Pay as you go` (must normalize, via `normalizePlanName`, to `pay as you go` — matches `PAYG_PLAN_NAME` in `billing.ts`, Task 4), $0/month base, with a usage meter:
- Event handle: `tryon_generated` (must match `EVENT_HANDLE` in `payg.ts` exactly, case-sensitive)
- Pricing structure: Fixed
- Price: $0.10 per unit (must match `PAYG_PRICE_PER_TRYON_USD_CENTS = 10` in `payg.ts`)
- Billing interval: monthly (30-day)

- [ ] **Step 2: Generate App Events API credentials**

In the Dev Dashboard, generate (or confirm reuse of) a `client_id`/`client_secret` pair for the App Events API — resolves the open item flagged in this plan's Global Constraints. Set `SHOPIFY_APP_EVENTS_CLIENT_ID` and `SHOPIFY_APP_EVENTS_CLIENT_SECRET` in `.env` / staging / production per the normal env-var rollout process this repo already uses for other Shopify secrets.

- [ ] **Step 3: Record the outcome**

Per `CLAUDE.md`'s "State that lives outside the repo" guidance, record in `docs/progress.md`: the exact plan name/meter handle/price configured in Partner Dashboard, and whether the App Events credentials turned out to be shared with `SHOPIFY_API_KEY`/`SECRET` or separate — so the next session doesn't have to rediscover it.

---

## Self-Review Notes

**Spec coverage:** Every "Decisions taken" row in the spec has a task — standalone plan (Task 13 config + Task 12 UI), $0.10 price (Task 2 constant, Task 13 Partner Dashboard), merchant-set cap with admin override (Tasks 10, 11, 12), credits ledger untouched (Task 8's branching, verified by its own tests). The reconciliation mechanism (spec's "Why the reconciliation tick is load-bearing" section) is Task 4. The `shopifyShopId` correction (already existed, no lookup needed) is reflected throughout — Task 5's client takes `shopifyShopId: number` directly rather than fetching it.

**Corrections made from the spec during planning, not left implicit:**
- `shopify_stores.shopifyShopId` already exists (`bigint`, populated at install) — the spec's "lazily fetched and cached" data-model row and `getOrFetchShopifyShopId` component were dropped entirely; Task 5/9 use the existing column directly.
- The dispatcher's terminal success status is `'COMPLETED'`, not `'SUCCEEDED'` as the spec's flow diagram said — Task 9 hooks the actual `finalizeOutput`/`transitionJob('COMPLETED', ...)` call.
- The App Events endpoint and version (`https://api.shopify.com/app/unstable/events`, `unstable` being the only currently-documented version) were fetched via WebFetch against the live docs rather than guessed, and are recorded in Global Constraints.

**Type consistency:** `checkPaygSpendCap`/`getPaygSpendThisCycleCents` (Task 2) are consumed identically in Task 8 (job creation) and Task 10 (`/me` route) with the same signature. `reportUsageEvent`'s `{ shopifyShopId, jobId }` param shape (Task 5) matches what Task 6's `usage-scheduler.ts` passes from its joined query. `PaygSpendCapBody`'s `spendCapUsdCents` field name is used identically in Task 10's merchant route and Task 11's admin route.
