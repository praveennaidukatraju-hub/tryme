# Shopify Credit Wallet — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Shopify App Pricing subscription billing (three monthly plans + a PAYG usage meter) with four non-expiring prepaid credit packs purchased through the Manual Pricing Billing API.

**Architecture:** Merchants buy a pack via `appPurchaseOneTimeCreate`, approve it on Shopify's hosted page, and are returned to a confirm route that re-fetches the charge's real state from Shopify before granting credits. An `APP_PURCHASES_ONE_TIME_UPDATE` webhook is the safety net for a merchant who approves and closes the tab. Both paths converge on the existing `grantStore` helper, whose `external_ref` unique index makes them idempotent against each other. Everything cycle-scoped — subscription polling, plan handles, period markers, usage metering — is deleted.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM on PostgreSQL 16, Vitest, React + Polaris (embedded SPA), Vite (admin SPA).

**Spec:** `docs/superpowers/specs/2026-08-19-shopify-credit-wallet-design.md`

## Global Constraints

- **Package manager is pnpm.** Never introduce npm or yarn lockfiles.
- **ESM only** — every package is `"type": "module"`. Relative imports inside a package must carry the `.js` extension.
- **No `console.log`** in committed code. Use `app.log` / `createLogger`.
- **Import `@tryme/db` as `workspace:*`**, never by relative path into `packages/`.
- **Never inline-mutate a workflow template** — irrelevant to this plan, but do not break it.
- **Credit deduct + job insert stay one Postgres transaction.** Untouched by this plan; do not refactor.
- **Grants must be idempotent on `external_ref`** via the migration-0150 partial unique index on `shopify_credit_ledger`. Never add a second idempotency mechanism.
- **Gates guarding money compare `=== true`.** Tests construct `Env` objects directly and cast them, so a new env flag is `undefined` there. `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` must keep its `=== true` comparison.
- **Prices live in code only, never in admin config.** Credits are admin-tunable; prices are not.
- **Pack credits are snapshotted onto the purchase row at INSERT** and the grant reads that column — never config, never Shopify's response.
- **No schema or data changes against production.** Migrations run locally, then through CI/CD.
- **Secrets discipline:** never print a credential value. When grepping `docker compose config` or any `.env`, match the exact line and never use `-A`/`-B`/`-C`.
- **Match surrounding comment density and idiom.** This codebase comments the *why*, especially the non-obvious constraint that motivated a line.
- **Unit tests:** `pnpm --filter @tryme/api test:unit`
- **Integration tests:** from `apps/api`, `npx vitest run --config vitest.integration.config.ts <pattern>` — requires `pnpm docker:up` running first.
- **Pack pricing (exact, do not round differently):**

  | Pack id | Price (USD) | Credits | Try-ons |
  |---|---|---|---|
  | `pack_10` | 10 | 800 | 160 |
  | `pack_25` | 25 | 2250 | 450 |
  | `pack_50` | 50 | 4800 | 960 |
  | `pack_100` | 100 | 10000 | 2000 |

- **Auto-refill credits (+10%, stored in phase 1, unused until phase 3):** 880 / 2475 / 5280 / 11000.
- **A try-on costs 5 credits** (`SIMPLE_TRYON_COST`). Every pack's credits must stay a multiple of it.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/api/src/modules/shopify/packs.ts` | Pack catalogue — ids, prices, both credit figures. Single source of truth for what a pack *is*. |
| `apps/api/src/modules/shopify/packs.test.ts` | Pricing-intent regression tests. |
| `apps/api/src/modules/shopify/purchase.ts` | Purchase business logic — create and confirm, `deps`-injectable. |
| `apps/api/src/modules/shopify/purchase.routes.ts` | HTTP surface for purchase + confirm. |
| `apps/shopify/src/lib/packs.ts` | SPA display copy only. Deliberately separate from the API's source of truth. |
| `packages/db/src/migrations/0159_shopify_credit_purchases.sql` | Additive: new table + `autorefill_*` columns. |
| `packages/db/src/migrations/0160_drop_shopify_app_pricing.sql` | Destructive: drop App Pricing / PAYG / catalogue schema. |
| `apps/api/test/integration/shopify-purchase.test.ts` | End-to-end purchase and confirm behaviour. |

**Modified**

| File | Change |
|---|---|
| `apps/api/src/lib/resolution-config.ts` | `getShopifyPackCredits` replaces `getShopifyPlanCredits`. |
| `packages/types/src/admin.ts` | `shopify.packCredits` replaces `shopify.planCredits`. |
| `packages/db/src/schema/shopify.ts` | New table + columns; drop the App Pricing / PAYG ones. |
| `packages/db/src/schema/jobs.ts` | Drop `shopifyCatalogJobs`. |
| `apps/api/src/modules/shopify/routes.ts` | Register purchase routes; unregister billing, PAYG, catalogue. |
| `apps/api/src/modules/shopify/webhook.routes.ts` | Handle and register `app_purchases_one_time_update`. |
| `apps/api/src/modules/shopify/me.routes.ts` | Drop subscription fields from the response. |
| `apps/api/src/modules/shopify/customer.routes.ts` | Remove the `billingMode === 'usage'` branches. |
| `apps/api/src/main.ts` | Stop starting the billing and usage schedulers. |
| `apps/api/src/env.ts` | Drop `SHOPIFY_APP_EVENTS_*` and `SHOPIFY_APP_HANDLE`. |
| `apps/dispatcher/src/job/processor.ts` | Remove the usage-event insert and the PAYG refund branch. |
| `apps/shopify/src/pages/PricingPage.tsx` | Rewritten around packs. |
| `apps/shopify/src/pages/DashboardPage.tsx` | Balance instead of plan status. |
| `apps/shopify/src/types.ts` | Drop subscription fields from `ShopifyMe`. |
| `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx` | Per-pack credit inputs. |

**Deleted**

`billing.ts`, `billing.routes.ts`, `billing-plans.ts`, `billing-plans.test.ts`, `billing-scheduler.ts`, `subscription-client.ts`, `payg.ts`, `payg.routes.ts`, `app-events-client.ts`, `usage-scheduler.ts`, `catalog.routes.ts`, `catalog-options.routes.ts`, `catalog-job.ts`, `catalog-publish.ts`, `apps/shopify/src/lib/billing.ts`, `apps/shopify/src/lib/planFeatures.ts`, `apps/shopify/src/lib/planFeatures.test.ts`, `packages/types/src/payg-constants.ts`, and the PAYG/billing test files listed in Task 9.

`grantShopifyTrialCredits` moves from `billing.ts` to `purchase.ts` — it is the 25-credit free tier and must survive.

---

### Task 1: Pack catalogue and admin-config reader

**Files:**
- Create: `apps/api/src/modules/shopify/packs.ts`
- Create: `apps/api/src/modules/shopify/packs.test.ts`
- Modify: `apps/api/src/lib/resolution-config.ts`
- Modify: `packages/types/src/admin.ts:147-159`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `CREDIT_PACK_IDS: readonly ['pack_10','pack_25','pack_50','pack_100']`
  - `type CreditPackId = (typeof CREDIT_PACK_IDS)[number]`
  - `interface CreditPack { id: CreditPackId; priceUsd: number; credits: number; autorefillCredits: number; label: string }`
  - `CREDIT_PACKS: Record<CreditPackId, CreditPack>`
  - `getPack(id: string): CreditPack | null`
  - `getShopifyPackCredits(app: FastifyInstance, packId: string, source: 'manual' | 'autorefill'): Promise<number | null>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/shopify/packs.test.ts`:

```ts
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { describe, expect, it } from 'vitest';
import { CREDIT_PACK_IDS, CREDIT_PACKS, getPack } from './packs.js';

describe('credit packs', () => {
  it('resolves every known pack id', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(getPack(id)?.id).toBe(id);
    }
  });

  it('returns null for an unknown pack id', () => {
    expect(getPack('pack_999')).toBeNull();
    expect(getPack('')).toBeNull();
  });

  it('prices every pack above Shopify’s $0.50 application-charge floor', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].priceUsd).toBeGreaterThanOrEqual(0.5);
    }
  });

  // A pack whose credits are not a whole number of try-ons leaves a remainder
  // the merchant paid for and can never spend.
  it('sizes every pack to a whole number of try-ons, on both purchase paths', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].credits % SIMPLE_TRYON_COST).toBe(0);
      expect(CREDIT_PACKS[id].autorefillCredits % SIMPLE_TRYON_COST).toBe(0);
    }
  });

  it('gives auto-refill strictly more credits than manual, at the same price', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].autorefillCredits).toBeGreaterThan(CREDIT_PACKS[id].credits);
    }
  });

  // Pricing-intent regression test: this is what catches someone later editing
  // a default into a value where a smaller pack is a better deal per credit
  // than a larger one, which would make the ladder meaningless.
  it('improves cents-per-credit monotonically as pack size grows', () => {
    const rates = CREDIT_PACK_IDS.map(
      (id) => (CREDIT_PACKS[id].priceUsd * 100) / CREDIT_PACKS[id].credits,
    );
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThan(rates[i - 1]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test:unit -- packs`
Expected: FAIL — `Cannot find module './packs.js'`

- [ ] **Step 3: Write the pack catalogue**

Create `apps/api/src/modules/shopify/packs.ts`:

```ts
/**
 * The credit packs a Shopify merchant can buy. Unlike the Shopify App Pricing
 * plan names this replaces, pack ids are ours end to end — Shopify never echoes
 * one back to us — so this needs no case-insensitive matching and no Partner
 * Dashboard coordination. An unknown id resolves to null and sells nothing
 * rather than guessing which pack the merchant meant.
 *
 * Credits never expire and are not cycle-scoped: a merchant may spend a pack
 * over ten days or forty.
 *
 * `priceUsd` is what gets sent to Shopify in the charge mutation, so it lives
 * here and only here — deliberately NOT admin-tunable, because config that
 * changes what a merchant is *charged* is a different risk class from config
 * that changes what they *receive*. `credits` and `autorefillCredits` are
 * admin-tunable via getShopifyPackCredits.
 *
 * Shopify rejects an application charge under $0.50 USD. No pack is close, so
 * this is a comment rather than a runtime check — prices are static.
 */
export const CREDIT_PACK_IDS = ['pack_10', 'pack_25', 'pack_50', 'pack_100'] as const;
export type CreditPackId = (typeof CREDIT_PACK_IDS)[number];

export interface CreditPack {
  id: CreditPackId;
  priceUsd: number;
  /** Granted on a manual one-time purchase. */
  credits: number;
  /**
   * Granted on an auto-refill purchase — a flat +10% bonus. Auto-refill has to
   * be strictly better than repeat manual buying or no merchant would hand over
   * a standing charge authorization. Stored and tested from phase 1; nothing
   * writes an 'autorefill' purchase until phase 3.
   */
  autorefillCredits: number;
  label: string;
}

export const CREDIT_PACKS: Record<CreditPackId, CreditPack> = {
  pack_10: { id: 'pack_10', priceUsd: 10, credits: 800, autorefillCredits: 880, label: 'Starter' },
  pack_25: { id: 'pack_25', priceUsd: 25, credits: 2250, autorefillCredits: 2475, label: 'Growth' },
  pack_50: { id: 'pack_50', priceUsd: 50, credits: 4800, autorefillCredits: 5280, label: 'Scale' },
  pack_100: {
    id: 'pack_100',
    priceUsd: 100,
    credits: 10000,
    autorefillCredits: 11000,
    label: 'Volume',
  },
};

/** The pack, or null when the id is not one we sell. */
export function getPack(id: string): CreditPack | null {
  return (CREDIT_PACKS as Record<string, CreditPack>)[id] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test:unit -- packs`
Expected: PASS, 6 tests

- [ ] **Step 5: Add the admin-config reader**

In `apps/api/src/lib/resolution-config.ts`, replace the `getShopifyPlanCredits` function (and its `billing-plans.js` import block at the top of the file) with:

```ts
import { type CreditPackId, CREDIT_PACKS, getPack } from '../modules/shopify/packs.js';
```

```ts
/**
 * Reads the admin-configured credit grant for one credit pack from the same
 * `config:system` Redis key the admin panel edits. Returns null for an id we
 * don't sell — same "unrecognized means grant nothing" behaviour the plan
 * lookup this replaces had, rather than guessing.
 *
 * Falls back to the code default when nothing is stored or the entry is
 * malformed, matching getResolutionCreditCost's try/catch behaviour.
 *
 * Note this is only consulted when a purchase row is INSERTed. The grant itself
 * reads the snapshotted `credits` column on that row, never this — see the
 * "credits are snapshotted" reasoning in purchase.ts.
 */
export async function getShopifyPackCredits(
  app: FastifyInstance,
  packId: string,
  source: 'manual' | 'autorefill',
): Promise<number | null> {
  const pack = getPack(packId);
  if (!pack) return null;
  const field = source === 'autorefill' ? 'autorefillCredits' : 'credits';
  const fallback = CREDIT_PACKS[pack.id][field];
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const credits = cfg.shopify?.packCredits?.[pack.id]?.[field];
    return typeof credits === 'number' ? credits : fallback;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 6: Update the admin config schema**

In `packages/types/src/admin.ts`, replace the `planCredits` block inside `shopify` (lines 149-157) with:

```ts
      packCredits: z
        .object({
          pack_10: z.object({ credits: z.number().int().positive().max(1_000_000), autorefillCredits: z.number().int().positive().max(1_000_000) }).partial(),
          pack_25: z.object({ credits: z.number().int().positive().max(1_000_000), autorefillCredits: z.number().int().positive().max(1_000_000) }).partial(),
          pack_50: z.object({ credits: z.number().int().positive().max(1_000_000), autorefillCredits: z.number().int().positive().max(1_000_000) }).partial(),
          pack_100: z.object({ credits: z.number().int().positive().max(1_000_000), autorefillCredits: z.number().int().positive().max(1_000_000) }).partial(),
        })
        .partial()
        .optional(),
```

- [ ] **Step 7: Verify nothing else referenced the old reader**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -30`
Expected: errors ONLY in `modules/shopify/billing.ts` (which imports `getShopifyPlanCredits`). That file is deleted in Task 9. Note the errors and continue — do not fix `billing.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/packs.ts apps/api/src/modules/shopify/packs.test.ts apps/api/src/lib/resolution-config.ts packages/types/src/admin.ts
git commit -m "feat(shopify): credit pack catalogue and admin-tunable pack credits"
```

---

### Task 2: Additive migration — purchases table and auto-refill columns

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Create: `packages/db/src/migrations/0159_shopify_credit_purchases.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `CreditPackId` from Task 1 (as a plain text column, not a DB enum).
- Produces: `schema.shopifyCreditPurchases` with columns `id`, `storeId`, `shopifyChargeId`, `source`, `packId`, `credits`, `priceUsdCents`, `status`, `createdAt`, `updatedAt`.

- [ ] **Step 1: Add the table and columns to the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, append after the `shopifyCreditLedger` definition:

```ts
/**
 * One row per purchase attempt, on either purchase path. Separate from
 * shopify_credit_ledger because a purchase has state *before* any credits
 * exist — the ledger only ever records grants that already happened.
 *
 * `credits` is snapshotted at INSERT and the grant reads THAT column, never
 * config and never Shopify's response (Shopify knows the price, not the
 * credits). This is load-bearing: pack credits are admin-editable while a
 * purchase can sit unconfirmed indefinitely, so re-reading config at confirm
 * time would let an admin edit silently change what an already-paying merchant
 * receives, with no record of the number they agreed to pay for. The row is
 * that record.
 */
export const shopifyCreditPurchases = pgTable(
  'shopify_credit_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    // The AppPurchaseOneTime GID. Null between our INSERT and the mutation
    // returning — a window in which the row exists but no charge does.
    shopifyChargeId: text('shopify_charge_id'),
    // 'manual' | 'autorefill'. Also decides which credit figure applied.
    source: text('source').notNull().default('manual'),
    packId: text('pack_id').notNull(),
    credits: integer('credits').notNull(),
    priceUsdCents: integer('price_usd_cents').notNull(),
    // 'PENDING' | 'ACTIVE' | 'DECLINED' | 'EXPIRED' | 'FAILED'.
    // FAILED is ours and means the charge was never created at Shopify.
    // Deliberately distinct from DECLINED, which means the merchant saw the
    // charge and said no — conflating them makes the two indistinguishable
    // when reconciling against Shopify payouts later.
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('shopify_credit_purchases_store_idx').on(table.storeId),
  }),
);
```

Then add the auto-refill columns to `shopifyStores`, immediately before `createdAt`:

```ts
  // Auto-refill (phase 3). Written in phase 1's migration so a later phase
  // doesn't have to ALTER a table that already carries rows. Null pack id
  // means auto-refill is off, which is every store today.
  autorefillPackId: text('autorefill_pack_id'),
  autorefillTriggerCredits: integer('autorefill_trigger_credits'),
  autorefillSubscriptionId: text('autorefill_subscription_id'),
  autorefillCappedAmountCents: integer('autorefill_capped_amount_cents'),
  // 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'DECLINED' | 'CAP_REACHED'.
  // CAP_REACHED is ours, not Shopify's: it records that a refill was refused
  // because the cycle's capped amount was exhausted, so the UI can say
  // something specific instead of silently falling back to manual.
  autorefillStatus: text('autorefill_status'),
```

- [ ] **Step 2: Write the migration SQL by hand**

Create `packages/db/src/migrations/0159_shopify_credit_purchases.sql`:

```sql
CREATE TABLE "shopify_credit_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopify_charge_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"pack_id" text NOT NULL,
	"credits" integer NOT NULL,
	"price_usd_cents" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_credit_purchases" ADD CONSTRAINT "shopify_credit_purchases_store_id_shopify_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "shopify_credit_purchases_store_idx" ON "shopify_credit_purchases" USING btree ("store_id");
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_pack_id" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_trigger_credits" integer;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_capped_amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD COLUMN "autorefill_status" text;
--> statement-breakpoint
-- At most one auto-refill purchase may be in flight per store. Half of the
-- double-charge guard (the other half is a pg_advisory_xact_lock in phase 3);
-- this is the database-level backstop that survives a refactor moving the lock.
CREATE UNIQUE INDEX "shopify_credit_purchases_one_pending_autorefill" ON "shopify_credit_purchases" USING btree ("store_id") WHERE "status" = 'PENDING' AND "source" = 'autorefill';
```

- [ ] **Step 3: Register the migration in the journal**

Append to the `entries` array in `packages/db/src/migrations/meta/_journal.json`:

```json
		{
			"idx": 159,
			"version": "7",
			"when": 1787058000000,
			"tag": "0159_shopify_credit_purchases",
			"breakpoints": true
		}
```

- [ ] **Step 4: Apply and verify**

```bash
pnpm docker:up
pnpm db:migrate
```

Then confirm the table and the partial index exist:

```bash
docker exec -i tryme-postgres psql -U postgres -d tryme -c "\d shopify_credit_purchases"
```

Expected: the table with all ten columns, the `store_idx` btree index, and `shopify_credit_purchases_one_pending_autorefill` shown as a partial unique index.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/0159_shopify_credit_purchases.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): shopify_credit_purchases table and auto-refill columns"
```

---

### Task 3: Purchase business logic

**Files:**
- Create: `apps/api/src/modules/shopify/purchase.ts`
- Test: `apps/api/test/integration/shopify-purchase.test.ts` (created in Task 4)

**Interfaces:**
- Consumes: `getPack`, `getShopifyPackCredits` (Task 1); `schema.shopifyCreditPurchases` (Task 2); existing `shopifyGraphQL(shopDomain, accessToken, query, variables?)` from `./service.js`, `getValidAccessToken(app, store)` from `./token.js`, `grantStore(db, storeId, amount, reason, externalRef?)` from `../credits/shopify-ledger.js`.
- Produces:
  - `createPurchase(app, store, packId, deps?): Promise<{ purchaseId: string; confirmationUrl: string }>`
  - `confirmPurchase(app, store, purchaseId, deps?): Promise<{ status: string; creditsGranted: number; creditBalance: number }>`
  - `grantShopifyTrialCredits(app, store): Promise<{ creditsGranted: number }>` (moved verbatim from `billing.ts`)
  - `interface OneTimePurchaseState { id: string; status: string; test: boolean }`

- [ ] **Step 1: Write the module**

Create `apps/api/src/modules/shopify/purchase.ts`:

```ts
import { schema } from '@tryme/db';
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getShopifyPackCredits, getShopifyTrialCredits } from '../../lib/resolution-config.js';
import { grantStore } from '../credits/shopify-ledger.js';
import { getPack } from './packs.js';
import { shopifyGraphQL } from './service.js';
import { getValidAccessToken } from './token.js';

type Store = typeof schema.shopifyStores.$inferSelect;

export interface OneTimePurchaseState {
  id: string;
  status: string;
  test: boolean;
}

const CREATE_PURCHASE_MUTATION = `
  mutation CreateCreditPackPurchase($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
    appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
      confirmationUrl
      appPurchaseOneTime {
        id
        status
        test
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * node(id:) rather than paginating currentAppInstallation.oneTimePurchases —
 * AppPurchaseOneTime implements Node, so a store with a long purchase history
 * costs one lookup instead of a page walk.
 */
const PURCHASE_STATUS_QUERY = `
  query CreditPackPurchaseStatus($id: ID!) {
    node(id: $id) {
      ... on AppPurchaseOneTime {
        id
        status
        test
      }
    }
  }
`;

interface CreateDeps {
  createCharge?: (
    app: FastifyInstance,
    store: Store,
    args: { name: string; amountUsd: number; returnUrl: string; test: boolean },
  ) => Promise<{ confirmationUrl: string; purchase: OneTimePurchaseState }>;
}

async function defaultCreateCharge(
  app: FastifyInstance,
  store: Store,
  args: { name: string; amountUsd: number; returnUrl: string; test: boolean },
) {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appPurchaseOneTimeCreate: {
      confirmationUrl: string | null;
      appPurchaseOneTime: OneTimePurchaseState | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(store.shopDomain, accessToken, CREATE_PURCHASE_MUTATION, {
    name: args.name,
    price: { amount: args.amountUsd.toFixed(2), currencyCode: 'USD' },
    returnUrl: args.returnUrl,
    test: args.test,
  });

  const payload = data.appPurchaseOneTimeCreate;
  if (payload.userErrors?.length) {
    throw new AppError('SHOPIFY', 502, payload.userErrors.map((e) => e.message).join('; '));
  }
  if (!payload.confirmationUrl || !payload.appPurchaseOneTime) {
    throw new AppError('SHOPIFY', 502, 'Shopify returned no confirmation URL for the charge');
  }
  return { confirmationUrl: payload.confirmationUrl, purchase: payload.appPurchaseOneTime };
}

/**
 * Starts a manual credit-pack purchase.
 *
 * The row is INSERTed *before* the charge is created so a Shopify failure
 * leaves an auditable FAILED row rather than nothing at all — "we tried and
 * Shopify refused" is a materially different fact from "the merchant never
 * clicked", and only the row can tell them apart afterwards.
 *
 * `test` mirrors the store's own environment gate rather than being hardcoded:
 * a development store can only ever be charged in test mode, and production
 * must never issue one.
 */
export async function createPurchase(
  app: FastifyInstance,
  store: Store,
  packId: string,
  deps: CreateDeps = {},
): Promise<{ purchaseId: string; confirmationUrl: string }> {
  const createCharge = deps.createCharge ?? defaultCreateCharge;

  const pack = getPack(packId);
  if (!pack) throw new AppError('BAD_REQUEST', 400, 'unknown pack');

  // SHOPIFY_APP_URL is optional in the env schema, and interpolating an
  // undefined into the return URL would strand a merchant on a broken page
  // *after* they had already been charged. Fail before creating the charge.
  if (!app.env.SHOPIFY_APP_URL) {
    throw new AppError('CONFIG', 500, 'SHOPIFY_APP_URL is not configured');
  }

  // Snapshotted here, at INSERT — see the shopify_credit_purchases docstring
  // for why the grant must never re-read this later.
  const credits = await getShopifyPackCredits(app, pack.id, 'manual');
  if (credits === null) throw new AppError('BAD_REQUEST', 400, 'unknown pack');

  const [row] = await app.db
    .insert(schema.shopifyCreditPurchases)
    .values({
      storeId: store.id,
      source: 'manual',
      packId: pack.id,
      credits,
      priceUsdCents: Math.round(pack.priceUsd * 100),
      status: 'PENDING',
    })
    .returning({ id: schema.shopifyCreditPurchases.id });

  // Try-ons are the merchant-facing unit — no merchant has an intuition for
  // what 2,250 credits buys, and this string is what Shopify prints on the
  // approval page and the invoice. Derived from the live cost rather than
  // hardcoded so it stays honest if an admin retunes tryon.creditCost.
  const tryOns = Math.floor(credits / SIMPLE_TRYON_COST);
  const returnUrl = `${app.env.SHOPIFY_APP_URL}/shopify-admin/billing/callback?purchase=${row.id}`;

  try {
    const { confirmationUrl, purchase } = await createCharge(app, store, {
      name: `TryMe — ${tryOns} try-ons`,
      amountUsd: pack.priceUsd,
      returnUrl,
      test: app.env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS === true,
    });
    await app.db
      .update(schema.shopifyCreditPurchases)
      .set({ shopifyChargeId: purchase.id, updatedAt: new Date() })
      .where(eq(schema.shopifyCreditPurchases.id, row.id));
    return { purchaseId: row.id, confirmationUrl };
  } catch (err) {
    await app.db
      .update(schema.shopifyCreditPurchases)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(schema.shopifyCreditPurchases.id, row.id));
    throw err;
  }
}

interface ConfirmDeps {
  fetchPurchase?: (
    app: FastifyInstance,
    store: Store,
    chargeId: string,
  ) => Promise<OneTimePurchaseState | null>;
}

async function defaultFetchPurchase(app: FastifyInstance, store: Store, chargeId: string) {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{ node: OneTimePurchaseState | null }>(
    store.shopDomain,
    accessToken,
    PURCHASE_STATUS_QUERY,
    { id: chargeId },
  );
  return data.node;
}

async function storeBalance(app: FastifyInstance, storeId: string): Promise<number> {
  const [row] = await app.db
    .select({ balance: schema.shopifyStoreCredits.balance })
    .from(schema.shopifyStoreCredits)
    .where(eq(schema.shopifyStoreCredits.storeId, storeId))
    .limit(1);
  return row?.balance ?? 0;
}

/**
 * Grants credits for a purchase Shopify says is ACTIVE.
 *
 * Shared by the merchant-facing confirm route and the
 * APP_PURCHASES_ONE_TIME_UPDATE webhook, which can race each other — a merchant
 * who approves and immediately lands back on our page will often beat the
 * webhook. Idempotency is the external_ref partial unique index on
 * shopify_credit_ledger (migration 0150), keyed on Shopify's own charge id, so
 * whichever arrives first grants and the other reports zero. That, not
 * application-level locking, is what makes this safe — matching the
 * atomicDeduct/refund idiom this codebase already uses.
 */
export async function grantForPurchase(
  app: FastifyInstance,
  purchaseRow: typeof schema.shopifyCreditPurchases.$inferSelect,
  observed: OneTimePurchaseState,
): Promise<number> {
  // Shopify marks a charge `test` when no money will ever change hands — always
  // the case on a development store, which any Partner can create for free and
  // without limit. Granting against one gives product away: once the app is
  // publicly installable, anyone could install on a fresh dev store, buy a
  // pack, take the credits, and repeat. Credits are GPU spend, so that converts
  // straight into cost.
  //
  // `=== true` rather than truthiness: the test harness casts an Env object
  // directly and leaves this undefined, and a gate guarding revenue must read
  // as denied for anything that is not explicitly boolean true.
  const testAllowed = !observed.test || app.env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS === true;

  if (observed.test && !testAllowed) {
    app.log.warn(
      { storeId: purchaseRow.storeId, purchaseId: purchaseRow.id },
      'shopify test purchase — no credits granted (set SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS=true to allow)',
    );
    return 0;
  }
  if (observed.status !== 'ACTIVE') return 0;

  // Distinct reason so test-funded credits stay separable from paid ones in the
  // ledger forever. `reason` is free text and is only ever written, so this
  // needs no migration and breaks no reader.
  const reason = observed.test ? 'SHOPIFY_PACK_TEST' : 'SHOPIFY_PACK';
  const externalRef = `shopify_pack:${observed.id}`;
  const { granted } = await grantStore(
    app.db,
    purchaseRow.storeId,
    purchaseRow.credits,
    reason,
    externalRef,
  );
  return granted ? purchaseRow.credits : 0;
}

/**
 * The merchant-facing confirm path, hit after Shopify's approval redirect.
 *
 * The `purchase` param is our own row UUID, never the Shopify GID, and is only
 * ever a lookup key: credits come from the row and the charge's real state comes
 * from Shopify. A merchant editing the URL can at worst point at another store's
 * row, which the storeId check rejects with a 404 — not a 403, which would
 * confirm that row exists.
 */
export async function confirmPurchase(
  app: FastifyInstance,
  store: Store,
  purchaseId: string,
  deps: ConfirmDeps = {},
): Promise<{ status: string; creditsGranted: number; creditBalance: number }> {
  const fetchPurchase = deps.fetchPurchase ?? defaultFetchPurchase;

  const [row] = await app.db
    .select()
    .from(schema.shopifyCreditPurchases)
    .where(eq(schema.shopifyCreditPurchases.id, purchaseId))
    .limit(1);

  if (!row || row.storeId !== store.id) {
    throw new AppError('NOT_FOUND', 404, 'purchase not found');
  }
  if (!row.shopifyChargeId) {
    return { status: row.status, creditsGranted: 0, creditBalance: await storeBalance(app, store.id) };
  }

  const observed = await fetchPurchase(app, store, row.shopifyChargeId);
  if (!observed) {
    throw new AppError('SHOPIFY', 502, 'charge not found at Shopify');
  }

  const creditsGranted = await grantForPurchase(app, row, observed);

  await app.db
    .update(schema.shopifyCreditPurchases)
    .set({ status: observed.status, updatedAt: new Date() })
    .where(eq(schema.shopifyCreditPurchases.id, row.id));

  return {
    status: observed.status,
    creditsGranted,
    creditBalance: await storeBalance(app, store.id),
  };
}

/**
 * Grants the one-time free-tier credits to a store at install time, called from
 * provisionShopifyStore. Independent of any purchase — this exists so a
 * merchant can try the feature before buying anything.
 *
 * Idempotent via the same external_ref index (migration 0150), keyed on store
 * id alone so this is strictly one-time per store: unlinking and relinking the
 * same store does not re-grant, but a different store linked to the same owner
 * does.
 *
 * Moved here verbatim from the deleted billing.ts — it is the 25-credit free
 * tier and has nothing to do with subscriptions.
 */
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

- [ ] **Step 2: Repoint the trial-credits import**

Find the caller of `grantShopifyTrialCredits`:

```bash
grep -rn "grantShopifyTrialCredits" apps/api/src --include=*.ts
```

In each file that imports it from `./billing.js`, change the import to `./purchase.js`.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -v "modules/shopify/billing" | head -20`
Expected: no output (errors remaining only in `billing.ts`, deleted in Task 9)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/purchase.ts apps/api/src/modules/shopify/token.ts
git commit -m "feat(shopify): credit pack purchase and confirm logic"
```

---

### Task 4: Purchase routes and integration tests

**Files:**
- Create: `apps/api/src/modules/shopify/purchase.routes.ts`
- Create: `apps/api/test/integration/shopify-purchase.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `packages/types/src/shopify.ts` (or wherever Shopify request schemas live — check with `ls packages/types/src`)

**Interfaces:**
- Consumes: `createPurchase`, `confirmPurchase` (Task 3).
- Produces: `POST /v1/shopify/billing/purchase` (body `{ packId }`) → `{ purchaseId, confirmationUrl }`; `GET /v1/shopify/billing/purchase/confirm?purchase=<uuid>` → `{ status, creditsGranted, creditBalance }`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/shopify-purchase.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPurchase, confirmPurchase } from '../../src/modules/shopify/purchase.js';
import { buildTestApp } from '../helpers/api.js';
import { setupTestContainers, teardownTestContainers } from '../helpers/containers.js';

let ctx: Awaited<ReturnType<typeof setupTestContainers>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;

const fakeCharge = (overrides: Partial<{ id: string; status: string; test: boolean }> = {}) => ({
  id: 'gid://shopify/AppPurchaseOneTime/1',
  status: 'ACTIVE',
  test: false,
  ...overrides,
});

beforeAll(async () => {
  ctx = await setupTestContainers();
  app = await buildTestApp(ctx);
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'purchase-test.myshopify.com',
      shopifyShopId: 987654321,
      accessToken: 'enc:token',
      scope: 'read_products',
    })
    .returning();
});

afterAll(async () => {
  await app.close();
  await teardownTestContainers(ctx);
});

describe('credit pack purchase', () => {
  it('writes a PENDING row and returns the confirmation URL', async () => {
    const result = await createPurchase(app, store, 'pack_25', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/confirm',
        purchase: fakeCharge(),
      }),
    });

    expect(result.confirmationUrl).toBe('https://shopify.test/confirm');

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, result.purchaseId));

    expect(row.status).toBe('PENDING');
    expect(row.credits).toBe(2250);
    expect(row.priceUsdCents).toBe(2500);
    expect(row.source).toBe('manual');
  });

  it('rejects an unknown pack id without writing a row', async () => {
    const before = await app.db.select().from(schema.shopifyCreditPurchases);
    await expect(createPurchase(app, store, 'pack_999')).rejects.toThrow();
    const after = await app.db.select().from(schema.shopifyCreditPurchases);
    expect(after.length).toBe(before.length);
  });

  it('grants credits once on an ACTIVE charge, and never twice', async () => {
    const chargeId = 'gid://shopify/AppPurchaseOneTime/double';
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId }),
      }),
    });
    const deps = { fetchPurchase: async () => fakeCharge({ id: chargeId }) };

    const first = await confirmPurchase(app, store, purchaseId, deps);
    expect(first.creditsGranted).toBe(800);

    const second = await confirmPurchase(app, store, purchaseId, deps);
    expect(second.creditsGranted).toBe(0);
    expect(second.creditBalance).toBe(first.creditBalance);
  });

  it('grants nothing while the charge is still PENDING', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/pending' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/pending', status: 'PENDING' }),
    });
    expect(result.creditsGranted).toBe(0);
    expect(result.status).toBe('PENDING');
  });

  it('grants nothing for a DECLINED charge', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/declined' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/declined', status: 'DECLINED' }),
    });
    expect(result.creditsGranted).toBe(0);
  });

  it('grants nothing for a test charge when the env gate is off', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/test' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/test', test: true }),
    });
    expect(result.creditsGranted).toBe(0);
  });

  it("returns 404 for another store's purchase row", async () => {
    const [other] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'other-purchase-test.myshopify.com',
        shopifyShopId: 987654322,
        accessToken: 'enc:token',
        scope: 'read_products',
      })
      .returning();
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/other' }),
      }),
    });
    await expect(confirmPurchase(app, other, purchaseId)).rejects.toMatchObject({ statusCode: 404 });
  });

  // The one guarantee in this module a future refactor could quietly undo.
  it('grants the snapshotted credits even after an admin edits the pack', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/snapshot' }),
      }),
    });

    await app.redis.set(
      'config:system',
      JSON.stringify({ shopify: { packCredits: { pack_10: { credits: 999999 } } } }),
    );

    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () => fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/snapshot' }),
    });
    expect(result.creditsGranted).toBe(800);

    await app.redis.del('config:system');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-purchase
```

Expected: FAIL — the module resolves, but assertions fail or the routes file is missing. Confirm the failure is about behaviour, not a missing `shopify_credit_purchases` table (if it is, Task 2's migration did not apply).

- [ ] **Step 3: Write the routes**

Create `apps/api/src/modules/shopify/purchase.routes.ts`:

```ts
import type { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { confirmPurchase, createPurchase } from './purchase.js';

const PurchaseBody = z.object({ packId: z.string().min(1).max(64) });
const ConfirmQuery = z.object({ purchase: z.string().uuid() });

export async function shopifyPurchaseRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/billing/purchase',
    { preHandler: app.requireShopifySession, schema: { body: PurchaseBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { packId } = req.body as z.infer<typeof PurchaseBody>;
      return createPurchase(app, store, packId);
    },
  );

  app.get(
    '/v1/shopify/billing/purchase/confirm',
    { preHandler: app.requireShopifySession, schema: { querystring: ConfirmQuery } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { purchase } = req.query as z.infer<typeof ConfirmQuery>;
      return confirmPurchase(app, store, purchase);
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/modules/shopify/routes.ts`, add the import and registration:

```ts
import { shopifyPurchaseRoutes } from './purchase.routes.js';
```

and immediately after `await app.register(shopifyMeRoutes);`:

```ts
  await app.register(shopifyPurchaseRoutes);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-purchase
```

Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/purchase.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/integration/shopify-purchase.test.ts
git commit -m "feat(shopify): credit pack purchase routes"
```

---

### Task 5: One-time purchase webhook

**Files:**
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts:52-59` (topic list), the `switch (topic)` block, and `:183-187` (registration map)

**Interfaces:**
- Consumes: `grantForPurchase` (Task 3), `schema.shopifyCreditPurchases` (Task 2).
- Produces: nothing consumed by later tasks.

**Why this exists:** Shopify's App Pricing sent no webhooks, which is why the old code polled. Manual Pricing does send `app_purchases_one_time/update`, so a merchant who approves a charge and closes the tab before the redirect still gets their credits. Our spec previously claimed this webhook did not exist — it does.

- [ ] **Step 1: Add the topic to the handled list**

In `apps/api/src/modules/shopify/webhook.routes.ts`, add to the `topics` array (line 52):

```ts
    'app_purchases_one_time_update',
```

- [ ] **Step 2: Add the handler branch**

Inside the `switch (topic)` block, add:

```ts
          case 'app_purchases_one_time_update': {
            // The payload's charge id is the only field we trust — everything
            // else (status especially) is re-read from our own row, and the
            // grant is idempotent on the charge id, so a replayed or spoofed
            // duplicate cannot double-grant. HMAC has already been verified
            // above, but defence in depth is cheap here.
            const chargeGid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
            const status = (payload as { status?: string }).status;
            if (!store || !chargeGid || !status) break;

            const [purchaseRow] = await app.db
              .select()
              .from(schema.shopifyCreditPurchases)
              .where(eq(schema.shopifyCreditPurchases.shopifyChargeId, chargeGid))
              .limit(1);
            if (!purchaseRow || purchaseRow.storeId !== store.id) break;

            const granted = await grantForPurchase(app, purchaseRow, {
              id: chargeGid,
              status: status.toUpperCase(),
              // Shopify sends this as a boolean on the one-time purchase payload.
              test: Boolean((payload as { test?: boolean }).test),
            });
            await app.db
              .update(schema.shopifyCreditPurchases)
              .set({ status: status.toUpperCase(), updatedAt: new Date() })
              .where(eq(schema.shopifyCreditPurchases.id, purchaseRow.id));
            req.log.info(
              { topic, storeId: store.id, purchaseId: purchaseRow.id, granted },
              'one-time purchase webhook processed',
            );
            break;
          }
```

Widen the `payload` type annotation at line 69 to include the new fields:

```ts
      const payload = JSON.parse(raw.toString() || '{}') as {
        id?: number;
        customer?: { id?: number; email?: string };
        admin_graphql_api_id?: string;
        status?: string;
        test?: boolean;
      };
```

Add the import at the top of the file:

```ts
import { grantForPurchase } from './purchase.js';
```

- [ ] **Step 3: Register the topic with Shopify**

In the `map` inside `registerWebhooksDecorator` (line 183), add:

```ts
      'app_purchases_one_time/update': `${base}/app_purchases_one_time_update`,
```

- [ ] **Step 4: Write the failing test**

Append to `apps/api/test/integration/shopify-purchase.test.ts`:

```ts
describe('one-time purchase webhook', () => {
  it('grants credits for a merchant who never returned to the confirm route', async () => {
    const chargeId = 'gid://shopify/AppPurchaseOneTime/webhook';
    const { purchaseId } = await createPurchase(app, store, 'pack_50', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId }),
      }),
    });

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

    const granted = await grantForPurchase(app, row, {
      id: chargeId,
      status: 'ACTIVE',
      test: false,
    });
    expect(granted).toBe(4800);

    // The merchant later opens the app and hits confirm — must not double-grant.
    const confirmResult = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () => fakeCharge({ id: chargeId }),
    });
    expect(confirmResult.creditsGranted).toBe(0);
  });
});
```

Add `grantForPurchase` to the import at the top of that test file.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts shopify-purchase
```

Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/webhook.routes.ts apps/api/test/integration/shopify-purchase.test.ts
git commit -m "feat(shopify): grant pack credits from the one-time purchase webhook"
```

---

### Task 6: Shopify SPA — packs replace the plan picker

**Files:**
- Create: `apps/shopify/src/lib/packs.ts`
- Rewrite: `apps/shopify/src/pages/PricingPage.tsx`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx:165-195`
- Modify: `apps/shopify/src/pages/BillingCallbackPage.tsx`
- Modify: `apps/shopify/src/types.ts:78-90`
- Delete: `apps/shopify/src/lib/billing.ts`, `apps/shopify/src/lib/planFeatures.ts`, `apps/shopify/src/lib/planFeatures.test.ts`, `apps/shopify/src/lib/billing.test.ts`

**Interfaces:**
- Consumes: `POST /v1/shopify/billing/purchase`, `GET /v1/shopify/billing/purchase/confirm` (Task 4); existing `apiFetch`, `navigateTopLevel` from `../lib/api`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the display-copy module**

Create `apps/shopify/src/lib/packs.ts`:

```ts
// Display copy only. The credit-granting source of truth is
// apps/api/src/modules/shopify/packs.ts, kept deliberately separate so a copy
// change here can never silently change what a merchant is actually granted.
// If these numbers drift from the API's, the API wins and the merchant sees
// the API's figure in their balance.
export interface PackDisplay {
  id: 'pack_10' | 'pack_25' | 'pack_50' | 'pack_100';
  label: string;
  priceUsd: number;
  credits: number;
  tryOns: number;
  bestValue?: boolean;
}

export const PACK_DISPLAY: PackDisplay[] = [
  { id: 'pack_10', label: 'Starter', priceUsd: 10, credits: 800, tryOns: 160 },
  { id: 'pack_25', label: 'Growth', priceUsd: 25, credits: 2250, tryOns: 450, bestValue: true },
  { id: 'pack_50', label: 'Scale', priceUsd: 50, credits: 4800, tryOns: 960 },
  { id: 'pack_100', label: 'Volume', priceUsd: 100, credits: 10000, tryOns: 2000 },
];

export const SHARED_FEATURE_BULLETS = [
  'Unlimited products',
  'AI Virtual Try-On',
  'Outfit Builder',
  'Customer Photo Upload',
  'Shopify Integration',
  'Try-On Button',
  'Multiple Garment Categories',
  'Realistic AI Rendering',
  'Try-On History',
  'Mobile & Desktop Support',
];

/** Credits never expire, so this is the merchant's whole runway, not a monthly allowance. */
export function tryOnsFromCredits(credits: number): number {
  return Math.floor(credits / 5);
}
```

- [ ] **Step 2: Rewrite the pricing page**

Replace the entire contents of `apps/shopify/src/pages/PricingPage.tsx`:

```tsx
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineGrid,
  InlineStack,
  Page,
  SkeletonBodyText,
  SkeletonPage,
  Text,
} from '@shopify/polaris';
import { CheckIcon } from '@shopify/polaris-icons';
import { useEffect, useState } from 'react';
import { apiFetch, navigateTopLevel } from '../lib/api';
import { PACK_DISPLAY, SHARED_FEATURE_BULLETS, tryOnsFromCredits } from '../lib/packs';
import type { ShopifyMe } from '../types';

export default function PricingPage() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function buyPack(packId: string) {
    setBuying(packId);
    setError(null);
    try {
      const { confirmationUrl } = await apiFetch<{ purchaseId: string; confirmationUrl: string }>(
        '/v1/shopify/billing/purchase',
        { method: 'POST', body: JSON.stringify({ packId }) },
      );
      // Shopify's approval page is outside the embedded app's origin, so this
      // must be a top-level navigation — an iframe navigation is blocked.
      navigateTopLevel(confirmationUrl);
    } catch (err) {
      setError((err as Error).message);
      setBuying(null);
    }
  }

  if (loading) {
    return (
      <SkeletonPage primaryAction>
        <SkeletonBodyText />
      </SkeletonPage>
    );
  }

  const balance = me?.creditBalance ?? 0;

  return (
    <Page title="Credits" subtitle="Buy credits once. They never expire.">
      <BlockStack gap="400">
        {error && <Banner tone="critical">{error}</Banner>}

        <Card>
          <BlockStack gap="200">
            <Text as="p" tone="subdued">
              Current balance
            </Text>
            <Text as="p" variant="heading2xl">
              {balance.toLocaleString()} credits
            </Text>
            <Text as="p" tone="subdued">
              About {tryOnsFromCredits(balance).toLocaleString()} try-ons remaining
            </Text>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          {PACK_DISPLAY.map((pack) => (
            <Card key={pack.id}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {pack.label}
                  </Text>
                  {pack.bestValue && <Badge tone="success">Best value</Badge>}
                </InlineStack>

                <Text as="p" variant="heading2xl">
                  ${pack.priceUsd}
                </Text>

                <BlockStack gap="100">
                  <Text as="p">{pack.tryOns.toLocaleString()} try-ons</Text>
                  <Text as="p" tone="subdued">
                    {pack.credits.toLocaleString()} credits · never expire
                  </Text>
                </BlockStack>

                <Button
                  variant="primary"
                  loading={buying === pack.id}
                  disabled={buying !== null}
                  onClick={() => buyPack(pack.id)}
                >
                  Buy credits
                </Button>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Included with every pack
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="200">
              {SHARED_FEATURE_BULLETS.map((label) => (
                <InlineStack key={label} gap="200" blockAlign="center" wrap={false}>
                  <Box width="20px">
                    <Icon source={CheckIcon} tone="success" />
                  </Box>
                  <Text as="span">{label}</Text>
                </InlineStack>
              ))}
            </InlineGrid>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 3: Update the callback page**

In `apps/shopify/src/pages/BillingCallbackPage.tsx`, keep the retry loop, the `SHOPIFY_REAUTH_REQUIRED` early return, and the page's refusal to fail silently exactly as they are. Three changes:

Replace the fetch inside the loop (line 37) with:

```tsx
        const purchase = new URLSearchParams(window.location.search).get('purchase') ?? '';
        const result = await apiFetch<{
          status: string;
          creditsGranted: number;
          creditBalance: number;
        }>(`/v1/shopify/billing/purchase/confirm?purchase=${encodeURIComponent(purchase)}`);
        // A DECLINED purchase is a normal outcome, not a failure — the merchant
        // looked at the charge and said no. Sending them to the dashboard with
        // no comment would be confusing, but so would an error banner about a
        // charge that deliberately never happened.
        if (result.status === 'DECLINED' || result.status === 'EXPIRED') {
          setDeclined(true);
          return;
        }
        navigate('/', { replace: true });
        return;
```

Add the state near line 31:

```tsx
  const [declined, setDeclined] = useState(false);
```

Add a declined branch before the existing `if (error)` block:

```tsx
  if (declined) {
    return (
      <Page>
        <Banner
          title="No charge was made"
          tone="info"
          action={{ content: 'Back to credits', onAction: () => navigate('/pricing') }}
        >
          <Text as="p">
            You didn't approve the charge, so nothing was billed and no credits were added.
          </Text>
        </Banner>
      </Page>
    );
  }
```

Finally, update the error-state copy (lines 64-80), which currently talks about plans and billing periods that no longer exist:

```tsx
          title="We couldn't confirm your purchase"
```

```tsx
            <Text as="p">
              You may have been charged, but we haven't been able to add the credits to your
              account yet. Retrying is safe — credits are only ever granted once per purchase.
            </Text>
```

- [ ] **Step 4: Trim the ShopifyMe type**

In `apps/shopify/src/types.ts`, delete these four lines from the `store` object (lines 81-84):

```ts
    planHandle: string | null;
    subscriptionStatus: string | null;
    billingMode: 'prepaid' | 'usage';
    paygSpendCapUsdCents: number | null;
```

Also delete the `paygSpendThisCycleUsdCents` field if present.

- [ ] **Step 5: Update the dashboard**

In `apps/shopify/src/pages/DashboardPage.tsx`, replace the plan-status block (lines ~165-195) with a credit-balance block:

```tsx
              <Text as="p" tone="subdued">
                Credit balance
              </Text>
              <Text as="p" variant="heading2xl">
                {(me?.creditBalance ?? 0).toLocaleString()}
              </Text>
              <Button url="/pricing">Buy credits</Button>
```

Remove the now-unused `PLAN_LABELS` constant and any import of `resolvePlanSelectionUrl`.

- [ ] **Step 6: Delete the dead modules**

```bash
git rm apps/shopify/src/lib/billing.ts apps/shopify/src/lib/billing.test.ts apps/shopify/src/lib/planFeatures.ts apps/shopify/src/lib/planFeatures.test.ts
```

- [ ] **Step 7: Typecheck and build**

```bash
pnpm --filter @tryme/shopify-admin typecheck
```

Expected: no errors. If any file still imports `planFeatures` or `billing`, fix the import — those modules are gone.

- [ ] **Step 8: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify-admin): credit pack purchase UI replaces the plan picker"
```

---

### Task 7: Admin panel — per-pack credit inputs

**Files:**
- Modify: `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx`

**Interfaces:**
- Consumes: `shopify.packCredits` in `SystemConfigBody` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the plan state with pack state**

In `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx`, add above the component:

```tsx
// Static, and deliberately not editable here: the price is the number sent to
// Shopify in the charge mutation. Config that changes what a merchant is
// *charged* is a different risk class from config that changes what they
// *receive*, so only the credit figures below are tunable.
const PACKS = [
  { id: 'pack_10', label: 'Starter', priceUsd: 10 },
  { id: 'pack_25', label: 'Growth', priceUsd: 25 },
  { id: 'pack_50', label: 'Scale', priceUsd: 50 },
  { id: 'pack_100', label: 'Volume', priceUsd: 100 },
] as const;

type PackId = (typeof PACKS)[number]['id'];
type PackCredits = Record<PackId, { credits: number; autorefillCredits: number }>;

const DEFAULT_PACK_CREDITS: PackCredits = {
  pack_10: { credits: 800, autorefillCredits: 880 },
  pack_25: { credits: 2250, autorefillCredits: 2475 },
  pack_50: { credits: 4800, autorefillCredits: 5280 },
  pack_100: { credits: 10000, autorefillCredits: 11000 },
};

function centsPerCredit(priceUsd: number, credits: number): string {
  if (!credits) return '—';
  return `${((priceUsd * 100) / credits).toFixed(2)}¢/credit`;
}
```

Replace the `shopifyPlanCredits` state (lines 11-15) with:

```tsx
  const [packCredits, setPackCredits] = useState<PackCredits>(DEFAULT_PACK_CREDITS);
```

- [ ] **Step 2: Repoint the load and save calls**

Replace the `apiFetch` type argument and body in the `useEffect` (lines 20-31):

```tsx
    apiFetch<{
      shopify?: {
        trialCredits: number;
        packCredits?: Partial<PackCredits>;
      };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.shopify) {
          setShopifyTrialCredits(cfg.shopify.trialCredits);
          if (cfg.shopify.packCredits) {
            setPackCredits((prev) => ({ ...prev, ...cfg.shopify?.packCredits }));
          }
        }
      })
```

Replace the save body (line 48):

```tsx
          shopify: { trialCredits: shopifyTrialCredits, packCredits },
```

- [ ] **Step 3: Replace the plan rows with pack rows**

Replace the `(['starter', 'growth', 'pro'] as const).map(...)` block (lines 113-157) with:

```tsx
                {PACKS.map((pack) => (
                  <div
                    key={pack.id}
                    style={{
                      display: 'grid',
                      gap: 8,
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r)',
                      background: 'var(--surface-2)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className="setting-lbl">{pack.label}</span>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                        ${pack.priceUsd} · fixed
                      </span>
                    </div>

                    {(['credits', 'autorefillCredits'] as const).map((field) => (
                      <div
                        key={field}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                          {field === 'credits' ? 'One-time purchase' : 'Auto-refill (+bonus)'}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginLeft: 'auto',
                          }}
                        >
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={1000000}
                            style={{ width: 100, textAlign: 'right' }}
                            value={packCredits[pack.id][field]}
                            disabled={saving}
                            onChange={(e) =>
                              setPackCredits((prev) => ({
                                ...prev,
                                [pack.id]: {
                                  ...prev[pack.id],
                                  [field]: Number(e.target.value),
                                },
                              }))
                            }
                          />
                          <span
                            style={{
                              fontSize: 13,
                              color: 'var(--muted)',
                              whiteSpace: 'nowrap',
                              width: 110,
                            }}
                          >
                            {centsPerCredit(pack.priceUsd, packCredits[pack.id][field])}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
```

Also update the trial-credits description (lines 80-82), which still refers to picking a paid plan:

```tsx
                Credits granted once, automatically, the first time a Shopify store links to an
                TryMe account — before the merchant buys any credit pack. This is the free tier.
```

- [ ] **Step 4: Fix the save-button validation**

Replace the `disabled={...}` expression on the save button (lines 165-179) with:

```tsx
                disabled={
                  saving ||
                  !Number.isInteger(shopifyTrialCredits) ||
                  shopifyTrialCredits < 0 ||
                  shopifyTrialCredits > 1000 ||
                  PACKS.some((pack) =>
                    (['credits', 'autorefillCredits'] as const).some((field) => {
                      const value = packCredits[pack.id][field];
                      return !Number.isInteger(value) || value < 1 || value > 1000000;
                    }),
                  )
                }
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx
git commit -m "feat(admin): per-pack Shopify credit configuration"
```

---

### Task 8: Delete the catalogue-generation feature

**Files:**
- Delete: `apps/api/src/modules/shopify/catalog.routes.ts`, `catalog-options.routes.ts`, `catalog-job.ts`, `catalog-publish.ts`, `apps/api/test/shopify-catalog-publish.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `packages/db/src/schema/jobs.ts` (drop `shopifyCatalogJobs`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Why:** Try-ons at 5 credits are the only billable unit. These routes deduct 25–40 credits per image via `resolveTryonPlan`, so a merchant sold "160 try-ons for $10" could exhaust a pack in 20–32 images. Verified dead: the embedded SPA calls thirteen endpoints and none is `/v1/shopify/catalog/*`, and all four routes sit behind `requireShopifySession`, so the SPA is the only possible caller.

- [ ] **Step 1: Re-verify nothing calls these routes**

```bash
grep -rn "v1/shopify/catalog" apps/shopify/src apps/shopify-extension apps/admin-web/src 2>/dev/null
```

Expected: **no output.** If anything appears, STOP — the premise of this task is wrong and it needs re-scoping.

- [ ] **Step 2: Delete the modules**

```bash
git rm apps/api/src/modules/shopify/catalog.routes.ts \
       apps/api/src/modules/shopify/catalog-options.routes.ts \
       apps/api/src/modules/shopify/catalog-job.ts \
       apps/api/src/modules/shopify/catalog-publish.ts \
       apps/api/test/shopify-catalog-publish.test.ts
```

- [ ] **Step 3: Unregister them**

In `apps/api/src/modules/shopify/routes.ts`, delete these two imports:

```ts
import { shopifyCatalogRoutes } from './catalog.routes.js';
import { shopifyCatalogOptionsRoutes } from './catalog-options.routes.js';
```

and these two registration lines:

```ts
  await app.register(shopifyCatalogOptionsRoutes);
  await app.register(shopifyCatalogRoutes);
```

- [ ] **Step 4: Drop the table from the Drizzle schema**

In `packages/db/src/schema/jobs.ts`, delete the entire `shopifyCatalogJobs` table definition. The SQL drop lands in Task 10.

- [ ] **Step 5: Confirm `resolveTryonPlan` still exists**

```bash
grep -n "export async function resolveTryonPlan" apps/api/src/modules/jobs/create.ts
```

Expected: one match. It is shared with the main web app and must **not** be removed — only the Shopify caller goes.

- [ ] **Step 6: Typecheck**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "modules/shopify/billing\|modules/shopify/payg\|usage-scheduler\|app-events" | head -20
```

Expected: no output beyond the files deleted in Task 9.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api packages/db/src/schema/jobs.ts
git commit -m "refactor(shopify): remove the catalogue generation feature

Try-ons at 5 credits are the only billable unit. These routes deducted
25-40 credits per image via resolveTryonPlan, which the pack pricing does
not describe. Verified dead code: the embedded SPA never called them and
requireShopifySession means nothing else could."
```

---

### Task 9: Delete App Pricing and PAYG billing

**Files:**
- Delete: `billing.ts`, `billing.routes.ts`, `billing-plans.ts`, `billing-plans.test.ts`, `billing-scheduler.ts`, `subscription-client.ts`, `payg.ts`, `payg.routes.ts`, `app-events-client.ts`, `usage-scheduler.ts` (all under `apps/api/src/modules/shopify/`), plus `packages/types/src/payg-constants.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`, `me.routes.ts`, `customer.routes.ts`, `apps/api/src/main.ts`, `apps/api/src/env.ts`, `packages/types/src/index.ts`, `apps/dispatcher/src/job/processor.ts`, `packages/db/src/schema/shopify.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `/v1/shopify/me` response loses `store.planHandle`, `store.subscriptionStatus`, `store.billingMode`, `store.paygSpendCapUsdCents`, and `paygSpendThisCycleUsdCents`.

- [ ] **Step 1: Find and delete the PAYG and billing test files**

```bash
ls apps/api/test/**/*billing* apps/api/test/**/*payg* apps/api/test/**/*usage* 2>/dev/null
```

Delete every file listed — they test code being removed.

- [ ] **Step 2: Delete the modules**

```bash
git rm apps/api/src/modules/shopify/billing.ts \
       apps/api/src/modules/shopify/billing.routes.ts \
       apps/api/src/modules/shopify/billing-plans.ts \
       apps/api/src/modules/shopify/billing-plans.test.ts \
       apps/api/src/modules/shopify/billing-scheduler.ts \
       apps/api/src/modules/shopify/subscription-client.ts \
       apps/api/src/modules/shopify/payg.ts \
       apps/api/src/modules/shopify/payg.routes.ts \
       apps/api/src/modules/shopify/app-events-client.ts \
       apps/api/src/modules/shopify/usage-scheduler.ts \
       packages/types/src/payg-constants.ts
```

- [ ] **Step 3: Unregister the routes and schedulers**

In `apps/api/src/modules/shopify/routes.ts`, delete the `shopifyBillingRoutes` and `shopifyPaygRoutes` imports and their two `app.register` lines.

In `apps/api/src/main.ts`, delete both scheduler imports and their calls:

```ts
import { startBillingScheduler } from './modules/shopify/billing-scheduler.js';
import { startUsageScheduler } from './modules/shopify/usage-scheduler.js';
...
startBillingScheduler(app);
startUsageScheduler(app);
```

In `packages/types/src/index.ts`, delete:

```ts
export * from './payg-constants.js';
```

- [ ] **Step 4: Strip the PAYG branches from job creation**

In `apps/api/src/modules/shopify/customer.routes.ts`:

Line 306-311 becomes:

```ts
      const jobCost = await getTryonCreditCost(app);
      await requireStoreHasCredits(app, store, jobCost);
```

Line ~467 — delete the conditional `billingMode` pin entirely:

```ts
              ...(store.billingMode === 'usage' ? { billingMode: 'usage' as const } : {}),
```

Line ~470 becomes unconditional:

```ts
          await atomicDeductStore(tx as never, storeId, jobCost, jobId);
```

Line ~518 — collapse the enqueue-failure branch to the refund path only:

```ts
            const { compensated } = await refundStoreAndMarkFailed(
              app.db,
              storeId,
              jobCost,
              jobId,
              'REFUND_ENQUEUE_FAIL',
              'ENQUEUE_FAIL',
            );
```

Delete the `checkPaygSpendCap` import.

- [ ] **Step 5: Strip the subscription fields from /me**

In `apps/api/src/modules/shopify/me.routes.ts`, delete the `getPaygSpendThisCycleCents` import and the `paygSpendThisCycleUsdCents` const (lines 69-70), and remove these five fields from the returned object:

```ts
        planHandle: store.planHandle,
        subscriptionStatus: store.subscriptionStatus,
        billingMode: store.billingMode,
        paygSpendCapUsdCents: store.paygSpendCapUsdCents,
...
      paygSpendThisCycleUsdCents,
```

- [ ] **Step 6: Strip PAYG from the dispatcher**

In `apps/dispatcher/src/job/processor.ts`:

Delete the usage-event insert block at lines ~2320-2337 (the `if (params.billingMode === 'usage') { ... }` block and its comment).

At line ~2451, the `if (creditsCharged > 0)` guard and its PAYG comment become unconditional — replace the comment and guard with:

```ts
  await db.transaction(async (tx) => {
```

keeping the transaction body exactly as it is.

Remove `PAYG_PRICE_PER_TRYON_USD_CENTS` from the `@tryme/types` import on line 11.

- [ ] **Step 7: Drop the env vars**

In `apps/api/src/env.ts`, delete lines 99-100:

```ts
  SHOPIFY_APP_EVENTS_CLIENT_ID: z.string().optional(),
  SHOPIFY_APP_EVENTS_CLIENT_SECRET: z.string().optional(),
```

Also remove `SHOPIFY_APP_HANDLE` if present — it existed only to build the hosted plan-picker URL. Keep `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS`: it now gates one-time charges, which carry the same `test` flag and the same abuse shape.

Then remove `VITE_SHOPIFY_APP_HANDLE` from the `args:` blocks in `infra/docker-compose.*.yml` and from `.env.production.example`.

- [ ] **Step 8: Drop the columns from the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, delete from `shopifyStores`: `planHandle`, `subscriptionStatus`, `currentSubscriptionId`, `currentPeriodEnd`, `lastBillingSyncAt`, `billingMode`, `paygSpendCapUsdCents`, `subscriptionIsTest`. Delete the entire `shopifyUsageEvents` table definition. The SQL drop lands in Task 10.

- [ ] **Step 9: Typecheck everything**

```bash
pnpm typecheck
```

Expected: no errors anywhere. Every remaining reference to a deleted symbol must be fixed here.

- [ ] **Step 10: Run the full API test suites**

```bash
pnpm --filter @tryme/api test:unit
cd apps/api && npx vitest run --config vitest.integration.config.ts
```

Expected: all pass. A pre-existing unrelated failure in `src/env.test.ts` about `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` is known (this repo's root `.env` sets it) — confirm it is that exact failure and not something this task caused.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(shopify): remove App Pricing subscriptions and PAYG metering

The wallet model is prepaid packs on Manual Pricing, so the subscription
poller, plan-handle mapping, App Events client and usage scheduler all
have nothing left to do. billing-scheduler existed only because App
Pricing sent no webhooks; Manual Pricing does."
```

---

### Task 10: Destructive migration and cutover checklist

**Files:**
- Create: `packages/db/src/migrations/0160_drop_shopify_app_pricing.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: schema changes from Tasks 8 and 9.
- Produces: nothing.

- [ ] **Step 1: Verify `shopify_catalog_jobs` is empty in production**

This is the one check that could turn a code deletion into a data decision. Reads against production are permitted; writes are not.

```bash
# From the VPS, against the production database:
psql "$DATABASE_URL" -c "SELECT count(*) FROM shopify_catalog_jobs;"
```

Expected: `0`.

**If it returns anything other than 0, STOP.** The jobs those rows track were real and billed, and dropping the table becomes a data decision that needs an explicit call — raise it rather than proceeding. In that case, ship the migration without the `DROP TABLE "shopify_catalog_jobs"` line and leave the table orphaned pending that decision.

- [ ] **Step 2: Write the migration**

Create `packages/db/src/migrations/0160_drop_shopify_app_pricing.sql`:

```sql
ALTER TABLE "shopify_stores" DROP COLUMN "plan_handle";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "subscription_status";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "current_subscription_id";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "current_period_end";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "last_billing_sync_at";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "billing_mode";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "payg_spend_cap_usd_cents";
--> statement-breakpoint
ALTER TABLE "shopify_stores" DROP COLUMN "subscription_is_test";
--> statement-breakpoint
DROP TABLE "shopify_usage_events";
--> statement-breakpoint
DROP TABLE "shopify_catalog_jobs";
```

`shopify_credit_ledger` rows carrying `SHOPIFY_SUBSCRIPTION` / `SHOPIFY_SUBSCRIPTION_TEST` reasons are deliberately left in place — they are historically accurate, and the distinct reason strings keep test-funded grants separable from real ones forever, which is exactly why they exist.

- [ ] **Step 3: Register it in the journal**

Append to `entries` in `packages/db/src/migrations/meta/_journal.json`:

```json
		{
			"idx": 160,
			"version": "7",
			"when": 1787061600000,
			"tag": "0160_drop_shopify_app_pricing",
			"breakpoints": true
		}
```

- [ ] **Step 4: Apply against a clean local database and verify**

```bash
pnpm docker:reset
pnpm docker:up
pnpm db:migrate
```

Then:

```bash
docker exec -i tryme-postgres psql -U postgres -d tryme -c "\d shopify_stores" | grep -E "plan_handle|billing_mode|payg_spend_cap|subscription_is_test"
```

Expected: **no output** — every column is gone.

```bash
docker exec -i tryme-postgres psql -U postgres -d tryme -c "\dt shopify_*"
```

Expected: `shopify_credit_purchases` present; `shopify_usage_events` and `shopify_catalog_jobs` absent.

- [ ] **Step 5: Run the full test suite against the fresh database**

```bash
pnpm --filter @tryme/api test:unit
cd apps/api && npx vitest run --config vitest.integration.config.ts
pnpm typecheck
pnpm lint
```

Expected: all pass.

- [ ] **Step 6: Record the out-of-repo cutover steps**

Append a dated entry to the top of `docs/progress.md` documenting the Partner Dashboard work, which no deploy performs:

```markdown
## 2026-08-19 — Shopify billing: App Pricing → Manual Pricing (prepaid credit packs)

**Out-of-repo state changed (Partner Dashboard) — do before deploying:**
- Switched the app from Shopify App Pricing to Manual Pricing in Partner
  Dashboard settings. Per Shopify staff this needs no app re-review.
- Removed the starter / growth / pro / Pay-as-you-go App Pricing plans and the
  `tryon_generated` usage meter.
- Registered `app_purchases_one_time/update`. The other topics are registered
  per-shop by registerWebhooksDecorator at install.
- Removed `SHOPIFY_APP_EVENTS_CLIENT_ID` / `_SECRET` and
  `SHOPIFY_APP_HANDLE` / `VITE_SHOPIFY_APP_HANDLE` from every `.env` on the VPS
  and from the compose `args:` blocks.

**Note:** `VITE_*` vars are baked in at build time — removing the app-handle arg
requires a rebuild, and a cached layer can silently keep the old value. Confirm
the output asset hash changed.
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/0160_drop_shopify_app_pricing.sql packages/db/src/migrations/meta/_journal.json docs/progress.md
git commit -m "feat(db): drop App Pricing, PAYG and catalogue schema"
```

---

## Verification Checklist

Run before opening the PR into `dev`:

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `pnpm build` — clean
- [ ] `pnpm --filter @tryme/api test:unit` — pass (the known `env.test.ts` local-`.env` failure aside)
- [ ] `cd apps/api && npx vitest run --config vitest.integration.config.ts` — pass
- [ ] `grep -rn "billingMode\|planHandle\|payg\|PAYG\|appEvents\|catalog/generate" apps packages --include=*.ts --include=*.tsx | grep -v dist` returns nothing
- [ ] `pnpm docker:reset && pnpm docker:up && pnpm db:migrate` succeeds from empty
- [ ] Manual: buy a pack on a development store end to end, confirm credits land exactly once, and confirm a second visit to the callback URL grants nothing

## Out of Scope (later phases)

- **Phase 2 — low-balance alerting.** Burn-rate runway, Polaris banners, shop-email fetch, threshold-crossing emails.
- **Phase 3 — auto-refill.** Enrolment, capped-amount subscription, `appUsageRecordCreate`, the trigger path and its two concurrency guards. Blocked on confirming Shopify permits a $0 recurring line with a usage line attached. The `source` column and `autorefill_*` columns land in phase 1 but nothing writes them until then.
