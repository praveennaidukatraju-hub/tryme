# Kiosk demo catalog data Implementation Plan

> Companion plan: [`2026-07-30-android-google-signin-onboarding.md`](./2026-07-30-android-google-signin-onboarding.md) — independent, can be done before or after this one. Doing it first lets this plan's admin merchant picker show the `signupSource` badge.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins author demo products in the same shape as merchant products and choose which merchant accounts see them on the Android app, without the merchant being able to edit or delete them.

**Architecture:** Four new admin-owned tables (`demo_catalog_sets` → `demo_catalog_subcategories` → `demo_catalog_items`, plus `demo_catalog_assignments`) mirror the merchant catalog columns. The existing merchant read routes append assigned demo rows tagged `isDemo:true, readOnly:true` behind an `includeDemo` query param that defaults to true, so the Android app renders them with no client change. The try-on garment lookup is extracted into one resolver that falls back from merchant items to assigned demo items.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM / PostgreSQL 16, S3-compatible storage via `@tryme/storage`, Vitest, Vite + React for the admin panel.

## Global Constraints

- ESM only. Every relative import inside `apps/api/src` ends in `.js`.
- Demo content rows carry **no** `merchantId`. Visibility is only ever through `demo_catalog_assignments`.
- Demo rows are read-only to merchants. Merchant mutation routes must never touch demo tables.
- Wire shape for demo rows must be byte-compatible with `MerchantCatalogItem` / `MerchantCatalogSubcategory` (`packages/types/src/widget.ts:96,154`) plus the two extra booleans — the Android app parses those exact field names.
- `includeDemo` defaults to **true**. Parse it as a string enum, never `z.coerce.boolean()` (which turns `"false"` into `true`).
- Prices are stored in paise, returned in rupees, exactly as `serializeCatalogItem` does (`merchant/catalog.routes.ts:23-42`).
- Every R2 delete must be driven from rows selected **before** the DB cascade removes them.
- Log `adminUserId` + entity id + changed field keys on every admin mutation (audit-trail precedent in CLAUDE.md).
- Integration tests need `pnpm docker:up`. No testcontainers.
- Never run migrations against production.

## File Structure

**Create**
- `packages/db/src/schema/demo-catalog.ts` — the four tables.
- `packages/db/src/migrations/0134_demo_catalog.sql`
- `packages/types/src/demo-catalog.ts` — admin request bodies only. The merchant-facing response shape reuses the existing `MerchantCatalog*` schemas.
- `apps/api/src/modules/admin/demo-catalog.routes.ts` — all `/admin/demo-catalog/*` CRUD + assignments.
- `apps/api/src/modules/admin/demo-upload-guard.ts` — `assertDemoUploadKey`.
- `apps/api/src/modules/merchant/demo-catalog-read.ts` — the assigned-demo loaders + serializers. Imported by the merchant catalog routes and the kiosk catalog route.
- `apps/api/src/modules/merchant/resolve-tryon-garment.ts` — merchant-item-then-demo-item garment resolution, shared by the merchant and kiosk job routes.
- `apps/admin-web/src/pages/DemoCatalogPage.tsx`
- Tests: `apps/api/test/demo-catalog-admin.test.ts`, `demo-catalog-merchant.test.ts`, `demo-catalog-tryon.test.ts`

**Modify**
- `packages/db/src/schema/index.ts`, `packages/types/src/index.ts`, `packages/storage/src/keys.ts`
- `packages/types/src/widget.ts` — optional `isDemo` / `readOnly` on the two response schemas
- `apps/api/src/modules/merchant/catalog.routes.ts` — `includeDemo` on three read routes
- `apps/api/src/modules/merchant/tryon.routes.ts:116-216` — use the resolver
- `apps/api/src/modules/kiosk/jobs.routes.ts:156-185` — use the resolver
- `apps/api/src/modules/kiosk/catalog.routes.ts:41` — append demo items
- `apps/api/src/server.ts` — register the admin routes
- `apps/admin-web/src/App.tsx`, `apps/admin-web/src/components/Sidebar.tsx`
- `apps/catalogues-web/src/app/(app)/catalogue-manager/CatalogueManagerContent.tsx:54,72` and the equivalent reads under `apps/catalogues-web/src/app/tryon-library-app/`

---

### Task 1: Demo catalog schema, migration and storage keys

**Files:**
- Create: `packages/db/src/schema/demo-catalog.ts`, `packages/db/src/migrations/0134_demo_catalog.sql`
- Modify: `packages/db/src/schema/index.ts`, `packages/storage/src/keys.ts:1-16`
- Test: `apps/api/test/demo-catalog-admin.test.ts` (schema cases; route cases land in Task 2)

**Interfaces:**
- Consumes: `garmentSubcategories` (`packages/db/src/schema/models.ts`), `merchants`, `users`.
- Produces:
  - `schema.demoCatalogSets`, `schema.demoCatalogSubcategories`, `schema.demoCatalogItems`, `schema.demoCatalogAssignments`
  - `keys.demoCatalogItem(id: string): string`, `keys.demoCatalogItemThumb(id: string): string`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/demo-catalog-admin.test.ts` with the schema round-trip cases:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let garmentTypeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);

  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-gt-${randomUUID()}`,
      label: 'Demo Garment Type',
      isActive: true,
    })
    .returning();
  if (!gt) throw new Error('failed to seed garment type');
  garmentTypeId = gt.id;
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function seedSet() {
  const [set] = await app.db
    .insert(schema.demoCatalogSets)
    .values({ name: `Set ${randomUUID()}` })
    .returning();
  if (!set) throw new Error('failed to seed set');
  const [sub] = await app.db
    .insert(schema.demoCatalogSubcategories)
    .values({ setId: set.id, category: 'women', name: 'Sarees', garmentSubcategoryId: garmentTypeId })
    .returning();
  if (!sub) throw new Error('failed to seed subcategory');
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub.id,
      label: 'Demo Saree',
      actualPricePaise: 250000,
      offerPricePaise: 199000,
      r2Key: keys.demoCatalogItem(randomUUID()),
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
    })
    .returning();
  if (!item) throw new Error('failed to seed item');
  return { setId: set.id, subcategoryId: sub.id, itemId: item.id };
}

describe('demo catalog schema', () => {
  it('defaults a new set to active and a new item to active+approved', async () => {
    const { setId, itemId } = await seedSet();
    const [set] = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, setId));
    expect(set?.isActive).toBe(true);
    expect(set?.sortOrder).toBe(0);

    const [item] = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, itemId));
    expect(item?.isActive).toBe(true);
    expect(item?.sku).toBeNull();
  });

  it('cascades set deletion down to subcategories and items', async () => {
    const { setId, subcategoryId, itemId } = await seedSet();
    await app.db.delete(schema.demoCatalogSets).where(eq(schema.demoCatalogSets.id, setId));

    const subs = await app.db
      .select()
      .from(schema.demoCatalogSubcategories)
      .where(eq(schema.demoCatalogSubcategories.id, subcategoryId));
    const items = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, itemId));
    expect(subs).toHaveLength(0);
    expect(items).toHaveLength(0);
  });

  it('cascades merchant deletion down to assignments only', async () => {
    const { setId } = await seedSet();
    const merchant = await createTestMerchant(app);
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId, merchantId: merchant.merchantId });

    await app.db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.merchantId));

    const assignments = await app.db
      .select()
      .from(schema.demoCatalogAssignments)
      .where(eq(schema.demoCatalogAssignments.setId, setId));
    expect(assignments).toHaveLength(0);

    const sets = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, setId));
    expect(sets).toHaveLength(1);
  });

  it('rejects assigning the same set to the same merchant twice', async () => {
    const { setId } = await seedSet();
    const merchant = await createTestMerchant(app);
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId, merchantId: merchant.merchantId });
    await expect(
      app.db
        .insert(schema.demoCatalogAssignments)
        .values({ setId, merchantId: merchant.merchantId }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('storage keys', () => {
  it('namespaces demo objects under demo-catalog/', () => {
    expect(keys.demoCatalogItem('abc')).toBe('demo-catalog/abc/image.jpg');
    expect(keys.demoCatalogItemThumb('abc')).toBe('demo-catalog/abc/thumb.jpg');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: FAIL — `schema.demoCatalogSets` is undefined.

- [x] **Step 3: Write the schema**

Create `packages/db/src/schema/demo-catalog.ts`. Columns deliberately mirror
`merchantCatalogSubcategories` / `merchantCatalogItems` (`packages/db/src/schema/merchant.ts:42,99`)
so one serializer can emit either shape:

```ts
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { merchants } from './merchant.js';
import { garmentSubcategories } from './models.js';
import { users } from './users.js';

/**
 * Admin-authored demo catalogue content, shown on merchant devices without the
 * merchant owning or being able to edit it. Deliberately NOT merchant_catalog_*
 * rows with a flag: these have no merchantId at all, so no merchant query can
 * ever accidentally treat them as its own, and one R2 object serves every
 * assigned merchant instead of N copies.
 */
export const demoCatalogSets = pgTable('demo_catalog_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const demoCatalogSubcategories = pgTable(
  'demo_catalog_subcategories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => demoCatalogSets.id, { onDelete: 'cascade' }),
    category: text('category').notNull(), // 'men' | 'women' | 'boys' | 'girls'
    name: text('name').notNull(),
    // Drives the try-on workflow, exactly as it does for merchant subcategories:
    // garment_subcategories.tryonCategoryId -> tryon_categories.workflowTemplateId.
    garmentSubcategoryId: uuid('garment_subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_catalog_subcategories_set_idx').on(t.setId, t.category)],
);

export const demoCatalogItems = pgTable(
  'demo_catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => demoCatalogSubcategories.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    sku: text('sku'),
    actualPricePaise: integer('actual_price_paise').notNull().default(0),
    offerPricePaise: integer('offer_price_paise').notNull().default(0),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demo_catalog_items_subcategory_idx').on(t.subcategoryId, t.isActive)],
);

/** The only thing that makes a demo set visible to a merchant. */
export const demoCatalogAssignments = pgTable(
  'demo_catalog_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => demoCatalogSets.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('demo_catalog_assignments_set_merchant_unique').on(t.setId, t.merchantId),
    index('demo_catalog_assignments_merchant_idx').on(t.merchantId),
  ],
);
```

Add to `packages/db/src/schema/index.ts`, keeping alphabetical order (after `./credits.js`):

```ts
export * from './demo-catalog.js';
```

- [x] **Step 4: Add the storage keys**

In `packages/storage/src/keys.ts`, after `merchantCatalogFlatGarment` (line 11):

```ts
  // Not merchant-scoped: one demo object is shared by every assigned merchant.
  demoCatalogItem: (id: string) => `demo-catalog/${id}/image.jpg`,
  demoCatalogItemThumb: (id: string) => `demo-catalog/${id}/thumb.jpg`,
```

- [x] **Step 5: Generate and apply the migration**

```bash
pnpm db:generate
pnpm docker:up
pnpm db:migrate
```
Confirm the emitted file is `0134_*.sql` and appears in `packages/db/src/migrations/meta/_journal.json`.
If drizzle-kit picked a different index because `origin/main` moved, take the server's index as
canonical and renumber upward — never below.

- [x] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: PASS, 5 tests.

- [x] **Step 7: Commit**

```bash
git add packages/db/src/schema/demo-catalog.ts packages/db/src/schema/index.ts \
  packages/db/src/migrations packages/storage/src/keys.ts apps/api/test/demo-catalog-admin.test.ts
git commit -m "feat(db): add demo catalog tables and storage keys"
```

---

### Task 2: Admin CRUD for demo sets and subcategories

**Files:**
- Create: `apps/api/src/modules/admin/demo-catalog.routes.ts`, `packages/types/src/demo-catalog.ts`
- Modify: `packages/types/src/index.ts`, `apps/api/src/server.ts`
- Test: `apps/api/test/demo-catalog-admin.test.ts` (append)

**Interfaces:**
- Consumes: `schema.demoCatalog*` (Task 1); `requireAdmin` (`apps/api/src/modules/admin/guard.ts`).
- Produces:
  - Types: `DemoCatalogSetCreateBody`, `DemoCatalogSetUpdateBody`, `DemoCatalogSubcategoryCreateBody`, `DemoCatalogSubcategoryUpdateBody`
  - Routes: `GET|POST /admin/demo-catalog/sets`, `PATCH|DELETE /admin/demo-catalog/sets/:id`, `GET /admin/demo-catalog/sets/:id/subcategories`, `POST /admin/demo-catalog/subcategories`, `PATCH|DELETE /admin/demo-catalog/subcategories/:id`
  - `adminDemoCatalogRoutes(app: FastifyInstance): Promise<void>`

- [x] **Step 1: Write the failing test**

Append to `apps/api/test/demo-catalog-admin.test.ts`. Use the existing admin-token helper from
`./helpers/admin.js` — read that file first for its exact name and signature:

```ts
describe('admin demo set + subcategory routes', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await createAdminToken(app, 'SUPER_ADMIN'); // from ./helpers/admin.js
  });

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  it('creates, lists, patches and deletes a set', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Womens Showroom', description: 'Sales demo' },
    });
    expect(created.statusCode).toBe(201);
    const setId = created.json().id;

    const listed = await app.inject({
      method: 'GET',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
    });
    const row = listed.json().items.find((s: { id: string }) => s.id === setId);
    expect(row).toMatchObject({
      name: 'Womens Showroom',
      isActive: true,
      subcategoryCount: 0,
      productCount: 0,
      assignedMerchantCount: 0,
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
      payload: { isActive: false, name: 'Renamed' },
    });
    expect(patched.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
      payload: { name: 'x' },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects an empty patch body', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Empty patch target' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${created.json().id}`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates and lists subcategories under a set with product counts', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'With subs' },
    });
    const setId = set.json().id;

    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: { setId, category: 'women', name: 'Sarees', garmentSubcategoryId: garmentTypeId },
    });
    expect(created.statusCode).toBe(201);

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/subcategories`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({ name: 'Sarees', productCount: 0 });
  });

  it('404s a subcategory pointed at a set that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: randomUUID(),
        category: 'women',
        name: 'Orphan',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s an unknown category', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Bad category' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: set.json().id,
        category: 'aliens',
        name: 'Nope',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without a token and 403s a SUPPORT admin', async () => {
    const anon = await app.inject({ method: 'GET', url: '/admin/demo-catalog/sets' });
    expect(anon.statusCode).toBe(401);

    const supportToken = await createAdminToken(app, 'SUPPORT');
    const support = await app.inject({
      method: 'GET',
      url: '/admin/demo-catalog/sets',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(support.statusCode).toBe(403);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: FAIL — 404 on `/admin/demo-catalog/sets`.

- [x] **Step 3: Write the types**

Create `packages/types/src/demo-catalog.ts`:

```ts
import { z } from 'zod';
import { MerchantCatalogCategory } from './widget.js';

export const DemoCatalogSetCreateBody = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogSetCreateBody = z.infer<typeof DemoCatalogSetCreateBody>;

export const DemoCatalogSetUpdateBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogSetUpdateBody = z.infer<typeof DemoCatalogSetUpdateBody>;

export const DemoCatalogSubcategoryCreateBody = z.object({
  setId: z.string().uuid(),
  category: MerchantCatalogCategory,
  name: z.string().min(1).max(160),
  garmentSubcategoryId: z.string().uuid(),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogSubcategoryCreateBody = z.infer<typeof DemoCatalogSubcategoryCreateBody>;

export const DemoCatalogSubcategoryUpdateBody = z
  .object({
    category: MerchantCatalogCategory.optional(),
    name: z.string().min(1).max(160).optional(),
    garmentSubcategoryId: z.string().uuid().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogSubcategoryUpdateBody = z.infer<typeof DemoCatalogSubcategoryUpdateBody>;
```

Add `export * from './demo-catalog.js';` to `packages/types/src/index.ts` after `./credits.js`.

- [x] **Step 4: Write the routes**

Create `apps/api/src/modules/admin/demo-catalog.routes.ts`:

```ts
import { schema } from '@tryme/db';
import {
  DemoCatalogSetCreateBody,
  DemoCatalogSetUpdateBody,
  DemoCatalogSubcategoryCreateBody,
  DemoCatalogSubcategoryUpdateBody,
} from '@tryme/types';
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

export async function adminDemoCatalogRoutes(app: FastifyInstance) {
  // Same split as admin/catalogue-templates.routes.ts: RW for content editing,
  // D for destructive operations.
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const D = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const uuidParam = z.object({ id: z.string().uuid() });

  async function loadSet(id: string) {
    const [set] = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, id))
      .limit(1);
    if (!set) throw new AppError('NOT_FOUND', 404, 'demo set not found');
    return set;
  }

  app.get('/admin/demo-catalog/sets', { preHandler: RW }, async () => {
    const sets = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .orderBy(asc(schema.demoCatalogSets.sortOrder), desc(schema.demoCatalogSets.createdAt));
    if (sets.length === 0) return { items: [] };

    const setIds = sets.map((s) => s.id);
    // Three grouped aggregates rather than N+1 per set.
    const subRows = await app.db
      .select({
        setId: schema.demoCatalogSubcategories.setId,
        id: schema.demoCatalogSubcategories.id,
      })
      .from(schema.demoCatalogSubcategories)
      .where(inArray(schema.demoCatalogSubcategories.setId, setIds));

    const itemRows = subRows.length
      ? await app.db
          .select({
            subcategoryId: schema.demoCatalogItems.subcategoryId,
            n: count(),
          })
          .from(schema.demoCatalogItems)
          .where(
            inArray(
              schema.demoCatalogItems.subcategoryId,
              subRows.map((s) => s.id),
            ),
          )
          .groupBy(schema.demoCatalogItems.subcategoryId)
      : [];

    const assignmentRows = await app.db
      .select({ setId: schema.demoCatalogAssignments.setId, n: count() })
      .from(schema.demoCatalogAssignments)
      .where(inArray(schema.demoCatalogAssignments.setId, setIds))
      .groupBy(schema.demoCatalogAssignments.setId);

    const itemsBySub = new Map(itemRows.map((r) => [r.subcategoryId, Number(r.n)]));
    const assignedBySet = new Map(assignmentRows.map((r) => [r.setId, Number(r.n)]));
    const subsBySet = new Map<string, string[]>();
    for (const row of subRows) {
      subsBySet.set(row.setId, [...(subsBySet.get(row.setId) ?? []), row.id]);
    }

    return {
      items: sets.map((set) => {
        const subIds = subsBySet.get(set.id) ?? [];
        return {
          ...set,
          subcategoryCount: subIds.length,
          productCount: subIds.reduce((sum, id) => sum + (itemsBySub.get(id) ?? 0), 0),
          assignedMerchantCount: assignedBySet.get(set.id) ?? 0,
        };
      }),
    };
  });

  app.post(
    '/admin/demo-catalog/sets',
    { preHandler: RW, schema: { body: DemoCatalogSetCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogSetCreateBody>;
      const [row] = await app.db
        .insert(schema.demoCatalogSets)
        .values({
          name: body.name,
          description: body.description ?? null,
          sortOrder: body.sortOrder ?? 0,
          createdByUserId: req.userId,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo set');
      app.log.info({ adminUserId: req.userId, demoSetId: row.id }, 'demo set created');
      reply.code(201);
      return row;
    },
  );

  app.patch(
    '/admin/demo-catalog/sets/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogSetUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogSetUpdateBody>;
      await loadSet(id);
      const [updated] = await app.db
        .update(schema.demoCatalogSets)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.demoCatalogSets.id, id))
        .returning();
      app.log.info(
        { adminUserId: req.userId, demoSetId: id, fields: Object.keys(body) },
        'demo set updated',
      );
      return updated;
    },
  );

  app.delete(
    '/admin/demo-catalog/sets/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await loadSet(id);

      // Select the R2 keys BEFORE the cascade removes the rows — the FK cascade
      // knows nothing about object storage.
      const orphaned = await app.db
        .select({
          r2Key: schema.demoCatalogItems.r2Key,
          thumbnailKey: schema.demoCatalogItems.thumbnailKey,
        })
        .from(schema.demoCatalogItems)
        .innerJoin(
          schema.demoCatalogSubcategories,
          eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
        )
        .where(eq(schema.demoCatalogSubcategories.setId, id));

      await app.db.delete(schema.demoCatalogSets).where(eq(schema.demoCatalogSets.id, id));
      await Promise.allSettled(
        orphaned.flatMap((row) => [
          app.storage.deleteObject(row.r2Key),
          app.storage.deleteObject(row.thumbnailKey),
        ]),
      );

      app.log.info(
        { adminUserId: req.userId, demoSetId: id, deletedObjects: orphaned.length * 2 },
        'demo set deleted',
      );
      reply.code(204);
      return reply.send();
    },
  );

  app.get(
    '/admin/demo-catalog/sets/:id/subcategories',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await loadSet(id);

      const rows = await app.db
        .select()
        .from(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.setId, id))
        .orderBy(
          asc(schema.demoCatalogSubcategories.sortOrder),
          desc(schema.demoCatalogSubcategories.createdAt),
        );
      if (rows.length === 0) return { items: [] };

      const counts = await app.db
        .select({ subcategoryId: schema.demoCatalogItems.subcategoryId, n: count() })
        .from(schema.demoCatalogItems)
        .where(
          inArray(
            schema.demoCatalogItems.subcategoryId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(schema.demoCatalogItems.subcategoryId);
      const byId = new Map(counts.map((r) => [r.subcategoryId, Number(r.n)]));

      return { items: rows.map((row) => ({ ...row, productCount: byId.get(row.id) ?? 0 })) };
    },
  );

  app.post(
    '/admin/demo-catalog/subcategories',
    { preHandler: RW, schema: { body: DemoCatalogSubcategoryCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogSubcategoryCreateBody>;
      await loadSet(body.setId);

      const [garmentType] = await app.db
        .select({ id: schema.garmentSubcategories.id })
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, body.garmentSubcategoryId))
        .limit(1);
      if (!garmentType) throw new AppError('NOT_FOUND', 404, 'garment type not found');

      const [row] = await app.db
        .insert(schema.demoCatalogSubcategories)
        .values({
          setId: body.setId,
          category: body.category,
          name: body.name,
          garmentSubcategoryId: body.garmentSubcategoryId,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo subcategory');
      app.log.info(
        { adminUserId: req.userId, demoSetId: body.setId, demoSubcategoryId: row.id },
        'demo subcategory created',
      );
      reply.code(201);
      return row;
    },
  );

  app.patch(
    '/admin/demo-catalog/subcategories/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogSubcategoryUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogSubcategoryUpdateBody>;
      const [updated] = await app.db
        .update(schema.demoCatalogSubcategories)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.demoCatalogSubcategories.id, id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');
      app.log.info(
        { adminUserId: req.userId, demoSubcategoryId: id, fields: Object.keys(body) },
        'demo subcategory updated',
      );
      return updated;
    },
  );

  app.delete(
    '/admin/demo-catalog/subcategories/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const orphaned = await app.db
        .select({
          r2Key: schema.demoCatalogItems.r2Key,
          thumbnailKey: schema.demoCatalogItems.thumbnailKey,
        })
        .from(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.subcategoryId, id));

      const [deleted] = await app.db
        .delete(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.id, id))
        .returning();
      if (!deleted) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');

      await Promise.allSettled(
        orphaned.flatMap((row) => [
          app.storage.deleteObject(row.r2Key),
          app.storage.deleteObject(row.thumbnailKey),
        ]),
      );
      app.log.info(
        { adminUserId: req.userId, demoSubcategoryId: id, deletedObjects: orphaned.length * 2 },
        'demo subcategory deleted',
      );
      reply.code(204);
      return reply.send();
    },
  );
}
```

Register in `apps/api/src/server.ts` next to `adminMerchantCatalogRoutes` (line 314):

```ts
  await app.register(adminDemoCatalogRoutes);
```
plus the import alongside the other admin imports.

`requireAdmin` sets `req.userId` — confirm that in `apps/api/src/modules/admin/guard.ts` before
relying on it for the audit logs; if it uses a different property name, use that one.

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: PASS, 11 tests.

- [x] **Step 6: Commit**

```bash
git add packages/types/src/demo-catalog.ts packages/types/src/index.ts \
  apps/api/src/modules/admin/demo-catalog.routes.ts apps/api/src/server.ts \
  apps/api/test/demo-catalog-admin.test.ts
git commit -m "feat(admin): CRUD for demo catalog sets and subcategories"
```

---

### Task 3: Admin demo product upload and CRUD

**Files:**
- Create: `apps/api/src/modules/admin/demo-upload-guard.ts`
- Modify: `apps/api/src/modules/admin/demo-catalog.routes.ts`, `packages/types/src/demo-catalog.ts`
- Test: `apps/api/test/demo-catalog-admin.test.ts` (append)

**Interfaces:**
- Consumes: `keys.demoCatalogItem` / `keys.demoCatalogItemThumb` (Task 1); `getUploadLimitBytes` (`apps/api/src/lib/upload-limits-config.ts`).
- Produces:
  - Types: `DemoCatalogPresignBody`, `DemoCatalogItemCreateBody`, `DemoCatalogItemUpdateBody`
  - `assertDemoUploadKey(app, adminUserId, key, label): Promise<void>`
  - Routes: `POST /admin/demo-catalog/presign`, `GET /admin/demo-catalog/items`, `POST /admin/demo-catalog/items`, `PATCH|DELETE /admin/demo-catalog/items/:id`

- [x] **Step 1: Write the failing test**

Append to `apps/api/test/demo-catalog-admin.test.ts`. Uploading real bytes to the test MinIO bucket
is what makes `assertDemoUploadKey` meaningful, so do the PUT for real:

```ts
describe('admin demo item routes', () => {
  let adminToken: string;
  let subcategoryId: string;

  beforeAll(async () => {
    adminToken = await createAdminToken(app, 'SUPER_ADMIN');
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Items set' },
    });
    const sub = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        setId: set.json().id,
        category: 'women',
        name: 'Sarees',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    subcategoryId = sub.json().id;
  });

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  /** Presigns, PUTs a real 1x1 JPEG, and returns the key. */
  async function uploadAsset(kind: 'image' | 'thumbnail') {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/presign',
      headers: auth(),
      payload: { kind, contentType: 'image/jpeg', contentLength: JPEG_1X1.length },
    });
    expect(res.statusCode).toBe(200);
    const { uploadUrl, r2Key } = res.json();
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: JPEG_1X1,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(put.ok).toBe(true);
    return r2Key as string;
  }

  it('creates an item from uploaded assets and returns rupee prices', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([uploadAsset('image'), uploadAsset('thumbnail')]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Red Saree',
        sku: 'DEMO-1',
        actualPrice: 2500,
        offerPrice: 1990,
        r2Key,
        thumbnailKey,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      label: 'Red Saree',
      sku: 'DEMO-1',
      actualPrice: 2500,
      offerPrice: 1990,
    });
    expect(res.json().imageUrl).toContain('demo-catalog/');
  });

  it('lists items for a subcategory and filters by search', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/items?subcategoryId=${subcategoryId}&search=DEMO-1`,
      headers: auth(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const miss = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/items?subcategoryId=${subcategoryId}&search=nothing-matches`,
      headers: auth(),
    });
    expect(miss.json().items).toHaveLength(0);
  });

  it('patches prices and active flag', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([uploadAsset('image'), uploadAsset('thumbnail')]);
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Patch me',
        actualPrice: 100,
        offerPrice: 90,
        r2Key,
        thumbnailKey,
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/items/${created.json().id}`,
      headers: auth(),
      payload: { offerPrice: 50, isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ offerPrice: 50, isActive: false, actualPrice: 100 });
  });

  it('deletes an item and its objects', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([uploadAsset('image'), uploadAsset('thumbnail')]);
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Delete me',
        actualPrice: 10,
        offerPrice: 10,
        r2Key,
        thumbnailKey,
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/items/${created.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await expect(app.storage.headObject(r2Key)).rejects.toThrow();
  });

  it('rejects a key outside demo-catalog/', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Bad key',
        actualPrice: 10,
        offerPrice: 10,
        r2Key: 'merchant-catalog/somebody/else/image.jpg',
        thumbnailKey: 'merchant-catalog/somebody/else/thumb.jpg',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an item pointed at a subcategory that does not exist', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([uploadAsset('image'), uploadAsset('thumbnail')]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId: randomUUID(),
        label: 'Orphan',
        actualPrice: 10,
        offerPrice: 10,
        r2Key,
        thumbnailKey,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

Add at the top of the file, next to the other imports:

```ts
// Smallest valid JPEG — enough for a real PUT and a real headObject content-type check.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/2gAMAwEAAhADEAAAAT8A/9k=',
  'base64',
);
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: FAIL — 404 on `/admin/demo-catalog/presign`.

- [x] **Step 3: Add the item types**

Append to `packages/types/src/demo-catalog.ts`:

```ts
export const DemoCatalogPresignBody = z.object({
  assetId: z.string().uuid().optional(),
  kind: z.enum(['image', 'thumbnail']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
export type DemoCatalogPresignBody = z.infer<typeof DemoCatalogPresignBody>;

export const DemoCatalogItemCreateBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(200),
  sku: z.string().max(120).optional(),
  actualPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  offerPrice: z.number().int().min(0),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogItemCreateBody = z.infer<typeof DemoCatalogItemCreateBody>;

export const DemoCatalogItemUpdateBody = z
  .object({
    subcategoryId: z.string().uuid().optional(),
    label: z.string().min(1).max(200).optional(),
    sku: z.string().max(120).nullable().optional(),
    actualPrice: z.number().int().min(0).optional(),
    offerPrice: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogItemUpdateBody = z.infer<typeof DemoCatalogItemUpdateBody>;
```

- [x] **Step 4: Write the upload guard**

Create `apps/api/src/modules/admin/demo-upload-guard.ts`, mirroring
`apps/api/src/modules/merchant/upload-guard.ts:7`:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';

const DEMO_CATALOG_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Demo objects are not merchant-scoped, so the prefix check is a flat
 * `demo-catalog/` rather than a per-owner path. The Redis ownership marker still
 * pins the key to the admin who presigned it, which is what stops an arbitrary
 * `demo-catalog/...` string being accepted.
 */
export async function assertDemoUploadKey(
  app: FastifyInstance,
  adminUserId: string,
  key: string,
  label: string,
) {
  if (!key.startsWith('demo-catalog/')) {
    throw new AppError('FORBIDDEN', 403, `${label} key is not a demo catalog key`);
  }

  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== `admin:${adminUserId}`) {
    throw new AppError('FORBIDDEN', 403, `${label} upload session expired or not owned`);
  }

  let head: { contentLength: number; contentType: string | null };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, `${label} not found`);
  }

  const maxBytes = await getUploadLimitBytes(app, 'merchantCatalogMaxBytes');
  if (head.contentLength > maxBytes) {
    throw new AppError('BAD_UPLOAD', 413, `${label} exceeds ${maxBytes / (1024 * 1024)}MB limit`);
  }
  if (!head.contentType || !DEMO_CATALOG_CONTENT_TYPES.has(head.contentType)) {
    throw new AppError('BAD_UPLOAD', 400, `${label} must be jpeg, png, or webp`);
  }
}
```

- [x] **Step 5: Add the item routes**

In `apps/api/src/modules/admin/demo-catalog.routes.ts`, add imports:

```ts
import { randomUUID } from 'node:crypto';
import { keys } from '@tryme/storage';
import {
  DemoCatalogItemCreateBody,
  DemoCatalogItemUpdateBody,
  DemoCatalogPresignBody,
} from '@tryme/types';
import { and, ilike, or, type SQL } from 'drizzle-orm';
import { assertDemoUploadKey } from './demo-upload-guard.js';
```

and inside `adminDemoCatalogRoutes`:

```ts
  type DemoItemRow = typeof schema.demoCatalogItems.$inferSelect;

  // Identical field set and paise->rupee conversion to the merchant serializer
  // (merchant/catalog.routes.ts:23) so the admin grid and the app agree.
  async function serializeItem(item: DemoItemRow) {
    const [imageUrl, thumbnailUrl] = await Promise.all([
      app.storage
        .presignGet(item.r2Key, 3600)
        .then((r) => r.url)
        .catch(() => null),
      app.storage
        .presignGet(item.thumbnailKey, 3600)
        .then((r) => r.url)
        .catch(() => null),
    ]);
    return {
      ...item,
      actualPrice: Math.round(item.actualPricePaise / 100),
      offerPrice: Math.round(item.offerPricePaise / 100),
      imageUrl,
      thumbnailUrl,
    };
  }

  app.post(
    '/admin/demo-catalog/presign',
    { preHandler: RW, schema: { body: DemoCatalogPresignBody } },
    async (req) => {
      const {
        assetId = randomUUID(),
        kind,
        contentType,
        contentLength,
      } = req.body as z.infer<typeof DemoCatalogPresignBody>;
      const key =
        kind === 'thumbnail' ? keys.demoCatalogItemThumb(assetId) : keys.demoCatalogItem(assetId);
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`upload:owner:${key}`, `admin:${req.userId}`, 'EX', 600);
      return { assetId, uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.get('/admin/demo-catalog/items', { preHandler: RW }, async (req) => {
    const { subcategoryId, search = '' } = req.query as {
      subcategoryId?: string;
      search?: string;
    };
    const conditions: (SQL | undefined)[] = [];
    if (subcategoryId) {
      conditions.push(eq(schema.demoCatalogItems.subcategoryId, subcategoryId));
    }
    if (search.trim()) {
      const pattern = `%${search.trim()}%`;
      conditions.push(
        or(ilike(schema.demoCatalogItems.label, pattern), ilike(schema.demoCatalogItems.sku, pattern)),
      );
    }

    const rows = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.demoCatalogItems.sortOrder), desc(schema.demoCatalogItems.createdAt));

    return { items: await Promise.all(rows.map(serializeItem)) };
  });

  app.post(
    '/admin/demo-catalog/items',
    { preHandler: RW, schema: { body: DemoCatalogItemCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogItemCreateBody>;

      const [subcategory] = await app.db
        .select({ id: schema.demoCatalogSubcategories.id })
        .from(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.id, body.subcategoryId))
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');

      await Promise.all([
        assertDemoUploadKey(app, req.userId, body.r2Key, 'image'),
        assertDemoUploadKey(app, req.userId, body.thumbnailKey, 'thumbnail'),
      ]);

      const [row] = await app.db
        .insert(schema.demoCatalogItems)
        .values({
          subcategoryId: body.subcategoryId,
          label: body.label,
          sku: body.sku?.trim() || null,
          actualPricePaise: body.actualPrice * 100,
          offerPricePaise: body.offerPrice * 100,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo item');

      app.log.info(
        { adminUserId: req.userId, demoItemId: row.id, demoSubcategoryId: body.subcategoryId },
        'demo item created',
      );
      reply.code(201);
      return serializeItem(row);
    },
  );

  app.patch(
    '/admin/demo-catalog/items/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogItemUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogItemUpdateBody>;

      const [updated] = await app.db
        .update(schema.demoCatalogItems)
        .set({
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sku !== undefined ? { sku: body.sku?.trim() || null } : {}),
          ...(body.actualPrice !== undefined ? { actualPricePaise: body.actualPrice * 100 } : {}),
          ...(body.offerPrice !== undefined ? { offerPricePaise: body.offerPrice * 100 } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.demoCatalogItems.id, id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', 404, 'demo item not found');

      app.log.info(
        { adminUserId: req.userId, demoItemId: id, fields: Object.keys(body) },
        'demo item updated',
      );
      return serializeItem(updated);
    },
  );

  app.delete(
    '/admin/demo-catalog/items/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [deleted] = await app.db
        .delete(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.id, id))
        .returning();
      if (!deleted) throw new AppError('NOT_FOUND', 404, 'demo item not found');

      await Promise.allSettled([
        app.storage.deleteObject(deleted.r2Key),
        app.storage.deleteObject(deleted.thumbnailKey),
      ]);
      app.log.info({ adminUserId: req.userId, demoItemId: id }, 'demo item deleted');
      reply.code(204);
      return reply.send();
    },
  );
```

- [x] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: PASS, 18 tests.

- [x] **Step 7: Commit**

```bash
git add packages/types/src/demo-catalog.ts apps/api/src/modules/admin/demo-upload-guard.ts \
  apps/api/src/modules/admin/demo-catalog.routes.ts apps/api/test/demo-catalog-admin.test.ts
git commit -m "feat(admin): upload and manage demo catalog products"
```

---

### Task 4: Demo set assignments

**Files:**
- Modify: `apps/api/src/modules/admin/demo-catalog.routes.ts`, `packages/types/src/demo-catalog.ts`
- Test: `apps/api/test/demo-catalog-admin.test.ts` (append)

**Interfaces:**
- Consumes: `schema.demoCatalogAssignments` (Task 1); `loadSet` (Task 2).
- Produces:
  - Type: `DemoCatalogAssignmentsPutBody` (`{ merchantIds: string[] }`)
  - Routes: `GET /admin/demo-catalog/sets/:id/assignments`, `PUT /admin/demo-catalog/sets/:id/assignments`

- [x] **Step 1: Write the failing test**

Append to `apps/api/test/demo-catalog-admin.test.ts`:

```ts
describe('admin demo set assignments', () => {
  let adminToken: string;
  let setId: string;

  beforeAll(async () => {
    adminToken = await createAdminToken(app, 'SUPER_ADMIN');
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Assignable' },
    });
    setId = set.json().id;
  });

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  it('replaces the assignment list wholesale and is idempotent', async () => {
    const a = await createTestMerchant(app);
    const b = await createTestMerchant(app);

    const first = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId, b.merchantId] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().assignedMerchantCount).toBe(2);

    const again = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId, b.merchantId] },
    });
    expect(again.json().assignedMerchantCount).toBe(2);

    const shrunk = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [b.merchantId] },
    });
    expect(shrunk.json().assignedMerchantCount).toBe(1);

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({ merchantId: b.merchantId, companyName: 'Test Co' });
  });

  it('clears every assignment on an empty list', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [] },
    });
    expect(res.json().assignedMerchantCount).toBe(0);
  });

  it('404s an unknown merchant id and changes nothing', async () => {
    const a = await createTestMerchant(app);
    await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId] },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [randomUUID()] },
    });
    expect(res.statusCode).toBe(404);

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
  });

  it('404s an unknown set id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${randomUUID()}/assignments`,
      headers: auth(),
      payload: { merchantIds: [] },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: FAIL — 404 on the assignments route.

- [x] **Step 3: Add the type**

Append to `packages/types/src/demo-catalog.ts`:

```ts
// Full replace, not add/remove: the admin UI edits a multi-select and saves the
// whole list, so a partial API would require the client to diff.
export const DemoCatalogAssignmentsPutBody = z.object({
  merchantIds: z.array(z.string().uuid()).max(500),
});
export type DemoCatalogAssignmentsPutBody = z.infer<typeof DemoCatalogAssignmentsPutBody>;
```

- [x] **Step 4: Add the routes**

In `apps/api/src/modules/admin/demo-catalog.routes.ts`, import
`DemoCatalogAssignmentsPutBody` and add:

```ts
  app.get(
    '/admin/demo-catalog/sets/:id/assignments',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await loadSet(id);

      const rows = await app.db
        .select({
          merchantId: schema.merchants.id,
          companyName: schema.merchants.companyName,
          isActive: schema.merchants.isActive,
          assignedAt: schema.demoCatalogAssignments.createdAt,
        })
        .from(schema.demoCatalogAssignments)
        .innerJoin(
          schema.merchants,
          eq(schema.merchants.id, schema.demoCatalogAssignments.merchantId),
        )
        .where(eq(schema.demoCatalogAssignments.setId, id))
        .orderBy(asc(schema.merchants.companyName));

      return { items: rows };
    },
  );

  app.put(
    '/admin/demo-catalog/sets/:id/assignments',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogAssignmentsPutBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { merchantIds } = req.body as z.infer<typeof DemoCatalogAssignmentsPutBody>;
      await loadSet(id);

      const unique = [...new Set(merchantIds)];
      if (unique.length > 0) {
        // Validate before writing so a typo'd id cannot half-apply the change.
        const found = await app.db
          .select({ id: schema.merchants.id })
          .from(schema.merchants)
          .where(inArray(schema.merchants.id, unique));
        if (found.length !== unique.length) {
          throw new AppError('NOT_FOUND', 404, 'one or more merchants not found');
        }
      }

      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.demoCatalogAssignments)
          .where(eq(schema.demoCatalogAssignments.setId, id));
        if (unique.length > 0) {
          await tx.insert(schema.demoCatalogAssignments).values(
            unique.map((merchantId) => ({
              setId: id,
              merchantId,
              assignedByUserId: req.userId,
            })),
          );
        }
      });

      app.log.info(
        { adminUserId: req.userId, demoSetId: id, merchantCount: unique.length },
        'demo set assignments replaced',
      );
      return { assignedMerchantCount: unique.length };
    },
  );
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- demo-catalog-admin`
Expected: PASS, 22 tests.

- [x] **Step 6: Commit**

```bash
git add packages/types/src/demo-catalog.ts apps/api/src/modules/admin/demo-catalog.routes.ts apps/api/test/demo-catalog-admin.test.ts
git commit -m "feat(admin): assign demo catalog sets to merchants"
```

---

### Task 5: Merchant read path — assigned demo rows

**Files:**
- Create: `apps/api/src/modules/merchant/demo-catalog-read.ts`
- Modify: `packages/types/src/widget.ts:96-172`, `apps/api/src/modules/merchant/catalog.routes.ts:137,171,436`
- Test: `apps/api/test/demo-catalog-merchant.test.ts`

**Interfaces:**
- Consumes: `schema.demoCatalog*` (Task 1).
- Produces:
  - `IncludeDemoQuery` (zod, in `demo-catalog-read.ts`)
  - `loadDemoSubcategories(app, merchantId, opts: { category?: string; mannequinOnly?: boolean }): Promise<SerializedDemoSubcategory[]>`
  - `loadDemoItems(app, merchantId, opts: { subcategoryId?: string; search?: string }): Promise<SerializedDemoItem[]>`
  - `isDemo` / `readOnly` optional booleans on `MerchantCatalogItem` and `MerchantCatalogSubcategory`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/demo-catalog-merchant.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let garmentTypeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-read-gt-${randomUUID()}`,
      label: 'Demo Read Garment Type',
      isActive: true,
    })
    .returning();
  if (!gt) throw new Error('failed to seed garment type');
  garmentTypeId = gt.id;
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function merchantToken(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function seedDemoSet(opts: { setActive?: boolean; itemActive?: boolean; category?: string } = {}) {
  const [set] = await app.db
    .insert(schema.demoCatalogSets)
    .values({ name: `Set ${randomUUID()}`, isActive: opts.setActive ?? true })
    .returning();
  const [sub] = await app.db
    .insert(schema.demoCatalogSubcategories)
    .values({
      setId: set!.id,
      category: opts.category ?? 'women',
      name: 'Demo Sarees',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub!.id,
      label: 'Demo Product',
      sku: 'DEMO-SKU',
      actualPricePaise: 250000,
      offerPricePaise: 199000,
      r2Key: keys.demoCatalogItem(randomUUID()),
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      isActive: opts.itemActive ?? true,
    })
    .returning();
  return { setId: set!.id, subcategoryId: sub!.id, itemId: item!.id };
}

async function assign(setId: string, merchantId: string) {
  await app.db.insert(schema.demoCatalogAssignments).values({ setId, merchantId });
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('merchant catalog reads with demo data', () => {
  it('includes assigned demo rows by default, tagged isDemo and readOnly', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    const subs = await get('/v1/merchant/catalog/subcategories', token);
    expect(subs.statusCode).toBe(200);
    const sub = subs.json().items.find((s: { id: string }) => s.id === demo.subcategoryId);
    expect(sub).toMatchObject({
      name: 'Demo Sarees',
      category: 'women',
      garmentSubcategoryId: garmentTypeId,
      merchantId: merchant.merchantId,
      productCount: 1,
      isDemo: true,
      readOnly: true,
    });

    const items = await get('/v1/merchant/catalog', token);
    const item = items.json().items.find((i: { id: string }) => i.id === demo.itemId);
    expect(item).toMatchObject({
      label: 'Demo Product',
      sku: 'DEMO-SKU',
      subcategoryId: demo.subcategoryId,
      merchantId: merchant.merchantId,
      actualPrice: 2500,
      offerPrice: 1990,
      sourceKind: 'uploaded',
      moderationStatus: 'approved',
      sourceJobId: null,
      flatSourceKey: null,
      isDemo: true,
      readOnly: true,
    });
    expect(item.imageUrl).toContain('demo-catalog/');
  });

  it('hides demo rows from an unassigned merchant', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    await seedDemoSet();

    expect((await get('/v1/merchant/catalog/subcategories', token)).json().items).toEqual([]);
    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('drops demo rows again when the set is unassigned', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);
    expect((await get('/v1/merchant/catalog', token)).json().items).toHaveLength(1);

    await app.db
      .delete(schema.demoCatalogAssignments)
      .where(eq(schema.demoCatalogAssignments.setId, demo.setId));
    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('excludes demo rows when includeDemo=false', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    expect(
      (await get('/v1/merchant/catalog/subcategories?includeDemo=false', token)).json().items,
    ).toEqual([]);
    expect((await get('/v1/merchant/catalog?includeDemo=false', token)).json().items).toEqual([]);
    // Guard against z.coerce.boolean(), which turns "false" into true.
    expect((await get('/v1/merchant/catalog?includeDemo=true', token)).json().items).toHaveLength(1);
  });

  it('hides an inactive set and an inactive item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);

    const inactiveSet = await seedDemoSet({ setActive: false });
    await assign(inactiveSet.setId, merchant.merchantId);
    const inactiveItem = await seedDemoSet({ itemActive: false });
    await assign(inactiveItem.setId, merchant.merchantId);

    const subs = (await get('/v1/merchant/catalog/subcategories', token)).json().items;
    expect(subs.map((s: { id: string }) => s.id)).not.toContain(inactiveSet.subcategoryId);
    // The subcategory of the active set is still listed, but with zero products.
    const stillListed = subs.find((s: { id: string }) => s.id === inactiveItem.subcategoryId);
    expect(stillListed?.productCount).toBe(0);

    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('applies the category filter to demo subcategories', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const women = await seedDemoSet({ category: 'women' });
    const men = await seedDemoSet({ category: 'men' });
    await assign(women.setId, merchant.merchantId);
    await assign(men.setId, merchant.merchantId);

    const ids = (await get('/v1/merchant/catalog/subcategories?category=women', token))
      .json()
      .items.map((s: { id: string }) => s.id);
    expect(ids).toContain(women.subcategoryId);
    expect(ids).not.toContain(men.subcategoryId);
  });

  it('applies subcategoryId and search filters to demo items', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const a = await seedDemoSet();
    const b = await seedDemoSet();
    await assign(a.setId, merchant.merchantId);
    await assign(b.setId, merchant.merchantId);

    const scoped = await get(`/v1/merchant/catalog?subcategoryId=${a.subcategoryId}`, token);
    expect(scoped.json().items).toHaveLength(1);
    expect(scoped.json().items[0].id).toBe(a.itemId);

    expect((await get('/v1/merchant/catalog?search=DEMO-SKU', token)).json().items).toHaveLength(2);
    expect((await get('/v1/merchant/catalog?search=no-such-thing', token)).json().items).toEqual([]);
  });

  it('sorts the merchant\'s own products before demo products', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const [ownSub] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.merchantId,
        category: 'women',
        name: 'My Sarees',
        garmentSubcategoryId: garmentTypeId,
      })
      .returning();
    await app.db.insert(schema.merchantCatalogItems).values({
      merchantId: merchant.merchantId,
      subcategoryId: ownSub!.id,
      label: 'My Product',
      actualPricePaise: 100,
      offerPricePaise: 100,
      r2Key: keys.merchantCatalogItem(merchant.merchantId, randomUUID()),
      thumbnailKey: keys.merchantCatalogItemThumb(merchant.merchantId, randomUUID()),
    });
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    const items = (await get('/v1/merchant/catalog', token)).json().items;
    expect(items[0].isDemo).toBeFalsy();
    expect(items.at(-1).isDemo).toBe(true);
  });

  it('404s a merchant mutation aimed at a demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);
    const headers = { authorization: `Bearer ${token}` };

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${demo.itemId}`,
      headers,
      payload: { label: 'hijacked' },
    });
    expect(patched.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/${demo.itemId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(404);

    const subDeleted = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/subcategories/${demo.subcategoryId}`,
      headers,
    });
    expect(subDeleted.statusCode).toBe(404);

    // And the row is untouched.
    const [row] = await app.db
      .select({ label: schema.demoCatalogItems.label })
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, demo.itemId));
    expect(row?.label).toBe('Demo Product');
  });
});
```

`presignGet` against MinIO works without the object existing, so these tests do not need to PUT
bytes — only Task 3's guard tests do.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-merchant`
Expected: FAIL — the first assertion finds no demo subcategory in the response.

- [x] **Step 3: Add the two optional response fields**

In `packages/types/src/widget.ts`, add to **both** `MerchantCatalogItem` (line 96) and
`MerchantCatalogSubcategory` (line 154):

```ts
  // Present and true only for admin-authored demo rows appended by the demo
  // catalog reader. Absent on the merchant's own rows.
  isDemo: z.boolean().optional(),
  readOnly: z.boolean().optional(),
```

- [x] **Step 4: Write the reader**

Create `apps/api/src/modules/merchant/demo-catalog-read.ts`:

```ts
import { schema } from '@tryme/db';
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Defaults to true so the Android app picks demo data up with no client change.
 * Parsed as a string enum on purpose: z.coerce.boolean() maps the string "false"
 * to true, which would make ?includeDemo=false a silent no-op.
 */
export const IncludeDemoQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value !== 'false');

type DemoSubcategoryRow = typeof schema.demoCatalogSubcategories.$inferSelect;
type DemoItemRow = typeof schema.demoCatalogItems.$inferSelect;

/** Subquery-free base filter: only sets assigned to this merchant and still active. */
function assignedSetFilter(merchantId: string): SQL | undefined {
  return and(
    eq(schema.demoCatalogAssignments.merchantId, merchantId),
    eq(schema.demoCatalogSets.isActive, true),
  );
}

export async function loadDemoSubcategories(
  app: FastifyInstance,
  merchantId: string,
  opts: { category?: string; mannequinOnly?: boolean } = {},
) {
  const conditions: (SQL | undefined)[] = [assignedSetFilter(merchantId)];
  if (opts.category) {
    conditions.push(eq(schema.demoCatalogSubcategories.category, opts.category));
  }
  if (opts.mannequinOnly) {
    conditions.push(eq(schema.garmentSubcategories.requiresMannequinStep, true));
  }

  let query = app.db
    .select({ sub: schema.demoCatalogSubcategories })
    .from(schema.demoCatalogSubcategories)
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    .innerJoin(
      schema.demoCatalogAssignments,
      eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
    )
    .$dynamic();

  if (opts.mannequinOnly) {
    query = query.innerJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.demoCatalogSubcategories.garmentSubcategoryId),
    );
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(
      asc(schema.demoCatalogSubcategories.sortOrder),
      desc(schema.demoCatalogSubcategories.createdAt),
    );

  if (rows.length === 0) return [];

  // Only active items count, matching what loadDemoItems will actually return.
  const counts = await app.db
    .select({ subcategoryId: schema.demoCatalogItems.subcategoryId, n: count() })
    .from(schema.demoCatalogItems)
    .where(
      and(
        inArray(
          schema.demoCatalogItems.subcategoryId,
          rows.map((r) => r.sub.id),
        ),
        eq(schema.demoCatalogItems.isActive, true),
      ),
    )
    .groupBy(schema.demoCatalogItems.subcategoryId);
  const byId = new Map(counts.map((r) => [r.subcategoryId, Number(r.n)]));

  return rows.map((r) => serializeDemoSubcategory(r.sub, merchantId, byId.get(r.sub.id) ?? 0));
}

export async function loadDemoItems(
  app: FastifyInstance,
  merchantId: string,
  opts: { subcategoryId?: string; search?: string } = {},
) {
  const conditions: (SQL | undefined)[] = [
    assignedSetFilter(merchantId),
    eq(schema.demoCatalogItems.isActive, true),
  ];
  if (opts.subcategoryId) {
    conditions.push(eq(schema.demoCatalogItems.subcategoryId, opts.subcategoryId));
  }
  if (opts.search?.trim()) {
    const pattern = `%${opts.search.trim()}%`;
    conditions.push(
      or(ilike(schema.demoCatalogItems.label, pattern), ilike(schema.demoCatalogItems.sku, pattern)),
    );
  }

  const rows = await app.db
    .select({ item: schema.demoCatalogItems })
    .from(schema.demoCatalogItems)
    .innerJoin(
      schema.demoCatalogSubcategories,
      eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
    )
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    .innerJoin(
      schema.demoCatalogAssignments,
      eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
    )
    .where(and(...conditions))
    .orderBy(asc(schema.demoCatalogItems.sortOrder), desc(schema.demoCatalogItems.createdAt));

  return Promise.all(rows.map((r) => serializeDemoItem(app, r.item, merchantId)));
}

/**
 * merchantId is stamped with the *requesting* merchant's id, not stored on the row —
 * MerchantCatalogSubcategory.merchantId is a non-null uuid on the wire and the
 * Android app reads these two shapes interchangeably.
 */
function serializeDemoSubcategory(
  row: DemoSubcategoryRow,
  merchantId: string,
  productCount: number,
) {
  return {
    id: row.id,
    merchantId,
    category: row.category,
    name: row.name,
    garmentSubcategoryId: row.garmentSubcategoryId,
    sortOrder: row.sortOrder,
    productCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDemo: true as const,
    readOnly: true as const,
  };
}

async function serializeDemoItem(app: FastifyInstance, item: DemoItemRow, merchantId: string) {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((r) => r.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((r) => r.url)
      .catch(() => null),
  ]);

  return {
    id: item.id,
    merchantId,
    subcategoryId: item.subcategoryId,
    label: item.label,
    sku: item.sku,
    actualPrice: Math.round(item.actualPricePaise / 100),
    offerPrice: Math.round(item.offerPricePaise / 100),
    actualPricePaise: item.actualPricePaise,
    offerPricePaise: item.offerPricePaise,
    r2Key: item.r2Key,
    thumbnailKey: item.thumbnailKey,
    imageUrl,
    thumbnailUrl,
    // Demo items are always admin-uploaded and pre-approved; these fields exist
    // only so the shape matches MerchantCatalogItem.
    sourceJobId: null,
    sourceKind: 'uploaded' as const,
    flatSourceKey: null,
    isActive: item.isActive,
    moderationStatus: 'approved' as const,
    moderationNote: null,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    isDemo: true as const,
    readOnly: true as const,
  };
}

export type SerializedDemoSubcategory = ReturnType<typeof serializeDemoSubcategory>;
export type SerializedDemoItem = Awaited<ReturnType<typeof serializeDemoItem>>;
```

If `.$dynamic()` is not available on this Drizzle version, drop the conditional join and instead
always `innerJoin` `garmentSubcategories` (the FK is NOT NULL so the join never drops a row), then
only add the `requiresMannequinStep` condition when `mannequinOnly` is set.

- [x] **Step 5: Wire the three merchant read routes**

In `apps/api/src/modules/merchant/catalog.routes.ts`, add:

```ts
import {
  IncludeDemoQuery,
  loadDemoItems,
  loadDemoSubcategories,
} from './demo-catalog-read.js';
```

`GET /v1/merchant/catalog/subcategories` (line 137) — add the querystring schema and append:

```ts
    {
      preHandler: app.requireMerchant,
      schema: {
        querystring: z.object({ category: z.string().optional(), includeDemo: IncludeDemoQuery }),
      },
    },
```
then, replacing the existing `return`:

```ts
      const { includeDemo } = req.query as { includeDemo: boolean };
      const own = await Promise.all(rows.map((row) => serializeSubcategory(app, row)));
      if (!includeDemo) return { items: own };
      // Demo rows go last so the merchant's real products lead on the kiosk.
      const demo = await loadDemoSubcategories(app, merchantId, { category });
      return { items: [...own, ...demo] };
```

`GET /v1/merchant/catalog/saree-subcategories` (line 171) — same treatment, passing
`{ category, mannequinOnly: true }`.

`GET /v1/merchant/catalog` (line 436) — add the querystring schema
(`search`, `subcategoryId`, `includeDemo: IncludeDemoQuery`) and replace the return:

```ts
      const own = await Promise.all(items.map((item) => serializeCatalogItem(app, item)));
      if (!includeDemo) return { items: own };
      const demo = await loadDemoItems(app, merchantId, { subcategoryId, search });
      return { items: [...own, ...demo] };
```

- [x] **Step 6: Run the tests**

Run: `pnpm --filter @tryme/api test -- demo-catalog-merchant`
Expected: PASS, 9 tests.

Run: `pnpm --filter @tryme/api test`
Expected: whole suite green — `includeDemo` is additive and existing callers pass nothing.

- [x] **Step 7: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/merchant/demo-catalog-read.ts \
  apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/demo-catalog-merchant.test.ts
git commit -m "feat(merchant): surface assigned demo catalog rows in catalog reads"
```

---

### Task 6: Try-on on demo products

**Files:**
- Create: `apps/api/src/modules/merchant/resolve-tryon-garment.ts`
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts:116-216`, `apps/api/src/modules/kiosk/jobs.routes.ts:150-190`, `apps/api/src/modules/kiosk/catalog.routes.ts:41-72`
- Test: `apps/api/test/demo-catalog-tryon.test.ts`

**Interfaces:**
- Consumes: `schema.demoCatalog*` (Task 1); `loadDemoItems` (Task 5).
- Produces: `resolveTryonGarment(app, merchantId, itemId): Promise<{ r2Key: string; workflowTemplateId: string; isDemo: boolean }>`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/demo-catalog-tryon.test.ts`. Reuse `createTestTryonCategory`
(`apps/api/test/helpers/merchant.ts`) so the garment type actually resolves to a workflow template:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant, createTestTryonCategory } from './helpers/merchant.js';

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/2gAMAwEAAhADEAAAAT8A/9k=',
  'base64',
);

let c: Containers;
let app: TestApp;
let garmentTypeId: string;
let workflowTemplateId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);

  const cat = await createTestTryonCategory(app, { slug: `demo-tryon-${randomUUID()}` });
  workflowTemplateId = cat.workflowTemplateId;

  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-tryon-gt-${randomUUID()}`,
      label: 'Demo Tryon Garment Type',
      isActive: true,
      tryonCategoryId: cat.categoryId,
    })
    .returning();
  if (!gt) throw new Error('failed to seed garment type');
  garmentTypeId = gt.id;
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function merchantToken(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function seedDemoItem(opts: { itemActive?: boolean } = {}) {
  const [set] = await app.db
    .insert(schema.demoCatalogSets)
    .values({ name: `Set ${randomUUID()}` })
    .returning();
  const [sub] = await app.db
    .insert(schema.demoCatalogSubcategories)
    .values({
      setId: set!.id,
      category: 'women',
      name: 'Demo Sarees',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  const r2Key = keys.demoCatalogItem(randomUUID());
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub!.id,
      label: 'Demo Tryon Product',
      actualPricePaise: 0,
      offerPricePaise: 0,
      r2Key,
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      isActive: opts.itemActive ?? true,
    })
    .returning();
  return { setId: set!.id, itemId: item!.id, r2Key };
}

/** Presign + PUT a real customer photo, returning its key. */
async function uploadCustomerPhoto(token: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/presign',
    headers: { authorization: `Bearer ${token}` },
    payload: { contentType: 'image/jpeg', contentLength: JPEG_1X1.length },
  });
  const { uploadUrl, r2Key } = res.json();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: JPEG_1X1,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  expect(put.ok).toBe(true);
  return r2Key as string;
}

describe('POST /v1/merchant/tryon/jobs with a demo item', () => {
  it('creates a job using the demo item image when the set is assigned', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem();
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId: demo.setId, merchantId: merchant.merchantId });

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });

    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs?.upperGarmentKey).toBe(demo.r2Key);
    expect((inputs?.params as { workflowTemplateId: string }).workflowTemplateId).toBe(
      workflowTemplateId,
    );

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    // Merchant try-ons are free — unchanged by demo data.
    expect(job?.creditsCharged).toBe(0);
    expect(job?.merchantId).toBe(merchant.merchantId);
  });

  it('404s a demo item whose set is not assigned to this merchant', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem();

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s an inactive demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem({ itemActive: false });
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId: demo.setId, merchantId: merchant.merchantId });

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an id that is neither a merchant item nor a demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: randomUUID(), customerPhotoKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it('still works for the merchant\'s own item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const [sub] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.merchantId,
        category: 'women',
        name: 'Mine',
        garmentSubcategoryId: garmentTypeId,
      })
      .returning();
    const ownKey = keys.merchantCatalogItem(merchant.merchantId, randomUUID());
    const [own] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        merchantId: merchant.merchantId,
        subcategoryId: sub!.id,
        label: 'Mine',
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: ownKey,
        thumbnailKey: keys.merchantCatalogItemThumb(merchant.merchantId, randomUUID()),
      })
      .returning();

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: own!.id, customerPhotoKey },
    });
    expect(res.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, res.json().jobId));
    expect(inputs?.upperGarmentKey).toBe(ownKey);
  });
});
```

Confirm the `garment_subcategories` FK column is really named `tryonCategoryId` by reading
`packages/db/src/schema/models.ts` — `merchant/tryon.routes.ts:152` joins on it, so it exists, but
match the exact property name.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- demo-catalog-tryon`
Expected: FAIL — the demo item id 404s ("catalog item not found") on the first test.

- [x] **Step 3: Write the resolver**

Create `apps/api/src/modules/merchant/resolve-tryon-garment.ts`. The merchant branch is the query
currently inlined at `merchant/tryon.routes.ts:127-173`, moved verbatim:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

export interface ResolvedTryonGarment {
  r2Key: string;
  workflowTemplateId: string;
  isDemo: boolean;
}

/**
 * One garment lookup for both try-on entry points (the merchant-token route and
 * the kiosk-device route, which had byte-identical copies of this query). Tries
 * the merchant's own catalogue first, then falls back to admin demo items the
 * merchant has been assigned. `merchantCatalogItemId` is a shared id namespace
 * across two tables; UUIDs make collisions impossible.
 */
export async function resolveTryonGarment(
  app: FastifyInstance,
  merchantId: string,
  itemId: string,
): Promise<ResolvedTryonGarment> {
  const [own] = await app.db
    .select({
      merchantId: schema.merchantCatalogItems.merchantId,
      r2Key: schema.merchantCatalogItems.r2Key,
      isActive: schema.merchantCatalogItems.isActive,
      moderationStatus: schema.merchantCatalogItems.moderationStatus,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.merchantCatalogItems)
    .innerJoin(
      schema.merchantCatalogSubcategories,
      eq(schema.merchantCatalogSubcategories.id, schema.merchantCatalogItems.subcategoryId),
    )
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.merchantCatalogSubcategories.garmentSubcategoryId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.merchantCatalogItems.id, itemId))
    .limit(1);

  if (own) {
    if (own.merchantId !== merchantId) {
      throw new AppError('NOT_FOUND', 404, 'catalog item not found');
    }
    if (!own.isActive || own.moderationStatus !== 'approved') {
      throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
    }
    assertWorkflow(own);
    return { r2Key: own.r2Key, workflowTemplateId: own.workflowTemplateId!, isDemo: false };
  }

  const [demo] = await app.db
    .select({
      r2Key: schema.demoCatalogItems.r2Key,
      isActive: schema.demoCatalogItems.isActive,
      setIsActive: schema.demoCatalogSets.isActive,
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.demoCatalogItems)
    .innerJoin(
      schema.demoCatalogSubcategories,
      eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
    )
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    // The inner join IS the authorization check: no assignment row, no result.
    .innerJoin(
      schema.demoCatalogAssignments,
      and(
        eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
        eq(schema.demoCatalogAssignments.merchantId, merchantId),
      ),
    )
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.demoCatalogSubcategories.garmentSubcategoryId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.demoCatalogItems.id, itemId))
    .limit(1);

  if (!demo) throw new AppError('NOT_FOUND', 404, 'catalog item not found');
  if (!demo.isActive || !demo.setIsActive) {
    throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
  }
  assertWorkflow(demo);
  return { r2Key: demo.r2Key, workflowTemplateId: demo.workflowTemplateId!, isDemo: true };
}

function assertWorkflow(row: {
  workflowTemplateId: string | null;
  tryonCategoryIsActive: boolean | null;
  workflowTemplateIsActive: boolean | null;
}) {
  if (!row.workflowTemplateId || !row.tryonCategoryIsActive || !row.workflowTemplateIsActive) {
    throw new AppError('VALIDATION', 400, 'garment type has no tryon category configured');
  }
}
```

- [x] **Step 4: Use the resolver in both job routes**

In `apps/api/src/modules/merchant/tryon.routes.ts`, replace lines 127-173 (the `item` query and its
four guards) with:

```ts
      const garment = await resolveTryonGarment(app, merchantId, merchantCatalogItemId);
```
and change the `createMerchantTryonJob` call's `upperGarmentKey: item.r2Key` /
`workflowTemplateId: item.workflowTemplateId` to `garment.r2Key` / `garment.workflowTemplateId`.
Add `import { resolveTryonGarment } from './resolve-tryon-garment.js';`. Leave the
`customerPhotoKey` prefix check, the Redis ownership check and the size check exactly as they are.

In `apps/api/src/modules/kiosk/jobs.routes.ts`, replace the equivalent block at lines 150-190 the
same way, importing from `'../merchant/resolve-tryon-garment.js'`. Leave `KIOSK_JOB_COST` and the
credit deduct untouched — that path charges 10 credits and demo items are not special there.

- [x] **Step 5: Append demo items to the kiosk device catalog**

In `apps/api/src/modules/kiosk/catalog.routes.ts`, after the existing `rows` query, replace the
return with:

```ts
    const own = await Promise.all(
      rows.map((row) => serializeCatalogItem(app, row.item, row.subcategory)),
    );
    // Same demo set the merchant-token surface sees, reshaped to the kiosk contract.
    const demo = await loadDemoItems(app, merchantId);
    const demoSubcategories = await loadDemoSubcategories(app, merchantId);
    const nameBySubcategory = new Map(demoSubcategories.map((s) => [s.id, s]));

    return {
      items: [
        ...own,
        ...demo.map((item) => {
          const sub = nameBySubcategory.get(item.subcategoryId);
          return {
            id: item.id,
            label: item.label,
            sku: item.sku,
            gender: (sub?.category ?? 'women') as KioskCatalogListResponse['items'][number]['gender'],
            category: sub?.name ?? 'Demo',
            imageUrl: item.imageUrl,
            thumbnailUrl: item.thumbnailUrl,
          } satisfies KioskCatalogListResponse['items'][number];
        }),
      ],
    };
```
plus `import { loadDemoItems, loadDemoSubcategories } from '../merchant/demo-catalog-read.js';`.

- [x] **Step 6: Run the tests**

Run: `pnpm --filter @tryme/api test -- demo-catalog-tryon`
Expected: PASS, 5 tests.

Run: `pnpm --filter @tryme/api test`
Expected: whole suite green — the merchant and kiosk try-on behaviour for non-demo items is
unchanged, including the existing error codes.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/resolve-tryon-garment.ts \
  apps/api/src/modules/merchant/tryon.routes.ts apps/api/src/modules/kiosk/jobs.routes.ts \
  apps/api/src/modules/kiosk/catalog.routes.ts apps/api/test/demo-catalog-tryon.test.ts
git commit -m "feat(tryon): allow try-on against assigned demo catalog items"
```

---

### Task 7: Keep demo rows out of the merchant-facing library UIs

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogue-manager/CatalogueManagerContent.tsx:54,72`
- Modify: the equivalent subcategory/item reads under `apps/catalogues-web/src/app/tryon-library-app/`

**Interfaces:**
- Consumes: `includeDemo` (Task 5).
- Produces: no new API surface.

- [x] **Step 1: Find every merchant-facing caller**

```bash
grep -rn "merchant/catalog/subcategories\|merchant/catalog?\|merchant/catalog'" apps/catalogues-web/src
```
Expected hits: `CatalogueManagerContent.tsx:54,72`, plus the `tryon-library-app` pages
(`page.tsx`, `subcategory/[id]/page.tsx`). Also check
`apps/catalogues-web/src/app/(app)/catalogue-manager/BulkUploadModal.tsx` — it only PATCHes, so it
needs no change.

- [x] **Step 2: Add `includeDemo=false` to each read**

`CatalogueManagerContent.tsx` line 54:

```ts
      api.get<MerchantCatalogSubcategoryListResponse>(
        // Demo rows are admin-owned and read-only; this screen is the merchant's own
        // library editor, so excluding them keeps every row here editable.
        '/v1/merchant/catalog/subcategories?includeDemo=false',
      ),
```

line 72:

```ts
        `/v1/merchant/catalog?includeDemo=false&subcategoryId=${selectedSubcategoryId}`,
```

Apply the same `includeDemo=false` to each `tryon-library-app` read found in Step 1, preserving the
existing query params.

- [x] **Step 3: Verify the web app builds and typechecks**

```bash
pnpm --filter @tryme/web build
```
Expected: clean build.

- [x] **Step 4: Verify by hand**

With the API running and a merchant assigned a demo set (Task 4), open `/catalogue-manager` and
`/tryon-library-app` as that merchant. Expected: only the merchant's own subcategories and products,
identical to before this plan. Every visible edit and delete control still works.

- [x] **Step 5: Commit**

```bash
git add apps/catalogues-web/src
git commit -m "fix(web): exclude demo rows from the merchant library editors"
```

---

### Task 8: Admin panel — Kiosk Demo Data page

**Files:**
- Create: `apps/admin-web/src/pages/DemoCatalogPage.tsx`
- Modify: `apps/admin-web/src/App.tsx:212-227`, `apps/admin-web/src/components/Sidebar.tsx:40-80`

**Interfaces:**
- Consumes: `/admin/demo-catalog/*` (Tasks 2-4); `GET /admin/merchants` (existing); `GET /admin/assets/garment-types` (existing, `admin/subcategories.routes.ts:22`); `apiFetch`, `apiErrorMessage` (`apps/admin-web/src/lib/data.ts:551,516`); `makeThumbnail` (`apps/admin-web/src/lib/thumbnail.ts:12`).
- Produces: route `/demo-catalog`, sidebar entry "Kiosk Demo Data".

- [x] **Step 1: Write the page**

Create `apps/admin-web/src/pages/DemoCatalogPage.tsx`. Three panes left to right — sets,
subcategories, products — matching the merchant `catalogue-manager` mental model:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';

type Toast = (message: string, kind?: 'success' | 'error') => void;

interface DemoSet {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  subcategoryCount: number;
  productCount: number;
  assignedMerchantCount: number;
}
interface DemoSubcategory {
  id: string;
  category: string;
  name: string;
  garmentSubcategoryId: string;
  productCount: number;
}
interface DemoItem {
  id: string;
  label: string;
  sku: string | null;
  actualPrice: number;
  offerPrice: number;
  isActive: boolean;
  thumbnailUrl: string | null;
}
interface GarmentType {
  id: string;
  label: string;
  genderSlug: string;
}
interface MerchantRow {
  id: string;
  companyName: string;
  signupSource?: string;
}

const CATEGORIES = ['men', 'women', 'boys', 'girls'] as const;

/** Presigns, thumbnails where needed, and PUTs. Returns the resolved key. */
async function uploadDemoAsset(file: File, kind: 'image' | 'thumbnail'): Promise<string> {
  const body = kind === 'thumbnail' ? await makeThumbnail(file) : file;
  const contentType = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  const { uploadUrl, r2Key } = await apiFetch<{ uploadUrl: string; r2Key: string }>(
    '/admin/demo-catalog/presign',
    {
      method: 'POST',
      body: JSON.stringify({ kind, contentType, contentLength: body.size }),
    },
  );
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) throw new Error('Image upload failed. Please try again.');
  return r2Key;
}

export default function DemoCatalogPage({ toast }: { toast: Toast }) {
  const [sets, setSets] = useState<DemoSet[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [subcategories, setSubcategories] = useState<DemoSubcategory[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  const [items, setItems] = useState<DemoItem[]>([]);
  const [garmentTypes, setGarmentTypes] = useState<GarmentType[]>([]);
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const loadSets = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: DemoSet[] }>('/admin/demo-catalog/sets');
      setSets(res.items);
    } catch (err) {
      toast(apiErrorMessage(err, 'Could not load demo sets'), 'error');
    }
  }, [toast]);

  useEffect(() => {
    void loadSets();
    void (async () => {
      try {
        const [gt, m] = await Promise.all([
          apiFetch<{ items: GarmentType[] }>('/admin/assets/garment-types'),
          apiFetch<{ items: MerchantRow[] }>('/admin/merchants'),
        ]);
        setGarmentTypes(gt.items);
        setMerchants(m.items);
      } catch (err) {
        toast(apiErrorMessage(err, 'Could not load pickers'), 'error');
      }
    })();
  }, [loadSets, toast]);

  useEffect(() => {
    if (!selectedSetId) {
      setSubcategories([]);
      setAssignedIds([]);
      return;
    }
    void (async () => {
      try {
        const [subs, assignments] = await Promise.all([
          apiFetch<{ items: DemoSubcategory[] }>(
            `/admin/demo-catalog/sets/${selectedSetId}/subcategories`,
          ),
          apiFetch<{ items: { merchantId: string }[] }>(
            `/admin/demo-catalog/sets/${selectedSetId}/assignments`,
          ),
        ]);
        setSubcategories(subs.items);
        setAssignedIds(assignments.items.map((a) => a.merchantId));
      } catch (err) {
        toast(apiErrorMessage(err, 'Could not load the demo set'), 'error');
      }
    })();
  }, [selectedSetId, toast]);

  useEffect(() => {
    if (!selectedSubId) {
      setItems([]);
      return;
    }
    void (async () => {
      try {
        const res = await apiFetch<{ items: DemoItem[] }>(
          `/admin/demo-catalog/items?subcategoryId=${selectedSubId}`,
        );
        setItems(res.items);
      } catch (err) {
        toast(apiErrorMessage(err, 'Could not load demo products'), 'error');
      }
    })();
  }, [selectedSubId, toast]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(apiErrorMessage(err, label), 'error');
    } finally {
      setBusy(false);
    }
  }

  const createSet = (form: HTMLFormElement) =>
    run('Could not create the demo set', async () => {
      const data = new FormData(form);
      await apiFetch('/admin/demo-catalog/sets', {
        method: 'POST',
        body: JSON.stringify({
          name: String(data.get('name') ?? '').trim(),
          description: String(data.get('description') ?? '').trim() || undefined,
        }),
      });
      form.reset();
      await loadSets();
      toast('Demo set created', 'success');
    });

  const toggleSet = (set: DemoSet) =>
    run('Could not update the demo set', async () => {
      await apiFetch(`/admin/demo-catalog/sets/${set.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !set.isActive }),
      });
      await loadSets();
    });

  const deleteSet = (set: DemoSet) =>
    run('Could not delete the demo set', async () => {
      if (
        !window.confirm(
          `Delete "${set.name}"? This removes ${set.productCount} demo product(s) from ${set.assignedMerchantCount} merchant(s).`,
        )
      ) {
        return;
      }
      await apiFetch(`/admin/demo-catalog/sets/${set.id}`, { method: 'DELETE' });
      if (selectedSetId === set.id) setSelectedSetId(null);
      await loadSets();
      toast('Demo set deleted', 'success');
    });

  const saveAssignments = (merchantIds: string[]) =>
    run('Could not save merchant visibility', async () => {
      await apiFetch(`/admin/demo-catalog/sets/${selectedSetId}/assignments`, {
        method: 'PUT',
        body: JSON.stringify({ merchantIds }),
      });
      setAssignedIds(merchantIds);
      await loadSets();
      toast('Merchant visibility saved', 'success');
    });

  const createSubcategory = (form: HTMLFormElement) =>
    run('Could not create the subcategory', async () => {
      const data = new FormData(form);
      await apiFetch('/admin/demo-catalog/subcategories', {
        method: 'POST',
        body: JSON.stringify({
          setId: selectedSetId,
          category: String(data.get('category')),
          name: String(data.get('name') ?? '').trim(),
          garmentSubcategoryId: String(data.get('garmentSubcategoryId')),
        }),
      });
      form.reset();
      setSelectedSetId(selectedSetId); // re-trigger the subcategory load
      const subs = await apiFetch<{ items: DemoSubcategory[] }>(
        `/admin/demo-catalog/sets/${selectedSetId}/subcategories`,
      );
      setSubcategories(subs.items);
      await loadSets();
      toast('Subcategory created', 'success');
    });

  const createItem = (form: HTMLFormElement) =>
    run('Could not create the demo product', async () => {
      const data = new FormData(form);
      const file = data.get('image');
      if (!(file instanceof File) || file.size === 0) {
        throw new Error('Choose an image for the demo product.');
      }
      // The same file becomes both objects — full-res image plus a downscaled thumb.
      const [r2Key, thumbnailKey] = await Promise.all([
        uploadDemoAsset(file, 'image'),
        uploadDemoAsset(file, 'thumbnail'),
      ]);
      await apiFetch('/admin/demo-catalog/items', {
        method: 'POST',
        body: JSON.stringify({
          subcategoryId: selectedSubId,
          label: String(data.get('label') ?? '').trim(),
          sku: String(data.get('sku') ?? '').trim() || undefined,
          actualPrice: Number(data.get('actualPrice') ?? 0),
          offerPrice: Number(data.get('offerPrice') ?? 0),
          r2Key,
          thumbnailKey,
        }),
      });
      form.reset();
      const res = await apiFetch<{ items: DemoItem[] }>(
        `/admin/demo-catalog/items?subcategoryId=${selectedSubId}`,
      );
      setItems(res.items);
      await loadSets();
      toast('Demo product added', 'success');
    });

  const deleteItem = (item: DemoItem) =>
    run('Could not delete the demo product', async () => {
      if (!window.confirm(`Delete "${item.label}"?`)) return;
      await apiFetch(`/admin/demo-catalog/items/${item.id}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      await loadSets();
    });

  const selectedSet = sets.find((s) => s.id === selectedSetId) ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Kiosk Demo Data</h1>
        <p className="muted">
          Admin-authored demo products. Merchants see them on the Android app but cannot edit or
          delete them. A set is only visible to the merchants selected below.
        </p>
      </header>

      <div className="grid-3">
        <section className="card">
          <h2>Demo sets</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createSet(e.currentTarget);
            }}
          >
            <input name="name" placeholder="Set name" required maxLength={160} />
            <input name="description" placeholder="Description (optional)" maxLength={500} />
            <button type="submit" disabled={busy}>
              Add set
            </button>
          </form>

          <ul className="list">
            {sets.map((set) => (
              <li key={set.id} className={set.id === selectedSetId ? 'selected' : ''}>
                <button type="button" onClick={() => setSelectedSetId(set.id)}>
                  <strong>{set.name}</strong>
                  <span className="muted">
                    {set.subcategoryCount} subcats · {set.productCount} products ·{' '}
                    {set.assignedMerchantCount} merchants
                  </span>
                  {!set.isActive && <span className="badge">Inactive</span>}
                </button>
                <button type="button" disabled={busy} onClick={() => void toggleSet(set)}>
                  {set.isActive ? 'Deactivate' : 'Activate'}
                </button>
                <button type="button" disabled={busy} onClick={() => void deleteSet(set)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Subcategories</h2>
          {!selectedSet ? (
            <p className="muted">Select a set.</p>
          ) : (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void createSubcategory(e.currentTarget);
                }}
              >
                <select name="category" required>
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
                <input name="name" placeholder="Subcategory name" required maxLength={160} />
                <select name="garmentSubcategoryId" required>
                  <option value="">Garment type…</option>
                  {garmentTypes.map((gt) => (
                    <option key={gt.id} value={gt.id}>
                      {gt.genderSlug} · {gt.label}
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={busy}>
                  Add subcategory
                </button>
              </form>

              <ul className="list">
                {subcategories.map((sub) => (
                  <li key={sub.id} className={sub.id === selectedSubId ? 'selected' : ''}>
                    <button type="button" onClick={() => setSelectedSubId(sub.id)}>
                      <strong>{sub.name}</strong>
                      <span className="muted">
                        {sub.category} · {sub.productCount} products
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <h3>Visible to merchants</h3>
              <select
                multiple
                size={8}
                value={assignedIds}
                onChange={(e) =>
                  setAssignedIds(Array.from(e.currentTarget.selectedOptions, (o) => o.value))
                }
              >
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.companyName}
                    {m.signupSource === 'android_google' ? ' (self-signup)' : ''}
                  </option>
                ))}
              </select>
              <button type="button" disabled={busy} onClick={() => void saveAssignments(assignedIds)}>
                Save visibility
              </button>
            </>
          )}
        </section>

        <section className="card">
          <h2>Demo products</h2>
          {!selectedSubId ? (
            <p className="muted">Select a subcategory.</p>
          ) : (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void createItem(e.currentTarget);
                }}
              >
                <input name="label" placeholder="Product name" required maxLength={200} />
                <input name="sku" placeholder="SKU (optional)" maxLength={120} />
                <input name="actualPrice" type="number" min={0} placeholder="MRP (₹)" required />
                <input name="offerPrice" type="number" min={0} placeholder="Offer (₹)" required />
                <input name="image" type="file" accept="image/jpeg,image/png,image/webp" required />
                <button type="submit" disabled={busy}>
                  Add product
                </button>
              </form>

              <ul className="grid-items">
                {items.map((item) => (
                  <li key={item.id}>
                    {item.thumbnailUrl && <img src={item.thumbnailUrl} alt={item.label} />}
                    <strong>{item.label}</strong>
                    <span className="muted">
                      {item.sku ?? '—'} · ₹{item.offerPrice} <s>₹{item.actualPrice}</s>
                    </span>
                    {!item.isActive && <span className="badge">Inactive</span>}
                    <button type="button" disabled={busy} onClick={() => void deleteItem(item)}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
```

Class names (`page`, `card`, `grid-3`, `list`, `badge`, `muted`, `grid-items`) must match what
`apps/admin-web/src/styles` actually defines — open a sibling page such as `DevApiPage.tsx` and reuse
its wrappers rather than inventing new ones. If `grid-3` / `grid-items` do not exist, add them to the
stylesheet the other pages use.

- [x] **Step 2: Register the route and sidebar entry**

`apps/admin-web/src/App.tsx` — import the page and add, after the `/tryon` route (line 218):

```tsx
            <Route path="/demo-catalog" element={<DemoCatalogPage {...pageProps} />} />
```

`apps/admin-web/src/components/Sidebar.tsx` — in the `Content` group, after the `tryon` entry:

```tsx
      {
        k: 'demo-catalog',
        label: 'Kiosk Demo Data',
        icon: Icon.Image,
        roles: ['SUPER_ADMIN', 'MODERATOR', 'ADMIN'],
      },
```

Roles must match the `RW` guard from Task 2 (`SUPER_ADMIN`, `MODERATOR`, `ADMIN`) — otherwise the
link shows for someone who then gets a 403.

- [x] **Step 3: Verify it builds**

```bash
pnpm --filter @tryme/admin build
pnpm lint
```
Expected: clean build, 0 lint errors.

- [x] **Step 4: Verify by hand**

With the API running, log in to the admin panel and:
1. Create a set → it appears with zero counts.
2. Add a `women` subcategory bound to a real garment type.
3. Add a product with a real image + prices → the thumbnail renders and the set counts update.
4. Select a test merchant under "Visible to merchants" → Save → the set's merchant count becomes 1.
5. `curl -H "Authorization: Bearer <merchant token>" '<api>/v1/merchant/catalog?includeDemo=true'`
   → the demo product is present with `isDemo: true`; with `includeDemo=false` it is absent.
6. Deactivate the set → the merchant read no longer returns it.
7. Delete the set → confirm dialog names the product and merchant counts, and the objects are gone
   from MinIO.

- [x] **Step 5: Commit**

```bash
git add apps/admin-web/src
git commit -m "feat(admin): Kiosk Demo Data page"
```

---

### Task 9: End-to-end verification on the Android app

No code. This is the acceptance gate for the whole plan.

- [x] **Step 1: Bring up the stack**

```bash
pnpm docker:up
pnpm db:migrate
pnpm --filter @tryme/api dev
pnpm --filter @tryme/dispatcher dev
```

If the dispatcher fails every job with `column "widget_client_id" does not exist`, its container
image predates migration `0096` — rebuild it (`docker compose build dispatcher && docker compose up -d dispatcher`).
That failure is recorded in `docs/progress.md` and is unrelated to this work.

- [x] **Step 2: Run the full suites**

```bash
pnpm --filter @tryme/api test
pnpm lint
pnpm typecheck
```
Expected: all green. `apps/admin-mobile` typecheck failures are pre-existing and out of scope.

- [x] **Step 3: Walk the app**

1. Install the app pointed at the local API. Log in as a merchant with an **empty** catalogue.
   Expected: Women flow shows nothing.
2. Assign a demo set with one `women` product in admin. Refresh the app.
   Expected: the demo subcategory and product appear with the correct price and SKU, no app changes
   or reinstall needed.
3. Run a try-on on the demo product.
   Expected: job reaches `COMPLETED`, the result renders, and `jobs.credits_charged = 0`.
4. Reload `/catalogue-manager` and `/tryon-library-app` as the same merchant.
   Expected: no demo rows, no changed UI.
5. Unassign the set in admin, refresh the app.
   Expected: the demo product disappears; a try-on POST against that item id now 404s.

- [x] **Step 4: Record progress**

Add a dated entry at the top of `docs/progress.md` with **Done**, **Failed / Not Done** and
**Open Questions / Decisions** sections, per CLAUDE.md. Include the unresolved free-try-on abuse
surface under Open Questions.

- [x] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record demo catalog rollout"
```

---

## Plan B self-review

- **Spec coverage.** Separate demo tables with no `merchantId` → T1. Demo sets → merchants
  assignment → T1 (table) + T4 (routes) + T8 (UI). Same authoring format as catalogue-manager,
  upload-only → T3 + T8. `includeDemo` defaulting to true, so no Android change → T5, verified in
  T9 step 3.2. Demo rows read-only to merchants → T5 (`readOnly: true`, and the 404 test proving
  merchant mutations cannot reach them). Try-on on demo items, credits unchanged → T6. Admin-only
  control, no merchant opt-out → nothing built, by design. Admin page called "Kiosk Demo Data" → T8.
  Web library editors unaffected → T7.
- **Placeholders.** None. Steps that depend on a codebase detail I could not confirm say exactly
  what to read and what to reconcile against: credit-plan columns (Plan A T2), the admin-token test
  helper (T2), `req.userId` on the admin guard (T2), `tryonCategoryId` on `garment_subcategories`
  (T6), `.$dynamic()` availability (T5), and the admin stylesheet class names (T8).
- **Type consistency.** `MerchantCatalogCategory` is imported into `demo-catalog.ts` rather than
  re-declared, so the four category strings have one definition. `serializeDemoItem` emits every
  field `MerchantCatalogItem` declares — `actualPrice`/`offerPrice` in rupees plus the raw paise
  columns that `...item` spread already exposes on the merchant path — so both branches of
  `/v1/merchant/catalog` return the same keys. `resolveTryonGarment` returns
  `{ r2Key, workflowTemplateId, isDemo }` and both call sites (T6) read exactly those names.
  `productCount` is spelled identically in the admin subcategory list (T2), the merchant serializer
  (T5) and the page (T8). `assignedMerchantCount` is the same name in the sets list (T2), the
  assignments PUT response (T4) and the page (T8).
- **Cross-plan check.** Plan A adds migration `0133`, Plan B adds `0134`. If they are executed out
  of order, take whichever index `origin/main` already holds as canonical and renumber the other
  upward — never below.

---

