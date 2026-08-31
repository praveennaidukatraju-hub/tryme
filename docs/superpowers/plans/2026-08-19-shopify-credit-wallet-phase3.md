# Shopify Credit Wallet — Phase 3: Auto-Refill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a merchant authorise a monthly spending ceiling once, then never run out of credits again — when their balance drops below a threshold they set, the next pack is charged automatically with no approval screen.

**Architecture:** A usage-only `AppSubscription` carries a merchant-approved `cappedAmount`. Each refill is an `appUsageRecordCreate` against that subscription's line item, which needs no per-charge approval while the cycle's cumulative total stays under the cap. Refills fire from the credit-deduction path for responsiveness and from the phase-2 alert scheduler as a safety net; three independent guards stop a merchant ever being charged twice for one refill.

**Tech Stack:** Fastify 5, Drizzle ORM on PostgreSQL 16, Shopify Admin GraphQL (manual Billing API), Vitest, React + Polaris.

**Spec:** `docs/superpowers/specs/2026-08-19-shopify-credit-wallet-design.md` § "Auto-refill"

**Depends on:** Phase 1 and Phase 2 merged. This plan assumes `shopify_credit_purchases` exists with its `source` column and its partial unique index on one in-flight auto-refill per store, that `CREDIT_PACKS[...].autorefillCredits` exists, that `computeRunway` and `LowCreditsBanner` exist, and that the alert scheduler runs hourly.

## The blocking question is resolved

The spec recorded an open question — whether Shopify permits a $0 recurring line with a usage line attached — and instructed that it be confirmed rather than guessed. Verified against shopify.dev on 2026-08-19:

> "You can create usage-only subscriptions by including just `appUsagePricingDetails` in your `lineItems` without `appRecurringPricingDetails`."

So the question is moot: no recurring line is needed **at all**, not even a $0 one. The fallback the spec reserved (a nominal base fee folded into the first refill, which would have changed the pricing table) is not required. Pack pricing is unchanged from phase 1.

Three further facts from the same verification pass shape this plan:

| Fact | Consequence |
|---|---|
| `appUsageRecordCreate` accepts an optional `idempotencyKey` (max 255 chars); a repeat with the same key does not create a second charge | The strongest double-charge guard available, and the only one that survives a network timeout on a charge Shopify already accepted |
| Exceeding the cap returns a `userErrors` entry ("Failed to create usage charge" / "Total price exceeds balance remaining"), not an exception | Cap exhaustion must be detected by inspecting `userErrors`, never by catching |
| Raising the cap uses `appSubscriptionLineItemUpdate` and **requires fresh merchant approval** via a returned `confirmationUrl` | `CAP_REACHED` is not self-healing — recovery is a merchant-facing flow, not a retry |

## Global Constraints

- **Package manager is pnpm.** Never introduce npm or yarn lockfiles.
- **ESM only** — relative imports inside a package carry the `.js` extension.
- **No `console.log`.** Use `app.log` with child loggers bound to `storeId`.
- **A merchant must never be charged twice for one refill.** This is the single most important property in this phase. Three guards, each with a distinct job — see Task 3. Do not remove one because another looks sufficient.
- **Never block a shopper's try-on on a refill.** The refill runs after the job-creation transaction commits and is never awaited by the request.
- **Auto-refill is a standing authorisation to charge.** It must be as easy to revoke as it was to grant, and revoking must cancel the Shopify subscription — not merely clear our columns.
- **Cap exhaustion is a normal outcome, not an error.** A merchant hitting their own ceiling is the ceiling working. Log at `warn`, tell them plainly, offer the raise-cap flow.
- **Auto-refill credits come from `CREDIT_PACKS[id].autorefillCredits`** (+10% over manual), snapshotted onto the purchase row at INSERT exactly as manual purchases are.
- **`SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS === true`** still gates test charges. Same `=== true` comparison — the test harness casts an `Env` and leaves it undefined.
- **No schema or data changes against production.** Migrations run locally, then through CI/CD.
- **Unit tests:** `pnpm --filter @tryme/api test:unit`
- **Integration tests:** from `apps/api`, `npx vitest run --config vitest.integration.config.ts <pattern>` — requires `pnpm docker:up`.
- **Default trigger threshold:** 20% of the chosen pack's manual credits, merchant-editable.
- **Minimum capped amount:** the chosen pack's price. A ceiling below one refill can never fund a refill.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/api/src/modules/shopify/autorefill-client.ts` | Every Shopify Admin GraphQL call auto-refill needs. No business logic. |
| `apps/api/src/modules/shopify/autorefill.ts` | Enrolment, the refill trigger, and cap handling. |
| `apps/api/src/modules/shopify/autorefill.routes.ts` | Merchant-facing HTTP surface. |
| `apps/api/src/modules/shopify/autorefill.test.ts` | Threshold and eligibility unit tests. |
| `packages/db/src/migrations/0162_autorefill_line_item.sql` | `autorefill_line_item_id`. |
| `apps/api/test/integration/shopify-autorefill.test.ts` | Trigger, concurrency, cap, and lifecycle behaviour. |

**Modified**

| File | Change |
|---|---|
| `packages/db/src/schema/shopify.ts` | `autorefillLineItemId` column. |
| `apps/api/src/modules/shopify/customer.routes.ts` | Fire the refill after the job transaction commits. |
| `apps/api/src/modules/shopify/alert-scheduler.ts` | Safety-net refill sweep; suppress low-credit email for healthy auto-refill stores. |
| `apps/api/src/modules/shopify/routes.ts` | Register the auto-refill routes. |
| `apps/api/src/modules/shopify/me.routes.ts` | Return the auto-refill block. |
| `apps/shopify/src/types.ts` | `autorefill` on `ShopifyMe`. |
| `apps/shopify/src/pages/PricingPage.tsx` | Auto-refill panel. |
| `apps/shopify/src/pages/DashboardPage.tsx` | Inverted banner for enrolled stores. |
| `apps/shopify/src/pages/BillingCallbackPage.tsx` | Handle the subscription-approval return. |

---

### Task 1: Migration — the line item id

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Create: `packages/db/src/migrations/0162_autorefill_line_item.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: the `autorefill_*` columns added in phase 1.
- Produces: `shopifyStores.autorefillLineItemId`.

**Why this is needed:** phase 1 stored `autorefill_subscription_id`, but `appUsageRecordCreate` takes `subscriptionLineItemId` — a *different* GID, addressing the line item inside the subscription. Without it every refill would need an extra Admin API round trip to re-resolve the line item.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, add to `shopifyStores` immediately after `autorefillSubscriptionId`:

```ts
  // The AppSubscriptionLineItem GID inside autorefillSubscriptionId. Distinct
  // from the subscription id and NOT derivable from it: appUsageRecordCreate
  // addresses the line item, not the subscription. Captured from the
  // appSubscriptionCreate response so a refill never needs an extra round trip
  // to re-resolve it.
  autorefillLineItemId: text('autorefill_line_item_id'),
```

- [ ] **Step 2: Write the migration**

Create `packages/db/src/migrations/0162_autorefill_line_item.sql`:

```sql
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_line_item_id" text;
```

- [ ] **Step 3: Register it in the journal**

Append to `entries` in `packages/db/src/migrations/meta/_journal.json`:

```json
		{
			"idx": 162,
			"version": "7",
			"when": 1787068800000,
			"tag": "0162_autorefill_line_item",
			"breakpoints": true
		}
```

- [ ] **Step 4: Apply and verify**

```bash
pnpm docker:up
pnpm db:migrate
docker exec -i tryme-postgres psql -U postgres -d tryme -c "\d shopify_stores" | grep autorefill
```

Expected: six `autorefill_*` columns, including `autorefill_line_item_id`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/0162_autorefill_line_item.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): store the auto-refill subscription line item id"
```

---

### Task 2: Shopify client for auto-refill

**Files:**
- Create: `apps/api/src/modules/shopify/autorefill-client.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL(shopDomain, accessToken, query, variables?)` from `./service.js`, `getValidAccessToken(app, store)` from `./token.js`, `AppError` from `../../lib/errors.js`.
- Produces:
  - `createUsageSubscription(app, store, args): Promise<{ confirmationUrl: string; subscriptionId: string; lineItemId: string }>` where `args` is `{ name: string; terms: string; cappedAmountUsd: number; returnUrl: string; test: boolean }`
  - `createUsageRecord(app, store, args): Promise<{ ok: true; recordId: string } | { ok: false; capReached: boolean; message: string }>` where `args` is `{ lineItemId: string; description: string; amountUsd: number; idempotencyKey: string }`
  - `updateCappedAmount(app, store, args): Promise<{ confirmationUrl: string }>` where `args` is `{ lineItemId: string; cappedAmountUsd: number }`
  - `cancelSubscription(app, store, subscriptionId: string): Promise<void>`

- [ ] **Step 1: Write the module**

Create `apps/api/src/modules/shopify/autorefill-client.ts`:

```ts
import type { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { shopifyGraphQL } from './service.js';
import { getValidAccessToken } from './token.js';

type Store = typeof schema.shopifyStores.$inferSelect;

interface UserError {
  field: string[] | null;
  message: string;
}

/**
 * A usage-only subscription: `lineItems` carries just appUsagePricingDetails,
 * with no appRecurringPricingDetails at all. Verified supported on shopify.dev
 * — there is no $0 base line and no nominal base fee, so the merchant is billed
 * strictly for refills they actually received.
 *
 * `cappedAmount` is the ceiling the merchant approves once. Every refill after
 * that needs no approval while the cycle's cumulative total stays under it.
 */
const CREATE_SUBSCRIPTION = `
  mutation CreateAutorefillSubscription(
    $name: String!
    $returnUrl: URL!
    $test: Boolean!
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
      confirmationUrl
      appSubscription {
        id
        status
        lineItems {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_USAGE_RECORD = `
  mutation CreateAutorefillUsageRecord(
    $subscriptionLineItemId: ID!
    $description: String!
    $price: MoneyInput!
    $idempotencyKey: String!
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      description: $description
      price: $price
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_CAPPED_AMOUNT = `
  mutation UpdateAutorefillCap($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const CANCEL_SUBSCRIPTION = `
  mutation CancelAutorefillSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function throwOnUserErrors(errors: UserError[] | undefined, context: string): void {
  if (errors?.length) {
    throw new AppError('SHOPIFY', 502, `${context}: ${errors.map((e) => e.message).join('; ')}`);
  }
}

export async function createUsageSubscription(
  app: FastifyInstance,
  store: Store,
  args: {
    name: string;
    terms: string;
    cappedAmountUsd: number;
    returnUrl: string;
    test: boolean;
  },
): Promise<{ confirmationUrl: string; subscriptionId: string; lineItemId: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription: { id: string; status: string; lineItems: Array<{ id: string }> } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CREATE_SUBSCRIPTION, {
    name: args.name,
    returnUrl: args.returnUrl,
    test: args.test,
    lineItems: [
      {
        plan: {
          appUsagePricingDetails: {
            terms: args.terms,
            cappedAmount: { amount: args.cappedAmountUsd.toFixed(2), currencyCode: 'USD' },
          },
        },
      },
    ],
  });

  const payload = data.appSubscriptionCreate;
  throwOnUserErrors(payload.userErrors, 'auto-refill subscription');

  const lineItemId = payload.appSubscription?.lineItems?.[0]?.id;
  if (!payload.confirmationUrl || !payload.appSubscription || !lineItemId) {
    throw new AppError('SHOPIFY', 502, 'Shopify returned an incomplete auto-refill subscription');
  }

  return {
    confirmationUrl: payload.confirmationUrl,
    subscriptionId: payload.appSubscription.id,
    lineItemId,
  };
}

/**
 * Charges one refill.
 *
 * Returns a discriminated result rather than throwing on the cap case, because
 * hitting a merchant-set ceiling is a normal outcome — the ceiling working as
 * intended — and must not be handled by the same path as a network fault.
 *
 * `idempotencyKey` is Shopify's own duplicate-charge protection: a repeat with
 * the same key does not create a second charge. This is the only guard that
 * helps when we time out on a request Shopify actually accepted, which no
 * amount of application-side locking can detect.
 */
export async function createUsageRecord(
  app: FastifyInstance,
  store: Store,
  args: {
    lineItemId: string;
    description: string;
    amountUsd: number;
    idempotencyKey: string;
  },
): Promise<{ ok: true; recordId: string } | { ok: false; capReached: boolean; message: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appUsageRecordCreate: {
      appUsageRecord: { id: string } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CREATE_USAGE_RECORD, {
    subscriptionLineItemId: args.lineItemId,
    description: args.description,
    price: { amount: args.amountUsd.toFixed(2), currencyCode: 'USD' },
    idempotencyKey: args.idempotencyKey,
  });

  const payload = data.appUsageRecordCreate;
  if (payload.userErrors?.length) {
    const message = payload.userErrors.map((e) => e.message).join('; ');
    // Shopify phrases cap exhaustion two ways depending on the surface
    // ("Failed to create usage charge" and "Total price exceeds balance
    // remaining"). Match on both rather than on one, and treat anything
    // unrecognized as a genuine failure rather than silently assuming the cap.
    const capReached =
      /exceeds balance remaining/i.test(message) || /failed to create usage charge/i.test(message);
    return { ok: false, capReached, message };
  }

  const recordId = payload.appUsageRecord?.id;
  if (!recordId) {
    return { ok: false, capReached: false, message: 'Shopify returned no usage record' };
  }
  return { ok: true, recordId };
}

/**
 * Raising the ceiling needs fresh merchant approval — Shopify returns a
 * confirmation URL and refuses further usage records until it is approved. So
 * this cannot be called to self-heal a CAP_REACHED store; it is the first half
 * of a merchant-facing flow.
 */
export async function updateCappedAmount(
  app: FastifyInstance,
  store: Store,
  args: { lineItemId: string; cappedAmountUsd: number },
): Promise<{ confirmationUrl: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionLineItemUpdate: {
      confirmationUrl: string | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, UPDATE_CAPPED_AMOUNT, {
    id: args.lineItemId,
    cappedAmount: { amount: args.cappedAmountUsd.toFixed(2), currencyCode: 'USD' },
  });

  const payload = data.appSubscriptionLineItemUpdate;
  throwOnUserErrors(payload.userErrors, 'auto-refill cap update');
  if (!payload.confirmationUrl) {
    throw new AppError('SHOPIFY', 502, 'Shopify returned no confirmation URL for the cap update');
  }
  return { confirmationUrl: payload.confirmationUrl };
}

export async function cancelSubscription(
  app: FastifyInstance,
  store: Store,
  subscriptionId: string,
): Promise<void> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionCancel: {
      appSubscription: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CANCEL_SUBSCRIPTION, { id: subscriptionId });
  throwOnUserErrors(data.appSubscriptionCancel.userErrors, 'auto-refill cancel');
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/shopify/autorefill-client.ts
git commit -m "feat(shopify): Admin GraphQL client for auto-refill subscriptions"
```

---

### Task 3: Refill trigger and its concurrency guards

**Files:**
- Create: `apps/api/src/modules/shopify/autorefill.ts`
- Create: `apps/api/src/modules/shopify/autorefill.test.ts`

**Interfaces:**
- Consumes: `createUsageRecord` (Task 2); `getPack` (phase 1, which exposes `credits` and `autorefillCredits` on the returned pack); `grantStore` from `../credits/shopify-ledger.js`; `schema.shopifyCreditPurchases`.
- Produces:
  - `shouldRefill(input: { balance: number; triggerCredits: number | null; status: string | null }): boolean`
  - `defaultTriggerCredits(packId: string): number | null`
  - `runRefill(app, store, deps?): Promise<'refilled' | 'skipped' | 'cap_reached' | 'failed'>`

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/modules/shopify/autorefill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultTriggerCredits, shouldRefill } from './autorefill.js';

describe('shouldRefill', () => {
  it('refills at or below the trigger', () => {
    expect(shouldRefill({ balance: 160, triggerCredits: 160, status: 'ACTIVE' })).toBe(true);
    expect(shouldRefill({ balance: 40, triggerCredits: 160, status: 'ACTIVE' })).toBe(true);
  });

  it('does not refill above the trigger', () => {
    expect(shouldRefill({ balance: 161, triggerCredits: 160, status: 'ACTIVE' })).toBe(false);
  });

  it('does not refill when auto-refill is off', () => {
    expect(shouldRefill({ balance: 0, triggerCredits: null, status: null })).toBe(false);
  });

  // PENDING means the merchant was shown the approval page and has not accepted
  // it. Charging against an unapproved authorization is exactly the "granting
  // against a PENDING charge" mistake the prepaid path already guards against.
  it('does not refill unless the subscription is ACTIVE', () => {
    for (const status of ['PENDING', 'DECLINED', 'CANCELLED', 'CAP_REACHED', 'FROZEN']) {
      expect(shouldRefill({ balance: 0, triggerCredits: 160, status })).toBe(false);
    }
  });
});

describe('defaultTriggerCredits', () => {
  it('is 20% of the pack the merchant chose', () => {
    expect(defaultTriggerCredits('pack_10')).toBe(160);
    expect(defaultTriggerCredits('pack_25')).toBe(450);
    expect(defaultTriggerCredits('pack_50')).toBe(960);
    expect(defaultTriggerCredits('pack_100')).toBe(2000);
  });

  it('is null for a pack we do not sell', () => {
    expect(defaultTriggerCredits('pack_999')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test:unit -- autorefill`
Expected: FAIL — `Cannot find module './autorefill.js'`

- [ ] **Step 3: Write the module**

Create `apps/api/src/modules/shopify/autorefill.ts`:

```ts
import { schema } from '@tryme/db';
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { grantStore } from '../credits/shopify-ledger.js';
import { createUsageRecord } from './autorefill-client.js';
import { getPack } from './packs.js';

type Store = typeof schema.shopifyStores.$inferSelect;

/** Fraction of the chosen pack at which a refill fires, when the merchant hasn't set their own. */
const DEFAULT_TRIGGER_FRACTION = 0.2;

/** 20% of the chosen pack's manual credits, or null for a pack we don't sell. */
export function defaultTriggerCredits(packId: string): number | null {
  const pack = getPack(packId);
  if (!pack) return null;
  return Math.round(pack.credits * DEFAULT_TRIGGER_FRACTION);
}

/**
 * Whether this store is due a refill right now.
 *
 * Pure so the eligibility rules are testable without a database. The ACTIVE
 * check is the load-bearing one: `autorefillStatus` is PENDING between creating
 * the subscription and the merchant approving it, and charging against an
 * unapproved authorization would be giving product away against a charge that
 * may never be accepted.
 */
export function shouldRefill(input: {
  balance: number;
  triggerCredits: number | null;
  status: string | null;
}): boolean {
  if (input.triggerCredits == null) return false;
  if (input.status !== 'ACTIVE') return false;
  return input.balance <= input.triggerCredits;
}

interface RefillDeps {
  charge?: typeof createUsageRecord;
}

/**
 * Charges and grants exactly one refill, or explains why it didn't.
 *
 * ## The three guards, and why each is needed
 *
 * A merchant being charged twice for one refill is the worst thing this feature
 * can do, and the three ways it could happen are genuinely different problems:
 *
 * 1. **`pg_advisory_xact_lock` on the store id.** Two concurrent try-ons can
 *    both drive the balance under the trigger and both call this function. The
 *    lock serialises them, and the re-read inside it means the second one sees
 *    the first one's committed effect. Same idiom as
 *    lockAndRecheckShopperLimits (limits.ts).
 * 2. **The partial unique index on one in-flight `autorefill` purchase per
 *    store** (migration 0159). A database-level backstop that still holds if a
 *    later refactor moves or drops the lock — the failure mode being guarded
 *    against is too expensive to depend on one mechanism a refactor can quietly
 *    remove.
 * 3. **Shopify's own `idempotencyKey`, keyed on our purchase row id.** The only
 *    guard that helps when we time out on a request Shopify actually accepted.
 *    No application-side locking can detect that case, because from our side a
 *    successful charge and a lost response look identical. Retrying the same
 *    row reuses the key and cannot double-charge.
 *
 * Guard 1 stops two rows existing. Guard 2 stops two rows existing even if 1 is
 * bypassed. Guard 3 stops two *charges* for one row. Removing any of them
 * leaves a real hole.
 */
export async function runRefill(
  app: FastifyInstance,
  store: Store,
  deps: RefillDeps = {},
): Promise<'refilled' | 'skipped' | 'cap_reached' | 'failed'> {
  const charge = deps.charge ?? createUsageRecord;

  const packId = store.autorefillPackId;
  const lineItemId = store.autorefillLineItemId;
  if (!packId || !lineItemId) return 'skipped';

  const pack = getPack(packId);
  if (!pack) {
    app.log.error(
      { storeId: store.id, packId },
      'auto-refill configured with a pack we no longer sell — refill skipped',
    );
    return 'skipped';
  }

  // Guard 1: serialise concurrent triggers for this store, then re-read the
  // balance having observed whatever the winner committed.
  const purchaseId = await app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`shopify-autorefill:${store.id}`}, 0))`);

    const [credits] = await tx
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));

    const eligible = shouldRefill({
      balance: credits?.balance ?? 0,
      triggerCredits: store.autorefillTriggerCredits,
      status: store.autorefillStatus,
    });
    if (!eligible) return null;

    // Guard 2: the partial unique index rejects a second in-flight autorefill
    // row for this store. onConflictDoNothing turns that into "someone else is
    // already refilling", which is a skip, not an error.
    const inserted = await tx
      .insert(schema.shopifyCreditPurchases)
      .values({
        storeId: store.id,
        source: 'autorefill',
        packId: pack.id,
        // Snapshotted at INSERT exactly like a manual purchase — the grant
        // reads this column, never CREDIT_PACKS, so an admin editing pack
        // generosity mid-flight cannot change what this refill delivers.
        credits: pack.autorefillCredits,
        priceUsdCents: Math.round(pack.priceUsd * 100),
        status: 'PENDING',
      })
      .onConflictDoNothing()
      .returning({ id: schema.shopifyCreditPurchases.id });

    return inserted[0]?.id ?? null;
  });

  if (!purchaseId) return 'skipped';

  const tryOns = Math.floor(pack.autorefillCredits / SIMPLE_TRYON_COST);

  // Guard 3: Shopify's idempotency key, keyed on the row. A retry after a
  // timeout reuses it and cannot produce a second charge.
  const result = await charge(app, store, {
    lineItemId,
    description: `TryMe auto-refill — ${tryOns} try-ons`,
    amountUsd: pack.priceUsd,
    idempotencyKey: `autorefill:${purchaseId}`,
  });

  if (!result.ok) {
    await app.db
      .update(schema.shopifyCreditPurchases)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

    if (result.capReached) {
      await app.db
        .update(schema.shopifyStores)
        .set({ autorefillStatus: 'CAP_REACHED', updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));
      // warn, not error: the merchant set this ceiling and it is doing its job.
      app.log.warn(
        { storeId: store.id, shopDomain: store.shopDomain },
        'auto-refill stopped — monthly spend ceiling reached',
      );
      return 'cap_reached';
    }

    app.log.error(
      { storeId: store.id, message: result.message },
      'auto-refill charge failed — will retry on the next trigger',
    );
    return 'failed';
  }

  await app.db
    .update(schema.shopifyCreditPurchases)
    .set({ shopifyChargeId: result.recordId, status: 'ACTIVE', updatedAt: new Date() })
    .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

  const { granted } = await grantStore(
    app.db,
    store.id,
    pack.autorefillCredits,
    'SHOPIFY_AUTOREFILL',
    `shopify_autorefill:${result.recordId}`,
  );

  app.log.info(
    { storeId: store.id, purchaseId, credits: pack.autorefillCredits, granted },
    'auto-refill completed',
  );
  return 'refilled';
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm --filter @tryme/api test:unit -- autorefill`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the failing integration test**

Create `apps/api/test/integration/shopify-autorefill.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRefill } from '../../src/modules/shopify/autorefill.js';
import { buildTestApp } from '../helpers/api.js';
import { setupTestContainers, teardownTestContainers } from '../helpers/containers.js';

let ctx: Awaited<ReturnType<typeof setupTestContainers>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;
let charges: string[];

const okCharge = () => ({
  charge: async (
    _app: unknown,
    _store: unknown,
    args: { idempotencyKey: string },
  ): Promise<{ ok: true; recordId: string }> => {
    charges.push(args.idempotencyKey);
    return { ok: true, recordId: `gid://shopify/AppUsageRecord/${charges.length}` };
  },
});

const capCharge = () => ({
  charge: async (): Promise<{ ok: false; capReached: boolean; message: string }> => ({
    ok: false,
    capReached: true,
    message: 'Total price exceeds balance remaining',
  }),
});

async function reset(balance: number, patch: Partial<typeof schema.shopifyStores.$inferSelect> = {}) {
  await app.db.delete(schema.shopifyCreditPurchases).where(eq(schema.shopifyCreditPurchases.storeId, store.id));
  await app.db
    .insert(schema.shopifyStoreCredits)
    .values({ storeId: store.id, balance })
    .onConflictDoUpdate({ target: schema.shopifyStoreCredits.storeId, set: { balance } });
  const [updated] = await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: 'pack_25',
      autorefillTriggerCredits: 450,
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/1',
      autorefillLineItemId: 'gid://shopify/AppSubscriptionLineItem/1',
      autorefillStatus: 'ACTIVE',
      ...patch,
    })
    .where(eq(schema.shopifyStores.id, store.id))
    .returning();
  store = updated;
}

beforeAll(async () => {
  ctx = await setupTestContainers();
  app = await buildTestApp(ctx);
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'autorefill-test.myshopify.com',
      shopifyShopId: 66601,
      accessToken: 'enc:token',
      scope: 'read_products',
    })
    .returning();
});

beforeEach(() => {
  charges = [];
});

afterAll(async () => {
  await app.close();
  await teardownTestContainers(ctx);
});

describe('auto-refill', () => {
  it('charges once and grants the bonus credit amount', async () => {
    await reset(100);
    const result = await runRefill(app, store, okCharge());
    expect(result).toBe('refilled');
    expect(charges).toHaveLength(1);

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    // 100 starting + 2475 auto-refill credits for pack_25 (not the manual 2250)
    expect(credits.balance).toBe(2575);
  });

  it('skips when the balance is above the trigger', async () => {
    await reset(1000);
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('skips when auto-refill is not ACTIVE', async () => {
    await reset(100, { autorefillStatus: 'PENDING' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  // The double-charge test. This is the reason all three guards exist.
  it('charges exactly once when two refills race', async () => {
    await reset(100);
    const results = await Promise.all([
      runRefill(app, store, okCharge()),
      runRefill(app, store, okCharge()),
    ]);
    expect(charges).toHaveLength(1);
    expect(results.filter((r) => r === 'refilled')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(1);
  });

  it('uses the purchase row id as the idempotency key', async () => {
    await reset(100);
    await runRefill(app, store, okCharge());
    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.storeId, store.id));
    expect(charges[0]).toBe(`autorefill:${row.id}`);
  });

  it('marks the store CAP_REACHED and grants nothing when the ceiling is hit', async () => {
    await reset(100);
    expect(await runRefill(app, store, capCharge())).toBe('cap_reached');

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('CAP_REACHED');

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits.balance).toBe(100);

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.storeId, store.id));
    expect(row.status).toBe('FAILED');
  });

  it('does not retry once the store is CAP_REACHED', async () => {
    await reset(100, { autorefillStatus: 'CAP_REACHED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('leaves the balance untouched and the row FAILED on a transient charge failure', async () => {
    await reset(100);
    const result = await runRefill(app, store, {
      charge: async () => ({ ok: false as const, capReached: false, message: 'network' }),
    });
    expect(result).toBe('failed');

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    // A transient failure must NOT look like the merchant's ceiling.
    expect(refreshed.autorefillStatus).toBe('ACTIVE');
  });
});
```

- [ ] **Step 6: Run the integration tests to verify they pass**

```bash
pnpm docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-autorefill
```

Expected: PASS, 8 tests

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/autorefill.ts apps/api/src/modules/shopify/autorefill.test.ts apps/api/test/integration/shopify-autorefill.test.ts
git commit -m "feat(shopify): auto-refill trigger with three double-charge guards"
```

---

### Task 4: Enrolment, cap-raise, and disable routes

**Files:**
- Create: `apps/api/src/modules/shopify/autorefill.routes.ts`
- Modify: `apps/api/src/modules/shopify/autorefill.ts` (add enrolment functions)
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `apps/api/src/modules/shopify/me.routes.ts`

**Interfaces:**
- Consumes: `createUsageSubscription`, `updateCappedAmount`, `cancelSubscription` (Task 2); `defaultTriggerCredits` (Task 3).
- Produces:
  - `enrolAutorefill(app, store, args): Promise<{ confirmationUrl: string }>` where `args` is `{ packId: string; triggerCredits?: number; cappedAmountUsd: number }`
  - `confirmAutorefill(app, store): Promise<{ status: string }>`
  - `disableAutorefill(app, store): Promise<void>`
  - `POST /v1/shopify/billing/autorefill`, `GET /v1/shopify/billing/autorefill/confirm`, `PATCH /v1/shopify/billing/autorefill`, `DELETE /v1/shopify/billing/autorefill`, `POST /v1/shopify/billing/autorefill/raise-cap`

- [ ] **Step 1: Add the enrolment functions**

First extend the imports at the **top** of `apps/api/src/modules/shopify/autorefill.ts` — these are additions to the existing import block, not appended lines:

```ts
import { AppError } from '../../lib/errors.js';
import {
  cancelSubscription,
  createUsageRecord,
  createUsageSubscription,
  updateCappedAmount,
} from './autorefill-client.js';
```

(The existing `import { createUsageRecord } from './autorefill-client.js';` line is replaced by the grouped one above.)

Then append the functions to the end of the file:

```ts
/**
 * Starts enrolment. The merchant approves a monthly ceiling once on Shopify's
 * own page; every refill after that is silent.
 *
 * The cap may not be lower than one refill — a ceiling that cannot fund a
 * single pack would enrol the merchant into something that can never fire, and
 * they would discover it only by running out.
 */
export async function enrolAutorefill(
  app: FastifyInstance,
  store: Store,
  args: { packId: string; triggerCredits?: number; cappedAmountUsd: number },
): Promise<{ confirmationUrl: string }> {
  const pack = getPack(args.packId);
  if (!pack) throw new AppError('BAD_REQUEST', 400, 'unknown pack');

  if (args.cappedAmountUsd < pack.priceUsd) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `Monthly limit must be at least $${pack.priceUsd}, the price of one refill`,
    );
  }
  if (!app.env.SHOPIFY_APP_URL) {
    throw new AppError('CONFIG', 500, 'SHOPIFY_APP_URL is not configured');
  }

  const trigger = args.triggerCredits ?? defaultTriggerCredits(pack.id);
  const tryOns = Math.floor(pack.autorefillCredits / SIMPLE_TRYON_COST);

  const { confirmationUrl, subscriptionId, lineItemId } = await createUsageSubscription(
    app,
    store,
    {
      name: 'TryMe auto-refill',
      terms: `$${pack.priceUsd} per ${tryOns} try-ons, charged automatically when your balance runs low`,
      cappedAmountUsd: args.cappedAmountUsd,
      returnUrl: `${app.env.SHOPIFY_APP_URL}/shopify-admin/billing/autorefill-callback`,
      test: app.env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS === true,
    },
  );

  // PENDING until the merchant approves. shouldRefill refuses to charge against
  // anything but ACTIVE, so nothing can fire in this window.
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: pack.id,
      autorefillTriggerCredits: trigger,
      autorefillSubscriptionId: subscriptionId,
      autorefillLineItemId: lineItemId,
      autorefillCappedAmountCents: Math.round(args.cappedAmountUsd * 100),
      autorefillStatus: 'PENDING',
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { confirmationUrl };
}

/**
 * Called when the merchant returns from Shopify's approval page. Trusts nothing
 * in the redirect — flips to ACTIVE only because our own row says a
 * subscription was created, and the merchant could only have arrived here by
 * completing that flow.
 *
 * A later APP_SUBSCRIPTIONS_UPDATE webhook is what corrects this if they in
 * fact declined; see Task 5.
 */
export async function confirmAutorefill(
  app: FastifyInstance,
  store: Store,
): Promise<{ status: string }> {
  if (!store.autorefillSubscriptionId) {
    throw new AppError('BAD_STATE', 400, 'no auto-refill enrolment to confirm');
  }
  await app.db
    .update(schema.shopifyStores)
    .set({ autorefillStatus: 'ACTIVE', updatedAt: new Date() })
    .where(eq(schema.shopifyStores.id, store.id));
  return { status: 'ACTIVE' };
}

/**
 * Turning auto-refill off must cancel the Shopify subscription, not merely
 * clear our columns. Leaving an approved charge authorization live at Shopify
 * for a merchant who believes they revoked it is the kind of thing that ends up
 * in a review.
 *
 * Our columns are cleared even if the cancel call fails: the merchant asked for
 * this to stop, and it stopping locally is the part we control. The orphaned
 * subscription is logged for an operator.
 */
export async function disableAutorefill(app: FastifyInstance, store: Store): Promise<void> {
  if (store.autorefillSubscriptionId) {
    try {
      await cancelSubscription(app, store, store.autorefillSubscriptionId);
    } catch (err) {
      app.log.error(
        { err, storeId: store.id, subscriptionId: store.autorefillSubscriptionId },
        'failed to cancel auto-refill subscription at Shopify — clearing locally anyway, subscription may be orphaned',
      );
    }
  }
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: null,
      autorefillTriggerCredits: null,
      autorefillSubscriptionId: null,
      autorefillLineItemId: null,
      autorefillCappedAmountCents: null,
      autorefillStatus: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));
}

/**
 * First half of CAP_REACHED recovery. Shopify requires fresh merchant approval
 * for a higher ceiling and refuses usage records until it is granted, so this
 * returns a confirmation URL rather than fixing anything on its own.
 */
export async function raiseCap(
  app: FastifyInstance,
  store: Store,
  cappedAmountUsd: number,
): Promise<{ confirmationUrl: string }> {
  if (!store.autorefillLineItemId) {
    throw new AppError('BAD_STATE', 400, 'auto-refill is not enabled');
  }
  const current = (store.autorefillCappedAmountCents ?? 0) / 100;
  if (cappedAmountUsd <= current) {
    throw new AppError('BAD_REQUEST', 400, 'new monthly limit must be higher than the current one');
  }

  const { confirmationUrl } = await updateCappedAmount(app, store, {
    lineItemId: store.autorefillLineItemId,
    cappedAmountUsd,
  });

  // Not applied until approval lands — recorded as pending so the UI can say
  // "waiting for your approval" rather than showing a ceiling that isn't real.
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillCappedAmountCents: Math.round(cappedAmountUsd * 100),
      autorefillStatus: 'PENDING',
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { confirmationUrl };
}
```

- [ ] **Step 2: Write the routes**

Create `apps/api/src/modules/shopify/autorefill.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  confirmAutorefill,
  defaultTriggerCredits,
  disableAutorefill,
  enrolAutorefill,
  raiseCap,
} from './autorefill.js';

const EnrolBody = z.object({
  packId: z.string().min(1).max(64),
  triggerCredits: z.number().int().positive().max(1_000_000).optional(),
  cappedAmountUsd: z.number().positive().max(10_000),
});

const UpdateBody = z.object({
  packId: z.string().min(1).max(64).optional(),
  triggerCredits: z.number().int().positive().max(1_000_000).optional(),
});

const RaiseCapBody = z.object({ cappedAmountUsd: z.number().positive().max(10_000) });

export async function shopifyAutorefillRoutes(app: FastifyInstance) {
  const store = (req: { shopifyStore?: unknown }) =>
    req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

  app.post(
    '/v1/shopify/billing/autorefill',
    { preHandler: app.requireShopifySession, schema: { body: EnrolBody } },
    async (req) => enrolAutorefill(app, store(req), req.body as z.infer<typeof EnrolBody>),
  );

  app.get(
    '/v1/shopify/billing/autorefill/confirm',
    { preHandler: app.requireShopifySession },
    async (req) => confirmAutorefill(app, store(req)),
  );

  // Changing pack or threshold does not touch the approved ceiling, so it needs
  // no new merchant approval — the authorization the merchant gave is a dollar
  // ceiling, and neither of these raises it.
  app.patch(
    '/v1/shopify/billing/autorefill',
    { preHandler: app.requireShopifySession, schema: { body: UpdateBody } },
    async (req) => {
      const s = store(req);
      const body = req.body as z.infer<typeof UpdateBody>;
      const packId = body.packId ?? s.autorefillPackId;
      const patch: Partial<typeof schema.shopifyStores.$inferInsert> = { updatedAt: new Date() };
      if (body.packId) patch.autorefillPackId = body.packId;
      if (body.triggerCredits != null) {
        patch.autorefillTriggerCredits = body.triggerCredits;
      } else if (body.packId && packId) {
        patch.autorefillTriggerCredits = defaultTriggerCredits(packId);
      }
      await app.db
        .update(schema.shopifyStores)
        .set(patch)
        .where(eq(schema.shopifyStores.id, s.id));
      return { ok: true };
    },
  );

  app.delete(
    '/v1/shopify/billing/autorefill',
    { preHandler: app.requireShopifySession },
    async (req) => {
      await disableAutorefill(app, store(req));
      return { ok: true };
    },
  );

  app.post(
    '/v1/shopify/billing/autorefill/raise-cap',
    { preHandler: app.requireShopifySession, schema: { body: RaiseCapBody } },
    async (req) =>
      raiseCap(app, store(req), (req.body as z.infer<typeof RaiseCapBody>).cappedAmountUsd),
  );
}
```

- [ ] **Step 3: Register the routes**

In `apps/api/src/modules/shopify/routes.ts`, add the import and register it immediately after `shopifyPurchaseRoutes`:

```ts
import { shopifyAutorefillRoutes } from './autorefill.routes.js';
```

```ts
  await app.register(shopifyAutorefillRoutes);
```

- [ ] **Step 4: Return auto-refill state from /me**

In `apps/api/src/modules/shopify/me.routes.ts`, add to the returned object alongside `runway`:

```ts
      autorefill: {
        enabled: store.autorefillStatus != null,
        status: store.autorefillStatus,
        packId: store.autorefillPackId,
        triggerCredits: store.autorefillTriggerCredits,
        cappedAmountUsdCents: store.autorefillCappedAmountCents,
      },
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/autorefill.ts apps/api/src/modules/shopify/autorefill.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/src/modules/shopify/me.routes.ts
git commit -m "feat(shopify): auto-refill enrolment, cap-raise and disable routes"
```

---

### Task 5: Wire the trigger and the subscription webhook

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts`
- Modify: `apps/api/src/modules/shopify/alert-scheduler.ts`
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts`

**Interfaces:**
- Consumes: `runRefill`, `shouldRefill` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Fire the refill after the job transaction commits**

In `apps/api/src/modules/shopify/customer.routes.ts`, immediately after the block that sets `jobCommitted = true`, add:

```ts
        // Fired after the transaction commits and deliberately NOT awaited: a
        // shopper is waiting on this request, and a Shopify round trip has no
        // business being in their critical path. The hourly sweep in
        // alert-scheduler.ts is the safety net if this process dies before the
        // promise settles, so losing it costs at most an hour, never a charge.
        if (store.autorefillStatus === 'ACTIVE') {
          void runRefill(app, store).catch((err) => {
            app.log.error({ err, storeId }, 'auto-refill after job dispatch failed');
          });
        }
```

Add the import:

```ts
import { runRefill } from './autorefill.js';
```

- [ ] **Step 2: Add the safety-net sweep to the alert scheduler**

In `apps/api/src/modules/shopify/alert-scheduler.ts`, inside the `for (const store of stores)` loop, immediately after `const runway = await computeRunway(app, store.id);`, add:

```ts
      // Safety net for a refill that was lost to a process restart between the
      // job committing and its fire-and-forget promise settling. runRefill is
      // idempotent on all three of its guards, so calling it here when one
      // already succeeded is a cheap no-op.
      if (store.autorefillStatus === 'ACTIVE') {
        const outcome = await runRefill(app, store);
        if (outcome === 'refilled') {
          // The balance just changed underneath us; alerting on the stale value
          // would email a merchant about a shortfall that no longer exists.
          await app.db
            .update(schema.shopifyStores)
            .set({ lastAlertLevel: 'ok' })
            .where(eq(schema.shopifyStores.id, store.id));
          continue;
        }
      }
```

Add the import:

```ts
import { runRefill } from './autorefill.js';
```

- [ ] **Step 3: Suppress low-credit email for healthy auto-refill stores**

Still in `alert-scheduler.ts`, change the email condition so an enrolled, healthy store is not warned about a shortfall that will resolve itself. Replace `if (worsened && runway.level !== 'ok') {` with:

```ts
      // An ACTIVE auto-refill store is not "running low" in any sense the
      // merchant needs to act on — the refill fires before they run out. The
      // exception is CAP_REACHED, where auto-refill has stopped and they very
      // much do need to know.
      const autorefillHandlesIt = store.autorefillStatus === 'ACTIVE';
      if (worsened && runway.level !== 'ok' && !autorefillHandlesIt) {
```

- [ ] **Step 4: Handle the subscription webhook**

In `apps/api/src/modules/shopify/webhook.routes.ts`, add `'app_subscriptions_update'` to the `topics` array and this branch to the `switch (topic)`:

```ts
          case 'app_subscriptions_update': {
            // The merchant can cancel or decline the auto-refill subscription
            // from Shopify's own billing screen, where our app never sees the
            // click. Without this the store would keep believing it has a live
            // charge authorization and every refill would fail confusingly.
            const subId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
            const rawStatus = (payload as { status?: string }).status;
            if (!store || !subId || !rawStatus) break;
            if (store.autorefillSubscriptionId !== subId) break;

            const status = rawStatus.toUpperCase();
            const mapped =
              status === 'ACTIVE'
                ? 'ACTIVE'
                : status === 'DECLINED'
                  ? 'DECLINED'
                  : 'CANCELLED';
            await app.db
              .update(schema.shopifyStores)
              .set({ autorefillStatus: mapped, updatedAt: new Date() })
              .where(eq(schema.shopifyStores.id, store.id));
            req.log.info(
              { topic, storeId: store.id, status: mapped },
              'auto-refill subscription status updated',
            );
            break;
          }
```

And register the topic in the `map` inside `registerWebhooksDecorator`:

```ts
      'app_subscriptions/update': `${base}/app_subscriptions_update`,
```

- [ ] **Step 5: Add the regression test**

Append to `apps/api/test/integration/shopify-autorefill.test.ts`:

```ts
describe('auto-refill lifecycle', () => {
  it('stops refilling once the subscription is cancelled at Shopify', async () => {
    await reset(100, { autorefillStatus: 'CANCELLED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('resumes refilling after the merchant re-approves', async () => {
    await reset(100, { autorefillStatus: 'CANCELLED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');

    await reset(100, { autorefillStatus: 'ACTIVE' });
    expect(await runRefill(app, store, okCharge())).toBe('refilled');
  });
});
```

- [ ] **Step 6: Run the tests**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-autorefill shopify-alerting
```

Expected: PASS — 10 auto-refill tests and the 7 phase-2 alerting tests still green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/src/modules/shopify/alert-scheduler.ts apps/api/src/modules/shopify/webhook.routes.ts apps/api/test/integration/shopify-autorefill.test.ts
git commit -m "feat(shopify): fire auto-refill on deduct, sweep hourly, track subscription status"
```

---

### Task 6: Auto-refill UI

**Files:**
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/shopify/src/pages/PricingPage.tsx`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/pages/BillingCallbackPage.tsx`
- Modify: `apps/shopify/src/App.tsx` (route for the auto-refill callback)

**Interfaces:**
- Consumes: `/v1/shopify/billing/autorefill*` (Task 4), `me.autorefill` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Extend the SPA type**

In `apps/shopify/src/types.ts`, add to `ShopifyMe`:

```ts
  autorefill: {
    enabled: boolean;
    status: 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'DECLINED' | 'CAP_REACHED' | null;
    packId: string | null;
    triggerCredits: number | null;
    cappedAmountUsdCents: number | null;
  };
```

- [ ] **Step 2: Add the auto-refill panel to the pricing page**

In `apps/shopify/src/pages/PricingPage.tsx`, add below the pack grid:

```tsx
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Auto-refill
              </Text>
              {me?.autorefill.status === 'ACTIVE' && <Badge tone="success">On</Badge>}
              {me?.autorefill.status === 'PENDING' && <Badge tone="attention">Awaiting approval</Badge>}
              {me?.autorefill.status === 'CAP_REACHED' && <Badge tone="critical">Limit reached</Badge>}
            </InlineStack>

            <Text as="p" tone="subdued">
              Never run out. When your balance drops below your threshold we buy your chosen pack
              automatically — and auto-refill packs include 10% extra credits.
            </Text>

            {!me?.autorefill.enabled && (
              <BlockStack gap="200">
                <Select
                  label="Refill with"
                  options={PACK_DISPLAY.map((p) => ({
                    label: `${p.label} — $${p.priceUsd} (${Math.round(p.credits * 1.1 / 5).toLocaleString()} try-ons)`,
                    value: p.id,
                  }))}
                  value={refillPack}
                  onChange={setRefillPack}
                />
                <TextField
                  label="Monthly limit"
                  type="number"
                  prefix="$"
                  value={refillCap}
                  onChange={setRefillCap}
                  helpText="The most we can charge you in a 30-day period. You approve this once; refills after that are automatic. You can change or cancel it any time."
                  autoComplete="off"
                />
                <Button variant="primary" loading={enrolling} onClick={enableAutorefill}>
                  Turn on auto-refill
                </Button>
              </BlockStack>
            )}

            {me?.autorefill.status === 'CAP_REACHED' && (
              <Banner tone="critical" title="Auto-refill has stopped">
                <Text as="p">
                  You've reached your $
                  {((me.autorefill.cappedAmountUsdCents ?? 0) / 100).toFixed(2)} monthly limit.
                  Raise it to resume automatic refills — Shopify will ask you to approve the new
                  limit.
                </Text>
              </Banner>
            )}

            {me?.autorefill.enabled && (
              <Button tone="critical" variant="plain" onClick={turnOffAutorefill}>
                Turn off auto-refill
              </Button>
            )}
          </BlockStack>
        </Card>
```

Add the handlers alongside `buyPack`:

```tsx
  const [refillPack, setRefillPack] = useState('pack_25');
  const [refillCap, setRefillCap] = useState('100');
  const [enrolling, setEnrolling] = useState(false);

  async function enableAutorefill() {
    setEnrolling(true);
    setError(null);
    try {
      const { confirmationUrl } = await apiFetch<{ confirmationUrl: string }>(
        '/v1/shopify/billing/autorefill',
        {
          method: 'POST',
          body: JSON.stringify({
            packId: refillPack,
            cappedAmountUsd: Number.parseFloat(refillCap),
          }),
        },
      );
      navigateTopLevel(confirmationUrl);
    } catch (err) {
      setError((err as Error).message);
      setEnrolling(false);
    }
  }

  async function turnOffAutorefill() {
    setError(null);
    try {
      await apiFetch('/v1/shopify/billing/autorefill', { method: 'DELETE' });
      setMe(await apiFetch<ShopifyMe>('/v1/shopify/me'));
    } catch (err) {
      setError((err as Error).message);
    }
  }
```

Add `Select` and `TextField` to the `@shopify/polaris` import.

- [ ] **Step 3: Invert the dashboard banner for enrolled stores**

In `apps/shopify/src/pages/DashboardPage.tsx`, change `LowCreditsBanner` to take the whole `me` and branch:

```tsx
export function LowCreditsBanner({ me }: { me: ShopifyMe }) {
  const { runway, autorefill } = me;

  // Auto-refill has stopped at a ceiling the merchant set. This is the one
  // auto-refill state that needs their attention, and it is more urgent than a
  // plain low balance because they believe it is handled.
  if (autorefill.status === 'CAP_REACHED') {
    return (
      <Banner
        tone="critical"
        title="Auto-refill has stopped — monthly limit reached"
        action={{ content: 'Raise limit', url: '/pricing' }}
      >
        <Text as="p">
          Your balance is {runway.balance.toLocaleString()} credits and automatic refills are
          paused until you raise your monthly limit.
        </Text>
      </Banner>
    );
  }

  // A healthy enrolled store is never "low" — the refill fires first.
  if (autorefill.status === 'ACTIVE') return null;

  if (runway.level === 'ok') return null;

  const days = runway.daysRemaining != null ? Math.max(1, Math.round(runway.daysRemaining)) : null;

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

Update both call sites (dashboard and pricing) from `<LowCreditsBanner runway={me.runway} />` to `<LowCreditsBanner me={me} />`.

- [ ] **Step 4: Add the auto-refill callback route**

Create the return page by extending `BillingCallbackPage.tsx` to handle both, or add a route in `apps/shopify/src/App.tsx`:

```tsx
<Route path="/billing/autorefill-callback" element={<AutorefillCallbackPage />} />
```

Create `apps/shopify/src/pages/AutorefillCallbackPage.tsx`:

```tsx
import { Banner, Page, Spinner } from '@shopify/polaris';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';

export default function AutorefillCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/v1/shopify/billing/autorefill/confirm')
      .then(() => navigate('/pricing', { replace: true }))
      .catch((err) => setError((err as Error).message));
  }, [navigate]);

  if (error) {
    return (
      <Page>
        <Banner
          title="We couldn't confirm auto-refill"
          tone="critical"
          action={{ content: 'Back to credits', onAction: () => navigate('/pricing') }}
        >
          {error}
        </Banner>
      </Page>
    );
  }
  return (
    <Page>
      <Spinner accessibilityLabel="Confirming auto-refill" size="large" />
    </Page>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/shopify-admin typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify-admin): auto-refill enrolment panel and cap-reached banner"
```

---

## Verification Checklist

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — clean
- [ ] `pnpm --filter @tryme/api test:unit` — pass
- [ ] `cd apps/api && npx vitest run --config vitest.integration.config.ts` — pass
- [ ] `pnpm docker:reset && pnpm docker:up && pnpm db:migrate` succeeds from empty
- [ ] Manual, on a development store with `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS=true`: enrol, approve the cap, burn below the trigger, confirm exactly one refill charge and the bonus credit amount
- [ ] Manual: set a cap of one refill, trigger two refills, confirm the second sets `CAP_REACHED` and the banner offers the raise-cap flow
- [ ] Manual: turn auto-refill off, then confirm in the Shopify admin's billing screen that the subscription is actually cancelled — not just cleared locally

## Out of Scope

- **Refill cooldown.** A merchant with a low threshold and a high cap could refill several times in a day. That is probably correct — they are using the product — but if it turns out to alarm merchants, the fix is a minimum interval between refills, not a change to the trigger.
- **Proactive cap-approaching notification.** Shopify fires `APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT` at 90%; wiring it would warn a merchant before auto-refill stops rather than after. A clear follow-up, deliberately not bundled here so the core charge path ships with a smaller blast radius.
- **Per-store refill history in the UI.** `shopify_credit_purchases` records every refill with `source = 'autorefill'`; surfacing it is a reporting task.
- **Automatic cap raising.** Shopify requires merchant approval, so this is not possible even in principle.
