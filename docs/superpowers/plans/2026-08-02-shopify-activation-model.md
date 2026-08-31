# Shopify Activation Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat per-product enable/disable Manage page with a global-toggle + collections + individual-products + exclusions activation model, where exclusion always wins.

**Architecture:** A single pure resolver function (`computeEffectiveEnabled`) encodes the one precedence rule (exclusion beats everything, including global mode) and is the only place that rule is allowed to live. Everything else — the enforcement point in `customer.routes.ts`, every list endpoint, every summary count — either calls the resolver or a thin DB wrapper around it. Collection membership is tracked in a new junction table, synced only for collections a merchant has actually selected (never the whole store's catalog of collections), kept current by an hourly scheduled job riding the same Redis-Streams sync infrastructure the product sync already uses.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM, PostgreSQL 16, Redis Streams (`shopify:sync`), React 18 + Polaris 13, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-02-shopify-activation-model-design.md`

## Global Constraints

- ESM only, pnpm workspaces. Never introduce npm/yarn lockfiles.
- No `console.log` in committed code — use `app.log` / `req.log`.
- `pnpm docker:up` must be running before any integration test.
- **Never run a migration against production or `tryon_prod`** — local/staging only, shipped through the normal push → CI/CD → `db:migrate:prod` path.
- No new Shopify OAuth scopes. Collections are covered by the already-granted `read_products` scope.
- Exclusion always wins — over individual enablement, collection enablement, and global mode. This is the one rule every task touching the resolver must preserve.
- `apps/admin-mobile` is out of scope.
- No per-product/per-variant AI reference image overrides in this plan — explicitly dropped in the spec's Non-Goals.

---

## Plan Corrections Applied In This Plan

**The product/collection "picker" is a custom Polaris modal backed by our own search endpoints, not Shopify's native App Bridge resource picker.** The spec's Section "Collection Sync Mechanism" assumed a Shopify-native resource picker. Checking `apps/shopify/src/lib/appBridge.ts` and `apps/shopify/package.json` shows this app has no `@shopify/app-bridge-react` dependency and talks to App Bridge only through the raw `window.shopify` global plus HTML custom elements (`ui-nav-menu`, `ui-save-bar`) — the modern App Bridge script does not expose a public resource-picker custom element compatible with that setup. Building our own picker is also strictly more correct here: a product must already exist in `shopifyProductGarments` (synced) before it can be enabled at all (pre-existing 404 in `products.routes.ts`), so scoping the product picker to our own synced list, rather than Shopify's full live catalog, prevents picking a product that isn't ready yet. Collections are searched live via a new endpoint that reuses the existing `fetchCollectionTitleMap` helper from `products.sync.ts` (already fetches every custom + smart collection's id/title once per full sync) — exported and reused, not duplicated.

**The Individual Products tab's `enabled` toggle and the Exclusion tab's product-level exclusion both reuse the existing `PATCH /v1/shopify/products/:id` endpoint** (adding `excluded` as a third optional body field) instead of new `/v1/shopify/activation/products` POST/DELETE endpoints as literally listed in the spec's API table. The existing endpoint already has the right shape (single product, `{enabled?, excluded?}`), the right auth, and the right "cannot enable a non-active product" rule. Duplicating it would just be two implementations of the same update.

**The existing `GET /v1/shopify/products` endpoint is extended with optional `enabled`, `excluded`, `status`, and `q` query params** and reused for the Individual Products tab, both Exclusion-tab product lists, and the Failed-to-Sync card, instead of the spec's separate `/v1/shopify/activation/products` and `/v1/shopify/activation/failed` endpoints. One paginated, searchable, filterable product-list endpoint serves every product list in this feature.

None of these change any user-facing behavior described in the spec — they change which existing file implements it.

---

## File Structure

- `packages/db/src/schema/shopify.ts` — four new tables, one new column, one new settings type.
- `packages/db/src/migrations/0136_shopify_activation_model.sql` (new) — hand-written migration.
- `apps/api/src/modules/shopify/activation.ts` (new) — the resolver: pure `computeEffectiveEnabled` + async `resolveEffectiveEnabled` DB wrapper.
- `apps/api/src/modules/shopify/products.routes.ts` (modify) — `GET /v1/shopify/products` gains `enabled`/`excluded`/`status`/`q` filters; `PATCH /v1/shopify/products/:id` gains `excluded`.
- `apps/api/src/modules/shopify/customer.routes.ts` (modify) — enforcement point swapped to the resolver.
- `apps/api/src/modules/shopify/products.sync.ts` (modify) — export `nextPageUrl` and `fetchCollectionTitleMap` for reuse.
- `apps/api/src/modules/shopify/collections.sync.ts` (new) — per-collection membership sync (`collects.json?collection_id=`).
- `apps/api/src/modules/shopify/service.ts` (modify) — `SyncTask` gains a `'collection'` mode.
- `apps/api/src/modules/shopify/sync-consumer.ts` / `products.sync.ts` (modify) — `syncOneTask` dispatches the new mode.
- `apps/api/src/main.ts` (modify) — wires the new hourly scheduler alongside the existing `startSyncConsumer(app)`.
- `apps/api/src/modules/shopify/activation.routes.ts` (new) — mode, summary counts, collections CRUD, exclusions/collections CRUD, collection search.
- `apps/api/src/modules/shopify/routes.ts` (modify) — registers the new route module.
- `apps/shopify/src/lib/activationTabState.ts` (new) — pure helper: is a given tab editable under the current mode.
- `apps/shopify/src/pages/ManagePage.tsx` (full rebuild).
- `docs/progress.md` (modify).

---

## Task 1: Schema — activation tables, exclusion column, migration

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Create: `packages/db/src/migrations/0136_shopify_activation_model.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `schema.shopifyCollections`, `schema.shopifyCollectionProducts`, `schema.shopifyEnabledCollections`, `schema.shopifyExcludedCollections`; `schema.shopifyProductGarments.excluded: boolean`; `ShopifyStoreSettings.activation?: { mode: 'global' | 'selective' }`.

- [ ] **Step 1: Add the `activation` settings type**

In `packages/db/src/schema/shopify.ts`, add above the `ShopifyStoreSettings` interface:

```ts
export interface ShopifyActivationSettings {
  mode: 'global' | 'selective';
}
```

Then add a field to `ShopifyStoreSettings`:

```ts
export interface ShopifyStoreSettings {
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
  limits?: ShopifyStoreLimits;
  retention?: ShopifyStoreRetention;
  widget?: ShopifyWidgetConfig;
  widgetConfigSynced?: boolean;
  activation?: ShopifyActivationSettings;
}
```

- [ ] **Step 2: Add `excluded` to `shopifyProductGarments`**

In the same file, in the `shopifyProductGarments` table definition, add after the `enabled` column:

```ts
    enabled: boolean('enabled').notNull().default(false),
    // Exclusion tab, products sub-section. Always wins over `enabled`, over
    // collection-based enablement, and over global mode — see
    // apps/api/src/modules/shopify/activation.ts.
    excluded: boolean('excluded').notNull().default(false),
```

- [ ] **Step 3: Add the four new tables**

Append at the end of `packages/db/src/schema/shopify.ts`:

```ts
/**
 * Cached collection metadata — only for collections a merchant has actually
 * selected (enabled or excluded). Never populated for the whole store's
 * collection list; there is no reason to know about a collection nobody
 * picked.
 */
export const shopifyCollections = pgTable(
  'shopify_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);

/**
 * Collection membership, rebuilt in full for one collection at a time
 * (delete + reinsert that collection's rows) whenever that collection is
 * synced — never diffed, membership sets are small enough not to need it.
 */
export const shopifyCollectionProducts = pgTable(
  'shopify_collection_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId, t.shopifyProductId),
    byStoreProduct: index('shopify_collection_products_store_product_idx').on(
      t.storeId,
      t.shopifyProductId,
    ),
    byStoreCollection: index('shopify_collection_products_store_collection_idx').on(
      t.storeId,
      t.shopifyCollectionId,
    ),
  }),
);

/** Collections tab: merchant's picks for collection-level enablement. */
export const shopifyEnabledCollections = pgTable(
  'shopify_enabled_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);

/** Exclusion tab, collections sub-section. */
export const shopifyExcludedCollections = pgTable(
  'shopify_excluded_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyCollectionId: bigint('shopify_collection_id', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyCollectionId),
  }),
);
```

- [ ] **Step 4: Write the migration**

Create `packages/db/src/migrations/0136_shopify_activation_model.sql`:

```sql
ALTER TABLE "shopify_product_garments" ADD COLUMN IF NOT EXISTS "excluded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "title" text NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_collection_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "shopify_product_id" bigint NOT NULL,
  CONSTRAINT "shopify_collection_products_store_id_shopify_collection_id_shopify_product_id_unique" UNIQUE("store_id","shopify_collection_id","shopify_product_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_enabled_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_enabled_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_excluded_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "shopify_collection_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shopify_excluded_collections_store_id_shopify_collection_id_unique" UNIQUE("store_id","shopify_collection_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_collections" ADD CONSTRAINT "shopify_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_collection_products" ADD CONSTRAINT "shopify_collection_products_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_enabled_collections" ADD CONSTRAINT "shopify_enabled_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shopify_excluded_collections" ADD CONSTRAINT "shopify_excluded_collections_store_id_shopify_stores_id_fk"
   FOREIGN KEY ("store_id") REFERENCES "public"."shopify_stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_collection_products_store_product_idx" ON "shopify_collection_products" ("store_id","shopify_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_collection_products_store_collection_idx" ON "shopify_collection_products" ("store_id","shopify_collection_id");
```

- [ ] **Step 5: Register it in the journal**

In `packages/db/src/migrations/meta/_journal.json`, append after the idx-135 entry (copy its exact `"version"` value):

```json
{
  "idx": 136,
  "version": "7",
  "when": 1786000000000,
  "tag": "0136_shopify_activation_model",
  "breakpoints": true
}
```

- [ ] **Step 6: Apply locally and verify**

Run: `pnpm db:migrate`
Expected: succeeds (a NOTICE about an existing object is safe).

```bash
psql "$DATABASE_URL" -c "\d shopify_collection_products"
```

Expected: two indexes listed beyond the primary key, plus the unique constraint.

**Never run this against production or `tryon_prod`.**

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/0136_shopify_activation_model.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(shopify): activation model schema — collections, exclusions, global mode"
```

---

## Task 2: Resolver — `computeEffectiveEnabled` + `resolveEffectiveEnabled`

**Files:**
- Create: `apps/api/src/modules/shopify/activation.ts`
- Test: `apps/api/test/shopify-activation-resolver.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyCollectionProducts`, `schema.shopifyEnabledCollections`, `schema.shopifyExcludedCollections` (Task 1).
- Produces: `computeEffectiveEnabled(input: EffectiveEnablementInput): boolean`; `resolveEffectiveEnabled(app: FastifyInstance, store: typeof schema.shopifyStores.$inferSelect, garment: { shopifyProductId: number; enabled: boolean; excluded: boolean }): Promise<boolean>`. Task 3 and Task 4 both call these.

- [ ] **Step 1: Write the failing unit tests for the pure resolver**

Create `apps/api/test/shopify-activation-resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeEffectiveEnabled } from '../src/modules/shopify/activation.js';

const base = {
  mode: 'selective' as const,
  individuallyEnabled: false,
  individuallyExcluded: false,
  inEnabledCollection: false,
  inExcludedCollection: false,
};

describe('computeEffectiveEnabled', () => {
  it('is false by default (selective mode, nothing set)', () => {
    expect(computeEffectiveEnabled(base)).toBe(false);
  });

  it('is true when individually enabled', () => {
    expect(computeEffectiveEnabled({ ...base, individuallyEnabled: true })).toBe(true);
  });

  it('is true when in an enabled collection', () => {
    expect(computeEffectiveEnabled({ ...base, inEnabledCollection: true })).toBe(true);
  });

  it('is true for every product when mode is global', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global' })).toBe(true);
  });

  it('individual exclusion wins over individual enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, individuallyEnabled: true, individuallyExcluded: true }),
    ).toBe(false);
  });

  it('individual exclusion wins over collection enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, inEnabledCollection: true, individuallyExcluded: true }),
    ).toBe(false);
  });

  it('collection exclusion wins over individual enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, individuallyEnabled: true, inExcludedCollection: true }),
    ).toBe(false);
  });

  it('collection exclusion wins over collection enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, inEnabledCollection: true, inExcludedCollection: true }),
    ).toBe(false);
  });

  it('individual exclusion wins even under global mode', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global', individuallyExcluded: true })).toBe(
      false,
    );
  });

  it('collection exclusion wins even under global mode', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global', inExcludedCollection: true })).toBe(
      false,
    );
  });

  it('both exclusion signals set still resolves to false, not a crash', () => {
    expect(
      computeEffectiveEnabled({
        ...base,
        mode: 'global',
        individuallyExcluded: true,
        inExcludedCollection: true,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @tryme/api test -- shopify-activation-resolver`
Expected: FAIL — `activation.ts` does not exist yet.

- [ ] **Step 3: Implement the pure resolver and the DB wrapper**

Create `apps/api/src/modules/shopify/activation.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface EffectiveEnablementInput {
  mode: 'global' | 'selective';
  individuallyEnabled: boolean;
  individuallyExcluded: boolean;
  inEnabledCollection: boolean;
  inExcludedCollection: boolean;
}

/**
 * The one place the activation precedence rule is allowed to live. Exclusion
 * is checked first in every branch, including under global mode — a product
 * excluded while global mode is on stays excluded. Every other caller in this
 * codebase (the try-on enforcement point, every list endpoint, every summary
 * count) must go through this function or `resolveEffectiveEnabled` rather
 * than re-deriving the rule.
 */
export function computeEffectiveEnabled(input: EffectiveEnablementInput): boolean {
  if (input.individuallyExcluded || input.inExcludedCollection) return false;
  if (input.mode === 'global') return true;
  return input.individuallyEnabled || input.inEnabledCollection;
}

async function isInCollectionSet(
  app: FastifyInstance,
  storeId: string,
  shopifyProductId: number,
  collectionSetTable:
    | typeof schema.shopifyEnabledCollections
    | typeof schema.shopifyExcludedCollections,
): Promise<boolean> {
  const [row] = await app.db
    .select({ one: sql<number>`1` })
    .from(schema.shopifyCollectionProducts)
    .innerJoin(
      collectionSetTable,
      and(
        eq(collectionSetTable.storeId, schema.shopifyCollectionProducts.storeId),
        eq(collectionSetTable.shopifyCollectionId, schema.shopifyCollectionProducts.shopifyCollectionId),
      ),
    )
    .where(
      and(
        eq(schema.shopifyCollectionProducts.storeId, storeId),
        eq(schema.shopifyCollectionProducts.shopifyProductId, shopifyProductId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * DB-backed wrapper around `computeEffectiveEnabled` for a single product.
 * Two collection-membership lookups plus the pure resolver — this is the
 * function `customer.routes.ts` calls at the actual try-on enforcement point.
 */
export async function resolveEffectiveEnabled(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  garment: { shopifyProductId: number; enabled: boolean; excluded: boolean },
): Promise<boolean> {
  const [inEnabledCollection, inExcludedCollection] = await Promise.all([
    isInCollectionSet(app, store.id, garment.shopifyProductId, schema.shopifyEnabledCollections),
    isInCollectionSet(app, store.id, garment.shopifyProductId, schema.shopifyExcludedCollections),
  ]);

  return computeEffectiveEnabled({
    mode: store.settings.activation?.mode ?? 'selective',
    individuallyEnabled: garment.enabled,
    individuallyExcluded: garment.excluded,
    inEnabledCollection,
    inExcludedCollection,
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @tryme/api test -- shopify-activation-resolver`
Expected: PASS, 11/11.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/activation.ts apps/api/test/shopify-activation-resolver.test.ts
git commit -m "feat(shopify): effective-enablement resolver with exclusion-first precedence"
```

---

## Task 3: Extend the products list and PATCH endpoints

**Files:**
- Modify: `apps/api/src/modules/shopify/products.routes.ts`
- Modify: `apps/api/test/shopify-products.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /v1/shopify/products` accepts `enabled?: boolean`, `excluded?: boolean`, `status?: 'active'|'processing'|'failed'|'deleted'`, `q?: string`. `PATCH /v1/shopify/products/:id` accepts `excluded?: boolean` in addition to the existing `enabled`/`garmentImageUrl`. Task 9's Manage page filters by both `enabled` and `excluded` on this same endpoint (e.g. `?excluded=true` for the Exclusion tab's product list, `?excluded=false&q=` for its "Exclude products" picker).

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/shopify-products.test.ts`, inside the existing `describe('GET /v1/shopify/products', ...)` block:

```ts
  it('filters by enabled', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?enabled=true',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.every((p: { enabled: boolean }) => p.enabled)).toBe(true);
  });

  it('filters by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?status=processing',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Blue Shirt');
  });

  it('filters by search query, case-insensitive', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?q=red',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Red Shirt');
  });

  it('filters by excluded', async () => {
    // Excludes product 2, asserts the filter, then reverts — this file's
    // fixture rows are shared across the whole describe block and later
    // tests assume product 2 starts un-excluded.
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: true },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/products?excluded=true',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe('Blue Shirt');
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/2',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { excluded: false },
      });
    }
  });
```

Add a new `describe` block at the end of the same file:

```ts
describe('PATCH /v1/shopify/products/:id — excluded', () => {
  it('excludes a product regardless of status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toBe(true);
  });

  it('un-excludes a product', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: FAIL — `enabled`/`status`/`q` query params are ignored today (test asserting filtered results fails), and `excluded` is not a recognized field (the PATCH body schema rejects it, or the response lacks `excluded`).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/products.routes.ts`, change the imports line to add `ilike`:

```ts
import { and, count, eq, ilike, ne } from 'drizzle-orm';
```

Replace `ProductsQuery`:

```ts
const ProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  enabled: z.coerce.boolean().optional(),
  excluded: z.coerce.boolean().optional(),
  status: z.enum(['active', 'processing', 'failed', 'deleted']).optional(),
  q: z.string().optional(),
});
```

Replace `PatchProductBody`:

```ts
const PatchProductBody = z
  .object({
    enabled: z.boolean().optional(),
    excluded: z.boolean().optional(),
    garmentImageUrl: z.string().url().optional(),
  })
  .refine(
    (b) => b.enabled !== undefined || b.excluded !== undefined || b.garmentImageUrl !== undefined,
    { message: 'at least one of enabled, excluded, or garmentImageUrl is required' },
  );
```

In the `GET /v1/shopify/products` handler, replace the `notDeleted` condition and query building:

```ts
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { page, pageSize, enabled, excluded, status, q } = req.query as z.infer<
        typeof ProductsQuery
      >;

      const conditions = [eq(schema.shopifyProductGarments.storeId, store.id)];
      conditions.push(
        status
          ? eq(schema.shopifyProductGarments.status, status)
          : ne(schema.shopifyProductGarments.status, 'deleted'),
      );
      if (enabled !== undefined) conditions.push(eq(schema.shopifyProductGarments.enabled, enabled));
      if (excluded !== undefined)
        conditions.push(eq(schema.shopifyProductGarments.excluded, excluded));
      if (q) conditions.push(ilike(schema.shopifyProductGarments.title, `%${q}%`));
      const where = and(...conditions);

      const [{ total }] = await app.db
        .select({ total: count() })
        .from(schema.shopifyProductGarments)
        .where(where);

      const rows = await app.db
        .select({
          shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
          title: schema.shopifyProductGarments.title,
          r2Key: schema.shopifyProductGarments.r2Key,
          status: schema.shopifyProductGarments.status,
          enabled: schema.shopifyProductGarments.enabled,
          excluded: schema.shopifyProductGarments.excluded,
        })
        .from(schema.shopifyProductGarments)
        .where(where)
        .orderBy(schema.shopifyProductGarments.shopifyProductId)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const items = rows.map((r) => ({
        shopifyProductId: r.shopifyProductId,
        title: r.title,
        thumbnailUrl: app.storage.publicUrl(r.r2Key),
        status: r.status,
        enabled: r.enabled,
        excluded: r.excluded,
      }));

      return { page, pageSize, total, items };
```

Don't forget to update the route registration's schema reference — it already points at `ProductsQuery`, no change needed there.

In the `PATCH /v1/shopify/products/:id` handler, update the destructure and the `.set(...)`:

```ts
      const { enabled, excluded, garmentImageUrl } = req.body as z.infer<typeof PatchProductBody>;
```

```ts
      const [updated] = await app.db
        .update(schema.shopifyProductGarments)
        .set({
          ...(enabled !== undefined ? { enabled } : {}),
          ...(excluded !== undefined ? { excluded } : {}),
          ...(newR2Key ? { r2Key: newR2Key } : {}),
        })
        .where(eq(schema.shopifyProductGarments.id, existing.id))
        .returning();

      return {
        shopifyProductId: updated.shopifyProductId,
        title: updated.title,
        thumbnailUrl: app.storage.publicUrl(updated.r2Key),
        status: updated.status,
        enabled: updated.enabled,
        excluded: updated.excluded,
      };
```

Note: `excluded` has no status gate, unlike `enabled` — a product can be excluded regardless of sync status, so the existing `if (enabled === true && existing.status !== 'active')` check is untouched and does not gain an `excluded` counterpart.

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm --filter @tryme/api test -- shopify-products`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/products.routes.ts apps/api/test/shopify-products.test.ts
git commit -m "feat(shopify): filterable product list and product-level exclusion"
```

---

## Task 4: Swap the try-on enforcement point to the resolver

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:325`
- Modify: `apps/api/test/integration/shopify-customer.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveEnabled` (Task 2).

- [ ] **Step 1: Add the failing cases**

`apps/api/test/integration/shopify-customer.test.ts` is the customer job-creation integration test. It has no existing test for the disabled-product refusal path today — its local helpers are `seedOwner(balance)`, `seedStore(ownerUserId)`, `seedDefaultFunnelTemplate()`, `seedGarment(storeId, shopifyProductId)` (hardcodes `enabled: true`, so the two new tests below insert their own garment row directly instead of using it), and `uploadCustomerPhoto(storeKey, bytes)`. Its existing success case (`'creates a job billed to the store owner...'`, line 249) asserts `201` with a `jobId` in the body; a refusal asserts `202` with no `jobId`.

Add these two tests to the same `describe('shopify customer routes', ...)` block, after the existing `'creates a job billed to the store owner...'` test:

```ts
  it('allows a try-on for a product enabled only via an enabled collection', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: 900,
      r2Key: `shopify-garments/${store.id}/900/garment.jpg`,
      title: 'Collection Shirt',
      status: 'active',
      enabled: false,
    });
    await app.db.insert(schema.shopifyEnabledCollections).values({
      storeId: store.id,
      shopifyCollectionId: 500,
    });
    await app.db.insert(schema.shopifyCollectionProducts).values({
      storeId: store.id,
      shopifyCollectionId: 500,
      shopifyProductId: 900,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 900 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('jobId');
  });

  it('refuses a try-on for a product excluded despite global mode', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { activation: { mode: 'global' } } })
      .where(eq(schema.shopifyStores.id, store.id));
    // enabled: true is deliberate — the old code's plain `!garment.enabled`
    // check would have let this one through (a real regression). Only the
    // resolver's exclusion-first rule catches it.
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: 901,
      r2Key: `shopify-garments/${store.id}/901/garment.jpg`,
      title: 'Excluded Shirt',
      status: 'active',
      enabled: true,
      excluded: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 901 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty('jobId');
    expect(res.json().message).toBe('This product is not available for try-on right now.');
  });
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @tryme/api test -- shopify-customer`
Expected: the collection-based case FAILS with `201` expected but `202` received (today `enabled: false` refuses regardless of collection membership). The exclusion-under-global case FAILS with `202` expected but `201` received — today's code only checks the plain `enabled` column, which is `true`, so the product is wrongly let through; nothing reads `excluded` or `settings.activation` yet.

- [ ] **Step 3: Implement the swap**

In `apps/api/src/modules/shopify/customer.routes.ts`, add the import:

```ts
import { resolveEffectiveEnabled } from './activation.js';
```

Replace:

```ts
      if (!garment.enabled) {
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }
```

with:

```ts
      const effectivelyEnabled = await resolveEffectiveEnabled(app, store, garment);
      if (!effectivelyEnabled) {
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }
```

Confirm `store` (the full row, `req.shopifyStoreRow`) is already in scope in this handler at this point — it is, per the existing `const store = req.shopifyStoreRow as typeof schema.shopifyStores.$inferSelect;` a few lines above.

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm --filter @tryme/api test -- <the test file name>`
Expected: PASS, including every pre-existing case in that file (the plain `enabled: true` / `enabled: false` cases must still behave identically — `resolveEffectiveEnabled` with no collections and `mode: 'selective'` reduces to exactly `garment.enabled`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/<the test file name>
git commit -m "feat(shopify): try-on enforcement respects the activation resolver"
```

---

## Task 5: Collection membership sync

**Files:**
- Modify: `apps/api/src/modules/shopify/products.sync.ts` (export two helpers)
- Create: `apps/api/src/modules/shopify/collections.sync.ts`
- Test: `apps/api/test/shopify-collections-sync.test.ts`

**Interfaces:**
- Consumes: `shopifyAdminFetch`, `getValidAccessToken` (existing).
- Produces: `syncCollectionMembership(app: FastifyInstance, store: typeof schema.shopifyStores.$inferSelect, shopifyCollectionId: number): Promise<{ title: string; productCount: number }>`; `searchCollections(app: FastifyInstance, store: typeof schema.shopifyStores.$inferSelect, q: string): Promise<Array<{ shopifyCollectionId: number; title: string }>>`. Task 6 and Task 7 both call these.

- [ ] **Step 1: Export the two helpers products.sync.ts already has**

In `apps/api/src/modules/shopify/products.sync.ts`, change:

```ts
function nextPageUrl(res: { headers: { get(name: string): string | null } }): string | null {
```

to:

```ts
export function nextPageUrl(res: { headers: { get(name: string): string | null } }): string | null {
```

and:

```ts
async function fetchCollectionTitleMap(shop: string, token: string): Promise<Map<number, string>> {
```

to:

```ts
export async function fetchCollectionTitleMap(shop: string, token: string): Promise<Map<number, string>> {
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/test/shopify-collections-sync.test.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { syncCollectionMembership, searchCollections } from '../src/modules/shopify/collections.sync.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let storeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: 'test-secret',
    SHOPIFY_API_KEY: 'test-key',
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'c.myshopify.com',
      myshopifyDomain: 'c.myshopify.com',
      name: 'C',
      email: 'c@c.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('syncCollectionMembership', () => {
  it('replaces a collection\'s membership with a fresh pull, and fetches its title', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    await app.db.insert(schema.shopifyCollectionProducts).values({
      storeId,
      shopifyCollectionId: 500,
      shopifyProductId: 999, // stale — must be gone after resync
    });

    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/custom_collections/500.json')) {
        return {
          ok: true,
          json: async () => ({ custom_collection: { id: 500, title: 'Summer' } }),
        } as Response;
      }
      if (url.includes('/collects.json')) {
        return {
          ok: true,
          headers: new Map(),
          json: async () => ({ collects: [{ collection_id: 500, product_id: 1 }, { collection_id: 500, product_id: 2 }] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const result = await syncCollectionMembership(app, store, 500);
      expect(result).toEqual({ title: 'Summer', productCount: 2 });

      const rows = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(
          and(
            eq(schema.shopifyCollectionProducts.storeId, storeId),
            eq(schema.shopifyCollectionProducts.shopifyCollectionId, 500),
          ),
        );
      expect(rows.map((r) => r.shopifyProductId).sort()).toEqual([1, 2]);
      expect(rows.some((r) => r.shopifyProductId === 999)).toBe(false);

      const [collectionRow] = await app.db
        .select()
        .from(schema.shopifyCollections)
        .where(
          and(
            eq(schema.shopifyCollections.storeId, storeId),
            eq(schema.shopifyCollections.shopifyCollectionId, 500),
          ),
        );
      expect(collectionRow.title).toBe('Summer');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('syncCollectionMembership — deleted collection', () => {
  it('throws CollectionNotFoundError when both resources 404', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;

    try {
      const { CollectionNotFoundError } = await import('../src/modules/shopify/collections.sync.js');
      await expect(syncCollectionMembership(app, store, 12345)).rejects.toBeInstanceOf(
        CollectionNotFoundError,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not classify a rate-limit response as not-found', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response) as typeof fetch;

    try {
      const { CollectionNotFoundError } = await import('../src/modules/shopify/collections.sync.js');
      await expect(syncCollectionMembership(app, store, 12345)).rejects.not.toBeInstanceOf(
        CollectionNotFoundError,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('searchCollections', () => {
  it('filters the full custom+smart collection list by a case-insensitive title substring', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/custom_collections.json')) {
        return {
          ok: true,
          headers: new Map(),
          json: async () => ({ custom_collections: [{ id: 1, title: 'Summer Dresses' }] }),
        } as unknown as Response;
      }
      if (url.includes('/smart_collections.json')) {
        return {
          ok: true,
          headers: new Map(),
          json: async () => ({ smart_collections: [{ id: 2, title: 'Winter Coats' }] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const results = await searchCollections(app, store, 'summer');
      expect(results).toEqual([{ shopifyCollectionId: 1, title: 'Summer Dresses' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm --filter @tryme/api test -- shopify-collections-sync`
Expected: FAIL — `collections.sync.js` does not exist yet.

- [ ] **Step 4: Implement**

Create `apps/api/src/modules/shopify/collections.sync.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { fetchCollectionTitleMap, nextPageUrl } from './products.sync.js';
import { shopifyAdminFetch } from './service.js';
import { getValidAccessToken } from './token.js';

/**
 * Thrown only when both `custom_collections` and `smart_collections` return a
 * genuine 404 for this ID — i.e. the collection was deleted on Shopify's
 * side. The scheduled resync (Task 6) treats this specifically as "clean up
 * this collection's rows"; any other failure (rate limit, 5xx, network) must
 * not be misread as a deletion, so it throws a plain `Error` instead and is
 * retried next cycle unchanged.
 */
export class CollectionNotFoundError extends Error {
  constructor(shopifyCollectionId: number) {
    super(`collection ${shopifyCollectionId} not found on either resource`);
    this.name = 'CollectionNotFoundError';
  }
}

async function fetchOneCollectionTitle(
  shop: string,
  token: string,
  shopifyCollectionId: number,
): Promise<string> {
  for (const resource of ['custom_collections', 'smart_collections'] as const) {
    const res = await shopifyAdminFetch(shop, token, `/${resource}/${shopifyCollectionId}.json`);
    if (res.ok) {
      const body = (await res.json()) as Record<string, { title: string }>;
      const key = resource === 'custom_collections' ? 'custom_collection' : 'smart_collection';
      const title = body[key]?.title;
      if (title) return title;
    } else if (res.status !== 404) {
      throw new Error(`${resource} fetch failed for collection ${shopifyCollectionId}: HTTP ${res.status}`);
    }
  }
  throw new CollectionNotFoundError(shopifyCollectionId);
}

async function fetchCollectionMemberProductIds(
  shop: string,
  token: string,
  shopifyCollectionId: number,
): Promise<number[]> {
  const ids: number[] = [];
  let url: string | null = `/collects.json?collection_id=${shopifyCollectionId}&limit=250`;
  while (url) {
    const res = await shopifyAdminFetch(shop, token, url);
    if (!res.ok) throw new Error(`collects.json fetch failed: HTTP ${res.status}`);
    const { collects } = (await res.json()) as { collects: Array<{ product_id: number }> };
    for (const c of collects) ids.push(c.product_id);
    url = nextPageUrl(res);
  }
  return ids;
}

/**
 * Pulls one collection's title and full membership from Shopify and replaces
 * (not diffs) that collection's rows in `shopify_collection_products`, in one
 * transaction — a failure here must not leave a collection showing partial
 * membership.
 */
export async function syncCollectionMembership(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyCollectionId: number,
): Promise<{ title: string; productCount: number }> {
  const token = await getValidAccessToken(app, store);
  const shop = store.shopDomain;

  const [title, productIds] = await Promise.all([
    fetchOneCollectionTitle(shop, token, shopifyCollectionId),
    fetchCollectionMemberProductIds(shop, token, shopifyCollectionId),
  ]);

  await app.db.transaction(async (tx) => {
    await tx
      .insert(schema.shopifyCollections)
      .values({ storeId: store.id, shopifyCollectionId, title })
      .onConflictDoUpdate({
        target: [schema.shopifyCollections.storeId, schema.shopifyCollections.shopifyCollectionId],
        set: { title, syncedAt: new Date() },
      });

    await tx
      .delete(schema.shopifyCollectionProducts)
      .where(
        and(
          eq(schema.shopifyCollectionProducts.storeId, store.id),
          eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
        ),
      );

    if (productIds.length > 0) {
      await tx.insert(schema.shopifyCollectionProducts).values(
        productIds.map((shopifyProductId) => ({
          storeId: store.id,
          shopifyCollectionId,
          shopifyProductId,
        })),
      );
    }
  });

  return { title, productCount: productIds.length };
}

/**
 * Live search over every custom + smart collection, for the "Add
 * collections"/"Exclude collections" picker modal. Shopify's REST collections
 * endpoints only support exact-title filtering, not substring search, so this
 * fetches the full list (already what `fetchCollectionTitleMap` does for the
 * product sync's collection-title join) and filters in memory.
 */
export async function searchCollections(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  q: string,
): Promise<Array<{ shopifyCollectionId: number; title: string }>> {
  const token = await getValidAccessToken(app, store);
  const titleById = await fetchCollectionTitleMap(store.shopDomain, token);
  const needle = q.toLowerCase();
  return [...titleById.entries()]
    .filter(([, title]) => title.toLowerCase().includes(needle))
    .map(([shopifyCollectionId, title]) => ({ shopifyCollectionId, title }));
}
```

- [ ] **Step 5: Run and confirm pass**

Run: `pnpm --filter @tryme/api test -- shopify-collections-sync`
Expected: PASS, 2/2.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/src/modules/shopify/collections.sync.ts apps/api/test/shopify-collections-sync.test.ts
git commit -m "feat(shopify): per-collection membership sync and live collection search"
```

---

## Task 6: Scheduled resync + `SyncTask` collection mode

**Files:**
- Modify: `apps/api/src/modules/shopify/service.ts`
- Modify: `apps/api/src/modules/shopify/products.sync.ts` (`syncOneTask` dispatch)
- Create: `apps/api/src/modules/shopify/collections-resync-scheduler.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/test/shopify-collections-resync-scheduler.test.ts`

**Interfaces:**
- Consumes: `syncCollectionMembership` (Task 5), `enqueueSync` (existing).
- Produces: `startCollectionResyncScheduler(app: FastifyInstance, intervalMs?: number): () => void`.

- [ ] **Step 1: Extend `SyncTask`**

In `apps/api/src/modules/shopify/service.ts`, change:

```ts
export interface SyncTask {
  storeId: string;
  mode: 'full' | 'product';
  shopifyProductId?: number;
}
```

to:

```ts
export interface SyncTask {
  storeId: string;
  mode: 'full' | 'product' | 'collection';
  shopifyProductId?: number;
  shopifyCollectionId?: number;
}
```

- [ ] **Step 2: Dispatch the new mode in `syncOneTask`, with 404 cleanup**

In `apps/api/src/modules/shopify/products.sync.ts`, add `and` to the existing drizzle-orm import:

```ts
import { and, eq, sql } from 'drizzle-orm';
```

Find the `syncOneTask` function's mode branch (it currently branches on `task.mode === 'full'` vs the product-mode path). Add, near the top of the function body after the store/token setup already there:

```ts
  if (task.mode === 'collection') {
    if (task.shopifyCollectionId === undefined) return;
    const { syncCollectionMembership, CollectionNotFoundError } = await import('./collections.sync.js');
    const shopifyCollectionId = task.shopifyCollectionId;
    try {
      await syncCollectionMembership(app, store, shopifyCollectionId);
    } catch (err) {
      if (err instanceof CollectionNotFoundError) {
        // Confirmed deleted on Shopify's side — the selection itself is
        // meaningless now, so remove it along with the cached membership,
        // not just the membership.
        await app.db
          .delete(schema.shopifyCollections)
          .where(
            and(
              eq(schema.shopifyCollections.storeId, store.id),
              eq(schema.shopifyCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyCollectionProducts)
          .where(
            and(
              eq(schema.shopifyCollectionProducts.storeId, store.id),
              eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyEnabledCollections)
          .where(
            and(
              eq(schema.shopifyEnabledCollections.storeId, store.id),
              eq(schema.shopifyEnabledCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyExcludedCollections)
          .where(
            and(
              eq(schema.shopifyExcludedCollections.storeId, store.id),
              eq(schema.shopifyExcludedCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        app.log.info(
          { storeId: task.storeId, shopifyCollectionId },
          'collection deleted on Shopify — removed selection and cached membership',
        );
        return;
      }
      // Anything else (rate limit, 5xx, network) is not a deletion — log and
      // let next cycle's tick re-enqueue this same collection. The outer
      // sync-consumer loop already isolates one task's throw from the rest of
      // the stream, so re-throwing here would be redundant, not additive.
      app.log.warn(
        { err, storeId: task.storeId, shopifyCollectionId },
        'scheduled collection resync failed — will retry next cycle',
      );
    }
    return;
  }
```

Use a dynamic `import()` here specifically to avoid a circular import (`collections.sync.ts` imports from `products.sync.ts` per Task 5's `fetchCollectionTitleMap`/`nextPageUrl`, so a top-level import back the other way would cycle). Place this branch before the existing `full`/`product` logic, after `store`/`token` are already resolved earlier in the function.

- [ ] **Step 3: Write the failing scheduler test**

Create `apps/api/test/shopify-collections-resync-scheduler.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { startCollectionResyncScheduler } from '../src/modules/shopify/collections-resync-scheduler.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: 'test-secret',
    SHOPIFY_API_KEY: 'test-key',
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('startCollectionResyncScheduler', () => {
  it('enqueues one collection task per selected collection, across enabled and excluded, and skips stores with none selected', async () => {
    const storeWithSelections = await upsertShopifyStore(
      app,
      { shopifyShopId: 901, shopDomain: 's1.myshopify.com', myshopifyDomain: 's1.myshopify.com', name: 'S1', email: 's1@s1.com' },
      'tok',
      'read_products',
    );
    const storeWithNone = await upsertShopifyStore(
      app,
      { shopifyShopId: 902, shopDomain: 's2.myshopify.com', myshopifyDomain: 's2.myshopify.com', name: 'S2', email: 's2@s2.com' },
      'tok',
      'read_products',
    );
    await app.db.insert(schema.shopifyEnabledCollections).values({
      storeId: storeWithSelections.id,
      shopifyCollectionId: 10,
    });
    await app.db.insert(schema.shopifyExcludedCollections).values({
      storeId: storeWithSelections.id,
      shopifyCollectionId: 20,
    });

    const xaddSpy = vi.spyOn(app.redis, 'xadd');
    const stop = startCollectionResyncScheduler(app, 1_000_000); // large interval — we call the tick directly, not via timer
    stop(); // stop the timer immediately; we only want to test the tick logic itself

    // Re-import the tick function directly instead of waiting on setInterval:
    const mod = await import('../src/modules/shopify/collections-resync-scheduler.js');
    await mod.runResyncTick(app);

    const enqueuedTasks = xaddSpy.mock.calls
      .filter((call) => call[0] === 'shopify:sync')
      .map((call) => JSON.parse(call[2] as string));

    expect(
      enqueuedTasks.some(
        (t) => t.storeId === storeWithSelections.id && t.mode === 'collection' && t.shopifyCollectionId === 10,
      ),
    ).toBe(true);
    expect(
      enqueuedTasks.some(
        (t) => t.storeId === storeWithSelections.id && t.mode === 'collection' && t.shopifyCollectionId === 20,
      ),
    ).toBe(true);
    expect(enqueuedTasks.some((t) => t.storeId === storeWithNone.id)).toBe(false);

    xaddSpy.mockRestore();
  });
});

describe('syncOneTask — collection mode, deleted collection', () => {
  it('cleans up the selection and cached membership when Shopify confirms the collection is gone', async () => {
    const { syncOneTask } = await import('../src/modules/shopify/products.sync.js');
    const store = await upsertShopifyStore(
      app,
      { shopifyShopId: 903, shopDomain: 's3.myshopify.com', myshopifyDomain: 's3.myshopify.com', name: 'S3', email: 's3@s3.com' },
      'tok',
      'read_products',
    );
    await app.db.insert(schema.shopifyEnabledCollections).values({ storeId: store.id, shopifyCollectionId: 700 });
    await app.db.insert(schema.shopifyCollectionProducts).values({ storeId: store.id, shopifyCollectionId: 700, shopifyProductId: 1 });
    await app.db.insert(schema.shopifyCollections).values({ storeId: store.id, shopifyCollectionId: 700, title: 'Gone' });

    const originalFetch = global.fetch;
    global.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;

    try {
      await syncOneTask(app, { storeId: store.id, mode: 'collection', shopifyCollectionId: 700 });

      const enabledRows = await app.db
        .select()
        .from(schema.shopifyEnabledCollections)
        .where(eq(schema.shopifyEnabledCollections.storeId, store.id));
      expect(enabledRows).toHaveLength(0);

      const membershipRows = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(eq(schema.shopifyCollectionProducts.storeId, store.id));
      expect(membershipRows).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 4: Run and confirm failure**

Run: `pnpm --filter @tryme/api test -- shopify-collections-resync-scheduler`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement**

Create `apps/api/src/modules/shopify/collections-resync-scheduler.ts`:

```ts
import { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { enqueueSync } from './service.js';

/**
 * One tick: enqueue a `collection`-mode sync task for every (store, collection)
 * pair currently selected in either the enabled or excluded set. A store with
 * no selections triggers zero Shopify calls — this never touches a collection
 * nobody picked.
 */
export async function runResyncTick(app: FastifyInstance): Promise<void> {
  const enabled = await app.db
    .select({ storeId: schema.shopifyEnabledCollections.storeId, shopifyCollectionId: schema.shopifyEnabledCollections.shopifyCollectionId })
    .from(schema.shopifyEnabledCollections);
  const excluded = await app.db
    .select({ storeId: schema.shopifyExcludedCollections.storeId, shopifyCollectionId: schema.shopifyExcludedCollections.shopifyCollectionId })
    .from(schema.shopifyExcludedCollections);

  const pairs = new Map<string, { storeId: string; shopifyCollectionId: number }>();
  for (const row of [...enabled, ...excluded]) {
    pairs.set(`${row.storeId}:${row.shopifyCollectionId}`, row);
  }

  for (const { storeId, shopifyCollectionId } of pairs.values()) {
    await enqueueSync(app.redis, { storeId, mode: 'collection', shopifyCollectionId });
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Call once after `app.listen(...)`, alongside `startSyncConsumer(app)` —
 * mirrors that function's "start once, get a stop function back" shape.
 */
export function startCollectionResyncScheduler(
  app: FastifyInstance,
  intervalMs: number = HOUR_MS,
): () => void {
  const timer = setInterval(() => {
    void runResyncTick(app).catch((err) => {
      app.log.error({ err }, 'collection resync tick failed');
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 6: Run and confirm pass**

Run: `pnpm --filter @tryme/api test -- shopify-collections-resync-scheduler`
Expected: PASS.

- [ ] **Step 7: Wire it into `main.ts`**

In `apps/api/src/main.ts`, add the import:

```ts
import { startCollectionResyncScheduler } from './modules/shopify/collections-resync-scheduler.js';
```

and, right after the existing `startSyncConsumer(app);` line:

```ts
startCollectionResyncScheduler(app);
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/service.ts apps/api/src/modules/shopify/products.sync.ts apps/api/src/modules/shopify/collections-resync-scheduler.ts apps/api/src/main.ts apps/api/test/shopify-collections-resync-scheduler.test.ts
git commit -m "feat(shopify): hourly bounded resync for selected collections only"
```

---

## Task 7: Activation routes — mode, summary, collections, exclusions, search

**Files:**
- Create: `apps/api/src/modules/shopify/activation.routes.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Test: `apps/api/test/shopify-activation-routes.test.ts`

**Interfaces:**
- Consumes: `syncCollectionMembership`, `searchCollections` (Task 5); `schema.shopifyEnabledCollections`, `schema.shopifyExcludedCollections`, `schema.shopifyCollections` (Task 1).
- Produces: the full activation route surface below.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/test/shopify-activation-routes.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    { shopifyShopId: 88, shopDomain: 'a.myshopify.com', myshopifyDomain: 'a.myshopify.com', name: 'A', email: 'a@a.com' },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('a.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    { storeId, shopifyProductId: 1, shopifyVariantId: null, r2Key: 'x', title: 'One', status: 'active', enabled: true },
    { storeId, shopifyProductId: 2, shopifyVariantId: null, r2Key: 'y', title: 'Two', status: 'failed', enabled: false, failedReason: 'bad image' },
    { storeId, shopifyProductId: 3, shopifyVariantId: null, r2Key: 'z', title: 'Three', status: 'active', enabled: false, excluded: true },
  ]);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/activation', () => {
  it('returns mode and summary counts, including failed-to-sync independent of enabled state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/activation',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('selective');
    expect(body.counts.individuallyEnabledProducts).toBe(1);
    expect(body.counts.excludedProducts).toBe(1);
    expect(body.counts.failedToSync).toBe(1);
  });
});

describe('PATCH /v1/shopify/activation/mode', () => {
  it('sets global mode', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/activation/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { mode: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('global');

    const [row] = await app.db.select().from(schema.shopifyStores).where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.activation?.mode).toBe('global');

    // reset for later tests in this file
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/activation/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { mode: 'selective' },
    });
  });
});

describe('collections enable/exclude CRUD', () => {
  it('adds an enabled collection, syncing its membership, then removes it', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/custom_collections/50.json')) {
        return { ok: true, json: async () => ({ custom_collection: { id: 50, title: 'Hats' } }) } as Response;
      }
      if (url.includes('/smart_collections/50.json')) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      if (url.includes('/collects.json')) {
        return {
          ok: true,
          headers: new Map(),
          json: async () => ({ collects: [{ collection_id: 50, product_id: 1 }] }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const addRes = await app.inject({
        method: 'POST',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { shopifyCollectionIds: [50] },
      });
      expect(addRes.statusCode).toBe(200);

      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}` },
      });
      const list = listRes.json().items;
      expect(list.some((c: { shopifyCollectionId: number; title: string }) => c.shopifyCollectionId === 50 && c.title === 'Hats')).toBe(true);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/collections/50',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delRes.statusCode).toBe(200);

      const listAfter = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listAfter.json().items.some((c: { shopifyCollectionId: number }) => c.shopifyCollectionId === 50)).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('exclusions/collections CRUD', () => {
  it('adds and removes an excluded collection', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/custom_collections/60.json')) {
        return { ok: true, json: async () => ({ custom_collection: { id: 60, title: 'Clearance' } }) } as Response;
      }
      if (url.includes('/collects.json')) {
        return { ok: true, headers: new Map(), json: async () => ({ collects: [] }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const addRes = await app.inject({
        method: 'POST',
        url: '/v1/shopify/activation/exclusions/collections',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { shopifyCollectionIds: [60] },
      });
      expect(addRes.statusCode).toBe(200);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/exclusions/collections/60',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delRes.statusCode).toBe(200);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('GET /v1/shopify/activation/collections/search', () => {
  it('proxies a live title search', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/custom_collections.json')) {
        return { ok: true, headers: new Map(), json: async () => ({ custom_collections: [{ id: 1, title: 'Summer' }] }) } as unknown as Response;
      }
      if (url.includes('/smart_collections.json')) {
        return { ok: true, headers: new Map(), json: async () => ({ smart_collections: [] }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections/search?q=summer',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([{ shopifyCollectionId: 1, title: 'Summer' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tryme/api test -- shopify-activation-routes`
Expected: FAIL — none of these routes exist.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/shopify/activation.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { searchCollections, syncCollectionMembership } from './collections.sync.js';
import { mergeStoreSettingsObject, storeSettingsJson } from './settings-json.js';

const ModeBody = z.object({ mode: z.enum(['global', 'selective']) });
const CollectionIdsBody = z.object({ shopifyCollectionIds: z.array(z.number().int()).min(1) });
const SearchQuery = z.object({ q: z.string().min(1) });

async function summaryCounts(app: FastifyInstance, storeId: string) {
  const [{ enabledCollections }] = await app.db
    .select({ enabledCollections: count() })
    .from(schema.shopifyEnabledCollections)
    .where(eq(schema.shopifyEnabledCollections.storeId, storeId));

  const [{ excludedCollections }] = await app.db
    .select({ excludedCollections: count() })
    .from(schema.shopifyExcludedCollections)
    .where(eq(schema.shopifyExcludedCollections.storeId, storeId));

  const [{ individuallyEnabledProducts }] = await app.db
    .select({ individuallyEnabledProducts: count() })
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.enabled, true),
      ),
    );

  const [{ excludedProducts }] = await app.db
    .select({ excludedProducts: count() })
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.excluded, true),
      ),
    );

  // Catalog-wide, deliberately independent of `enabled` — a product turned on
  // via a collection or global mode never appears in the individually-enabled
  // set and would otherwise have no failure visibility at all.
  const [{ failedToSync }] = await app.db
    .select({ failedToSync: count() })
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.status, 'failed'),
      ),
    );

  return { enabledCollections, excludedCollections, individuallyEnabledProducts, excludedProducts, failedToSync };
}

function registerCollectionSetRoutes(
  app: FastifyInstance,
  basePath: string,
  table: typeof schema.shopifyEnabledCollections | typeof schema.shopifyExcludedCollections,
) {
  app.get(basePath, { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
    const selections = await app.db.select().from(table).where(eq(table.storeId, store.id));

    const items = await Promise.all(
      selections.map(async (s) => {
        const [collectionRow] = await app.db
          .select({ title: schema.shopifyCollections.title })
          .from(schema.shopifyCollections)
          .where(
            and(
              eq(schema.shopifyCollections.storeId, store.id),
              eq(schema.shopifyCollections.shopifyCollectionId, s.shopifyCollectionId),
            ),
          )
          .limit(1);
        const [{ productCount }] = await app.db
          .select({ productCount: count() })
          .from(schema.shopifyCollectionProducts)
          .where(
            and(
              eq(schema.shopifyCollectionProducts.storeId, store.id),
              eq(schema.shopifyCollectionProducts.shopifyCollectionId, s.shopifyCollectionId),
            ),
          );
        return {
          shopifyCollectionId: s.shopifyCollectionId,
          title: collectionRow?.title ?? '',
          productCount,
        };
      }),
    );
    return { items };
  });

  app.post(
    basePath,
    { preHandler: app.requireShopifySession, schema: { body: CollectionIdsBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { shopifyCollectionIds } = req.body as z.infer<typeof CollectionIdsBody>;

      for (const shopifyCollectionId of shopifyCollectionIds) {
        await syncCollectionMembership(app, store, shopifyCollectionId);
        await app.db
          .insert(table)
          .values({ storeId: store.id, shopifyCollectionId })
          .onConflictDoNothing();
      }
      return { ok: true };
    },
  );

  app.delete(
    `${basePath}/:shopifyCollectionId`,
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const shopifyCollectionId = Number((req.params as { shopifyCollectionId: string }).shopifyCollectionId);

      await app.db
        .delete(table)
        .where(and(eq(table.storeId, store.id), eq(table.shopifyCollectionId, shopifyCollectionId)));
      await app.db
        .delete(schema.shopifyCollectionProducts)
        .where(
          and(
            eq(schema.shopifyCollectionProducts.storeId, store.id),
            eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
          ),
        );
      return { ok: true };
    },
  );
}

export async function shopifyActivationRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/activation', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
    return {
      mode: store.settings.activation?.mode ?? 'selective',
      counts: await summaryCounts(app, store.id),
    };
  });

  app.patch(
    '/v1/shopify/activation/mode',
    { preHandler: app.requireShopifySession, schema: { body: ModeBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { mode } = req.body as z.infer<typeof ModeBody>;

      const settings = mergeStoreSettingsObject(storeSettingsJson(), ['activation'], { mode });
      await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));

      return { mode };
    },
  );

  app.get(
    '/v1/shopify/activation/collections/search',
    { preHandler: app.requireShopifySession, schema: { querystring: SearchQuery } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { q } = req.query as z.infer<typeof SearchQuery>;
      const items = await searchCollections(app, store, q);
      return { items };
    },
  );

  registerCollectionSetRoutes(app, '/v1/shopify/activation/collections', schema.shopifyEnabledCollections);
  registerCollectionSetRoutes(app, '/v1/shopify/activation/exclusions/collections', schema.shopifyExcludedCollections);
}
```

Note: no route in this file throws its own `AppError` — every failure path here (sync failure, not-found) is handled by `syncCollectionMembership`/`searchCollections` already throwing, which propagates as an unhandled rejection that Fastify's default error handler turns into a 500. That is correct here: a collection-add failure is a genuine 5xx-shaped failure (Shopify unreachable, collection genuinely gone), not a validation error deserving a specific 4xx shape.

- [ ] **Step 4: Register the route module**

In `apps/api/src/modules/shopify/routes.ts`, add the import:

```ts
import { shopifyActivationRoutes } from './activation.routes.js';
```

and, alongside the other `await app.register(...)` calls:

```ts
  await app.register(shopifyActivationRoutes);
```

- [ ] **Step 5: Run and confirm pass**

Run: `pnpm --filter @tryme/api test -- shopify-activation-routes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/activation.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-activation-routes.test.ts
git commit -m "feat(shopify): activation mode, summary, and collections API"
```

---

## Task 8: `activationTabState` helper (client)

**Files:**
- Create: `apps/shopify/src/lib/activationTabState.ts`
- Test: `apps/shopify/src/lib/activationTabState.test.ts`

**Interfaces:**
- Produces: `isTabEditable(mode: 'global' | 'selective', tab: 'collections' | 'individual' | 'exclusion'): boolean`. Task 9 consumes this.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify/src/lib/activationTabState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isTabEditable } from './activationTabState';

describe('isTabEditable', () => {
  it('collections and individual tabs are editable in selective mode', () => {
    expect(isTabEditable('selective', 'collections')).toBe(true);
    expect(isTabEditable('selective', 'individual')).toBe(true);
  });

  it('collections and individual tabs are read-only in global mode', () => {
    expect(isTabEditable('global', 'collections')).toBe(false);
    expect(isTabEditable('global', 'individual')).toBe(false);
  });

  it('exclusion tab is always editable, in either mode', () => {
    expect(isTabEditable('selective', 'exclusion')).toBe(true);
    expect(isTabEditable('global', 'exclusion')).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm --filter @tryme/shopify test -- activationTabState`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/shopify/src/lib/activationTabState.ts`:

```ts
export type ActivationMode = 'global' | 'selective';
export type ActivationTab = 'collections' | 'individual' | 'exclusion';

/**
 * The Exclusion tab stays editable in every mode — exclusion always wins,
 * including under global, so it must never be locked out. Collections and
 * Individual Products go read-only under global mode: their data stays
 * visible (status badges included), only Add/Remove is disabled.
 */
export function isTabEditable(mode: ActivationMode, tab: ActivationTab): boolean {
  if (tab === 'exclusion') return true;
  return mode !== 'global';
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm --filter @tryme/shopify test -- activationTabState`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/lib/activationTabState.ts apps/shopify/src/lib/activationTabState.test.ts
git commit -m "feat(shopify): tab-editability helper for the activation model"
```

---

## Task 9: Manage page — full rebuild

**Files:**
- Modify (full rewrite): `apps/shopify/src/pages/ManagePage.tsx`
- Modify: `apps/shopify/src/types.ts` (`ShopifyProductListItem` gains `excluded`)

**Interfaces:**
- Consumes: `isTabEditable` (Task 8); `GET/PATCH /v1/shopify/activation`, `GET/POST/DELETE /v1/shopify/activation/collections`, `GET/POST/DELETE /v1/shopify/activation/exclusions/collections`, `GET /v1/shopify/activation/collections/search`, `GET /v1/shopify/products` (with `enabled`/`status`/`excluded`/`q`), `PATCH /v1/shopify/products/:id` (Tasks 3, 7).

No automated test for this task — this app's Vitest setup has no `@testing-library/react` (only `analyticsRange.test.ts`-style pure-logic tests exist for this codebase's pages), and the page itself is Polaris + App Bridge + fetch wiring, matching the same reasoning already applied to `WidgetDesignPage.tsx`. Verify manually per Step 5 below.

- [ ] **Step 1: Read the current file and its API client conventions**

Read `apps/shopify/src/pages/ManagePage.tsx` (the version this plan replaces) and `apps/shopify/src/lib/api.ts` for the `apiFetch<T>(path, init?)` signature already used throughout this app — reuse it exactly, do not invent a new fetch wrapper.

- [ ] **Step 2: Add `excluded` to the client-side product type**

In `apps/shopify/src/types.ts`, change:

```ts
export interface ShopifyProductListItem {
  shopifyProductId: number;
  title: string | null;
  thumbnailUrl: string;
  status: string;
  enabled: boolean;
}
```

to:

```ts
export interface ShopifyProductListItem {
  shopifyProductId: number;
  title: string | null;
  thumbnailUrl: string;
  status: string;
  enabled: boolean;
  excluded: boolean;
}
```

- [ ] **Step 3: Write the new page**

Replace the full contents of `apps/shopify/src/pages/ManagePage.tsx`:

```tsx
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Pagination,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  Toast,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { isTabEditable } from '../lib/activationTabState';
import type { ShopifyProductListItem } from '../types';

type DisplayStatus = 'active' | 'processing' | 'failed' | 'disabled';

function displayStatus(item: ShopifyProductListItem): DisplayStatus {
  if (!item.enabled || item.status === 'deleted') return 'disabled';
  return item.status as DisplayStatus;
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
  active: 'Active',
  processing: 'Processing',
  failed: 'Failed',
  disabled: 'Disabled',
};

const STATUS_TONE: Record<DisplayStatus, 'success' | 'attention' | 'critical' | 'info'> = {
  active: 'success',
  processing: 'attention',
  failed: 'critical',
  disabled: 'info',
};

interface ActivationSummary {
  mode: 'global' | 'selective';
  counts: {
    enabledCollections: number;
    excludedCollections: number;
    individuallyEnabledProducts: number;
    excludedProducts: number;
    failedToSync: number;
  };
}

interface CollectionListItem {
  shopifyCollectionId: number;
  title: string;
  productCount: number;
}

interface CollectionSearchResult {
  shopifyCollectionId: number;
  title: string;
}

interface ProductListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: ShopifyProductListItem[];
}

const PAGE_SIZE = 20;

const TABS = [
  { id: 'collections', content: 'Collections' },
  { id: 'individual', content: 'Individual Products' },
  { id: 'exclusion', content: 'Exclusion' },
] as const;

function CollectionPickerModal({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  onPicked: (shopifyCollectionId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CollectionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      apiFetch<{ items: CollectionSearchResult[] }>(
        `/v1/shopify/activation/collections/search?q=${encodeURIComponent(query)}`,
      )
        .then((res) => setResults(res.items))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <Modal open title="Add a collection" onClose={onClose}>
      <Modal.Section>
        <BlockStack gap="300">
          <TextField
            label="Search collections"
            labelHidden
            autoComplete="off"
            placeholder="Search by collection name"
            value={query}
            onChange={setQuery}
          />
          {searching && <Text as="p" tone="subdued">Searching…</Text>}
          {results.map((r) => (
            <InlineStack key={r.shopifyCollectionId} align="space-between" blockAlign="center">
              <Text as="span">{r.title}</Text>
              <Button size="slim" onClick={() => onPicked(r.shopifyCollectionId)}>
                Add
              </Button>
            </InlineStack>
          ))}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function CollectionsPanel({
  basePath,
  editable,
  addLabel,
  emptyHeading,
  onChanged,
}: {
  basePath: string;
  editable: boolean;
  addLabel: string;
  emptyHeading: string;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<CollectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: CollectionListItem[] }>(basePath)
      .then((res) => setItems(res.items))
      .finally(() => setLoading(false));
  }, [basePath]);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(shopifyCollectionId: number) {
    await apiFetch(`${basePath}/${shopifyCollectionId}`, { method: 'DELETE' });
    load();
    onChanged();
  }

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between">
        <Text as="h2" variant="headingMd">
          Collections
        </Text>
        <Button disabled={!editable} onClick={() => setPickerOpen(true)}>
          {addLabel}
        </Button>
      </InlineStack>
      <IndexTable
        selectable={false}
        loading={loading}
        itemCount={items.length}
        resourceName={{ singular: 'collection', plural: 'collections' }}
        headings={[{ title: 'Collection' }, { title: 'Products' }, { title: '' }]}
        emptyState={<EmptyState heading={emptyHeading} image="" />}
      >
        {items.map((item, index) => (
          <IndexTable.Row
            id={String(item.shopifyCollectionId)}
            key={item.shopifyCollectionId}
            position={index}
          >
            <IndexTable.Cell>
              <Text as="span" fontWeight="semibold">
                {item.title}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>{item.productCount}</IndexTable.Cell>
            <IndexTable.Cell>
              <Button size="slim" disabled={!editable} onClick={() => remove(item.shopifyCollectionId)}>
                Remove
              </Button>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>

      {pickerOpen && (
        <CollectionPickerModal
          onClose={() => setPickerOpen(false)}
          onPicked={async (shopifyCollectionId) => {
            await apiFetch(basePath, {
              method: 'POST',
              body: JSON.stringify({ shopifyCollectionIds: [shopifyCollectionId] }),
            });
            setPickerOpen(false);
            load();
            onChanged();
          }}
        />
      )}
    </BlockStack>
  );
}

function ProductPickerModal({
  title,
  searchParams,
  actionLabel,
  onClose,
  onPicked,
}: {
  title: string;
  searchParams: Record<string, string>;
  actionLabel: string;
  onClose: () => void;
  onPicked: (shopifyProductId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShopifyProductListItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({
        ...searchParams,
        pageSize: '20',
        ...(query ? { q: query } : {}),
      });
      apiFetch<ProductListResponse>(`/v1/shopify/products?${params}`)
        .then((res) => setResults(res.items))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchParams]);

  return (
    <Modal open title={title} onClose={onClose}>
      <Modal.Section>
        <BlockStack gap="300">
          <TextField
            label="Search products"
            labelHidden
            autoComplete="off"
            placeholder="Search by product name"
            value={query}
            onChange={setQuery}
          />
          {searching && <Text as="p" tone="subdued">Searching…</Text>}
          {results.map((r) => (
            <InlineStack key={r.shopifyProductId} align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Thumbnail source={r.thumbnailUrl} alt={r.title ?? 'Product'} size="small" />
                <Text as="span">{r.title}</Text>
              </InlineStack>
              <Button size="slim" onClick={() => onPicked(r.shopifyProductId)}>
                {actionLabel}
              </Button>
            </InlineStack>
          ))}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function IndividualProductsPanel({
  editable,
  onChanged,
  setToastMessage,
  setError,
}: {
  editable: boolean;
  onChanged: () => void;
  setToastMessage: (m: string) => void;
  setError: (m: string) => void;
}) {
  const [items, setItems] = useState<ShopifyProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      enabled: 'true',
      page: String(page),
      pageSize: String(PAGE_SIZE),
      ...(query ? { q: query } : {}),
    });
    apiFetch<ProductListResponse>(`/v1/shopify/products?${params}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .finally(() => setLoading(false));
  }, [page, query]);

  useEffect(() => {
    load();
  }, [load]);

  async function removeProduct(shopifyProductId: number) {
    await apiFetch(`/v1/shopify/products/${shopifyProductId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    setToastMessage('Removed from Try-On.');
    load();
    onChanged();
  }

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between">
        <TextField
          label="Search"
          labelHidden
          autoComplete="off"
          placeholder="Search products"
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPage(1);
          }}
        />
        <Button disabled={!editable} onClick={() => setPickerOpen(true)}>
          Add products
        </Button>
      </InlineStack>
      <IndexTable
        selectable={false}
        loading={loading}
        itemCount={items.length}
        resourceName={{ singular: 'product', plural: 'products' }}
        headings={[{ title: 'Product' }, { title: 'Status' }, { title: '' }]}
        emptyState={<EmptyState heading="No individually enabled products" image="" />}
      >
        {items.map((item, index) => {
          const status = displayStatus(item);
          return (
            <IndexTable.Row
              id={String(item.shopifyProductId)}
              key={item.shopifyProductId}
              position={index}
            >
              <IndexTable.Cell>
                <InlineStack gap="300" blockAlign="center">
                  <Thumbnail source={item.thumbnailUrl} alt={item.title ?? 'Product'} size="small" />
                  <Text as="span" fontWeight="semibold">
                    {item.title}
                  </Text>
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Button size="slim" disabled={!editable} onClick={() => removeProduct(item.shopifyProductId)}>
                  Remove
                </Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>
      <InlineStack align="center">
        <Pagination
          hasPrevious={page > 1}
          onPrevious={() => setPage((p) => p - 1)}
          hasNext={page * PAGE_SIZE < total}
          onNext={() => setPage((p) => p + 1)}
        />
      </InlineStack>

      {pickerOpen && (
        <ProductPickerModal
          title="Add products"
          searchParams={{ enabled: 'false' }}
          actionLabel="Add"
          onClose={() => setPickerOpen(false)}
          onPicked={async (shopifyProductId) => {
            try {
              await apiFetch(`/v1/shopify/products/${shopifyProductId}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: true }),
              });
              setPickerOpen(false);
              load();
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </BlockStack>
  );
}

function ExclusionPanel({
  onChanged,
  setToastMessage,
  setError,
}: {
  onChanged: () => void;
  setToastMessage: (m: string) => void;
  setError: (m: string) => void;
}) {
  const [excludedProducts, setExcludedProducts] = useState<ShopifyProductListItem[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productPickerOpen, setProductPickerOpen] = useState(false);

  const loadProducts = useCallback(() => {
    setLoadingProducts(true);
    apiFetch<ProductListResponse>('/v1/shopify/products?excluded=true&pageSize=100')
      .then((res) => setExcludedProducts(res.items))
      .finally(() => setLoadingProducts(false));
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  async function unexclude(shopifyProductId: number) {
    await apiFetch(`/v1/shopify/products/${shopifyProductId}`, {
      method: 'PATCH',
      body: JSON.stringify({ excluded: false }),
    });
    setToastMessage('Removed from exclusions.');
    loadProducts();
    onChanged();
  }

  return (
    <BlockStack gap="600">
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            Excluded Products
          </Text>
          <Button onClick={() => setProductPickerOpen(true)}>Exclude products</Button>
        </InlineStack>
        <IndexTable
          selectable={false}
          loading={loadingProducts}
          itemCount={excludedProducts.length}
          resourceName={{ singular: 'product', plural: 'products' }}
          headings={[{ title: 'Product' }, { title: '' }]}
          emptyState={<EmptyState heading="No excluded products" image="" />}
        >
          {excludedProducts.map((item, index) => (
            <IndexTable.Row
              id={String(item.shopifyProductId)}
              key={item.shopifyProductId}
              position={index}
            >
              <IndexTable.Cell>
                <InlineStack gap="300" blockAlign="center">
                  <Thumbnail source={item.thumbnailUrl} alt={item.title ?? 'Product'} size="small" />
                  <Text as="span" fontWeight="semibold">
                    {item.title}
                  </Text>
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Button size="slim" onClick={() => unexclude(item.shopifyProductId)}>
                  Remove
                </Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </BlockStack>

      <CollectionsPanel
        basePath="/v1/shopify/activation/exclusions/collections"
        editable
        addLabel="Exclude collections"
        emptyHeading="No excluded collections"
        onChanged={onChanged}
      />

      {productPickerOpen && (
        <ProductPickerModal
          title="Exclude products"
          searchParams={{ excluded: 'false' }}
          actionLabel="Exclude"
          onClose={() => setProductPickerOpen(false)}
          onPicked={async (shopifyProductId) => {
            try {
              await apiFetch(`/v1/shopify/products/${shopifyProductId}`, {
                method: 'PATCH',
                body: JSON.stringify({ excluded: true }),
              });
              setProductPickerOpen(false);
              loadProducts();
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </BlockStack>
  );
}

function FailedProductsModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ShopifyProductListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ProductListResponse>('/v1/shopify/products?status=failed&pageSize=100')
      .then((res) => setItems(res.items))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Modal open title="Failed to sync" onClose={onClose}>
      <Modal.Section>
        <IndexTable
          selectable={false}
          loading={loading}
          itemCount={items.length}
          resourceName={{ singular: 'product', plural: 'products' }}
          headings={[{ title: 'Product' }]}
          emptyState={<EmptyState heading="Nothing failed to sync" image="" />}
        >
          {items.map((item, index) => (
            <IndexTable.Row
              id={String(item.shopifyProductId)}
              key={item.shopifyProductId}
              position={index}
            >
              <IndexTable.Cell>
                <InlineStack gap="300" blockAlign="center">
                  <Thumbnail source={item.thumbnailUrl} alt={item.title ?? 'Product'} size="small" />
                  <Text as="span" fontWeight="semibold">
                    {item.title}
                  </Text>
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Modal.Section>
    </Modal>
  );
}

export default function ManagePage() {
  const [summary, setSummary] = useState<ActivationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState(0);
  const [failedModalOpen, setFailedModalOpen] = useState(false);

  const loadSummary = useCallback(() => {
    apiFetch<ActivationSummary>('/v1/shopify/activation')
      .then(setSummary)
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const toggleGlobalMode = useCallback(
    async (checked: boolean) => {
      const nextMode = checked ? 'global' : 'selective';
      const previous = summary;
      setSummary((s) => (s ? { ...s, mode: nextMode } : s));
      try {
        await apiFetch('/v1/shopify/activation/mode', {
          method: 'PATCH',
          body: JSON.stringify({ mode: nextMode }),
        });
        setToastMessage(
          nextMode === 'global' ? 'Try-On enabled on all products.' : 'Switched to selective activation.',
        );
      } catch (err) {
        setSummary(previous);
        setError((err as Error).message);
      }
    },
    [summary],
  );

  if (!summary) {
    return (
      <Page title="Manage">
        <Card>
          <Text as="p">Loading…</Text>
        </Card>
      </Page>
    );
  }

  const mode = summary.mode;
  const activeTabId = TABS[selectedTab].id;

  return (
    <Page title="Manage" subtitle="Control which products offer Try-On.">
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <Card>
          <BlockStack gap="200">
            <Checkbox
              label="Enable Try-On on all products (except exclusions)"
              checked={mode === 'global'}
              onChange={toggleGlobalMode}
            />
            <Text as="p" tone="subdued">
              When on, every synced product offers Try-On unless it — or a collection it belongs
              to — is excluded below.
            </Text>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 5 }} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Enabled Collections
              </Text>
              <Text as="p" variant="heading2xl">
                {summary.counts.enabledCollections}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Individually Enabled Products
              </Text>
              <Text as="p" variant="heading2xl">
                {summary.counts.individuallyEnabledProducts}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Excluded Products
              </Text>
              <Text as="p" variant="heading2xl">
                {summary.counts.excludedProducts}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Excluded Collections
              </Text>
              <Text as="p" variant="heading2xl">
                {summary.counts.excludedCollections}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <Button variant="plain" onClick={() => setFailedModalOpen(true)}>
              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  Failed to Sync
                </Text>
                <Text as="p" variant="heading2xl" tone="critical">
                  {summary.counts.failedToSync}
                </Text>
              </BlockStack>
            </Button>
          </Card>
        </InlineGrid>

        <Card>
          <Tabs tabs={[...TABS]} selected={selectedTab} onSelect={setSelectedTab}>
            <Box padding="400">
              {activeTabId === 'collections' && (
                <CollectionsPanel
                  basePath="/v1/shopify/activation/collections"
                  editable={isTabEditable(mode, 'collections')}
                  addLabel="Add collections"
                  emptyHeading="No enabled collections"
                  onChanged={loadSummary}
                />
              )}
              {activeTabId === 'individual' && (
                <IndividualProductsPanel
                  editable={isTabEditable(mode, 'individual')}
                  onChanged={loadSummary}
                  setToastMessage={setToastMessage}
                  setError={setError}
                />
              )}
              {activeTabId === 'exclusion' && (
                <ExclusionPanel
                  onChanged={loadSummary}
                  setToastMessage={setToastMessage}
                  setError={setError}
                />
              )}
            </Box>
          </Tabs>
        </Card>
      </BlockStack>

      {failedModalOpen && <FailedProductsModal onClose={() => setFailedModalOpen(false)} />}

      {toastMessage && <Toast content={toastMessage} onDismiss={() => setToastMessage(null)} />}
    </Page>
  );
}
```

Notes on this implementation:
- `CollectionsPanel` is reused for both the Collections tab (`basePath="/v1/shopify/activation/collections"`) and the Exclusion tab's collections sub-section (`basePath="/v1/shopify/activation/exclusions/collections"`, `editable` hardcoded `true` since the Exclusion tab is always editable per `isTabEditable`) — one component, two base paths, avoiding duplicated list/picker code for what is structurally the same feature against a different table.
- `ProductPickerModal` is likewise reused by both the Individual Products tab's "Add products" (`searchParams={{ enabled: 'false' }}`, so only not-yet-individually-enabled products are offered) and the Exclusion tab's "Exclude products" (`searchParams={{ excluded: 'false' }}`).
- The Failed-to-Sync card is a Polaris `Button variant="plain"` wrapping the stat text rather than a bare HTML button, keeping it inside Polaris's own focus/hover styling rather than hand-rolling it.
- No `IndexFilters`/`useSetIndexFiltersMode` this time — the old page's tab-strip role is now played by Polaris `Tabs` at the page level, and searches are plain `TextField`s debounced by a 300ms `setTimeout`, matching the picker modals' own search pattern rather than mixing two different search UI patterns on one page.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @tryme/shopify typecheck`
Expected: no errors.

Run: `pnpm --filter @tryme/shopify lint`
Expected: no errors.

- [ ] **Step 5: Manual dev-store verification**

With the local server running and tunnel linked (as already set up this session), walk through in the browser:
- Toggle global mode on: Collections and Individual Products tabs' lists stay visible with their status badges, but Add/Remove controls become disabled; Exclusion tab stays fully interactive.
- Toggle global mode off: previously-set individual/collection selections are unchanged.
- Add a collection via the picker: it appears with the right product count; a product in that collection (not individually enabled) becomes usable for try-on on the storefront.
- Exclude a product that is also in an enabled collection: it stops being usable for try-on, confirming exclusion wins.
- Click the Failed-to-Sync card: see the one seeded failed product, no Remove action present.
- Individual Products tab pagination: with more than one page's worth of products, `page=2` loads a different set (confirms the pagination gap found earlier this session is actually closed).

Report which of these were verified vs. not runnable in the current dev-store setup — do not claim success without having actually clicked through.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src/pages/ManagePage.tsx apps/shopify/src/types.ts
git commit -m "feat(shopify): rebuild Manage page around the activation model"
```

---

## Task 10: Docs

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top of the log**

Follow the file's existing entry format (see the entries above it for the exact heading/Done/Failed/Open-Questions shape). Cover: the new activation model (global/collections/individual/exclusions), the exclusion-always-wins resolver, the bounded hourly collection resync, the reused `PATCH /v1/shopify/products/:id` endpoint for individual enable/exclude, the custom Polaris picker replacing the assumed native App Bridge picker, and the full Manage page replacement. Note any of Task 9's manual verification steps that couldn't be completed.

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs(shopify): record activation model implementation"
```

---

## Final Verification

After Task 10, run the full set of touched suites together and confirm nothing regressed:

```bash
pnpm --filter @tryme/api test -- shopify-activation-resolver shopify-products shopify-collections-sync shopify-collections-resync-scheduler shopify-activation-routes shopify-customer
pnpm --filter @tryme/shopify test
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/shopify typecheck
```

Do not run the full API integration suite — this repo's convention (see prior plans) is to run only the newly-touched files by name, which is what the list above already includes (`shopify-customer` is the pre-existing file modified in Task 4).

**Never push, never open a PR** — local commits only, per this session's standing instruction.
