# Shopify Store Credit Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Shopify store its own credit balance, fully separate from any tryme.com web-app user's `user_credits`, and remove the now-pointless account-link flow that exists purely to identify a billing target.

**Architecture:** Two new tables (`shopify_store_credits`, `shopify_credit_ledger`) mirror the existing `user_credits`/`credit_ledger` pattern exactly, keyed on `storeId` instead of `userId`. Every place that currently bills a Shopify-triggered job to `store.ownerUserId` (job creation, dispatcher refund, SSE channel) switches to bill/notify the store directly. The account-link UI (`LinkAccountGate`, "Disconnect account") is deleted; the one-time trial grant moves from the link route to store-install time.

**Tech Stack:** Fastify 5, Drizzle ORM, PostgreSQL 16, Vitest (integration tests against docker-compose Postgres), React + Polaris (`apps/shopify`), React (`apps/admin-web`).

## Global Constraints

- No `ALTER` on `user_credits` or `credit_ledger` — those tables and their behavior for regular web-app users are untouched.
- Migration is additive only: two new tables, no column changes to `shopify_stores` (the unused `ownerUserId` column stays, per spec's explicit non-goal).
- `jobs.userId` and `jobs.shopifyStoreId` are already nullable — no `jobs` table migration.
- Every new grant/deduct/refund function mirrors the existing `atomicDeduct`/`refund`/`refundAndMarkFailed`/`adminGrant` idiom in `apps/api/src/modules/credits/ledger.ts`: `UPDATE ... WHERE balance >= amount` for deducts, `onConflictDoNothing` on a unique `externalRef` or `(job_id, reason)` for idempotent grants/refunds.
- No testcontainers — integration tests reuse the docker-compose Postgres/Redis/MinIO already running (`pnpm docker:up` must be up before `pnpm test`).
- No admin-triggered manual credit grants/adjustments in this pass (read-only new admin page).
- Spec: `docs/superpowers/specs/2026-08-11-shopify-store-credit-decoupling-design.md`.

---

## File Structure

**New files:**
- `packages/db/src/schema/shopify.ts` — add `shopifyStoreCredits`, `shopifyCreditLedger` table definitions (existing file, new exports).
- `apps/api/src/modules/credits/shopify-ledger.ts` — `atomicDeductStore`, `refundStoreAndMarkFailed`, `grantStore` (store-scoped equivalents of `ledger.ts`).
- `apps/api/src/modules/shopify/catalog-job.ts` — `createShopifyStoreCatalogJob`, extracted/adapted from `jobs/create.ts`'s `createJob` for store billing (admin "Generate" flow only).
- `apps/api/src/modules/admin/shopify-stores.routes.ts` — `GET /admin/shopify-stores`, `GET /admin/shopify-stores/:id/ledger`.
- `apps/admin-web/src/pages/ShopifyStoresPage.tsx` — new admin list + detail page.
- `apps/api/test/integration/shopify-store-credits.test.ts` — deduct/refund/grant tests for the new ledger.
- `apps/api/test/integration/admin-shopify-stores.test.ts` — new admin route tests.

**Modified files:**
- `apps/api/src/modules/shopify/billing.ts` — `grantShopifyTrialCredits`, `syncStoreSubscription` target new tables.
- `apps/api/src/modules/shopify/auth.routes.ts` — trial grant call moves from `/store/account/link` (deleted) to `provisionShopifyStore`; `/store/account/unlink` deleted.
- `apps/api/src/modules/shopify/catalog.routes.ts` — calls `createShopifyStoreCatalogJob` instead of shared `createJob`.
- `apps/api/src/modules/shopify/customer.routes.ts` — `requireStoreOwnerWithCredits` → store-balance check; job insert/deduct/refund/SSE-subscribe target the store.
- `apps/api/src/modules/shopify/me.routes.ts` — `creditBalance` reads `shopify_store_credits`; drops `ownerUserId` from response.
- `apps/api/src/modules/jobs/create.ts` — `resolveTryonPlan`'s `userId` param becomes `userId: string | null` (skip the custom-background-ownership branch when null).
- `apps/dispatcher/src/job/state.ts` — `transitionJob`'s `TransitionOptions` gains `shopifyStoreId?: string` for channel resolution.
- `apps/dispatcher/src/workflow/finalize.ts` — `FinalizeOutputOpts.userId` becomes `string | null`, gains `shopifyStoreId?: string`.
- `apps/dispatcher/src/job/processor.ts` — `processShopifyJob` stops reading `job.userId!`; `markShopifyFailed` drops its `userId` param, refunds via the new store-scoped tables.
- `apps/shopify/src/App.tsx` — drop the `!me?.store.ownerUserId` gate.
- `apps/shopify/src/pages/DashboardPage.tsx` — drop "Disconnect account"; plan/status becomes a prominent badge.
- `apps/shopify/src/types.ts` — `ShopifyMe.store` drops `ownerUserId`.
- `apps/admin-web/src/App.tsx`, `apps/admin-web/src/components/Sidebar.tsx` — register the new page.

**Deleted files:**
- `apps/shopify/src/components/LinkAccountGate.tsx`.

---

### Task 1: New tables — `shopify_store_credits` / `shopify_credit_ledger`

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Migration: generated under `packages/db/src/migrations/` by `drizzle-kit generate`, then hand-edited (see Step 4)

**Interfaces:**
- Produces: `schema.shopifyStoreCredits` (`{ storeId: string (PK), balance: number, updatedAt: Date }`), `schema.shopifyCreditLedger` (`{ id: string, storeId: string, delta: number, reason: string, jobId: string | null, externalRef: string | null, createdAt: Date }`) — consumed by every later task.

- [ ] **Step 1: Add the table definitions**

Add to the end of `packages/db/src/schema/shopify.ts` (after the `shopifyStores` export, keeping the same `pgTable` style already used in that file):

```ts
export const shopifyStoreCredits = pgTable('shopify_store_credits', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => shopifyStores.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyCreditLedger = pgTable('shopify_credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id')
    .notNull()
    .references(() => shopifyStores.id, { onDelete: 'cascade' }),
  delta: integer('delta').notNull(),
  reason: text('reason').notNull(),
  jobId: uuid('job_id'),
  // Idempotency key for non-job-triggered grants (trial, subscription cycle).
  // Mirrors credit_ledger.external_ref (migration 0148) and the (job_id, reason)
  // partial unique index (migration 0074) — both re-created by hand below since
  // drizzle-kit generate does not express partial unique indexes from pgTable
  // column definitions alone.
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add `integer` to the existing `drizzle-orm/pg-core` import at the top of the file if not already imported (check first — `shopifyStores` already uses `bigint`/`boolean`/`jsonb`/`text`/`timestamp`/`uuid`; `integer` is new).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `packages/db/src/migrations/` creating `shopify_store_credits` and `shopify_credit_ledger` with the columns above, plus their FKs to `shopify_stores`.

- [ ] **Step 3: Hand-edit the generated migration to add the two partial unique indexes**

Open the newly generated `.sql` file and append (after the two `CREATE TABLE` statements):

```sql
CREATE UNIQUE INDEX "shopify_credit_ledger_job_reason_idx" ON "shopify_credit_ledger" ("job_id", "reason") WHERE "job_id" IS NOT NULL;
CREATE UNIQUE INDEX "shopify_credit_ledger_external_ref_idx" ON "shopify_credit_ledger" ("external_ref") WHERE "external_ref" IS NOT NULL;
```

These mirror `credit_ledger`'s existing partial unique indexes exactly (same purpose: at-most-once refund per job, at-most-once grant per `externalRef`).

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:migrate`
Expected: migration applies cleanly against the local dev Postgres (from `pnpm docker:up`).

- [ ] **Step 5: Verify in psql**

Run: `docker exec -it $(docker ps --filter name=postgres -q) psql -U postgres -d tryme -c "\d shopify_credit_ledger"`
Expected: table exists with both unique indexes listed.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/
git commit -m "feat(db): add shopify_store_credits and shopify_credit_ledger tables"
```

---

### Task 2: Store-scoped ledger functions

**Files:**
- Create: `apps/api/src/modules/credits/shopify-ledger.ts`
- Test: `apps/api/test/integration/shopify-store-credits.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyStoreCredits`, `schema.shopifyCreditLedger` (Task 1).
- Produces: `atomicDeductStore(db, storeId, amount, jobId): Promise<number>` (returns new balance, throws `AppError('INSUFFICIENT_CREDITS', 402, ...)` if insufficient), `refundStoreAndMarkFailed(db, storeId, amount, jobId, refundReason, jobErrorCode): Promise<{ compensated: boolean }>`, `grantStore(db, storeId, amount, reason, externalRef?): Promise<{ granted: boolean }>` — consumed by Task 3 (catalog job), Task 4 (customer routes), Task 5 (dispatcher), Task 6 (billing.ts).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/shopify-store-credits.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, type TestDbContext } from '../helpers/containers.js';
import {
  atomicDeductStore,
  grantStore,
  refundStoreAndMarkFailed,
} from '../../src/modules/credits/shopify-ledger.js';

describe('shopify-ledger', () => {
  let ctx: TestDbContext;

  beforeAll(async () => {
    ctx = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb(ctx);
  });

  async function makeStore(): Promise<string> {
    const [store] = await ctx.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${crypto.randomUUID()}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1e9),
        accessToken: 'enc:test',
        scope: 'read_products,write_products',
      })
      .returning({ id: schema.shopifyStores.id });
    return store.id;
  }

  it('grantStore creates a balance and is idempotent on externalRef', async () => {
    const storeId = await makeStore();
    const first = await grantStore(ctx.db, storeId, 25, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    expect(first.granted).toBe(true);
    const second = await grantStore(ctx.db, storeId, 25, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    expect(second.granted).toBe(false);
    const [row] = await ctx.db
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    expect(row.balance).toBe(25);
  });

  it('atomicDeductStore decrements balance and throws when insufficient', async () => {
    const storeId = await makeStore();
    await grantStore(ctx.db, storeId, 10, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    const balance = await atomicDeductStore(ctx.db, storeId, 4, crypto.randomUUID());
    expect(balance).toBe(6);
    await expect(atomicDeductStore(ctx.db, storeId, 100, crypto.randomUUID())).rejects.toThrow(
      'insufficient credits',
    );
  });

  it('refundStoreAndMarkFailed refunds and marks the job FAILED exactly once', async () => {
    const storeId = await makeStore();
    await grantStore(ctx.db, storeId, 10, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    const jobId = crypto.randomUUID();
    await ctx.db.insert(schema.jobs).values({
      id: jobId,
      shopifyStoreId: storeId,
      status: 'QUEUED',
      creditsCharged: 3,
      source: 'shopify',
    });
    await atomicDeductStore(ctx.db, storeId, 3, jobId);

    const first = await refundStoreAndMarkFailed(
      ctx.db,
      storeId,
      3,
      jobId,
      'REFUND_ENQUEUE_FAIL',
      'ENQUEUE_FAIL',
    );
    expect(first.compensated).toBe(true);

    const second = await refundStoreAndMarkFailed(
      ctx.db,
      storeId,
      3,
      jobId,
      'REFUND_ENQUEUE_FAIL',
      'ENQUEUE_FAIL',
    );
    expect(second.compensated).toBe(false); // job no longer QUEUED

    const [row] = await ctx.db
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    expect(row.balance).toBe(10); // back to full, refunded exactly once
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/shopify-store-credits.test.ts`
Expected: FAIL — `Cannot find module '../../src/modules/credits/shopify-ledger.js'`

- [ ] **Step 3: Implement `shopify-ledger.ts`**

Create `apps/api/src/modules/credits/shopify-ledger.ts`:

```ts
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { creditsDeductedTotal, creditsRefundedTotal } from '@tryme/observability';
import { and, eq, gte, sql } from 'drizzle-orm';
import { AppError } from '../../lib/errors.js';

/** Store-scoped equivalent of ledger.ts's atomicDeduct — bills a Shopify store's own balance instead of any user's. */
export async function atomicDeductStore(db: DB, storeId: string, amount: number, jobId: string) {
  const balance = await db.transaction(async (tx) => {
    const res = await tx
      .update(schema.shopifyStoreCredits)
      .set({
        balance: sql`${schema.shopifyStoreCredits.balance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.shopifyStoreCredits.storeId, storeId),
          gte(schema.shopifyStoreCredits.balance, amount),
        ),
      )
      .returning({ balance: schema.shopifyStoreCredits.balance });
    if (!res.length) throw new AppError('INSUFFICIENT_CREDITS', 402, 'insufficient credits');
    await tx
      .insert(schema.shopifyCreditLedger)
      .values({ storeId, delta: -amount, reason: 'JOB_DISPATCH', jobId });
    return res[0]?.balance;
  });
  creditsDeductedTotal.inc(amount);
  return balance;
}

/** Store-scoped equivalent of ledger.ts's refundAndMarkFailed — see that function's docstring for why the refund and FAILED transition share one transaction guarded on status='QUEUED'. */
export async function refundStoreAndMarkFailed(
  db: DB,
  storeId: string,
  amount: number,
  jobId: string,
  refundReason: string,
  jobErrorCode: string,
): Promise<{ compensated: boolean }> {
  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: jobErrorCode })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'QUEUED')))
      .returning({ id: schema.jobs.id });
    if (!claimed.length) return { compensated: false, refunded: false };

    const inserted = await tx
      .insert(schema.shopifyCreditLedger)
      .values({ storeId, delta: amount, reason: refundReason, jobId })
      .onConflictDoNothing()
      .returning({ id: schema.shopifyCreditLedger.id });
    if (inserted.length) {
      await tx
        .update(schema.shopifyStoreCredits)
        .set({
          balance: sql`${schema.shopifyStoreCredits.balance} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    }
    return { compensated: true, refunded: inserted.length > 0 };
  });
  if (result.refunded) creditsRefundedTotal.inc(amount);
  return { compensated: result.compensated };
}

/** Store-scoped equivalent of ledger.ts's adminGrant idiom, but idempotent via externalRef (mirrors billing.ts's trial/subscription grants) rather than always-apply. */
export async function grantStore(
  db: DB,
  storeId: string,
  amount: number,
  reason: string,
  externalRef?: string,
): Promise<{ granted: boolean }> {
  const granted = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.shopifyCreditLedger)
      .values({ storeId, delta: amount, reason, externalRef })
      .onConflictDoNothing()
      .returning({ id: schema.shopifyCreditLedger.id });
    if (!inserted.length) return false;
    await tx
      .insert(schema.shopifyStoreCredits)
      .values({ storeId, balance: amount })
      .onConflictDoUpdate({
        target: schema.shopifyStoreCredits.storeId,
        set: {
          balance: sql`${schema.shopifyStoreCredits.balance} + ${amount}`,
          updatedAt: new Date(),
        },
      });
    return true;
  });
  return { granted };
}
```

Note: `grantStore` without an `externalRef` relies on `onConflictDoNothing()` matching nothing (no conflict target hit for a null `external_ref`, since the partial unique index only applies `WHERE external_ref IS NOT NULL`) — every call in this plan always passes one, so this is not exercised, but matches `credit_ledger`'s existing nullable-`externalRef` shape for consistency.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/shopify-store-credits.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/credits/shopify-ledger.ts apps/api/test/integration/shopify-store-credits.test.ts
git commit -m "feat(api): add store-scoped Shopify credit ledger functions"
```

---

### Task 3: `billing.ts` grants target the store, not the owner user

**Files:**
- Modify: `apps/api/src/modules/shopify/billing.ts`
- Modify: `apps/api/src/modules/shopify/auth.routes.ts` (trial grant call site moves)
- Test: `apps/api/test/integration/shopify-billing-sync.test.ts` (existing file — update assertions)

**Interfaces:**
- Consumes: `grantStore` (Task 2).
- Produces: `syncStoreSubscription(app, store, deps?)` — same return shape `SyncResult`, now grants regardless of `ownerUserId` (no longer gated on it); `grantShopifyTrialCredits(app, store)` — drops the `userId` parameter entirely.

- [ ] **Step 1: Update `syncStoreSubscription`**

In `apps/api/src/modules/shopify/billing.ts`, replace the grant block (the `if (ownerUserId !== null && amount !== null && subscription.status === 'ACTIVE')` section):

```ts
  let grantable = false;
  let creditsGranted = 0;

  if (amount !== null && subscription.status === 'ACTIVE') {
    grantable = true;
    if (isNewCycle) {
      const externalRef = `shopify_subscription:${store.id}:${subscription.id}:${
        periodEnd?.toISOString() ?? 'none'
      }`;
      const { granted } = await grantStore(
        app.db,
        store.id,
        amount,
        'SHOPIFY_SUBSCRIPTION',
        externalRef,
      );
      if (granted) creditsGranted = amount;
    }
  }
```

Delete the now-unused `const ownerUserId = store.ownerUserId;` line above it. Add the import: `import { grantStore } from '../credits/shopify-ledger.js';`. Update the doc comment above `syncStoreSubscription` (currently explains the `ownerUserId !== null` gate) to drop the reference to needing an owner — grants now apply to every active-subscription store unconditionally.

- [ ] **Step 2: Update `grantShopifyTrialCredits`**

Replace the whole function body:

```ts
export async function grantShopifyTrialCredits(
  app: FastifyInstance,
  store: Store,
): Promise<{ creditsGranted: number }> {
  const amount = await getShopifyTrialCredits(app);
  if (amount <= 0) return { creditsGranted: 0 };

  const externalRef = `shopify_trial:${store.id}`;
  const { granted } = await grantStore(app.db, store.id, amount, 'SHOPIFY_TRIAL', externalRef);
  return { creditsGranted: granted ? amount : 0 };
}
```

Update its docstring: it's no longer granted on account-link (that flow is gone) — it's granted once per store at install time, called from `provisionShopifyStore`.

- [ ] **Step 3: Move the trial-grant call site**

In `apps/api/src/modules/shopify/auth.routes.ts`, in `provisionShopifyStore` (around line 177, right after `const store = await upsertShopifyStore(...)`), add:

```ts
  const store = await upsertShopifyStore(app, details, accessToken, scope, grant);
  const { creditsGranted } = await grantShopifyTrialCredits(app, store);
  log.debug({ storeId: store.id, creditsGranted }, 'shopify trial credit grant');
```

This runs on every provisioning call (fresh install and reauthorization) — safe because `grantShopifyTrialCredits` is idempotent per store via `externalRef`. Add the import: `import { grantShopifyTrialCredits } from './billing.js';` (check for an existing import from `./billing.js` in this file first and extend it rather than duplicating).

Delete the two routes entirely: `POST /v1/shopify/store/account/link` (lines ~270-288) and `POST /v1/shopify/store/account/unlink` (lines ~290-302), along with the now-unused `resolveAccountLinkCode` import if nothing else in the file uses it (check with `grep -n resolveAccountLinkCode apps/api/src/modules/shopify/auth.routes.ts`).

- [ ] **Step 4: Update the existing integration test's stale assertions**

Open `apps/api/test/integration/shopify-billing-sync.test.ts`. Every test that currently:
- creates a store with `ownerUserId` set and asserts credits landed in `user_credits` — change to assert credits landed in `shopify_store_credits` (`WHERE store_id = store.id`) instead, and drop the `ownerUserId` setup (stores no longer need one for a grant to apply).
- asserts `grantShopifyTrialCredits(app, store, userId)` — update the call to the new two-arg signature `grantShopifyTrialCredits(app, store)`, and change its balance assertions to read `shopify_store_credits`.
- has a case for "no owner → no grant" — delete that case; a store with no owner now still gets granted (the whole point of this change).

Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/shopify-billing-sync.test.ts` after edits.
Expected: PASS (adjust exact counts as needed — re-run and read failures if any assertion still references the old shared-balance shape).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.ts apps/api/src/modules/shopify/auth.routes.ts apps/api/test/integration/shopify-billing-sync.test.ts
git commit -m "feat(api): Shopify trial and subscription credits target the store's own balance"
```

---

### Task 4: `resolveTryonPlan` accepts a nullable `userId`

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts`

**Interfaces:**
- Produces: `resolveTryonPlan(app, userId: string | null, body, opts): Promise<TryonPlan>` and `verifyGarmentKey(app, userId: string | null, key, trustedGarmentKeys?): Promise<void>` — both consumed by Task 5's new `createShopifyStoreCatalogJob`. `resolveMannequinGarmentKey` is untouched (`userId: string`, non-null) since the Shopify catalog-generate flow never calls it (`GenerateBody` has no `mannequinJobId` field).

- [ ] **Step 1: Widen `verifyGarmentKey`'s type**

In `apps/api/src/modules/jobs/create.ts`, change `verifyGarmentKey`'s `userId: string` parameter (around line 77) to `userId: string | null`, and guard the untrusted-key fallback:

```ts
export async function verifyGarmentKey(
  app: FastifyInstance,
  userId: string | null,
  key: string,
  trustedGarmentKeys?: Set<string>,
): Promise<void> {
  if (trustedGarmentKeys?.has(key)) {
    await assertGarmentObjectValid(app, key);
    return;
  }
  if (userId === null) {
    // A null userId (store-billed caller) must never reach here — every key that
    // caller passes is expected to already be in trustedGarmentKeys (see Task 5's
    // createShopifyStoreCatalogJob). Reaching this branch means a code path there
    // is passing an unverified key, which is a bug, not a recoverable case.
    throw new AppError('FORBIDDEN', 403, 'garment key ownership cannot be verified');
  }
  await assertOwnsUploadKey(app, userId, key);
}
```

- [ ] **Step 2: Widen `resolveTryonPlan`'s type and guard the custom-background branch**

In `apps/api/src/modules/jobs/create.ts`, change `resolveTryonPlan`'s signature (around line 158-161) from `userId: string` to `userId: string | null`. Find the custom-background ownership check (`eq(schema.modelBackgrounds.userId, userId)`, around line 238) and its surrounding `or(...)` — wrap that whole branch so it's skipped when `userId === null`:

```ts
        or(
          eq(schema.modelBackgrounds.isActive, true),
          userId !== null ? eq(schema.modelBackgrounds.userId, userId) : sql`false`,
        ),
```

(Match this to the exact surrounding `or(...)` structure at that line — read the current code first, since the exact query shape around it determines the precise edit; the principle is: a `userId === null` caller can only match admin-curated (`isActive = true`) backgrounds, never a custom-uploaded one, and must not crash on a null `eq(...)` operand.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS — no other caller of `resolveTryonPlan` or `verifyGarmentKey` breaks, since `string` still satisfies `string | null`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts
git commit -m "refactor(api): resolveTryonPlan and verifyGarmentKey accept a nullable userId for store-billed callers"
```

---

### Task 5: Shopify admin "Generate" — store-billed job creation

**Files:**
- Create: `apps/api/src/modules/shopify/catalog-job.ts`
- Modify: `apps/api/src/modules/shopify/catalog.routes.ts`

**Interfaces:**
- Consumes: `resolveTryonPlan(app, null, body, opts)` (Task 4), `atomicDeductStore`, `refundStoreAndMarkFailed` (Task 2).
- Produces: `createShopifyStoreCatalogJob(app, store, body, opts): Promise<{ catalogueId: string; jobIds: string[] }>` — consumed only by `catalog.routes.ts`.

- [ ] **Step 1: Write `createShopifyStoreCatalogJob`**

Create `apps/api/src/modules/shopify/catalog-job.ts`. This is `jobs/create.ts`'s `createJob` adapted for a store-billed caller: it drops the banned-check and tier/queueStream/watermark lookup (no `users` row backs a store — jobs get the schema defaults `queueStream: 'normal'`, `priority: false`, `watermark: false`, same as `customer.routes.ts`'s existing Shopify widget-job insert already relies on), and passes `null` into `resolveTryonPlan` so it can never resolve a merchant-custom background (only admin-curated ones — Shopify's `GenerateBody` doesn't expose a `mannequinJobId`/raw-garment-key path either, so `resolveMannequinGarmentKey`'s and the raw-key `verifyGarmentKey`'s per-user ownership checks are never reached by this caller):

```ts
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateTryOnJobRequest, JOB_SOURCE } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { atomicDeductStore, refundStoreAndMarkFailed } from '../credits/shopify-ledger.js';
import { resolveTryonPlan, verifyGarmentKey } from '../jobs/create.js';
import { promptGuard } from '../jobs/sanitize.js';

type Store = typeof schema.shopifyStores.$inferSelect;

/**
 * Store-billed sibling of jobs/create.ts's createJob, used only by the Shopify
 * merchant "Generate" flow (catalog.routes.ts). No `users` row backs a store,
 * so this skips the banned-check and tier/queueStream/watermark lookup that
 * createJob does for regular web-app users — jobs get the schema defaults
 * (queueStream 'normal', priority false, watermark false), matching what
 * customer.routes.ts's Shopify widget-job insert already relies on today.
 * `mannequinJobId` is never part of `GenerateBody`, so unlike createJob this
 * never needs resolveMannequinGarmentKey's per-user ownership check.
 */
export async function createShopifyStoreCatalogJob(
  app: FastifyInstance,
  store: Store,
  body: z.infer<typeof CreateTryOnJobRequest>,
  opts: { trustedGarmentKeys: Set<string> },
): Promise<{ catalogueId: string; jobIds: string[] }> {
  const { faceId, garmentTypeId, upperGarmentKey, lowerGarmentKey, thirdGarmentKey } = body.inputs;

  // Mirrors createJob's own verification calls (jobs/create.ts) — upperGarmentKey
  // is always in trustedGarmentKeys for this caller (the freshly downloaded R2 key
  // catalog.routes.ts just wrote), so this resolves to assertGarmentObjectValid,
  // not an ownership check. lowerGarmentKey/thirdGarmentKey are never populated by
  // GenerateBody today (it only sends lowerCatalogId/shoeCatalogId), but the checks
  // stay for parity with createJob in case that ever changes.
  if (upperGarmentKey) await verifyGarmentKey(app, null, upperGarmentKey, opts.trustedGarmentKeys);
  if (lowerGarmentKey) await verifyGarmentKey(app, null, lowerGarmentKey, opts.trustedGarmentKeys);
  if (thirdGarmentKey) await verifyGarmentKey(app, null, thirdGarmentKey, opts.trustedGarmentKeys);

  const plan = await resolveTryonPlan(app, null, body, {
    resolvedUpperGarmentKey: upperGarmentKey ?? null,
    trustedGarmentKeys: opts.trustedGarmentKeys,
  });

  const jobIds = await app.db.transaction(async (tx) => {
    const created: string[] = [];
    for (const look of plan.looks) {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          shopifyStoreId: store.id,
          catalogueId: plan.catalogueId,
          status: 'QUEUED',
          creditsCharged: plan.cost,
          source: JOB_SOURCE.SHOPIFY,
        })
        .returning();
      await atomicDeductStore(tx as unknown as DB, store.id, plan.cost, job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey: look.upperGarmentKey,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId: garmentTypeId ?? null,
        lowerCatalogId: look.lowerCatalogId,
        lowerGarmentKey: look.lowerGarmentKey,
        thirdGarmentKey: thirdGarmentKey ?? null,
        shoeCatalogId: look.shoeCatalogId,
        userHint: promptGuard(body.userHint),
        params: look.params,
      });
      created.push(job.id);
    }
    return created;
  });

  const stream = 'jobs:normal';
  const failedEnqueues: string[] = [];
  for (const jobId of jobIds) {
    try {
      await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'shopifyStoreId', store.id);
      jobsCreatedTotal.inc({ priority: 'normal', kind: JOB_SOURCE.SHOPIFY });
    } catch (err) {
      app.log.error({ err, jobId }, 'redis xadd failed — shopify catalog job will be refunded');
      failedEnqueues.push(jobId);
    }
  }

  if (failedEnqueues.length > 0) {
    await Promise.all(
      failedEnqueues.map((jobId) =>
        refundStoreAndMarkFailed(
          app.db,
          store.id,
          plan.cost,
          jobId,
          'REFUND_ENQUEUE_FAIL',
          'ENQUEUE_FAIL',
        ),
      ),
    );
    if (failedEnqueues.length === jobIds.length) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  return { catalogueId: plan.catalogueId, jobIds };
}
```

- [ ] **Step 2: Wire `catalog.routes.ts` to call it**

In `apps/api/src/modules/shopify/catalog.routes.ts`:
- Replace `import { createJob } from '../jobs/create.js';` with `import { createShopifyStoreCatalogJob } from './catalog-job.js';`.
- Replace the `if (!store.ownerUserId) { throw ... }` check (lines 109-111) — delete it entirely (no owner needed anymore).
- Replace the `createJob(app, store.ownerUserId, {...}, { trustedGarmentKeys: ... })` call (lines 132-150) with `createShopifyStoreCatalogJob(app, store, {...}, { trustedGarmentKeys: new Set([r2Key]) })` — same body shape, just the function and first two args change.
- Update the `jobResult` type annotation (`Awaited<ReturnType<typeof createJob>>`) to `Awaited<ReturnType<typeof createShopifyStoreCatalogJob>>`.

- [ ] **Step 3: Typecheck and run existing Shopify catalog tests**

Run: `pnpm --filter @tryme/api typecheck`
Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/shopify-catalog.test.ts` (or whatever the existing test file for this route is named — check `apps/api/test/integration/` for a `shopify-catalog*` file first)
Expected: PASS after updating any assertions in that file that set up `store.ownerUserId` and check `user_credits` — change to check `shopify_store_credits` instead, same pattern as Task 3 Step 4.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/catalog-job.ts apps/api/src/modules/shopify/catalog.routes.ts apps/api/test/integration/
git commit -m "feat(api): Shopify merchant Generate flow bills the store, not a linked user"
```

---

### Task 6: Shopify storefront widget — store-billed job creation

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts`
- Test: existing Shopify customer/widget integration test file (locate via `grep -rl "shopify/customer/jobs" apps/api/test/integration/`)

**Interfaces:**
- Consumes: `atomicDeductStore`, `refundStoreAndMarkFailed` (Task 2).
- Produces: `requireStoreHasCredits(app, store, jobCost): Promise<void>` (renamed/reshaped from `requireStoreOwnerWithCredits`, now returns nothing — no more userId to hand back).

- [ ] **Step 1: Replace `requireStoreOwnerWithCredits`**

```ts
/**
 * Confirms this store's own credit balance can afford one try-on job. Throws
 * INSUFFICIENT_CREDITS (402) either way — the widget shows the same generic
 * message for "never granted a balance" and "balance too low".
 */
async function requireStoreHasCredits(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  jobCost: number,
): Promise<void> {
  const [credits] = await app.db
    .select({ balance: schema.shopifyStoreCredits.balance })
    .from(schema.shopifyStoreCredits)
    .where(eq(schema.shopifyStoreCredits.storeId, store.id));
  if (!credits || credits.balance < jobCost) {
    throw new AppError('INSUFFICIENT_CREDITS', 402, 'insufficient credits');
  }
}
```

- [ ] **Step 2: Update the `/v1/shopify/customer/jobs` handler**

Replace `const userId = await requireStoreOwnerWithCredits(app, store, jobCost);` with `await requireStoreHasCredits(app, store, jobCost);`.

In the transaction block, change the `jobs` insert: drop `userId,` from the values object (leave `shopifyStoreId: storeId,` and the rest unchanged) — `userId` becomes implicitly `null` via the column default.

Change `await atomicDeduct(tx as never, userId, jobCost, jobId);` to `await atomicDeductStore(tx as never, storeId, jobCost, jobId);`.

Change the error-path refund: `refundAndMarkFailed(app.db, userId, jobCost, jobId, 'REFUND_ENQUEUE_FAIL', 'ENQUEUE_FAIL')` to `refundStoreAndMarkFailed(app.db, storeId, jobCost, jobId, 'REFUND_ENQUEUE_FAIL', 'ENQUEUE_FAIL')`.

Update imports: remove `atomicDeduct`, `refundAndMarkFailed` from `'../credits/ledger.js'` if nothing else in this file uses them (check first); add `atomicDeductStore`, `refundStoreAndMarkFailed` from `'../credits/shopify-ledger.js'`.

- [ ] **Step 3: Update the SSE subscribe route**

In `GET /v1/shopify/customer/jobs/:id/events` (around line 534-556), replace:

```ts
      if (!store.ownerUserId) {
        throw new AppError('NOT_FOUND', 404, 'Job not found');
      }

      writeSseHeaders(reply);
      const sub: Redis = app.redisSub.duplicate();
      const channel = `sse:events:${store.ownerUserId}`;
```

with:

```ts
      writeSseHeaders(reply);
      const sub: Redis = app.redisSub.duplicate();
      const channel = `sse:events:store:${storeId}`;
```

(The `!store.ownerUserId` 404 guard is deleted outright — every store now has a working channel, there's nothing left to gate on.)

- [ ] **Step 4: Update the existing widget-job integration test**

Find the test file (`grep -rl "shopify/customer/jobs" apps/api/test/integration/`). Update setup that gives the test store an `ownerUserId` + seeds `user_credits` — instead seed `shopify_store_credits` directly (or call the real `grantStore`/`atomicDeductStore` helpers from Task 2). Update any assertion reading `user_credits`/`credit_ledger` post-job to read `shopify_store_credits`/`shopify_credit_ledger` instead. Update the SSE test (if one exists) to subscribe on `sse:events:store:${storeId}` instead of `sse:events:${ownerUserId}`.

Run: `npx vitest run --config apps/api/vitest.integration.config.ts <that file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/
git commit -m "feat(api): Shopify storefront widget try-ons bill the store's own balance"
```

---

### Task 7: Dispatcher — refund branching + SSE rekeying

**Files:**
- Modify: `apps/dispatcher/src/job/state.ts`
- Modify: `apps/dispatcher/src/workflow/finalize.ts`
- Modify: `apps/dispatcher/src/job/processor.ts`

**Interfaces:**
- Consumes: `schema.shopifyStoreCredits`, `schema.shopifyCreditLedger` (Task 1).
- Produces: `transitionJob(db, pub, jobId, userId: string, status, opts: TransitionOptions & { shopifyStoreId?: string }, log)` — channel resolves to `sse:events:store:${shopifyStoreId}` when set, else `sse:events:${userId}`.

- [ ] **Step 1: `transitionJob` gains store-channel resolution**

In `apps/dispatcher/src/job/state.ts`, add to `TransitionOptions`:

```ts
export interface TransitionOptions {
  workerId?: string;
  errorCode?: string;
  resultKey?: string;
  thumbnailKey?: string;
  skipOutputInsert?: boolean;
  /**
   * Store-billed Shopify jobs only: SSE publishes to `sse:events:store:${shopifyStoreId}`
   * instead of `sse:events:${userId}`. Callers on this path pass userId as '' (mirrors
   * the existing kiosk-job convention of an empty userId for jobs with no real user).
   */
  shopifyStoreId?: string;
}
```

Replace the publish block at the end of `transitionJob`:

```ts
  const channelId = opts.shopifyStoreId ? `store:${opts.shopifyStoreId}` : userId;
  const ssePayload = JSON.stringify({ jobId, userId, type: 'STATUS', status, ...opts });
  const publishes = [pub.publish('sse:events:admin', ssePayload)];
  if (channelId) publishes.push(pub.publish(`sse:events:${channelId}`, ssePayload));
  await Promise.all(publishes);
  log.info({ jobId, userId, channelId, status }, 'job state transition');
```

(This is strictly additive for every existing caller — `opts.shopifyStoreId` is `undefined` unless set, so `channelId` falls back to `userId` exactly as today.)

- [ ] **Step 2: `finalizeOutput` threads `shopifyStoreId` through**

In `apps/dispatcher/src/workflow/finalize.ts`, `FinalizeOutputOpts.userId` stays `string` (unchanged — Step 3 below's caller passes `''` for it, same convention `TransitionOptions` documents), add `shopifyStoreId?: string` to the interface. Update the `transitionJob` call at the bottom:

```ts
  await transitionJob(
    db,
    pub,
    jobId,
    userId,
    'COMPLETED',
    { resultKey, thumbnailKey, skipOutputInsert: true, shopifyStoreId: opts.shopifyStoreId },
    jobLog,
  );
```

(No signature change needed to `userId` itself here — Task 3's `processShopifyJob` call passes `''` for it, matching the existing kiosk-job convention noted in `TransitionOptions`, and passes the real value via the new `shopifyStoreId` option.)

- [ ] **Step 3: `processShopifyJob` stops reading `job.userId!`**

In `apps/dispatcher/src/job/processor.ts`, in `processShopifyJob` (starts ~line 1957):
- Delete `const userId = job.userId!;` (the non-null-asserted read).
- Keep `const shopifyStoreId = job.shopifyStoreId!;`.
- Update the `finalizeOutput({...})` call (~line 2168-2178): replace `userId,` with `userId: '',` and add `shopifyStoreId,`.
- Update every `markShopifyFailed(cfg, jobId, userId, shopifyStoreId, ...)` call site within this function (5 call sites — confirm exact count via `grep -n "markShopifyFailed(" apps/dispatcher/src/job/processor.ts` before editing, since Task 7 Step 4 also changes the callee's signature) — drop the `userId` argument from each: `markShopifyFailed(cfg, jobId, shopifyStoreId, ...)`.

- [ ] **Step 4: `markShopifyFailed` refunds via the store-scoped tables**

Replace the whole function:

```ts
async function markShopifyFailed(
  cfg: ProcessorConfig,
  jobId: string,
  shopifyStoreId: string,
  creditsCharged: number,
  stream: string,
  messageId: string,
  errorCode: string,
  log: Logger,
  startedAt: number,
): Promise<void> {
  const { db, redis, pub } = cfg;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.shopifyCreditLedger)
      .where(
        and(
          eq(schema.shopifyCreditLedger.jobId, jobId),
          eq(schema.shopifyCreditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    if (existing.length) return;
    await tx
      .update(schema.shopifyStoreCredits)
      .set({ balance: sql`${schema.shopifyStoreCredits.balance} + ${creditsCharged}` })
      .where(eq(schema.shopifyStoreCredits.storeId, shopifyStoreId));
    await tx.insert(schema.shopifyCreditLedger).values({
      storeId: shopifyStoreId,
      delta: creditsCharged,
      reason: 'JOB_FAIL_REFUND',
      jobId,
    });
  });

  await transitionJob(db, pub, jobId, '', 'FAILED', { errorCode, shopifyStoreId }, log);
  await redis.xack(stream, 'dispatcher-cg', messageId);
  recordJobOutcome('failed', startedAt);
  log.warn({ jobId, shopifyStoreId, errorCode }, 'shopify job FAILED — store credits refunded');
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: PASS.

- [ ] **Step 6: Run dispatcher's existing Shopify job-processor tests**

Run: `pnpm --filter @tryme/dispatcher test -- shopify` (adjust the `-t`/file filter to whatever the existing Shopify processor test file is named — locate via `grep -rl "processShopifyJob\|markShopifyFailed" apps/dispatcher/test/` first)
Expected: PASS after updating any test setup that seeds `user_credits`/asserts on it for a Shopify job — switch to `shopify_store_credits`/`shopify_credit_ledger`, matching Task 3/6's pattern.

- [ ] **Step 7: Commit**

```bash
git add apps/dispatcher/src/job/state.ts apps/dispatcher/src/workflow/finalize.ts apps/dispatcher/src/job/processor.ts apps/dispatcher/test/
git commit -m "feat(dispatcher): Shopify job refunds and progress SSE target the store, not a user"
```

---

### Task 8: `/v1/shopify/me` reads the store balance

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`

**Interfaces:**
- Produces: `GET /v1/shopify/me` response — `creditBalance` always a number (never `null`), `store` drops `ownerUserId`.

- [ ] **Step 1: Replace the credit-balance lookup**

Replace lines 61-69:

```ts
    const [creditRow] = await app.db
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id))
      .limit(1);
    const creditBalance = creditRow?.balance ?? 0;
```

- [ ] **Step 2: Drop `ownerUserId` from the response**

In the returned `store` object (~line 116-124), delete the `ownerUserId: store.ownerUserId,` line.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts
git commit -m "feat(api): /v1/shopify/me reads the store's own credit balance"
```

---

### Task 9: Remove the account-link flow from the embedded app

**Files:**
- Delete: `apps/shopify/src/components/LinkAccountGate.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: `/v1/shopify/me` response shape from Task 8 (no `ownerUserId`, `creditBalance` always a number).

- [ ] **Step 1: Update `ShopifyMe` type**

In `apps/shopify/src/types.ts`, remove `ownerUserId: string | null;` from the `store` object in `ShopifyMe`, and change `creditBalance: number | null;` to `creditBalance: number;`.

- [ ] **Step 2: Delete `LinkAccountGate.tsx` and its usage in `App.tsx`**

Delete `apps/shopify/src/components/LinkAccountGate.tsx`.

In `apps/shopify/src/App.tsx`: remove the `import { LinkAccountGate } from './components/LinkAccountGate';` line, and delete the whole gate block:

```ts
  if (!me?.store.ownerUserId) {
    return (
      <AppProvider i18n={{}}>
        <LinkAccountGate onLinked={load} />
      </AppProvider>
    );
  }
```

- [ ] **Step 3: Remove "Disconnect account" from `DashboardPage.tsx`**

Delete: the `showDisconnect`/`disconnecting` state (lines 84-85), the `disconnectAccount` function (128-140), the `Button` at 346-348 and its `InlineStack` wrapper if it becomes the button's sole remaining content (keep the "Connected since" text if present — check what else is in that `InlineStack` before deleting the wrapper), and the confirm `Modal` (353-371).

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: PASS — no leftover references to `ownerUserId`, `LinkAccountGate`, or `disconnectAccount` (search with `grep -rn "ownerUserId\|LinkAccountGate\|disconnectAccount" apps/shopify/src/` to confirm zero hits before considering this task done).

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/
git commit -m "feat(shopify-admin): remove the account-link flow — stores bill themselves now"
```

---

### Task 10: Dashboard plan-prominence

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `me.store.planHandle`, `me.store.subscriptionStatus`, `me.creditBalance` (unchanged shape from Task 8/9, `creditBalance` now always a number).

- [ ] **Step 1: Add a prominent plan/credit badge near the top of the page**

Insert right after the `<Page title="Dashboard" ...>` opening, before the "Getting started" `Card` (i.e. as the first item inside the outer `BlockStack`):

```tsx
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="300" blockAlign="center">
              <Badge tone={me?.store.subscriptionStatus === 'active' ? 'success' : 'attention'} size="large">
                {me?.store.planHandle
                  ? `${PLAN_LABELS[me.store.planHandle] ?? me.store.planHandle} plan`
                  : 'No plan selected'}
              </Badge>
              {me?.store.planHandle && me.store.subscriptionStatus !== 'active' && (
                <Text as="span" tone="subdued">
                  {me.store.subscriptionStatus}
                </Text>
              )}
              <Text as="span" variant="headingLg">
                {me?.creditBalance ?? 0} credits
              </Text>
            </InlineStack>
            <Button onClick={() => navigate('/pricing')}>
              {me?.store.planHandle ? 'Manage plan' : 'Choose a plan'}
            </Button>
          </InlineStack>
        </Card>
```

- [ ] **Step 2: Remove the now-redundant plan/credit block from the stats grid**

The existing "Credit balance" card (lines 274-297, the first `Card` in the second `InlineGrid`) duplicates what Step 1 now shows prominently — delete that `Card` entirely, leaving the "Today's try-ons" and "Sync status" cards as a two-column `InlineGrid` (update `columns={{ xs: 1, sm: 3 }}` to `columns={{ xs: 1, sm: 2 }}` on that `InlineGrid` since it now holds two cards, not three).

- [ ] **Step 3: Manual verification**

Run `make shopify-dev-dev` (or `shopify-dev`, whichever config you're testing against), open the dashboard, confirm: plan badge shows at the top with the right tone (green for active, amber otherwise), credit count matches `/v1/shopify/me`'s `creditBalance`, "Manage plan" navigates to `/pricing`, and the stats grid below no longer has a duplicate credit card.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify/src/pages/DashboardPage.tsx
git commit -m "feat(shopify-admin): make active plan and credit balance prominent on the dashboard"
```

---

### Task 11: Admin "Shopify Stores" page — backend

**Files:**
- Create: `apps/api/src/modules/admin/shopify-stores.routes.ts`
- Modify: `apps/api/src/server.ts` (register the new route module)
- Test: `apps/api/test/integration/admin-shopify-stores.test.ts`

**Interfaces:**
- Produces: `GET /admin/shopify-stores` → `{ stores: Array<{ id, shopDomain, planHandle, subscriptionStatus, balance, installedAt, uninstalledAt }> }`; `GET /admin/shopify-stores/:id/ledger?cursor=&limit=` → `{ entries: Array<{ id, delta, reason, jobId, createdAt }>, nextCursor: string | null }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/admin-shopify-stores.test.ts` following the existing admin-route test pattern in this directory (check `apps/api/test/integration/admin-config.test.ts` for the harness setup — `buildTestApp()`, an admin JWT/session helper, etc. — and mirror it exactly): seed 2 stores (one with a `shopify_store_credits` row + a few `shopify_credit_ledger` rows, one without), assert `GET /admin/shopify-stores` returns both with `balance: 0` for the store with no credits row, assert `GET /admin/shopify-stores/:id/ledger` returns the seeded ledger rows newest-first, and assert both routes 403 for a non-admin session.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/admin-shopify-stores.test.ts`
Expected: FAIL — routes don't exist (404).

- [ ] **Step 3: Implement the routes**

Create `apps/api/src/modules/admin/shopify-stores.routes.ts`, following `apps/api/src/modules/admin/shopify-funnels.routes.ts`'s structure (`requireAdmin` import, route registration function shape):

```ts
import { schema } from '@tryme/db';
import { desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from './guard.js';

const LedgerQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function adminShopifyStoresRoutes(app: FastifyInstance) {
  const RO = requireAdmin(['SUPER_ADMIN', 'SUPPORT', 'ADMIN']);

  app.get('/admin/shopify-stores', { preHandler: RO }, async () => {
    const stores = await app.db
      .select({
        id: schema.shopifyStores.id,
        shopDomain: schema.shopifyStores.shopDomain,
        planHandle: schema.shopifyStores.planHandle,
        subscriptionStatus: schema.shopifyStores.subscriptionStatus,
        installedAt: schema.shopifyStores.installedAt,
        uninstalledAt: schema.shopifyStores.uninstalledAt,
        balance: sql<number>`COALESCE(${schema.shopifyStoreCredits.balance}, 0)`,
      })
      .from(schema.shopifyStores)
      .leftJoin(
        schema.shopifyStoreCredits,
        eq(schema.shopifyStoreCredits.storeId, schema.shopifyStores.id),
      )
      .orderBy(desc(schema.shopifyStores.installedAt));
    return { stores };
  });

  app.get(
    '/admin/shopify-stores/:id/ledger',
    { preHandler: RO, schema: { params: z.object({ id: z.string().uuid() }), querystring: LedgerQuery } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { cursor, limit } = req.query as z.infer<typeof LedgerQuery>;
      const entries = await app.db
        .select({
          id: schema.shopifyCreditLedger.id,
          delta: schema.shopifyCreditLedger.delta,
          reason: schema.shopifyCreditLedger.reason,
          jobId: schema.shopifyCreditLedger.jobId,
          createdAt: schema.shopifyCreditLedger.createdAt,
        })
        .from(schema.shopifyCreditLedger)
        .where(
          cursor
            ? sql`${schema.shopifyCreditLedger.storeId} = ${id} AND ${schema.shopifyCreditLedger.createdAt} < ${new Date(cursor)}`
            : eq(schema.shopifyCreditLedger.storeId, id),
        )
        .orderBy(desc(schema.shopifyCreditLedger.createdAt))
        .limit(limit);
      const nextCursor =
        entries.length === limit ? entries[entries.length - 1].createdAt.toISOString() : null;
      return { entries, nextCursor };
    },
  );
}
```

- [ ] **Step 4: Register the module**

In `apps/api/src/server.ts`, find where other admin route modules are imported/registered (e.g. `adminShopifyFunnelsRoutes` per the CLAUDE.md route table) and add alongside it:

```ts
import { adminShopifyStoresRoutes } from './modules/admin/shopify-stores.routes.js';
// ...
await app.register(adminShopifyStoresRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --config apps/api/vitest.integration.config.ts apps/api/test/integration/admin-shopify-stores.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/shopify-stores.routes.ts apps/api/src/server.ts apps/api/test/integration/admin-shopify-stores.test.ts
git commit -m "feat(api): add read-only admin Shopify Stores routes"
```

---

### Task 12: Admin "Shopify Stores" page — frontend

**Files:**
- Create: `apps/admin-web/src/pages/ShopifyStoresPage.tsx`
- Modify: `apps/admin-web/src/App.tsx`
- Modify: `apps/admin-web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `GET /admin/shopify-stores`, `GET /admin/shopify-stores/:id/ledger` (Task 11).

- [ ] **Step 1: Register the route and nav entry**

In `apps/admin-web/src/App.tsx`: add `import ShopifyStoresPage from './pages/ShopifyStoresPage';`, add `'shopify-stores': 'Shopify Stores',` to `PATH_LABELS`, add `<Route path="/shopify-stores" element={<ShopifyStoresPage {...pageProps} />} />` to the `<Routes>` block (alongside `/credit-analysis`).

In `apps/admin-web/src/components/Sidebar.tsx`: add a nav item in the "Operations" section (alongside `credit-analysis`, same `roles`):

```ts
      {
        k: 'shopify-stores',
        label: 'Shopify Stores',
        icon: Icon.Coin,
        roles: ['SUPER_ADMIN', 'SUPPORT', 'ADMIN'],
      },
```

- [ ] **Step 2: Build the page**

Create `apps/admin-web/src/pages/ShopifyStoresPage.tsx`, following `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx`'s data-fetching/table conventions (check that file first for the exact `apiFetch`/table-component/loading-state pattern this codebase uses, and match it — do not introduce a new table styling approach). List view: columns for shop domain, plan, subscription status, balance, installed/uninstalled dates. Clicking a row opens a detail panel/route showing that store's ledger (reason, delta, timestamp, jobId), paginated via the `cursor`/`nextCursor` from Task 11's API with a "Load more" button.

- [ ] **Step 3: Manual verification**

Run `pnpm --filter @tryme/admin dev`, log in as an admin, navigate to "Shopify Stores", confirm the list loads, click a row, confirm the ledger loads and paginates.

- [ ] **Step 4: Build check**

Run: `pnpm --filter @tryme/admin build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/pages/ShopifyStoresPage.tsx apps/admin-web/src/App.tsx apps/admin-web/src/components/Sidebar.tsx
git commit -m "feat(admin): add read-only Shopify Stores page (credit balance + activity)"
```

---

### Task 13: Full-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages/apps.

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 3: Full API integration suite**

Run: `pnpm --filter @tryme/api test:integration` (requires `pnpm docker:up` already running)
Expected: PASS, including every test file touched in Tasks 3, 5, 6, 11.

- [ ] **Step 4: Dispatcher test suite**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: PASS, including the file touched in Task 7 Step 6.

- [ ] **Step 5: Grep for orphaned references**

Run: `grep -rn "ownerUserId" apps/ packages/ --include=*.ts --include=*.tsx | grep -v node_modules`
Expected: only hits in `packages/db/src/schema/shopify.ts` (the column definition itself, kept per the spec's non-goal) and possibly old migration files (never edit those) — zero hits in any route, dispatcher, or frontend source file.

- [ ] **Step 6: Manual end-to-end pass**

Against a dev store (`make shopify-dev-dev`): fresh install → confirm trial credits granted (check admin Shopify Stores page or `shopify_store_credits` directly) → merchant "Generate" from Manage page → storefront widget try-on → confirm both deduct the store balance → force one enqueue failure if feasible (or trust the covered test) → confirm SSE progress reaches the widget during a real try-on.

- [ ] **Step 7: Update `docs/progress.md`**

Add a dated entry (today's date) under a new top entry: what shipped (store-scoped Shopify credits, account-link removal, admin Shopify Stores page), and note the Non-goals from the spec (ownerUserId column left unused, no historical credit migration) so a future reader isn't surprised by them.

- [ ] **Step 8: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log Shopify store credit decoupling completion"
```
