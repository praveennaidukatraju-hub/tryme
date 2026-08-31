# Shopify Funnel Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the currently-unwired single `shopify_stores.settings.workflowTemplateId` field (nothing writes it, every Shopify try-on job dead-ends) with admin-curated **funnel templates** that merchants assign their products to — manually per product, or automatically via rules on `product_type`/`tags`/`vendor`.

**Architecture:** A new global, admin-owned `shopify_funnel_templates` table (label → `workflow_templates` row) plus a per-store `shopify_funnel_rules` table (mode + AND-combined conditions + priority). `shopify_product_garments` gains a `funnel_template_id` pointer, an assignment-source flag so manual overrides survive re-sync, and persisted `product_type`/`tags`/`vendor` to evaluate rules against. Job dispatch resolves workflow via funnel → store-default fallback → a new explicit `NO_WORKFLOW_CONFIGURED` failure.

**Tech Stack:** Fastify 5, Drizzle ORM, Zod, Vitest (backend, TDD); React + Polaris (`apps/shopify`), React (`apps/admin-web`) — no test harness in either frontend app, matching every prior frontend task in this project.

## Global Constraints

- **Conditions are AND-combined** within one rule — no OR/mixed logic (spec-approved, deferred to a future iteration).
- **Manual assignment always wins** — a product with `funnel_assignment_source = 'manual'` is never touched by sync-time auto-assignment or the "Re-run rules" bulk action.
- **Funnel templates are global** (admin-owned, shared across every Shopify store) — merchants never see or pick a raw `workflow_templates` UUID directly, only a funnel template's friendly label.
- **Rules are per-store** — each store independently sets Manual/Automated mode and conditions per funnel template.
- **Condition fields are exactly** `product_type` | `tags` | `vendor` — no structured-category taxonomy support (deferred).
- **Priority is a plain integer**, merchant-editable via a number input — lower evaluates first. (Simplified from the design doc's "drag handle" language: a number input is equivalent merchant-facing control with far less UI complexity — same behavior, fewer moving parts.)
- **ESM only**, pnpm workspaces, pino via `@tryme/logger`, ASCII quotes, no `console.log` in committed code.
- **Never hand-write migration SQL or snapshot JSON in this repo** — edit the Drizzle schema `.ts` file, then run `pnpm db:generate` to produce the migration + snapshot from the real schema diff. This repo has a documented history of migration-snapshot corruption from hand-authored SQL (see `CLAUDE.md`'s "Migration Index Conflicts" section) — always let the tool generate it.

---

## File Structure

**Create:**
- `apps/api/src/modules/shopify/funnel-rules.ts` — pure rule-matching logic + DB-touching resolve/assign helpers
- `apps/api/src/modules/shopify/funnel-rules.test.ts` — co-located pure-unit test for `matchesConditions` (no containers)
- `apps/api/src/modules/shopify/funnel.routes.ts` — merchant-facing funnel-rules + manual-assignment + re-run endpoints
- `apps/api/test/shopify-funnel-routes.test.ts` — integration tests for the above
- `apps/api/src/modules/admin/shopify-funnels.routes.ts` — admin CRUD for `shopify_funnel_templates`
- `apps/api/test/shopify-funnel-templates-admin.test.ts` — integration tests for the above
- `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx` — admin funnel-template CRUD UI
- `apps/shopify/src/pages/FunnelSetupPage.tsx` — merchant funnel-rules UI

**Modify:**
- `packages/db/src/schema/shopify.ts` — new tables + `shopify_product_garments` columns
- `apps/api/src/modules/shopify/products.sync.ts` — persist `product_type`/`tags`/`vendor`, call auto-assignment
- `apps/api/test/shopify-sync.test.ts` — cover the new persistence + auto-assignment behavior
- `apps/api/src/modules/shopify/products.routes.ts` — list response gains funnel fields; manual-assign endpoint
- `apps/api/src/modules/shopify/routes.ts` — register `funnel.routes.ts`
- `apps/api/src/modules/shopify/me.routes.ts` — `stats` gains `funnelConfigured: boolean`
- `apps/api/test/shopify-me.test.ts` — cover the new stat
- `apps/api/src/server.ts` — register `adminShopifyFunnelsRoutes`
- `apps/dispatcher/src/job/processor.ts` — `processShopifyJob`'s workflow resolution becomes a fallback chain
- `apps/dispatcher/test/integration/shopify.test.ts` — cover the fallback chain + `NO_WORKFLOW_CONFIGURED`
- `apps/admin-web/src/App.tsx` — route + `PATH_LABELS` entry
- `apps/admin-web/src/components/Sidebar.tsx` — nav item
- `apps/shopify/src/App.tsx` — route
- `apps/shopify/src/components/AppShell.tsx` — nav item
- `apps/shopify/src/pages/ProductsPage.tsx` — Funnel column
- `apps/shopify/src/pages/DashboardPage.tsx` — 4th checklist item
- `apps/shopify/src/types.ts` — new types

---

## Task 1: Database schema — funnel templates, funnel rules, product-garment columns

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`

**Interfaces:**
- Consumes: `workflowTemplates` (existing, from `./models.js`), `shopifyStores` (existing, same file).
- Produces: `schema.shopifyFunnelTemplates`, `schema.shopifyFunnelRules` tables; `schema.FunnelRuleCondition` type; `shopify_product_garments` gains `funnelTemplateId`, `funnelAssignmentSource`, `productType`, `tags`, `vendor` columns — every later task's Drizzle queries reference these exact names.

- [ ] **Step 1: Edit the schema file**

Replace `packages/db/src/schema/shopify.ts` with:

```ts
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';
import { widgetClients } from './widget.js';

export interface ShopifyStoreSettings {
  buttonText?: string;
  buttonColor?: string;
  position?: string;
  customCss?: string;
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
}

export interface FunnelRuleCondition {
  field: 'product_type' | 'tags' | 'vendor';
  operator: 'equals' | 'contains';
  value: string;
}

export const shopifyPlans = pgTable('shopify_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  includedTryons: integer('included_tryons').notNull(),
  overageCents: integer('overage_cents').notNull(),
  trialDays: integer('trial_days').notNull().default(7),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyStores = pgTable('shopify_stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id')
    .notNull()
    .unique()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  shopDomain: text('shop_domain').notNull().unique(),
  shopifyShopId: bigint('shopify_shop_id', { mode: 'number' }).notNull().unique(),
  accessToken: text('access_token').notNull(), // encrypted: iv:authTag:ciphertext
  scope: text('scope').notNull(),
  billingPlanId: bigint('billing_plan_id', { mode: 'number' }),
  shopifyPlanId: uuid('shopify_plan_id').references(() => shopifyPlans.id),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
  settings: jsonb('settings').$type<ShopifyStoreSettings>().notNull().default({}),
  syncCursor: text('sync_cursor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Global, admin-owned — merchants only ever see `label`; the workflow_template_id
// link is set by an admin in apps/admin-web, never chosen directly by a merchant.
export const shopifyFunnelTemplates = pgTable('shopify_funnel_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  workflowTemplateId: uuid('workflow_template_id')
    .notNull()
    .references(() => workflowTemplates.id),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-store — each store independently sets Manual/Automated mode + conditions
// per funnel template. A row only exists once a merchant has saved settings for
// that (store, funnel template) pair; an unconfigured pair defaults to Manual
// mode with no conditions at the API layer, not by inserting a row up front.
export const shopifyFunnelRules = pgTable(
  'shopify_funnel_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    funnelTemplateId: uuid('funnel_template_id')
      .notNull()
      .references(() => shopifyFunnelTemplates.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('manual'), // 'manual' | 'automated'
    conditions: jsonb('conditions').$type<FunnelRuleCondition[]>().notNull().default([]),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.funnelTemplateId),
  }),
);

export const shopifyProductGarments = pgTable(
  'shopify_product_garments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => shopifyStores.id, { onDelete: 'cascade' }),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
    shopifyVariantId: bigint('shopify_variant_id', { mode: 'number' }),
    r2Key: text('r2_key').notNull(),
    title: text('title'),
    status: text('status').notNull().default('processing'), // active|processing|failed|deleted
    enabled: boolean('enabled').notNull().default(false),
    failedReason: text('failed_reason'),
    funnelTemplateId: uuid('funnel_template_id').references(() => shopifyFunnelTemplates.id),
    // 'manual' | 'automated' | null (never assigned). Sync-time auto-assignment and
    // the "Re-run rules" bulk action both skip any row with source = 'manual'.
    funnelAssignmentSource: text('funnel_assignment_source'),
    productType: text('product_type'),
    tags: text('tags').array(),
    vendor: text('vendor'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: unique().on(t.storeId, t.shopifyProductId, t.shopifyVariantId),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
cd packages/db
node_modules/.bin/drizzle-kit generate
```
Expected: a new `packages/db/src/migrations/00NN_<generated_name>.sql` (next index after `0090`) containing `CREATE TABLE` statements for `shopify_funnel_templates` and `shopify_funnel_rules`, plus `ALTER TABLE "shopify_product_garments" ADD COLUMN ...` for the five new columns. Read the generated file — confirm it contains ONLY additive `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` statements, no `DROP`/rename of anything unrelated. If it contains anything unexpected (a drop, a rename of an existing column), STOP and report — do not proceed with a migration that touches unrelated schema.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: the new migration applies cleanly (no "already exists" — this is genuinely new schema, not a reconciliation case).

- [ ] **Step 4: Verify with typecheck + full test suite**

Run: `pnpm --filter @tryme/db build && pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api test`
Expected: PASS, no regressions (this task only adds schema — no behavior changes yet).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/
git commit -m "feat(db): shopify_funnel_templates + shopify_funnel_rules tables, product_garments funnel columns"
```

---

## Task 2: Pure rule-matching logic

**Files:**
- Create: `apps/api/src/modules/shopify/funnel-rules.ts`
- Create: `apps/api/src/modules/shopify/funnel-rules.test.ts`

**Interfaces:**
- Consumes: `schema.FunnelRuleCondition` (Task 1).
- Produces: `matchesConditions(product: ProductAttributes, conditions: FunnelRuleCondition[]): boolean` and `interface ProductAttributes { productType: string | null; tags: string[] | null; vendor: string | null }` — Task 3's sync-time assignment and Task 6's manual-clear/re-run both call `matchesConditions` indirectly via `resolveFunnelTemplateId` (also produced here).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/shopify/funnel-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesConditions } from './funnel-rules.js';

describe('matchesConditions', () => {
  const product = { productType: 'Shirts', tags: ['Sale', 'Cotton'], vendor: 'Acme Co' };

  it('returns false for an empty conditions array', () => {
    expect(matchesConditions(product, [])).toBe(false);
  });

  it('matches product_type with equals', () => {
    expect(
      matchesConditions(product, [{ field: 'product_type', operator: 'equals', value: 'Shirts' }]),
    ).toBe(true);
    expect(
      matchesConditions(product, [{ field: 'product_type', operator: 'equals', value: 'Pants' }]),
    ).toBe(false);
  });

  it('matches product_type with contains, case-insensitive', () => {
    expect(
      matchesConditions(product, [{ field: 'product_type', operator: 'contains', value: 'shirt' }]),
    ).toBe(true);
  });

  it('matches vendor with equals', () => {
    expect(
      matchesConditions(product, [{ field: 'vendor', operator: 'equals', value: 'Acme Co' }]),
    ).toBe(true);
    expect(
      matchesConditions(product, [{ field: 'vendor', operator: 'equals', value: 'acme co' }]),
    ).toBe(false);
  });

  it('matches tags by array membership, ignoring operator', () => {
    expect(matchesConditions(product, [{ field: 'tags', operator: 'equals', value: 'Sale' }])).toBe(
      true,
    );
    expect(
      matchesConditions(product, [{ field: 'tags', operator: 'contains', value: 'Sale' }]),
    ).toBe(true);
    expect(
      matchesConditions(product, [{ field: 'tags', operator: 'equals', value: 'Clearance' }]),
    ).toBe(false);
  });

  it('AND-combines multiple conditions — all must match', () => {
    expect(
      matchesConditions(product, [
        { field: 'product_type', operator: 'equals', value: 'Shirts' },
        { field: 'vendor', operator: 'equals', value: 'Acme Co' },
      ]),
    ).toBe(true);
    expect(
      matchesConditions(product, [
        { field: 'product_type', operator: 'equals', value: 'Shirts' },
        { field: 'vendor', operator: 'equals', value: 'Wrong Vendor' },
      ]),
    ).toBe(false);
  });

  it('returns false when the product field is null', () => {
    expect(
      matchesConditions(
        { productType: null, tags: null, vendor: null },
        [{ field: 'product_type', operator: 'equals', value: 'Shirts' }],
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- funnel-rules`
Expected: FAIL — `funnel-rules.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/shopify/funnel-rules.ts`:

```ts
import { schema } from '@tryme/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface ProductAttributes {
  productType: string | null;
  tags: string[] | null;
  vendor: string | null;
}

export function matchesConditions(
  product: ProductAttributes,
  conditions: schema.FunnelRuleCondition[],
): boolean {
  if (conditions.length === 0) return false;
  return conditions.every((cond) => {
    if (cond.field === 'tags') {
      return (product.tags ?? []).includes(cond.value);
    }
    const fieldValue = cond.field === 'product_type' ? product.productType : product.vendor;
    if (fieldValue == null) return false;
    if (cond.operator === 'equals') return fieldValue === cond.value;
    return fieldValue.toLowerCase().includes(cond.value.toLowerCase());
  });
}

export async function resolveFunnelTemplateId(
  app: FastifyInstance,
  storeId: string,
  product: ProductAttributes,
): Promise<string | null> {
  const rules = await app.db
    .select()
    .from(schema.shopifyFunnelRules)
    .where(
      and(
        eq(schema.shopifyFunnelRules.storeId, storeId),
        eq(schema.shopifyFunnelRules.mode, 'automated'),
      ),
    )
    .orderBy(asc(schema.shopifyFunnelRules.priority));

  for (const rule of rules) {
    if (matchesConditions(product, rule.conditions)) return rule.funnelTemplateId;
  }
  return null;
}

// Called at sync time and by "Re-run rules" — never touches a row whose
// funnel_assignment_source is already 'manual' (caller is responsible for that
// check; this function always overwrites automated/null assignments).
export async function assignFunnelFromRules(
  app: FastifyInstance,
  garmentRowId: string,
  storeId: string,
  product: ProductAttributes,
): Promise<void> {
  const funnelTemplateId = await resolveFunnelTemplateId(app, storeId, product);
  await app.db
    .update(schema.shopifyProductGarments)
    .set({
      funnelTemplateId,
      funnelAssignmentSource: funnelTemplateId ? 'automated' : null,
    })
    .where(eq(schema.shopifyProductGarments.id, garmentRowId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- funnel-rules`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/funnel-rules.ts apps/api/src/modules/shopify/funnel-rules.test.ts
git commit -m "feat(api): funnel rule matching (AND-combined product_type/tags/vendor conditions)"
```

---

## Task 3: Sync-time persistence + auto-assignment

**Files:**
- Modify: `apps/api/src/modules/shopify/products.sync.ts`
- Modify: `apps/api/test/shopify-sync.test.ts`

**Interfaces:**
- Consumes: `assignFunnelFromRules` (Task 2).
- Produces: `syncProduct`'s existing signature is unchanged; `ShopifyProduct` interface gains `product_type`, `tags`, `vendor` — Task 6's manual-assignment endpoint relies on these columns already being populated by the time a merchant looks at the Products page.

- [ ] **Step 1: Write the failing test**

Open `apps/api/test/shopify-sync.test.ts`. Find the existing `syncProduct(...)` calls (6 call sites, each passing a `title` field per the prior task that added it) and add a new test block. Add this `it` inside the existing top-level `describe` block, after the existing tests:

```ts
it('persists product_type/tags/vendor and leaves funnel unassigned with no matching rule', async () => {
  await syncProduct(
    app,
    storeId,
    {
      id: 501,
      title: 'Test Shirt',
      image: { src: 'https://cdn.shopify.com/shirt.jpg' },
      product_type: 'Shirts',
      tags: 'Sale, Cotton',
      vendor: 'Acme Co',
    },
    mockFetch,
  );

  const [row] = await app.db
    .select()
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.shopifyProductId, 501),
      ),
    );
  expect(row.productType).toBe('Shirts');
  expect(row.tags).toEqual(['Sale', 'Cotton']);
  expect(row.vendor).toBe('Acme Co');
  expect(row.funnelTemplateId).toBeNull();
  expect(row.funnelAssignmentSource).toBeNull();
});

it('auto-assigns a funnel template when an automated rule matches', async () => {
  const [wf] = await app.db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .limit(1);
  const [template] = await app.db
    .insert(schema.shopifyFunnelTemplates)
    .values({ slug: 'upper-test', label: 'Upper', workflowTemplateId: wf.id })
    .returning();
  await app.db.insert(schema.shopifyFunnelRules).values({
    storeId,
    funnelTemplateId: template.id,
    mode: 'automated',
    conditions: [{ field: 'product_type', operator: 'equals', value: 'Shirts' }],
    priority: 0,
  });

  await syncProduct(
    app,
    storeId,
    {
      id: 502,
      title: 'Auto-Assigned Shirt',
      image: { src: 'https://cdn.shopify.com/shirt2.jpg' },
      product_type: 'Shirts',
      tags: '',
      vendor: 'Acme Co',
    },
    mockFetch,
  );

  const [row] = await app.db
    .select()
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.shopifyProductId, 502),
      ),
    );
  expect(row.funnelTemplateId).toBe(template.id);
  expect(row.funnelAssignmentSource).toBe('automated');
});

it('does not overwrite a manually-assigned funnel on re-sync', async () => {
  const [wf] = await app.db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .limit(1);
  const [manualTemplate] = await app.db
    .insert(schema.shopifyFunnelTemplates)
    .values({ slug: 'manual-test', label: 'Manual Pick', workflowTemplateId: wf.id })
    .returning();

  await syncProduct(
    app,
    storeId,
    {
      id: 503,
      title: 'Manually Pinned',
      image: { src: 'https://cdn.shopify.com/shirt3.jpg' },
      product_type: 'Shirts',
      tags: '',
      vendor: '',
    },
    mockFetch,
  );
  const [before] = await app.db
    .select()
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.shopifyProductId, 503),
      ),
    );
  await app.db
    .update(schema.shopifyProductGarments)
    .set({ funnelTemplateId: manualTemplate.id, funnelAssignmentSource: 'manual' })
    .where(eq(schema.shopifyProductGarments.id, before.id));

  await syncProduct(
    app,
    storeId,
    {
      id: 503,
      title: 'Manually Pinned (re-synced)',
      image: { src: 'https://cdn.shopify.com/shirt3.jpg' },
      product_type: 'Pants', // changed — would auto-match a different rule if evaluated
      tags: '',
      vendor: '',
    },
    mockFetch,
  );
  const [after] = await app.db
    .select()
    .from(schema.shopifyProductGarments)
    .where(
      and(
        eq(schema.shopifyProductGarments.storeId, storeId),
        eq(schema.shopifyProductGarments.shopifyProductId, 503),
      ),
    );
  expect(after.funnelTemplateId).toBe(manualTemplate.id);
  expect(after.funnelAssignmentSource).toBe('manual');
});
```

Check the top of the file for the existing `mockFetch`/`storeId`/`app` setup and the exact `and`/`eq` import — reuse whatever's already imported rather than re-importing. If `and` isn't already imported from `drizzle-orm`, add it to the existing import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: FAIL — `row.productType` is `undefined`, `product_type`/`tags`/`vendor` fields don't exist on the `ShopifyProduct` type passed to `syncProduct` yet.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/products.sync.ts`, update the `ShopifyProduct` interface:

```ts
interface ShopifyProduct {
  id: number;
  title: string;
  image?: { src?: string } | null;
  product_type?: string;
  tags?: string; // Shopify REST returns tags as a comma-separated string, not an array
  vendor?: string;
}
```

Update `upsertGarment`'s signature and its `.values(...)`/`.onConflictDoUpdate(...)` calls to accept and persist the three new fields:

```ts
async function upsertGarment(
  app: FastifyInstance,
  storeId: string,
  productId: number,
  r2Key: string,
  title: string,
  status: string,
  productType: string | null,
  tags: string[] | null,
  vendor: string | null,
  failedReason?: string,
) {
  const [row] = await app.db
    .insert(schema.shopifyProductGarments)
    .values({
      storeId,
      shopifyProductId: productId,
      shopifyVariantId: NO_VARIANT_SENTINEL,
      r2Key,
      title,
      status,
      productType,
      tags,
      vendor,
      failedReason,
    })
    .onConflictDoUpdate({
      target: [
        schema.shopifyProductGarments.storeId,
        schema.shopifyProductGarments.shopifyProductId,
        schema.shopifyProductGarments.shopifyVariantId,
      ],
      // r2Key intentionally excluded: a merchant's chosen garment image (set via
      // PATCH /v1/shopify/products/:id, stored at a distinct garment-<uuid>.jpg key)
      // must survive routine product re-syncs (products/update webhook fires on any
      // edit -- price, description, tags, ...). syncProduct always downloads to the
      // same deterministic `garment.jpg` path regardless of any override, so a
      // never-overridden row's r2Key already equals that path from its initial
      // insert -- excluding it from the update changes nothing for that case, while
      // correctly preserving an override.
      set: {
        title,
        status,
        productType,
        tags,
        vendor,
        failedReason: failedReason ?? null,
        syncedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}
```

Update `syncProduct` to pass the new fields through and call `assignFunnelFromRules` when the row isn't manually pinned:

```ts
export async function syncProduct(
  app: FastifyInstance,
  storeId: string,
  product: ShopifyProduct,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  const r2Key = `shopify-garments/${storeId}/${product.id}/garment.jpg`;
  const productType = product.product_type ?? null;
  const tags = product.tags ? product.tags.split(',').map((t) => t.trim()).filter(Boolean) : null;
  const vendor = product.vendor ?? null;
  const src = product.image?.src;
  if (!src) {
    const row = await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'failed',
      productType,
      tags,
      vendor,
      'no product image',
    );
    if (row.funnelAssignmentSource !== 'manual') {
      await assignFunnelFromRules(app, row.id, storeId, { productType, tags, vendor });
    }
    return;
  }
  try {
    assertShopifyCdn(src);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: FetchLikeResponse;
    try {
      // redirect: 'error' stops assertShopifyCdn's host allowlist from being bypassed by
      // a redirect (e.g. 302 from an allowed host to an arbitrary/internal host) — fetch
      // throws instead of following it, which the outer catch below already handles.
      res = await fetchFn(src, { redirect: 'error', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      throw new Error('product image exceeds 10MB');
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('product image exceeds 10MB');
    }
    const buf = Buffer.from(arrayBuffer);
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    await app.storage.putObject(r2Key, buf, ct);
    const row = await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'active',
      productType,
      tags,
      vendor,
    );
    if (row.funnelAssignmentSource !== 'manual') {
      await assignFunnelFromRules(app, row.id, storeId, { productType, tags, vendor });
    }
  } catch (err) {
    app.log.warn({ err, storeId, productId: product.id }, 'product sync failed');
    const row = await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'failed',
      productType,
      tags,
      vendor,
      (err as Error).message,
    );
    if (row.funnelAssignmentSource !== 'manual') {
      await assignFunnelFromRules(app, row.id, storeId, { productType, tags, vendor });
    }
  }
}
```

Add the import: `import { assignFunnelFromRules } from './funnel-rules.js';` at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: PASS (all existing + 3 new tests).

- [ ] **Step 5: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/test/shopify-sync.test.ts
git commit -m "feat(api): persist product_type/tags/vendor at sync, auto-assign funnel template"
```

---

## Task 4: Admin CRUD API for funnel templates

**Files:**
- Create: `apps/api/src/modules/admin/shopify-funnels.routes.ts`
- Create: `apps/api/test/shopify-funnel-templates-admin.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `requireAdmin` (existing, from `./guard.js`), `schema.workflowTemplates` (existing).
- Produces: `adminShopifyFunnelsRoutes(app: FastifyInstance): Promise<void>`. Routes: `GET /admin/shopify/funnel-templates`, `POST /admin/shopify/funnel-templates`, `PATCH /admin/shopify/funnel-templates/:id` — Task 8's admin-web page and Task 5's merchant-facing `GET /v1/shopify/funnel-templates` (read-only, active-only) both rely on rows created here.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-funnel-templates-admin.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { adminAuthHeader } from './helpers/admin.js';

let c: Containers;
let app: TestApp;
let adminHeaders: Record<string, string>;
let workflowTemplateId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
  const [wf] = await app.db.select({ id: schema.workflowTemplates.id }).from(schema.workflowTemplates).limit(1);
  workflowTemplateId = wf.id;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('admin shopify funnel templates CRUD', () => {
  it('creates, lists, and patches a funnel template', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'upper-garment', label: 'Upper Garment', workflowTemplateId, sortOrder: 1 },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json();
    expect(created.label).toBe('Upper Garment');
    expect(created.isActive).toBe(true);

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.some((i: { id: string }) => i.id === created.id)).toBe(true);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify/funnel-templates/${created.id}`,
      headers: adminHeaders,
      payload: { label: 'Upper Garment (renamed)', isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, created.id));
    expect(row.label).toBe('Upper Garment (renamed)');
    expect(row.isActive).toBe(false);
  });

  it('rejects a duplicate slug', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'dup-slug', label: 'First', workflowTemplateId, sortOrder: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'dup-slug', label: 'Second', workflowTemplateId, sortOrder: 0 },
    });
    expect(res.statusCode).toBe(500);
  });
});
```

`adminAuthHeader` (`apps/api/test/helpers/admin.ts`) is this codebase's real admin-login test helper — it registers a fresh user, promotes it to an `admin_users` row, logs in via `/admin/auth/login`, and returns `{ authorization: 'Bearer <token>' }` ready to spread into `app.inject`'s `headers`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-templates-admin`
Expected: FAIL — 404, routes don't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/admin/shopify-funnels.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

const CreateFunnelTemplateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  workflowTemplateId: z.string().uuid(),
  sortOrder: z.number().int().default(0),
});

const PatchFunnelTemplateBody = z.object({
  label: z.string().min(1).max(120).optional(),
  workflowTemplateId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function adminShopifyFunnelsRoutes(app: FastifyInstance) {
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/shopify/funnel-templates', { preHandler: RW }, async () => {
    const items = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .orderBy(asc(schema.shopifyFunnelTemplates.sortOrder));
    return { items };
  });

  app.post(
    '/admin/shopify/funnel-templates',
    { preHandler: RW, schema: { body: CreateFunnelTemplateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateFunnelTemplateBody>;
      const [row] = await app.db.insert(schema.shopifyFunnelTemplates).values(body).returning();
      return row;
    },
  );

  app.patch(
    '/admin/shopify/funnel-templates/:id',
    { preHandler: RW, schema: { params: uuidParam, body: PatchFunnelTemplateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof PatchFunnelTemplateBody>;
      const [updated] = await app.db
        .update(schema.shopifyFunnelTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.shopifyFunnelTemplates.id, id))
        .returning({ id: schema.shopifyFunnelTemplates.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'funnel template not found');
      return { ok: true };
    },
  );
}
```

In `apps/api/src/server.ts`, add the import near the other admin imports:

```ts
import { adminShopifyFunnelsRoutes } from './modules/admin/shopify-funnels.routes.js';
```

And register it alongside the other admin routes (after `adminGarmentTypesRoutes`):

```ts
  await app.register(adminShopifyFunnelsRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-templates-admin`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/shopify-funnels.routes.ts apps/api/test/shopify-funnel-templates-admin.test.ts apps/api/src/server.ts
git commit -m "feat(api): admin CRUD for shopify funnel templates"
```

---

## Task 5: Merchant-facing funnel-rules API

**Files:**
- Create: `apps/api/src/modules/shopify/funnel.routes.ts`
- Create: `apps/api/test/shopify-funnel-routes.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`

**Interfaces:**
- Consumes: `app.requireShopifySession` (existing), `schema.shopifyFunnelTemplates`/`schema.shopifyFunnelRules` (Task 1).
- Produces: `shopifyFunnelRoutes(app: FastifyInstance): Promise<void>`. Routes: `GET /v1/shopify/funnel-templates` (active templates + this store's rule, defaulted), `PATCH /v1/shopify/funnel-templates/:id/rule` (upsert mode/conditions/priority) — Task 8's Funnel Setup page calls both. Task 6 adds the manual-assignment and re-run endpoints to this same file.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-funnel-routes.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { signSessionToken } from './helpers/shopify-session.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 21).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;
let funnelTemplateId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 501,
      shopDomain: 'funnel-test.myshopify.com',
      myshopifyDomain: 'funnel-test.myshopify.com',
      name: 'F',
      email: 'f@f.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('funnel-test.myshopify.com', API_SECRET, API_KEY);

  const [wf] = await app.db.select({ id: schema.workflowTemplates.id }).from(schema.workflowTemplates).limit(1);
  const [template] = await app.db
    .insert(schema.shopifyFunnelTemplates)
    .values({ slug: 'funnel-route-test', label: 'Test Funnel', workflowTemplateId: wf.id })
    .returning();
  funnelTemplateId = template.id;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/funnel-templates', () => {
  it('lists active templates with a defaulted manual rule when none is saved', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/funnel-templates',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const item = body.items.find((i: { id: string }) => i.id === funnelTemplateId);
    expect(item.label).toBe('Test Funnel');
    expect(item.rule).toEqual({ mode: 'manual', conditions: [], priority: 0 });
  });
});

describe('PATCH /v1/shopify/funnel-templates/:id/rule', () => {
  it('upserts the store rule for a funnel template', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/shopify/funnel-templates/${funnelTemplateId}/rule`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: 'automated',
        conditions: [{ field: 'product_type', operator: 'equals', value: 'Shirts' }],
        priority: 5,
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyFunnelRules)
      .where(eq(schema.shopifyFunnelRules.storeId, storeId));
    expect(row.mode).toBe('automated');
    expect(row.priority).toBe(5);
    expect(row.conditions).toEqual([{ field: 'product_type', operator: 'equals', value: 'Shirts' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-routes`
Expected: FAIL — 404, routes don't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/shopify/funnel.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ConditionSchema = z.object({
  field: z.enum(['product_type', 'tags', 'vendor']),
  operator: z.enum(['equals', 'contains']),
  value: z.string().min(1),
});

const PutRuleBody = z.object({
  mode: z.enum(['manual', 'automated']),
  conditions: z.array(ConditionSchema).default([]),
  priority: z.number().int().default(0),
});

const uuidParam = z.object({ id: z.string().uuid() });

export async function shopifyFunnelRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/funnel-templates', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

    const templates = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isActive, true))
      .orderBy(asc(schema.shopifyFunnelTemplates.sortOrder));

    const rules = await app.db
      .select()
      .from(schema.shopifyFunnelRules)
      .where(eq(schema.shopifyFunnelRules.storeId, store.id));
    const rulesByTemplate = new Map(rules.map((r) => [r.funnelTemplateId, r]));

    return {
      items: templates.map((t) => {
        const rule = rulesByTemplate.get(t.id);
        return {
          id: t.id,
          slug: t.slug,
          label: t.label,
          rule: rule
            ? { mode: rule.mode, conditions: rule.conditions, priority: rule.priority }
            : { mode: 'manual' as const, conditions: [] as schema.FunnelRuleCondition[], priority: 0 },
        };
      }),
    };
  });

  app.patch(
    '/v1/shopify/funnel-templates/:id/rule',
    { preHandler: app.requireShopifySession, schema: { params: uuidParam, body: PutRuleBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id: funnelTemplateId } = req.params as { id: string };
      const { mode, conditions, priority } = req.body as z.infer<typeof PutRuleBody>;

      await app.db
        .insert(schema.shopifyFunnelRules)
        .values({ storeId: store.id, funnelTemplateId, mode, conditions, priority })
        .onConflictDoUpdate({
          target: [schema.shopifyFunnelRules.storeId, schema.shopifyFunnelRules.funnelTemplateId],
          set: { mode, conditions, priority, updatedAt: new Date() },
        });

      return { ok: true };
    },
  );
}
```

In `apps/api/src/modules/shopify/routes.ts`, add the import:

```ts
import { shopifyFunnelRoutes } from './funnel.routes.js';
```

And register it after `shopifyOnboardingRoutes`:

```ts
  await app.register(shopifyFunnelRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-routes`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/funnel.routes.ts apps/api/test/shopify-funnel-routes.test.ts apps/api/src/modules/shopify/routes.ts
git commit -m "feat(api): merchant-facing funnel-template list + per-store rule upsert"
```

---

## Task 6: Manual assignment + Re-run rules endpoints

**Files:**
- Modify: `apps/api/src/modules/shopify/funnel.routes.ts`
- Modify: `apps/api/test/shopify-funnel-routes.test.ts`
- Modify: `apps/api/src/modules/shopify/products.routes.ts`

**Interfaces:**
- Consumes: `resolveFunnelTemplateId`/`ProductAttributes` (Task 2), `shopifyFunnelRoutes` (Task 5, same file, extended here).
- Produces: `PATCH /v1/shopify/products/:id/funnel` (manual assign/clear), `POST /v1/shopify/funnel-templates/re-run` — Task 9's Products page Funnel dropdown and Funnel Setup page's "Re-run rules" button call these.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/shopify-funnel-routes.test.ts`, inside a new `describe` block after the existing ones — reuses `storeId`/`token`/`funnelTemplateId`/`app` from the existing `beforeAll`:

```ts
describe('PATCH /v1/shopify/products/:id/funnel', () => {
  it('manually assigns a product to a funnel template', async () => {
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId,
      shopifyProductId: 9001,
      shopifyVariantId: 0,
      r2Key: 'shopify-garments/test/9001/garment.jpg',
      status: 'active',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/9001/funnel',
      headers: { authorization: `Bearer ${token}` },
      payload: { funnelTemplateId },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 9001),
        ),
      );
    expect(row.funnelTemplateId).toBe(funnelTemplateId);
    expect(row.funnelAssignmentSource).toBe('manual');
  });

  it('clearing to null resets to automated and re-evaluates immediately', async () => {
    await app.db.insert(schema.shopifyFunnelRules).values({
      storeId,
      funnelTemplateId,
      mode: 'automated',
      conditions: [{ field: 'vendor', operator: 'equals', value: 'ClearTest' }],
      priority: 0,
    });
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId,
      shopifyProductId: 9002,
      shopifyVariantId: 0,
      r2Key: 'shopify-garments/test/9002/garment.jpg',
      status: 'active',
      vendor: 'ClearTest',
      funnelTemplateId,
      funnelAssignmentSource: 'manual',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/9002/funnel',
      headers: { authorization: `Bearer ${token}` },
      payload: { funnelTemplateId: null },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 9002),
        ),
      );
    expect(row.funnelAssignmentSource).toBe('automated');
    expect(row.funnelTemplateId).toBe(funnelTemplateId);
  });
});

describe('POST /v1/shopify/funnel-templates/re-run', () => {
  it('re-evaluates non-manual products, skips manual ones', async () => {
    await app.db.insert(schema.shopifyFunnelRules).values({
      storeId,
      funnelTemplateId,
      mode: 'automated',
      conditions: [{ field: 'vendor', operator: 'equals', value: 'RerunTest' }],
      priority: 0,
    }).onConflictDoUpdate({
      target: [schema.shopifyFunnelRules.storeId, schema.shopifyFunnelRules.funnelTemplateId],
      set: {
        mode: 'automated',
        conditions: [{ field: 'vendor', operator: 'equals', value: 'RerunTest' }],
      },
    });
    await app.db.insert(schema.shopifyProductGarments).values([
      {
        storeId,
        shopifyProductId: 9003,
        shopifyVariantId: 0,
        r2Key: 'x',
        status: 'active',
        vendor: 'RerunTest',
      },
      {
        storeId,
        shopifyProductId: 9004,
        shopifyVariantId: 0,
        r2Key: 'y',
        status: 'active',
        vendor: 'RerunTest',
        funnelTemplateId: null,
        funnelAssignmentSource: 'manual',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/funnel-templates/re-run',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.vendor, 'RerunTest'),
        ),
      );
    const auto = rows.find((r) => r.shopifyProductId === 9003);
    const manual = rows.find((r) => r.shopifyProductId === 9004);
    expect(auto?.funnelTemplateId).toBe(funnelTemplateId);
    expect(auto?.funnelAssignmentSource).toBe('automated');
    expect(manual?.funnelTemplateId).toBeNull();
    expect(manual?.funnelAssignmentSource).toBe('manual');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-routes`
Expected: FAIL — the new endpoints 404.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/funnel.routes.ts`, add the import and two new routes. Update the top import line:

```ts
import { resolveFunnelTemplateId } from './funnel-rules.js';
```

Append inside `shopifyFunnelRoutes`, after the existing `PATCH /v1/shopify/funnel-templates/:id/rule` route:

```ts
  app.patch(
    '/v1/shopify/products/:id/funnel',
    {
      preHandler: app.requireShopifySession,
      schema: {
        body: z.object({ funnelTemplateId: z.string().uuid().nullable() }),
      },
    },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id } = req.params as { id: string };
      const shopifyProductId = Number(id);
      const { funnelTemplateId } = req.body as { funnelTemplateId: string | null };

      const [existing] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, store.id),
            eq(schema.shopifyProductGarments.shopifyProductId, shopifyProductId),
          ),
        )
        .limit(1);
      if (!existing) return { ok: false, reason: 'product not synced yet' };

      if (funnelTemplateId === null) {
        // "Automated" chosen explicitly — clear the manual pin and re-evaluate
        // this one product against current rules immediately.
        const resolved = await resolveFunnelTemplateId(app, store.id, {
          productType: existing.productType,
          tags: existing.tags,
          vendor: existing.vendor,
        });
        await app.db
          .update(schema.shopifyProductGarments)
          .set({
            funnelTemplateId: resolved,
            funnelAssignmentSource: resolved ? 'automated' : null,
          })
          .where(eq(schema.shopifyProductGarments.id, existing.id));
        return { ok: true };
      }

      await app.db
        .update(schema.shopifyProductGarments)
        .set({ funnelTemplateId, funnelAssignmentSource: 'manual' })
        .where(eq(schema.shopifyProductGarments.id, existing.id));
      return { ok: true };
    },
  );

  app.post(
    '/v1/shopify/funnel-templates/re-run',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

      const products = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.storeId, store.id));

      let reassigned = 0;
      for (const p of products) {
        if (p.funnelAssignmentSource === 'manual') continue;
        const resolved = await resolveFunnelTemplateId(app, store.id, {
          productType: p.productType,
          tags: p.tags,
          vendor: p.vendor,
        });
        await app.db
          .update(schema.shopifyProductGarments)
          .set({
            funnelTemplateId: resolved,
            funnelAssignmentSource: resolved ? 'automated' : null,
          })
          .where(eq(schema.shopifyProductGarments.id, p.id));
        reassigned += 1;
      }

      return { ok: true, reassigned };
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-funnel-routes`
Expected: PASS (5 tests total in this file).

- [ ] **Step 5: Extend the products list response with funnel fields**

In `apps/api/src/modules/shopify/products.routes.ts`, update the `GET /v1/shopify/products` handler's `select` and `rows.map`:

```ts
      const rows = await app.db
        .select({
          shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
          title: schema.shopifyProductGarments.title,
          r2Key: schema.shopifyProductGarments.r2Key,
          status: schema.shopifyProductGarments.status,
          enabled: schema.shopifyProductGarments.enabled,
          funnelTemplateId: schema.shopifyProductGarments.funnelTemplateId,
          funnelAssignmentSource: schema.shopifyProductGarments.funnelAssignmentSource,
        })
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.storeId, store.id))
        .orderBy(schema.shopifyProductGarments.shopifyProductId)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const items = rows.map((r) => ({
        shopifyProductId: r.shopifyProductId,
        title: r.title,
        thumbnailUrl: app.storage.publicUrl(r.r2Key),
        status: r.status,
        enabled: r.enabled,
        funnelTemplateId: r.funnelTemplateId,
        funnelAssignmentSource: r.funnelAssignmentSource,
      }));
```

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/funnel.routes.ts apps/api/test/shopify-funnel-routes.test.ts apps/api/src/modules/shopify/products.routes.ts
git commit -m "feat(api): manual funnel assignment endpoint + re-run rules bulk action"
```

---

## Task 7: Dispatcher workflow resolution fallback chain

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`
- Modify: `apps/dispatcher/test/integration/shopify.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyProductGarments.funnelTemplateId`, `schema.shopifyFunnelTemplates.workflowTemplateId` (Task 1).
- Produces: nothing consumed by other tasks — `processShopifyJob`'s resolution logic changes are internal.

- [ ] **Step 1: Write the failing test**

Add to `apps/dispatcher/test/integration/shopify.test.ts`, inside the existing `describe('dispatcher shopify job routing', ...)` block, after the existing `seedShopifyJob` function (reusing its `env`/`redis`/`pub`/`comfy`/`WORKER_ID` setup and the same `PERSON_NODE_ID`/`GARMENT_NODE_ID`/`OUTPUT_NODE_ID` constants already defined at the top of the file) — add a new helper and two new `it`s:

```ts
  async function seedShopifyJobViaFunnel(opts: { withFunnel: boolean }) {
    const [client] = await env.db
      .insert(schema.widgetClients)
      .values({
        companyName: 'Funnel Acme',
        contactName: 'A',
        email: `shopify-funnel-${Date.now()}@test.com`,
        phone: '1234567890',
        websiteUrl: 'https://acme.example',
        companySize: '1-10',
        purpose: 'test',
        businessAddress: 'x',
        passwordHash: 'x',
        clientType: 'shopify',
        isActive: true,
      })
      .returning();
    await env.db
      .insert(schema.widgetClientCredits)
      .values({ widgetClientId: client?.id, balance: 5 });

    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        widgetClientId: client?.id as string,
        shopDomain: `funnel-test-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'iv:tag:enc',
        scope: 'read_products',
      })
      .returning();

    let funnelTemplateIdToAssign: string | undefined;
    if (opts.withFunnel) {
      const [funnelWorkflow] = await env.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `funnel-wf-${Date.now()}`,
          label: 'Funnel WF',
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
      const [funnelTemplate] = await env.db
        .insert(schema.shopifyFunnelTemplates)
        .values({
          slug: `funnel-tpl-${Date.now()}`,
          label: 'Funnel Template',
          workflowTemplateId: funnelWorkflow.id,
        })
        .returning();
      funnelTemplateIdToAssign = funnelTemplate.id;
    }

    const garmentKey = `shopify-garments/${store?.id}/garment.jpg`;
    await env.db.insert(schema.shopifyProductGarments).values({
      storeId: store?.id as string,
      shopifyProductId: 1,
      shopifyVariantId: 0,
      r2Key: garmentKey,
      status: 'active',
      enabled: true,
      funnelTemplateId: funnelTemplateIdToAssign ? funnelTemplateIdToAssign : null,
      funnelAssignmentSource: funnelTemplateIdToAssign ? 'manual' : null,
    });

    // biome-ignore lint/suspicious/noExplicitAny: mirrors seedShopifyJob's own userId cast above
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      widgetClientId: client?.id,
      customerPhotoKey: `widget-inputs/${client?.id}/photo.jpg`,
      status: 'QUEUED',
      creditsCharged: 2,
    }).returning();

    // biome-ignore lint/suspicious/noExplicitAny: mirrors seedShopifyJob's own face/bg/pose cast above
    await (env.db.insert(schema.jobInputs).values as any)({
      jobId: job?.id,
      upperGarmentKey: garmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      // No workflowTemplateId in params — proves the funnel lookup alone resolves
      // it when opts.withFunnel is true, and proves NO_WORKFLOW_CONFIGURED fires
      // when it's false (no funnel, no store.settings default either).
      params: { kind: 'shopify' },
    });

    for (const key of [`widget-inputs/${client?.id}/photo.jpg`, garmentKey]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job?.id as string };
  }

  it('resolves the workflow via the product\'s funnel template', async () => {
    const { jobId } = await seedShopifyJobViaFunnel({ withFunnel: true });
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '',
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');
  });

  it('fails with NO_WORKFLOW_CONFIGURED when neither a funnel nor a store default is set', async () => {
    const { jobId } = await seedShopifyJobViaFunnel({ withFunnel: false });
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '',
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('FAILED');
    expect(job?.errorCode).toBe('NO_WORKFLOW_CONFIGURED');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/dispatcher test -- shopify`
Expected: FAIL — `processShopifyJob` still reads `params.workflowTemplateId` only (which is absent in both new seed cases), so both new tests fail with the old `SHOPIFY_INPUTS_MISSING` code instead of resolving via the funnel or reporting `NO_WORKFLOW_CONFIGURED`.

- [ ] **Step 3: Implement**

In `apps/dispatcher/src/job/processor.ts`, find `processShopifyJob` (the function reading `params.workflowTemplateId` — see the existing block starting `const workflowTemplateId = params.workflowTemplateId as string | undefined;`). Replace that resolution with a lookup that checks the garment row's funnel assignment first:

```ts
  const garmentKey = inputs.upperGarmentKey;
  const customerPhotoKey = job.customerPhotoKey;

  const [garmentRow] = await db
    .select({
      funnelTemplateId: schema.shopifyProductGarments.funnelTemplateId,
    })
    .from(schema.shopifyProductGarments)
    .where(eq(schema.shopifyProductGarments.r2Key, garmentKey ?? ''))
    .limit(1);

  let workflowTemplateId: string | undefined;
  if (garmentRow?.funnelTemplateId) {
    const [funnelTemplate] = await db
      .select({ workflowTemplateId: schema.shopifyFunnelTemplates.workflowTemplateId })
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, garmentRow.funnelTemplateId));
    workflowTemplateId = funnelTemplate?.workflowTemplateId;
  }
  if (!workflowTemplateId) {
    workflowTemplateId = params.workflowTemplateId as string | undefined;
  }

  if (!workflowTemplateId || !garmentKey || !customerPhotoKey) {
    await markWidgetFailed(
      cfg,
      jobId,
      widgetClientId,
      creditsCharged,
      stream,
      messageId,
      !workflowTemplateId ? 'NO_WORKFLOW_CONFIGURED' : 'SHOPIFY_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }
```

This replaces the existing block that started with `const workflowTemplateId = params.workflowTemplateId as string | undefined;` through the existing `if (!workflowTemplateId || !garmentKey || !customerPhotoKey) { ... }` guard — the rest of `processShopifyJob` (loading the `workflow_templates` row by `workflowTemplateId`, node-ID checks, worker selection, upload/patch/submit/poll) is unchanged.

Add the import if not already present at the top of `apps/dispatcher/src/job/processor.ts`: confirm `schema` is already imported from `@tryme/db` (it is, used throughout this file) — no new import needed since `shopifyProductGarments`/`shopifyFunnelTemplates` are accessed via the existing `schema.*` namespace import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/dispatcher test -- shopify`
Expected: PASS.

- [ ] **Step 5: Run the full dispatcher suite + typecheck**

Run: `pnpm --filter @tryme/dispatcher test && pnpm --filter @tryme/dispatcher typecheck`
Expected: PASS, no regressions (saree/regular job processors are untouched).

- [ ] **Step 6: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/test/integration/shopify.test.ts
git commit -m "feat(dispatcher): resolve shopify job workflow via funnel template, fall back to store default"
```

---

## Task 8: Admin-web — funnel template CRUD page

**Files:**
- Create: `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx`
- Modify: `apps/admin-web/src/App.tsx`
- Modify: `apps/admin-web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `GET /admin/shopify/funnel-templates`, `POST /admin/shopify/funnel-templates`, `PATCH /admin/shopify/funnel-templates/:id` (Task 4), `apiFetch` (existing, from `../lib/data`), `GET /admin/workflows` (existing, `apps/api/src/modules/admin/workflows.routes.ts` — returns a **bare array** of `{id, slug, label, workflowType, isActive, ...}`, not `{items: [...]}`).
- Produces: nothing consumed by other tasks — last admin-web task.

**No TDD** — matches every prior admin-web/apps-shopify frontend task in this project. Verification is the build succeeding plus manual smoke-testing.

- [ ] **Step 1: Build the page**

Create `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/data';

interface WorkflowOption {
  id: string;
  label: string;
}

interface FunnelTemplate {
  id: string;
  slug: string;
  label: string;
  workflowTemplateId: string;
  isActive: boolean;
  sortOrder: number;
}

interface Props {
  toast: (opts: { title: string; description?: string }) => void;
}

export default function ShopifyFunnelsPage({ toast }: Props) {
  const [items, setItems] = useState<FunnelTemplate[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [workflowTemplateId, setWorkflowTemplateId] = useState('');
  const [sortOrder, setSortOrder] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ items: FunnelTemplate[] }>('/admin/shopify/funnel-templates'),
      apiFetch<WorkflowOption[]>('/admin/workflows'), // bare array, not { items }
    ])
      .then(([f, w]) => {
        setItems(f.items);
        setWorkflows(w);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!slug || !label || !workflowTemplateId) return;
    await apiFetch('/admin/shopify/funnel-templates', {
      method: 'POST',
      body: JSON.stringify({ slug, label, workflowTemplateId, sortOrder }),
    });
    toast({ title: 'Funnel template created' });
    setSlug('');
    setLabel('');
    setWorkflowTemplateId('');
    setSortOrder(0);
    load();
  }

  async function toggleActive(item: FunnelTemplate) {
    await apiFetch(`/admin/shopify/funnel-templates/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !item.isActive }),
    });
    load();
  }

  return (
    <div>
      <h1>Shopify Funnel Templates</h1>
      <p>
        Global, admin-owned labels merchants assign their Shopify products to. Each maps to one
        workflow template.
      </p>

      <div style={{ display: 'flex', gap: '8px', margin: '16px 0', alignItems: 'end' }}>
        <label>
          Slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Workflow
          <select
            value={workflowTemplateId}
            onChange={(e) => setWorkflowTemplateId(e.target.value)}
          >
            <option value="">Select a workflow</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort order
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value))}
          />
        </label>
        <button type="button" onClick={create}>
          Add
        </button>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Slug</th>
              <th>Workflow</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.label}</td>
                <td>{item.slug}</td>
                <td>{workflows.find((w) => w.id === item.workflowTemplateId)?.label ?? '?'}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={item.isActive}
                    onChange={() => toggleActive(item)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the route + nav**

In `apps/admin-web/src/App.tsx`, add the import near the other page imports:

```ts
import ShopifyFunnelsPage from './pages/ShopifyFunnelsPage';
```

Add to `PATH_LABELS`:

```ts
  'shopify-funnels': 'Shopify Funnels',
```

Add the route alongside the existing `<Route path="/workflows" ...>`:

```tsx
            <Route path="/shopify-funnels" element={<ShopifyFunnelsPage {...pageProps} />} />
```

In `apps/admin-web/src/components/Sidebar.tsx`, add a nav item to the `'Content'` group, after the existing `saree` entry:

```ts
      {
        k: 'shopify-funnels',
        label: 'Shopify Funnels',
        icon: Icon.Workflow,
        roles: ['SUPER_ADMIN', 'MODERATOR'],
      },
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @tryme/admin build`
Expected: succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/ShopifyFunnelsPage.tsx apps/admin-web/src/App.tsx apps/admin-web/src/components/Sidebar.tsx
git commit -m "feat(admin-web): shopify funnel template CRUD page"
```

---

## Task 9: apps/shopify — Funnel Setup page

**Files:**
- Create: `apps/shopify/src/pages/FunnelSetupPage.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppShell.tsx`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: `GET /v1/shopify/funnel-templates`, `PATCH /v1/shopify/funnel-templates/:id/rule`, `POST /v1/shopify/funnel-templates/re-run` (Tasks 5-6), `apiFetch` (existing, from `../lib/api`).
- Produces: `FunnelRule`, `FunnelTemplateItem` types in `types.ts` — Task 10's Products page Funnel dropdown reuses `FunnelTemplateItem`.

**No TDD** — matches every prior `apps/shopify` frontend task. Verification is the build succeeding plus manual smoke-testing.

- [ ] **Step 1: Add types**

In `apps/shopify/src/types.ts`, add:

```ts
export interface FunnelRuleCondition {
  field: 'product_type' | 'tags' | 'vendor';
  operator: 'equals' | 'contains';
  value: string;
}

export interface FunnelRule {
  mode: 'manual' | 'automated';
  conditions: FunnelRuleCondition[];
  priority: number;
}

export interface FunnelTemplateItem {
  id: string;
  slug: string;
  label: string;
  rule: FunnelRule;
}
```

- [ ] **Step 2: Build the page**

Create `apps/shopify/src/pages/FunnelSetupPage.tsx`:

```tsx
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import type { FunnelRuleCondition, FunnelTemplateItem } from '../types';

const FIELD_OPTIONS = [
  { label: 'Product type', value: 'product_type' },
  { label: 'Tags', value: 'tags' },
  { label: 'Vendor', value: 'vendor' },
];
const OPERATOR_OPTIONS = [
  { label: 'Equals', value: 'equals' },
  { label: 'Contains', value: 'contains' },
];

export default function FunnelSetupPage() {
  const [items, setItems] = useState<FunnelTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: FunnelTemplateItem[] }>('/v1/shopify/funnel-templates')
      .then((data) => setItems(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function updateLocalRule(id: string, rule: FunnelTemplateItem['rule']) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, rule } : i)));
  }

  async function saveRule(item: FunnelTemplateItem) {
    setSavingId(item.id);
    setError(null);
    try {
      await apiFetch(`/v1/shopify/funnel-templates/${item.id}/rule`, {
        method: 'PATCH',
        body: JSON.stringify(item.rule),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  async function rerun() {
    setRerunning(true);
    setError(null);
    try {
      await apiFetch('/v1/shopify/funnel-templates/re-run', { method: 'POST' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRerunning(false);
    }
  }

  function addCondition(item: FunnelTemplateItem) {
    updateLocalRule(item.id, {
      ...item.rule,
      conditions: [...item.rule.conditions, { field: 'product_type', operator: 'equals', value: '' }],
    });
  }

  function updateCondition(item: FunnelTemplateItem, index: number, patch: Partial<FunnelRuleCondition>) {
    const conditions = item.rule.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c));
    updateLocalRule(item.id, { ...item.rule, conditions });
  }

  function removeCondition(item: FunnelTemplateItem, index: number) {
    updateLocalRule(item.id, {
      ...item.rule,
      conditions: item.rule.conditions.filter((_, i) => i !== index),
    });
  }

  if (loading) {
    return (
      <Page title="Funnel Setup">
        <Layout>
          <Layout.Section>
            <Card>
              <SkeletonBodyText lines={6} />
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page title="Funnel Setup">
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Something went wrong">
              {error}
            </Banner>
          )}
          <Banner tone="info">
            Manual funnels: assign products individually from the Products page. Automated
            funnels: products matching every condition below get assigned automatically whenever
            they sync.
          </Banner>

          <BlockStack gap="400">
            {items.map((item) => (
              <Card key={item.id}>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      {item.label}
                    </Text>
                    <Select
                      label="Mode"
                      labelHidden
                      options={[
                        { label: 'Manual', value: 'manual' },
                        { label: 'Automated', value: 'automated' },
                      ]}
                      value={item.rule.mode}
                      onChange={(mode) =>
                        updateLocalRule(item.id, { ...item.rule, mode: mode as 'manual' | 'automated' })
                      }
                    />
                  </InlineStack>

                  {item.rule.mode === 'automated' && (
                    <BlockStack gap="200">
                      {item.rule.conditions.map((cond, index) => (
                        <InlineStack key={index} gap="200">
                          <Select
                            label="Field"
                            labelHidden
                            options={FIELD_OPTIONS}
                            value={cond.field}
                            onChange={(field) =>
                              updateCondition(item, index, { field: field as FunnelRuleCondition['field'] })
                            }
                          />
                          <Select
                            label="Operator"
                            labelHidden
                            options={OPERATOR_OPTIONS}
                            value={cond.operator}
                            onChange={(operator) =>
                              updateCondition(item, index, {
                                operator: operator as FunnelRuleCondition['operator'],
                              })
                            }
                          />
                          <TextField
                            label="Value"
                            labelHidden
                            autoComplete="off"
                            value={cond.value}
                            onChange={(value) => updateCondition(item, index, { value })}
                          />
                          <Button onClick={() => removeCondition(item, index)}>Remove</Button>
                        </InlineStack>
                      ))}
                      <InlineStack gap="200">
                        <Button onClick={() => addCondition(item)}>Add condition</Button>
                        <TextField
                          label="Priority"
                          labelHidden
                          type="number"
                          autoComplete="off"
                          value={String(item.rule.priority)}
                          onChange={(value) =>
                            updateLocalRule(item.id, { ...item.rule, priority: Number(value) || 0 })
                          }
                        />
                      </InlineStack>
                    </BlockStack>
                  )}

                  <Button onClick={() => saveRule(item)} loading={savingId === item.id}>
                    Save
                  </Button>
                </BlockStack>
              </Card>
            ))}
          </BlockStack>

          <Card>
            <InlineStack align="space-between">
              <Text as="p">Re-evaluate all non-manually-assigned products against saved rules.</Text>
              <Button onClick={rerun} loading={rerunning}>
                Re-run rules
              </Button>
            </InlineStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 3: Wire the route + nav**

In `apps/shopify/src/App.tsx`, add the import and route:

```ts
import FunnelSetupPage from './pages/FunnelSetupPage';
```

```tsx
          <Route path="/funnel-setup" element={<FunnelSetupPage />} />
```

In `apps/shopify/src/components/AppShell.tsx`, add to `NAV_ITEMS`:

```ts
  { to: '/funnel-setup', label: 'Funnel Setup' },
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/pages/FunnelSetupPage.tsx apps/shopify/src/App.tsx apps/shopify/src/components/AppShell.tsx apps/shopify/src/types.ts
git commit -m "feat(shopify-admin): Funnel Setup page (manual/automated rules per funnel template)"
```

---

## Task 10: Products page Funnel column + Dashboard checklist item

**Files:**
- Modify: `apps/shopify/src/pages/ProductsPage.tsx`
- Modify: `apps/shopify/src/types.ts`
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/api/test/shopify-me.test.ts`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `PATCH /v1/shopify/products/:id/funnel` (Task 6), `GET /v1/shopify/funnel-templates` (Task 5), `FunnelTemplateItem` (Task 9).
- Produces: nothing consumed by other tasks — last task of this plan.

**Backend piece (`me.routes.ts` stat) is TDD. Frontend pieces have no automated test harness**, matching every prior frontend task.

- [ ] **Step 1: Write the failing test for the new stat**

In `apps/api/test/shopify-me.test.ts`, find the existing `beforeAll` that inserts two `shopifyProductGarments` rows and the `it('includes totalTryOns, syncedProductCount, enabledProductCount', ...)` test. Add a new test after it:

```ts
describe('GET /v1/shopify/me stats.funnelConfigured', () => {
  it('is false with no funnel assignment, true once one exists', async () => {
    let res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().stats.funnelConfigured).toBe(false);

    const [wf] = await app.db.select({ id: schema.workflowTemplates.id }).from(schema.workflowTemplates).limit(1);
    const [template] = await app.db
      .insert(schema.shopifyFunnelTemplates)
      .values({ slug: 'me-stat-test', label: 'Me Stat Test', workflowTemplateId: wf.id })
      .returning();
    await app.db
      .update(schema.shopifyProductGarments)
      .set({ funnelTemplateId: template.id, funnelAssignmentSource: 'manual' })
      .where(eq(schema.shopifyProductGarments.storeId, storeId));

    res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().stats.funnelConfigured).toBe(true);
  });
});
```

Check the top of the test file for whether `eq` is already imported from `drizzle-orm` — add it to the existing import line if not.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: FAIL — `stats.funnelConfigured` is `undefined`.

- [ ] **Step 3: Implement the stat**

In `apps/api/src/modules/shopify/me.routes.ts`, add the import `exists` alongside the existing drizzle-orm imports (`and`, `count`, `eq`) — update the import line to `import { and, count, eq, exists } from 'drizzle-orm';` — and add the query + response field:

```ts
    const [{ funnelConfigured }] = await app.db
      .select({
        funnelConfigured: exists(
          app.db
            .select()
            .from(schema.shopifyProductGarments)
            .where(
              and(
                eq(schema.shopifyProductGarments.storeId, store.id),
                sql`${schema.shopifyProductGarments.funnelTemplateId} is not null`,
              ),
            ),
        ),
      })
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id))
      .limit(1);

    return {
      store: { shopDomain: store.shopDomain, settings: store.settings },
      credits: credits?.balance ?? 0,
      plan,
      stats: { totalTryOns, syncedProductCount, enabledProductCount, funnelConfigured },
    };
```

This replaces the existing final `return { ... }` statement. Add `sql` to the drizzle-orm import if not already present (check the existing import line — it currently imports `and, count, eq`; add `exists, sql` to make it `import { and, count, eq, exists, sql } from 'drizzle-orm';`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: PASS.

- [ ] **Step 5: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the backend piece**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts
git commit -m "feat(api): add funnelConfigured to GET /v1/shopify/me stats"
```

- [ ] **Step 7: Add the Funnel column to the Products page**

In `apps/shopify/src/types.ts`, update `ShopifyProductListItem`:

```ts
export interface ShopifyProductListItem {
  shopifyProductId: number;
  title: string | null;
  thumbnailUrl: string;
  status: string;
  enabled: boolean;
  funnelTemplateId: string | null;
  funnelAssignmentSource: 'manual' | 'automated' | null;
}
```

Also add `ShopifyMe`'s `stats` field gains `funnelConfigured: boolean` — update the existing `ShopifyStats` interface:

```ts
export interface ShopifyStats {
  totalTryOns: number;
  syncedProductCount: number;
  enabledProductCount: number;
  funnelConfigured: boolean;
}
```

In `apps/shopify/src/pages/ProductsPage.tsx`, add a funnel-templates fetch and a Funnel column. Update the imports:

```ts
import { useCallback, useEffect, useState } from 'react';
import { ImagePickerModal } from '../components/ImagePickerModal';
import { apiFetch } from '../lib/api';
import type { FunnelTemplateItem, ShopifyProductListItem } from '../types';
```

Add funnel-templates state and loading alongside the existing `items`/`error`/`loading` state:

```ts
  const [funnelTemplates, setFunnelTemplates] = useState<FunnelTemplateItem[]>([]);
```

In the existing `load` callback, also fetch funnel templates — replace:

```ts
  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: ShopifyProductListItem[] }>('/v1/shopify/products?pageSize=100')
      .then((data) => setItems(data.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);
```

with:

```ts
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ items: ShopifyProductListItem[] }>('/v1/shopify/products?pageSize=100'),
      apiFetch<{ items: FunnelTemplateItem[] }>('/v1/shopify/funnel-templates'),
    ])
      .then(([products, funnels]) => {
        setItems(products.items);
        setFunnelTemplates(funnels.items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);
```

Add a handler function alongside `toggleEnabled`/`selectImage`:

```ts
  async function setFunnel(shopifyProductId: number, funnelTemplateId: string | null) {
    setError(null);
    try {
      await apiFetch(`/v1/shopify/products/${shopifyProductId}/funnel`, {
        method: 'PATCH',
        body: JSON.stringify({ funnelTemplateId }),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
```

Add a heading and cell to the `IndexTable`. Update `headings`:

```tsx
        headings={[
          { title: 'Image' },
          { title: 'Title' },
          { title: 'Status' },
          { title: 'Try-on enabled' },
          { title: 'Funnel' },
        ]}
```

Add a new `<IndexTable.Cell>` after the existing "Try-on enabled" cell, inside the `items.map(...)` row:

```tsx
            <IndexTable.Cell>
              <select
                value={item.funnelTemplateId ?? ''}
                onChange={(e) => setFunnel(item.shopifyProductId, e.target.value || null)}
              >
                <option value="">Automated (no manual pin)</option>
                {funnelTemplates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </IndexTable.Cell>
```

- [ ] **Step 8: Add the 4th Dashboard checklist item**

In `apps/shopify/src/pages/DashboardPage.tsx`, find the existing `synced`/`enabled`/`themeBlockDone`/`doneCount` block and the three checklist `InlineStack` rows. Update to add a 4th item — replace:

```ts
  const synced = (me?.stats.syncedProductCount ?? 0) > 0;
  const enabled = (me?.stats.enabledProductCount ?? 0) > 0;
  const themeBlockDone = me?.store.settings.themeBlockConfirmed ?? false;
  const doneCount = [synced, enabled, themeBlockDone].filter(Boolean).length;
```

with:

```ts
  const synced = (me?.stats.syncedProductCount ?? 0) > 0;
  const enabled = (me?.stats.enabledProductCount ?? 0) > 0;
  const themeBlockDone = me?.store.settings.themeBlockConfirmed ?? false;
  const funnelConfigured = me?.stats.funnelConfigured ?? false;
  const doneCount = [synced, enabled, themeBlockDone, funnelConfigured].filter(Boolean).length;
```

Update the `Badge` denominator from `/3` to `/4`:

```tsx
                <Badge tone={doneCount === 4 ? 'success' : 'info'}>{`${doneCount}/4`}</Badge>
```

Add a 4th `InlineStack` row after the existing "Add the Try It On block to your theme" row, before the closing `</BlockStack>` of the Getting Started `Card`:

```tsx
              <InlineStack align="space-between">
                <Text as="p">
                  {funnelConfigured ? '✅' : '⭕'} Set up your funnel templates
                </Text>
                <Button onClick={() => navigate('/funnel-setup')}>Go to Funnel Setup</Button>
              </InlineStack>
```

- [ ] **Step 9: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/shopify/src/pages/ProductsPage.tsx apps/shopify/src/pages/DashboardPage.tsx apps/shopify/src/types.ts
git commit -m "feat(shopify-admin): funnel column on Products page + 4th dashboard checklist item"
```

- [ ] **Step 11: Manual verification against the real dev store**

No automated test applies to the frontend pieces. Verification:
1. Reload the embedded app — confirm a new "Funnel Setup" nav link appears.
2. On Funnel Setup, confirm at least one funnel template (created via the new admin-web page against your dev store's own `workflow_templates` rows) is listed, toggle it to Automated, add a condition (e.g. `product_type equals Shirts`), Save.
3. On Products, confirm the new Funnel column shows "Automated (no manual pin)" for a matching product after a re-sync, and that manually picking a different funnel template from the dropdown sticks (re-sync the store, confirm it doesn't revert).
4. On Dashboard, confirm the 4th checklist item flips to done once any product has a funnel assigned.
5. Click "Try It On" on a product whose funnel resolves to a real workflow template with valid ComfyUI node IDs — confirm the job actually reaches `GENERATING` (proving the dispatcher's new resolution chain picked up the funnel-resolved workflow, not a `NO_WORKFLOW_CONFIGURED` failure).
