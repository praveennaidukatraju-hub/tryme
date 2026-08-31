# Shopify Product Catalog Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Shopify merchant generate AI catalog images (model wearing the product) directly from the product page, using one of the product's own images as the garment, and publish approved results straight into Shopify's product media.

**Architecture:** Reuses the existing Studio job pipeline (`createJob()` in `apps/api/src/modules/jobs/create.ts`) end-to-end — same batch (`looks[]`), credit-cost, and validation logic the customer-facing studio wizard already uses. New surface area is: a `shopify_catalog_jobs` join table for store/product/publish bookkeeping, three new Shopify-session-authed API routes, a new page in the existing embedded `apps/shopify` React SPA, and a new Admin UI Extension block that opens that page in a Shopify `Modal`.

**Tech Stack:** Fastify 5 + Zod (`apps/api`), Drizzle ORM/Postgres (`packages/db`), Vite + React + Polaris (`apps/shopify`), Shopify Admin UI Extensions (`apps/shopify-extension`), Vitest integration tests against the shared docker-compose Postgres/Redis/MinIO.

## Global Constraints

- pnpm workspaces only — never introduce npm/yarn lockfiles.
- ESM only, Node 20+, TypeScript 5.6.
- No `console.log` in committed code — use `app.log` (pino).
- Never inline-mutate `workflow_templates.jsonContent` — not touched by this plan, but `createJob`'s own patching logic already respects this; do not add new patching code.
- `docker:up` must be running before any `pnpm test`. No testcontainers.
- Credit deduct + job insert stay one Postgres transaction — already true inside `createJob`; do not split it.
- All `/admin/*`-style privileged routes double-check auth — here, every new route uses `app.requireShopifySession` (session-token + `shopify_stores` row lookup), consistent with `funnel.routes.ts`/`products.routes.ts`.
- Migration index must follow the highest index on `main` (currently `0115_thin_onslaught.sql` → next is `0116_*`); run `pnpm db:generate` to let drizzle-kit pick the number, don't hand-write it.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/jobs.ts` | Add `shopifyCatalogJobs` table (co-located here, not `shopify.ts`, to avoid a circular import — `jobs.ts` already imports `shopifyStores` from `shopify.ts`). |
| `packages/db/src/migrations/0116_*.sql` (generated) | Migration for the new table. |
| `apps/api/src/modules/shopify/catalog-options.routes.ts` (new) | `GET /v1/shopify/catalog/options` — garment types/faces/backgrounds/poses/lower/shoe picker data, session-authed equivalent of `/v1/models/*`. |
| `apps/api/src/modules/shopify/catalog.routes.ts` (new) | `POST /v1/shopify/catalog/generate`, `GET /v1/shopify/catalog/jobs`, `POST /v1/shopify/catalog/jobs/:id/publish`. |
| `apps/api/src/modules/shopify/routes.ts` | Register the two new route modules. |
| `apps/api/src/env.ts`, `.env`, both `shopify.app*.toml` | Scope bump `read_products` → `read_products,write_products`. |
| `apps/shopify/src/types.ts` | Add types for the new options/generate/publish payloads. |
| `apps/shopify/src/pages/CatalogGeneratePage.tsx` (new) | Picker UI (product image → garment type → face → backgrounds/poses → lower/shoe) + generate + poll + approve/publish. |
| `apps/shopify/src/App.tsx` | Register the new route. |
| `apps/shopify-extension/extensions/product-catalog-extension/` (new) | Admin UI Extension: block on the product page + `Modal` opening `CatalogGeneratePage`. |

---

### Task 1: DB schema — `shopify_catalog_jobs` table

**Files:**
- Modify: `packages/db/src/schema/jobs.ts`
- Generated: `packages/db/src/migrations/0116_*.sql`, `packages/db/src/migrations/meta/0116_snapshot.json`, `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `schema.shopifyCatalogJobs` — `{jobId, storeId, shopifyProductId, sourceImageUrl, shopifyMediaId, publishedAt, createdAt}`. Later tasks (2, 4, 5) select/insert/update against this table by name.

- [ ] **Step 1: Add the table definition**

In `packages/db/src/schema/jobs.ts`, add `bigint` to the existing `drizzle-orm/pg-core` import:

```ts
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
```

Then add the table directly after the existing `jobOutputs` export:

```ts
// Tracks which jobs were generated via the Shopify product-page "generate
// catalog images" flow, for store/product ownership scoping and publish
// idempotency. Kept as its own table (not columns on `jobs`) so createJob()
// — used by every job-creation caller, not just this one — never needs to
// know about Shopify.
export const shopifyCatalogJobs = pgTable('shopify_catalog_jobs', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  storeId: uuid('store_id')
    .notNull()
    .references(() => shopifyStores.id, { onDelete: 'cascade' }),
  shopifyProductId: bigint('shopify_product_id', { mode: 'number' }).notNull(),
  sourceImageUrl: text('source_image_url').notNull(),
  // Shopify's media GID once published — doubles as the idempotency guard
  // for the publish endpoint (a second "Add to product" click is a no-op).
  shopifyMediaId: text('shopify_media_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0116_<generated-name>.sql` containing a `CREATE TABLE shopify_catalog_jobs (...)` statement, and updates `packages/db/src/migrations/meta/_journal.json` + a new `meta/0116_snapshot.json`.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: log line confirming migration `0116_*` applied, no errors.

- [ ] **Step 4: Typecheck the db package**

Run: `pnpm --filter @tryme/db exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(db): add shopify_catalog_jobs table"
```

---

### Task 2: `GET /v1/shopify/catalog/options`

**Files:**
- Create: `apps/api/src/modules/shopify/catalog-options.routes.ts`
- Test: `apps/api/test/shopify-catalog-options.test.ts`

**Interfaces:**
- Consumes: `app.requireShopifySession` (existing, sets `req.shopifyStore`), `schema.garmentSubcategories`, `schema.modelFaces`, `schema.modelBackgrounds`, `schema.modelPoseAssets`, `schema.catalogItems`, `schema.catalogItemSubcategories`, `schema.poseGarmentConfigs`, `schema.workflowTemplates` (all pre-existing).
- Produces: `GET /v1/shopify/catalog/options?gender=<men|women|boys|girls>&garmentTypeId=<uuid?>` → `{garmentTypes: [...], faces: [...], backgrounds: [...], poses: [...], lowerItems: [...], shoeItems: [...]}`. Task 7 (frontend) consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-catalog-options.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'opt-secret';
const API_KEY = 'opt-key';
let c: Containers;
let app: TestApp;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_API_SECRET: API_SECRET, SHOPIFY_API_KEY: API_KEY });
  await upsertShopifyStore(
    app,
    {
      shopifyShopId: 601,
      shopDomain: 'catalog-options-test.myshopify.com',
      myshopifyDomain: 'catalog-options-test.myshopify.com',
      name: 'O',
      email: 'o@o.com',
    },
    'tok',
    'read_products',
  );
  token = signSessionToken('catalog-options-test.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.modelFaces).values({
    gender: 'women',
    label: 'Face A',
    thumbnailKey: 'faces/a.jpg',
    r2Key: 'faces/a-full.jpg',
    isActive: true,
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/catalog/options', () => {
  it('rejects without a session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/shopify/catalog/options?gender=women' });
    expect(res.statusCode).toBe(401);
  });

  it('returns faces, backgrounds and poses for a gender with a valid session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/catalog/options?gender=women',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      garmentTypes: unknown[];
      faces: { label: string }[];
      backgrounds: unknown[];
      poses: unknown[];
      lowerItems: unknown[];
      shoeItems: unknown[];
    };
    expect(body.faces.some((f) => f.label === 'Face A')).toBe(true);
    expect(Array.isArray(body.backgrounds)).toBe(true);
    expect(Array.isArray(body.poses)).toBe(true);
    expect(Array.isArray(body.lowerItems)).toBe(true);
    expect(Array.isArray(body.shoeItems)).toBe(true);
  });
});
```

Check whether `schema.modelFaces` requires an `r2Key` (full-size face image) column not-null — inspect `packages/db/src/schema/models.ts` for `modelFaces` before running; adjust the seed `.values({...})` to include every `notNull()` column with no default (this is common across model tables — `r2Key`, `thumbnailKey`, `gender`, `label` at minimum).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-options`
Expected: FAIL — 404 (route doesn't exist yet) instead of 401/200.

- [ ] **Step 3: Write the route**

Create `apps/api/src/modules/shopify/catalog-options.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const GENDERS = ['men', 'women', 'boys', 'girls'] as const;

const OptionsQuery = z.object({
  gender: z.enum(GENDERS),
  garmentTypeId: z.string().uuid().optional(),
});

async function fetchCatalogItems(
  app: FastifyInstance,
  type: 'lower' | 'shoe',
  gender: string,
  garmentTypeId?: string,
) {
  let allowedIds: string[] | null = null;
  if (garmentTypeId) {
    const [gt] = await app.db
      .select({
        defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
        defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    const mappings = await app.db
      .select({ catalogItemId: schema.catalogItemSubcategories.catalogItemId })
      .from(schema.catalogItemSubcategories)
      .where(eq(schema.catalogItemSubcategories.subcategoryId, garmentTypeId));
    const defaultId = type === 'lower' ? gt?.defaultLowerCatalogId : gt?.defaultShoeCatalogId;
    allowedIds = [...new Set([...mappings.map((m) => m.catalogItemId), ...(defaultId ? [defaultId] : [])])];
    if (allowedIds.length === 0) return [];
  }

  const conditions = [
    eq(schema.catalogItems.isActive, true),
    eq(schema.catalogItems.type, type),
    eq(schema.catalogItems.genderSlug, gender),
  ];
  if (allowedIds) conditions.push(inArray(schema.catalogItems.id, allowedIds));

  const items = await app.db
    .select()
    .from(schema.catalogItems)
    .where(and(...conditions));

  return items.map((i) => ({
    id: i.id,
    label: i.label,
    thumbnailUrl: app.storage.publicUrl(i.thumbnailKey),
  }));
}

export async function shopifyCatalogOptionsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/shopify/catalog/options',
    { preHandler: app.requireShopifySession, schema: { querystring: OptionsQuery } },
    async (req) => {
      const { gender, garmentTypeId } = req.query as z.infer<typeof OptionsQuery>;

      const garmentTypes = await app.db
        .select({
          id: schema.garmentSubcategories.id,
          label: schema.garmentSubcategories.label,
          sortOrder: schema.garmentSubcategories.sortOrder,
        })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.genderSlug, gender),
            eq(schema.garmentSubcategories.isActive, true),
          ),
        )
        .orderBy(asc(schema.garmentSubcategories.sortOrder));

      const faceRows = await app.db
        .select({
          id: schema.modelFaces.id,
          label: schema.modelFaces.label,
          thumbnailKey: schema.modelFaces.thumbnailKey,
        })
        .from(schema.modelFaces)
        .where(
          and(
            eq(schema.modelFaces.gender, gender),
            eq(schema.modelFaces.isActive, true),
            isNull(schema.modelFaces.deletedAt),
          ),
        );
      const faces = faceRows.map((f) => ({
        id: f.id,
        label: f.label,
        thumbnailUrl: app.storage.publicUrl(f.thumbnailKey),
      }));

      const backgroundRows = await app.db
        .select({
          id: schema.modelBackgrounds.id,
          label: schema.modelBackgrounds.label,
          thumbnailKey: schema.modelBackgrounds.thumbnailKey,
        })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            isNull(schema.modelBackgrounds.deletedAt),
            eq(schema.modelBackgrounds.scope, 'general'),
          ),
        );
      const backgrounds = backgroundRows.map((b) => ({
        id: b.id,
        label: b.label,
        thumbnailUrl: app.storage.publicUrl(b.thumbnailKey),
      }));

      const poseRows = await app.db
        .select({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.displayName,
          fallbackLabel: schema.modelPoseAssets.label,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          lowerNodeId: schema.workflowTemplates.lowerNodeId,
          shoeNodeId: schema.workflowTemplates.shoeNodeId,
        })
        .from(schema.modelPoseAssets)
        .leftJoin(
          schema.workflowTemplates,
          eq(schema.modelPoseAssets.workflowTemplateId, schema.workflowTemplates.id),
        )
        .where(
          and(
            eq(schema.modelPoseAssets.genderSlug, gender),
            eq(schema.modelPoseAssets.isActive, true),
            isNull(schema.modelPoseAssets.deletedAt),
            eq(schema.modelPoseAssets.scope, 'general'),
          ),
        );
      const poses = poseRows.map((p) => ({
        id: p.id,
        label: p.label ?? p.fallbackLabel,
        thumbnailUrl: app.storage.publicUrl(p.thumbnailKey),
        hasLower: p.lowerNodeId != null,
        hasShoes: p.shoeNodeId != null,
      }));

      const [lowerItems, shoeItems] = await Promise.all([
        fetchCatalogItems(app, 'lower', gender, garmentTypeId),
        fetchCatalogItems(app, 'shoe', gender, garmentTypeId),
      ]);

      return { garmentTypes, faces, backgrounds, poses, lowerItems, shoeItems };
    },
  );
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/shopify/routes.ts`, add the import next to the existing ones and register it next to `shopifyProductsRoutes`:

```ts
import { shopifyCatalogOptionsRoutes } from './catalog-options.routes.js';
```

```ts
  await app.register(shopifyProductsRoutes);
  await app.register(shopifyCatalogOptionsRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-options`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/catalog-options.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-catalog-options.test.ts
git commit -m "feat(shopify): add catalog options endpoint for product-page generation picker"
```

---

### Task 3: `POST /v1/shopify/catalog/generate`

**Files:**
- Create: `apps/api/src/modules/shopify/catalog.routes.ts`
- Test: `apps/api/test/shopify-catalog-generate.test.ts`

**Interfaces:**
- Consumes: `createJob` from `../jobs/create.js` (`createJob(app, userId, body, opts)` → `Promise<{catalogueId, jobIds}>`), `schema.shopifyCatalogJobs` (Task 1), `app.storage.putObject(key, buffer, contentType)`.
- Produces: `POST /v1/shopify/catalog/generate` → `201 {catalogueId, jobIds}`. `catalogueId` is consumed by Task 4's `GET /v1/shopify/catalog/jobs?catalogueId=`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-catalog-generate.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'gen-secret';
const API_KEY = 'gen-key';
let c: Containers;
let app: TestApp;
let token: string;
let storeId: string;
let faceId: string;
let backgroundId: string;
let poseId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_API_SECRET: API_SECRET, SHOPIFY_API_KEY: API_KEY });

  const owner = await app.db
    .insert(schema.users)
    .values({
      email: `catalog-gen-${Date.now()}@example.com`,
      passwordHash: null,
      displayName: 'Owner',
      companyName: null,
      emailVerified: true,
      tier: 'free',
    })
    .returning();
  await app.db.insert(schema.userCredits).values({ userId: owner[0].id, balance: 1000 });

  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 701,
      shopDomain: 'catalog-generate-test.myshopify.com',
      myshopifyDomain: 'catalog-generate-test.myshopify.com',
      name: 'G',
      email: 'g@g.com',
    },
    'tok',
    'read_products',
  );
  await app.db
    .update(schema.shopifyStores)
    .set({ ownerUserId: owner[0].id })
    .where(eq(schema.shopifyStores.id, store.id));
  storeId = store.id;
  token = signSessionToken('catalog-generate-test.myshopify.com', API_SECRET, API_KEY);

  const [face] = await app.db
    .insert(schema.modelFaces)
    .values({ gender: 'women', label: 'F', thumbnailKey: 'f.jpg', r2Key: 'f-full.jpg', isActive: true })
    .returning();
  faceId = face.id;
  const [bg] = await app.db
    .insert(schema.modelBackgrounds)
    .values({ label: 'B', r2Key: 'bg.jpg', thumbnailKey: 'bg-t.jpg', bgComfyR2Key: 'bg-comfy.jpg', isActive: true })
    .returning();
  backgroundId = bg.id;
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: 'catalog-gen-wf',
      label: 'WF',
      jsonContent: {},
      faceNodeId: 'x',
      poseNodeId: 'x',
      bgNodeId: 'x',
      upperNodeIds: ['1'],
      facePhasePromptNode: 'x',
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
    })
    .returning();
  const [pose] = await app.db
    .insert(schema.modelPoseAssets)
    .values({
      genderSlug: 'women',
      label: 'P',
      displayName: 'P',
      r2Key: 'pose.jpg',
      thumbnailKey: 'pose-t.jpg',
      isActive: true,
      workflowTemplateId: wf.id,
    })
    .returning();
  poseId = pose.id;

  // Stub the outbound fetch to the Shopify CDN image so the test doesn't
  // depend on network access — createJob only needs the object to exist
  // in R2 with a readable size, not real image bytes.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('cdn.shopify.com')) {
        return new Response(Buffer.from('fake-jpeg-bytes'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await c?.stop();
});

describe('POST /v1/shopify/catalog/generate', () => {
  it('rejects without a session token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/shopify/catalog/generate', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('creates one job per look, billed to the store owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/catalog/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        shopifyProductId: 12345,
        sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/shirt.jpg',
        faceId,
        looks: [{ poseId, backgroundId }],
        aspectRatio: '3:4',
        resolution: 'HD',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { catalogueId: string; jobIds: string[] };
    expect(body.jobIds).toHaveLength(1);

    const [tracked] = await app.db
      .select()
      .from(schema.shopifyCatalogJobs)
      .where(eq(schema.shopifyCatalogJobs.jobId, body.jobIds[0]));
    expect(tracked.storeId).toBe(storeId);
    expect(tracked.shopifyProductId).toBe(12345);
  });

  it('rejects when the store has no linked owner', async () => {
    const unlinked = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 702,
        shopDomain: 'catalog-generate-unlinked.myshopify.com',
        myshopifyDomain: 'catalog-generate-unlinked.myshopify.com',
        name: 'U',
        email: 'u@u.com',
      },
      'tok',
      'read_products',
    );
    const unlinkedToken = signSessionToken('catalog-generate-unlinked.myshopify.com', API_SECRET, API_KEY);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/catalog/generate',
      headers: { authorization: `Bearer ${unlinkedToken}` },
      payload: {
        shopifyProductId: 1,
        sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/shirt.jpg',
        faceId,
        looks: [{ poseId, backgroundId }],
        aspectRatio: '3:4',
        resolution: 'HD',
      },
    });
    expect(res.statusCode).toBe(402);
    void unlinked;
  });
});
```

Before running, check `modelBackgrounds`/`modelPoseAssets`/`workflowTemplates` required (`notNull()`, no default) columns in `packages/db/src/schema/models.ts` and adjust the seed `.values({...})` calls above to include every one — this mirrors the exact seeding already done in `apps/api/test/shopify-funnel-routes.test.ts` for `workflowTemplates`, extend the same way for `modelBackgrounds`/`modelPoseAssets`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-generate`
Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 3: Write the route**

Create `apps/api/src/modules/shopify/catalog.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createJob } from '../jobs/create.js';
import { assertShopifyCdn } from './products.sync.js';

const GenerateBody = z.object({
  shopifyProductId: z.number().int().positive(),
  sourceImageUrl: z.string().url(),
  faceId: z.string().uuid(),
  garmentTypeId: z.string().uuid().optional(),
  looks: z
    .array(z.object({ poseId: z.string().uuid(), backgroundId: z.string().uuid() }))
    .min(1)
    .max(12),
  lowerCatalogId: z.string().uuid().optional(),
  shoeCatalogId: z.string().uuid().optional(),
  aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
  resolution: z.enum(['HD', '2K', '4K']),
});

const MAX_GARMENT_SOURCE_BYTES = 10 * 1024 * 1024;

async function downloadProductImageToR2(
  app: FastifyInstance,
  storeId: string,
  shopifyProductId: number,
  sourceImageUrl: string,
): Promise<string> {
  assertShopifyCdn(sourceImageUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(sourceImageUrl, { redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected product image');
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_GARMENT_SOURCE_BYTES) {
    throw new AppError('BAD_REQUEST', 400, 'source image exceeds 10MB');
  }
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const r2Key = `shopify-catalog-garments/${storeId}/${shopifyProductId}/${randomUUID()}.jpg`;
  await app.storage.putObject(r2Key, Buffer.from(arrayBuffer), contentType);
  return r2Key;
}

export async function shopifyCatalogRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/catalog/generate',
    { preHandler: app.requireShopifySession, schema: { body: GenerateBody } },
    async (req, reply) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const body = req.body as z.infer<typeof GenerateBody>;

      if (!store.ownerUserId) {
        throw new AppError('INSUFFICIENT_CREDITS', 402, 'Store is not linked to a billing account');
      }

      const r2Key = await downloadProductImageToR2(
        app,
        store.id,
        body.shopifyProductId,
        body.sourceImageUrl,
      );

      const { catalogueId, jobIds } = await createJob(
        app,
        store.ownerUserId,
        {
          inputs: {
            upperGarmentKey: r2Key,
            faceId: body.faceId,
            garmentTypeId: body.garmentTypeId,
            looks: body.looks,
            lowerCatalogId: body.lowerCatalogId,
            shoeCatalogId: body.shoeCatalogId,
          },
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
        } as never,
        { trustedGarmentKeys: new Set([r2Key]) },
      );

      await app.db.insert(schema.shopifyCatalogJobs).values(
        jobIds.map((jobId) => ({
          jobId,
          storeId: store.id,
          shopifyProductId: body.shopifyProductId,
          sourceImageUrl: body.sourceImageUrl,
        })),
      );

      return reply.code(201).send({ catalogueId, jobIds });
    },
  );
}
```

Check `assertShopifyCdn`'s export in `apps/api/src/modules/shopify/products.sync.ts` — it's already used by `products.routes.ts` via the same import path, so this import should resolve as-is; if it's not currently exported, add `export` to its declaration there (a one-word change, still within this step, not a separate task since `catalog.routes.ts` cannot compile without it).

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/shopify/routes.ts`:

```ts
import { shopifyCatalogRoutes } from './catalog.routes.js';
```

```ts
  await app.register(shopifyCatalogOptionsRoutes);
  await app.register(shopifyCatalogRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-generate`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no errors. If `createJob`'s body type doesn't structurally accept the object as constructed, fix the cast/shape here (not by changing `createJob`'s signature — it's shared by every other job-creation caller).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/catalog.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-catalog-generate.test.ts
git commit -m "feat(shopify): add catalog image generation endpoint for product page"
```

---

### Task 4: `GET /v1/shopify/catalog/jobs`

**Files:**
- Modify: `apps/api/src/modules/shopify/catalog.routes.ts`
- Test: `apps/api/test/shopify-catalog-jobs.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `schema.jobOutputs`, `schema.shopifyCatalogJobs` (Task 1).
- Produces: `GET /v1/shopify/catalog/jobs?catalogueId=<uuid>` → `{items: [{jobId, status, resultUrl, published, shopifyMediaId}]}`. Task 7 (frontend) polls this.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-catalog-jobs.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'jobs-secret';
const API_KEY = 'jobs-key';
let c: Containers;
let app: TestApp;
let token: string;
let storeId: string;
let catalogueId: string;
let jobId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_API_SECRET: API_SECRET, SHOPIFY_API_KEY: API_KEY });

  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 801,
      shopDomain: 'catalog-jobs-test.myshopify.com',
      myshopifyDomain: 'catalog-jobs-test.myshopify.com',
      name: 'J',
      email: 'j@j.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('catalog-jobs-test.myshopify.com', API_SECRET, API_KEY);

  catalogueId = crypto.randomUUID();
  const [job] = await app.db
    .insert(schema.jobs)
    .values({ catalogueId, status: 'COMPLETED', creditsCharged: 25, source: 'catalog' })
    .returning();
  jobId = job.id;
  await app.db.insert(schema.jobOutputs).values({ jobId, resultKey: `outputs/${jobId}/result.png` });
  await app.db.insert(schema.shopifyCatalogJobs).values({
    jobId,
    storeId,
    shopifyProductId: 999,
    sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/x.jpg',
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/catalog/jobs', () => {
  it('rejects without a session token', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/shopify/catalog/jobs?catalogueId=${catalogueId}` });
    expect(res.statusCode).toBe(401);
  });

  it('returns the job with a result URL, scoped to the session store', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/shopify/catalog/jobs?catalogueId=${catalogueId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { jobId: string; status: string; resultUrl: string | null; published: boolean }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].jobId).toBe(jobId);
    expect(body.items[0].status).toBe('COMPLETED');
    expect(body.items[0].resultUrl).toContain(jobId);
    expect(body.items[0].published).toBe(false);
  });

  it('excludes jobs belonging to a different store', async () => {
    const otherStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 802,
        shopDomain: 'catalog-jobs-other.myshopify.com',
        myshopifyDomain: 'catalog-jobs-other.myshopify.com',
        name: 'O',
        email: 'o@o.com',
      },
      'tok',
      'read_products',
    );
    const otherToken = signSessionToken('catalog-jobs-other.myshopify.com', API_SECRET, API_KEY);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/shopify/catalog/jobs?catalogueId=${catalogueId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(0);
    void otherStore;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-jobs`
Expected: FAIL — 404.

- [ ] **Step 3: Add the route**

Append to `apps/api/src/modules/shopify/catalog.routes.ts` (inside `shopifyCatalogRoutes`, after the `generate` route):

```ts
  app.get(
    '/v1/shopify/catalog/jobs',
    {
      preHandler: app.requireShopifySession,
      schema: { querystring: z.object({ catalogueId: z.string().uuid() }) },
    },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { catalogueId } = req.query as { catalogueId: string };

      const rows = await app.db
        .select({
          jobId: schema.jobs.id,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          resultKey: schema.jobOutputs.resultKey,
          shopifyMediaId: schema.shopifyCatalogJobs.shopifyMediaId,
        })
        .from(schema.jobs)
        .innerJoin(schema.shopifyCatalogJobs, eq(schema.shopifyCatalogJobs.jobId, schema.jobs.id))
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.catalogueId, catalogueId),
            eq(schema.shopifyCatalogJobs.storeId, store.id),
          ),
        );

      return {
        items: rows.map((r) => ({
          jobId: r.jobId,
          status: r.status,
          errorCode: r.errorCode,
          resultUrl: r.resultKey ? app.storage.publicUrl(r.resultKey) : null,
          published: r.shopifyMediaId != null,
        })),
      };
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-jobs`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/catalog.routes.ts apps/api/test/shopify-catalog-jobs.test.ts
git commit -m "feat(shopify): add catalog job status/preview listing endpoint"
```

---

### Task 5: `POST /v1/shopify/catalog/jobs/:id/publish`

**Files:**
- Create: `apps/api/src/modules/shopify/catalog-publish.ts` (Shopify Admin GraphQL call, isolated for testability)
- Modify: `apps/api/src/modules/shopify/catalog.routes.ts`
- Test: `apps/api/test/shopify-catalog-publish.test.ts`

**Interfaces:**
- Consumes: `decryptToken` (`../../lib/crypto.js`), `SHOPIFY_API_VERSION` (`./service.js`), `app.storage.presignGet(key, expiresIn)`, `keys.output(jobId)` (`@tryme/storage`).
- Produces: `createProductMedia(shopDomain, accessToken, shopifyProductId, imageUrl): Promise<{mediaId: string}>` — used only by the publish route; `POST /v1/shopify/catalog/jobs/:id/publish` → `200 {ok: true, mediaId}`.

- [ ] **Step 1: Write the failing test for the GraphQL helper**

Create `apps/api/test/shopify-catalog-publish.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { createProductMedia } from '../src/modules/shopify/catalog-publish.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'pub-secret';
const API_KEY = 'pub-key';
const ENC_KEY = Buffer.alloc(32, 33).toString('base64');
let c: Containers;
let app: TestApp;
let token: string;
let storeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 901,
      shopDomain: 'catalog-publish-test.myshopify.com',
      myshopifyDomain: 'catalog-publish-test.myshopify.com',
      name: 'P',
      email: 'p@p.com',
    },
    'plaintext-access-token',
    'read_products,write_products',
  );
  storeId = store.id;
  token = signSessionToken('catalog-publish-test.myshopify.com', API_SECRET, API_KEY);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('createProductMedia', () => {
  it('posts a productCreateMedia mutation and returns the media GID', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            productCreateMedia: {
              media: [{ id: 'gid://shopify/MediaImage/123' }],
              mediaUserErrors: [],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const mediaId = await createProductMedia(
      'catalog-publish-test.myshopify.com',
      'plaintext-access-token',
      555,
      'https://r2.example.com/signed/output.png',
    );
    expect(mediaId).toBe('gid://shopify/MediaImage/123');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/admin/api/'),
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('throws when Shopify returns mediaUserErrors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              productCreateMedia: {
                media: [],
                mediaUserErrors: [{ message: 'Product not found' }],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      createProductMedia('catalog-publish-test.myshopify.com', 'tok', 1, 'https://x/y.png'),
    ).rejects.toThrow('Product not found');
    vi.unstubAllGlobals();
  });
});

describe('POST /v1/shopify/catalog/jobs/:id/publish', () => {
  it('rejects without a session token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/shopify/catalog/jobs/x/publish' });
    expect(res.statusCode).toBe(401);
  });

  it('publishes a completed job and is idempotent on a second call', async () => {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ status: 'COMPLETED', creditsCharged: 25, source: 'catalog' })
      .returning();
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey: `outputs/${job.id}/result.png` });
    await app.db.insert(schema.shopifyCatalogJobs).values({
      jobId: job.id,
      storeId,
      shopifyProductId: 42,
      sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/x.jpg',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              productCreateMedia: { media: [{ id: 'gid://shopify/MediaImage/999' }], mediaUserErrors: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const first = await app.inject({
      method: 'POST',
      url: `/v1/shopify/catalog/jobs/${job.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { mediaId: string }).mediaId).toBe('gid://shopify/MediaImage/999');

    const second = await app.inject({
      method: 'POST',
      url: `/v1/shopify/catalog/jobs/${job.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { mediaId: string }).mediaId).toBe('gid://shopify/MediaImage/999');

    const [tracked] = await app.db
      .select()
      .from(schema.shopifyCatalogJobs)
      .where(eq(schema.shopifyCatalogJobs.jobId, job.id));
    expect(tracked.publishedAt).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('rejects publishing a job that has not completed', async () => {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ status: 'PROCESSING', creditsCharged: 25, source: 'catalog' })
      .returning();
    await app.db.insert(schema.shopifyCatalogJobs).values({
      jobId: job.id,
      storeId,
      shopifyProductId: 43,
      sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/x.jpg',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/shopify/catalog/jobs/${job.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-publish`
Expected: FAIL — module `catalog-publish.js` not found / route 404.

- [ ] **Step 3: Write the GraphQL helper**

Create `apps/api/src/modules/shopify/catalog-publish.ts`:

```ts
import { AppError } from '../../lib/errors.js';
import { SHOPIFY_API_VERSION } from './service.js';

interface ProductCreateMediaResponse {
  data?: {
    productCreateMedia?: {
      media: { id: string }[];
      mediaUserErrors: { message: string }[];
    };
  };
  errors?: { message: string }[];
}

const MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { message }
    }
  }
`;

/** Attaches an image (by URL — Shopify fetches it server-side) to a product's
 *  media gallery via the Admin GraphQL API. Throws on any GraphQL-level or
 *  mediaUserErrors failure so the caller can surface a clear error instead of
 *  silently returning no media. */
export async function createProductMedia(
  shopDomain: string,
  accessToken: string,
  shopifyProductId: number,
  imageUrl: string,
): Promise<string> {
  const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: MUTATION,
      variables: {
        productId: `gid://shopify/Product/${shopifyProductId}`,
        media: [{ originalSource: imageUrl, mediaContentType: 'IMAGE' }],
      },
    }),
  });
  if (!res.ok) {
    throw new AppError('SHOPIFY', 502, `Shopify GraphQL request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as ProductCreateMediaResponse;
  if (body.errors?.length) {
    throw new AppError('SHOPIFY', 502, body.errors[0].message);
  }
  const result = body.data?.productCreateMedia;
  if (!result || result.mediaUserErrors.length > 0) {
    throw new AppError('SHOPIFY', 502, result?.mediaUserErrors[0]?.message ?? 'productCreateMedia failed');
  }
  const media = result.media[0];
  if (!media) {
    throw new AppError('SHOPIFY', 502, 'productCreateMedia returned no media');
  }
  return media.id;
}
```

- [ ] **Step 4: Add the publish route**

Append to `apps/api/src/modules/shopify/catalog.routes.ts` (add these imports at the top, and the route inside `shopifyCatalogRoutes`):

```ts
import { keys } from '@tryme/storage';
import { decryptToken } from '../../lib/crypto.js';
import { createProductMedia } from './catalog-publish.js';
```

```ts
  app.post(
    '/v1/shopify/catalog/jobs/:id/publish',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { id: jobId } = req.params as { id: string };

      const [tracked] = await app.db
        .select()
        .from(schema.shopifyCatalogJobs)
        .where(
          and(eq(schema.shopifyCatalogJobs.jobId, jobId), eq(schema.shopifyCatalogJobs.storeId, store.id)),
        )
        .limit(1);
      if (!tracked) throw new AppError('NOT_FOUND', 404, 'catalog job not found');

      if (tracked.shopifyMediaId) {
        return { ok: true, mediaId: tracked.shopifyMediaId };
      }

      const [job] = await app.db
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId));
      if (!job || job.status !== 'COMPLETED') {
        throw new AppError('VALIDATION', 409, 'job has not completed yet');
      }

      const signed = await app.storage.presignGet(keys.output(jobId), 300);
      const accessToken = decryptToken(store.accessToken, app.env.SHOPIFY_TOKEN_ENC_KEY ?? '');
      const mediaId = await createProductMedia(
        store.shopDomain,
        accessToken,
        tracked.shopifyProductId,
        signed.url,
      );

      await app.db
        .update(schema.shopifyCatalogJobs)
        .set({ shopifyMediaId: mediaId, publishedAt: new Date() })
        .where(eq(schema.shopifyCatalogJobs.jobId, jobId));

      return { ok: true, mediaId };
    },
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-catalog-publish`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/catalog-publish.ts apps/api/src/modules/shopify/catalog.routes.ts apps/api/test/shopify-catalog-publish.test.ts
git commit -m "feat(shopify): add catalog image publish-to-product-media endpoint"
```

---

### Task 6: Scope bump + full route-module integration test

**Files:**
- Modify: `apps/api/src/env.ts` (comment only — no code change needed, `SHOPIFY_SCOPES` is already a free-form string env var)
- Modify: `.env` (not committed — gitignored)
- Modify: `apps/shopify-extension/shopify.app.toml`
- Modify: `apps/shopify-extension/shopify.app.dev.toml`

**Interfaces:** none — this task only changes config values, no new code surface.

- [ ] **Step 1: Update `.env`**

In `.env`, change:

```
SHOPIFY_SCOPES=read_products
```

to:

```
SHOPIFY_SCOPES=read_products,write_products
```

- [ ] **Step 2: Update both `shopify.app*.toml` files**

In `apps/shopify-extension/shopify.app.toml` and `apps/shopify-extension/shopify.app.dev.toml`, change:

```toml
[access_scopes]
scopes = "read_products"
```

to:

```toml
[access_scopes]
scopes = "read_products,write_products"
```

- [ ] **Step 3: Restart the local API and re-authenticate the dev store**

Run: restart `pnpm --filter @tryme/api dev` so it picks up the new `SHOPIFY_SCOPES` env value, then visit `/v1/shopify/auth?shop=<your-dev-store>.myshopify.com` in a browser to re-consent with the combined scope set.
Expected: Shopify's OAuth consent screen lists both "View products" and "Edit products" (the two human-readable labels for `read_products`/`write_products`).

- [ ] **Step 4: Verify the stored scope updated**

Run:
```bash
docker exec tryme-postgres psql -U tryon -d tryon_dev -c \
  "select shop_domain, scope from shopify_stores where shop_domain = '<your-dev-store>.myshopify.com';"
```
Expected: `scope` column now reads `read_products,write_products`.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-extension/shopify.app.toml apps/shopify-extension/shopify.app.dev.toml
git commit -m "chore(shopify): request write_products scope for catalog media publishing"
```

(`.env` is gitignored — no commit needed for it, but leave it updated locally.)

---

### Task 7: `apps/shopify` frontend — `CatalogGeneratePage`

**Files:**
- Modify: `apps/shopify/src/types.ts`
- Create: `apps/shopify/src/pages/CatalogGeneratePage.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init)` (existing, `../lib/api.js`), the exact response shapes from Tasks 2/3/4/5:
  - `GET /v1/shopify/catalog/options?gender=&garmentTypeId=` → `{garmentTypes, faces, backgrounds, poses, lowerItems, shoeItems}`
  - `GET /v1/shopify/products/:id/images` → `{images: {id, src}[]}` (pre-existing route)
  - `POST /v1/shopify/catalog/generate` → `{catalogueId, jobIds}`
  - `GET /v1/shopify/catalog/jobs?catalogueId=` → `{items: {jobId, status, resultUrl, published}[]}`
  - `POST /v1/shopify/catalog/jobs/:id/publish` → `{ok, mediaId}`
- Produces: route `/catalog-generate?productId=<id>` in the `apps/shopify` SPA, opened by Task 8's extension `Modal`.

This app has no automated test suite (`tsc -b` only, per the existing `package.json`) — verification here is `tsc` + manual QA against a real dev store, matching how `ProductsPage.tsx`/`FunnelSetupPage.tsx` are verified.

- [ ] **Step 1: Add the new types**

In `apps/shopify/src/types.ts`, append:

```ts
export interface CatalogOptionItem {
  id: string;
  label: string;
  thumbnailUrl: string;
}

export interface CatalogPoseOption extends CatalogOptionItem {
  hasLower: boolean;
  hasShoes: boolean;
}

export interface CatalogOptions {
  garmentTypes: { id: string; label: string }[];
  faces: CatalogOptionItem[];
  backgrounds: CatalogOptionItem[];
  poses: CatalogPoseOption[];
  lowerItems: CatalogOptionItem[];
  shoeItems: CatalogOptionItem[];
}

export interface CatalogGenerateJob {
  jobId: string;
  status: string;
  resultUrl: string | null;
  published: boolean;
}
```

- [ ] **Step 2: Write the page**

Create `apps/shopify/src/pages/CatalogGeneratePage.tsx`:

```tsx
import {
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Spinner,
  Text,
  Thumbnail,
} from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import type { CatalogGenerateJob, CatalogOptions, ShopifyProductImage } from '../types';

const GENDERS = [
  { label: 'Women', value: 'women' },
  { label: 'Men', value: 'men' },
  { label: 'Girls', value: 'girls' },
  { label: 'Boys', value: 'boys' },
];

export default function CatalogGeneratePage() {
  const [params] = useSearchParams();
  const productId = params.get('productId') ?? '';

  const [images, setImages] = useState<ShopifyProductImage[]>([]);
  const [selectedImageSrc, setSelectedImageSrc] = useState<string>('');
  const [gender, setGender] = useState('women');
  const [options, setOptions] = useState<CatalogOptions | null>(null);
  const [garmentTypeId, setGarmentTypeId] = useState<string>('');
  const [faceId, setFaceId] = useState<string>('');
  const [selectedLooks, setSelectedLooks] = useState<Set<string>>(new Set());
  const [backgroundId, setBackgroundId] = useState<string>('');
  const [lowerCatalogId, setLowerCatalogId] = useState<string>('');
  const [shoeCatalogId, setShoeCatalogId] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [jobs, setJobs] = useState<CatalogGenerateJob[]>([]);
  const [catalogueId, setCatalogueId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    apiFetch<{ images: ShopifyProductImage[] }>(`/v1/shopify/products/${productId}/images`)
      .then((res) => {
        setImages(res.images);
        if (res.images[0]) setSelectedImageSrc(res.images[0].src);
      })
      .catch((err) => setError((err as Error).message));
  }, [productId]);

  useEffect(() => {
    const query = new URLSearchParams({ gender });
    if (garmentTypeId) query.set('garmentTypeId', garmentTypeId);
    apiFetch<CatalogOptions>(`/v1/shopify/catalog/options?${query.toString()}`)
      .then(setOptions)
      .catch((err) => setError((err as Error).message));
  }, [gender, garmentTypeId]);

  const poseNeedsLower = useMemo(
    () => options?.poses.some((p) => selectedLooks.has(p.id) && p.hasLower) ?? false,
    [options, selectedLooks],
  );
  const poseNeedsShoes = useMemo(
    () => options?.poses.some((p) => selectedLooks.has(p.id) && p.hasShoes) ?? false,
    [options, selectedLooks],
  );

  function togglePose(poseId: string) {
    setSelectedLooks((prev) => {
      const next = new Set(prev);
      if (next.has(poseId)) next.delete(poseId);
      else next.add(poseId);
      return next;
    });
  }

  const generate = useCallback(async () => {
    if (!selectedImageSrc || !faceId || !backgroundId || selectedLooks.size === 0) {
      setError('Pick a garment image, face, background, and at least one pose first.');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const res = await apiFetch<{ catalogueId: string; jobIds: string[] }>(
        '/v1/shopify/catalog/generate',
        {
          method: 'POST',
          body: JSON.stringify({
            shopifyProductId: Number(productId),
            sourceImageUrl: selectedImageSrc,
            faceId,
            garmentTypeId: garmentTypeId || undefined,
            looks: Array.from(selectedLooks).map((poseId) => ({ poseId, backgroundId })),
            lowerCatalogId: poseNeedsLower ? lowerCatalogId || undefined : undefined,
            shoeCatalogId: poseNeedsShoes ? shoeCatalogId || undefined : undefined,
            aspectRatio: '3:4',
            resolution: 'HD',
          }),
        },
      );
      setCatalogueId(res.catalogueId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [
    selectedImageSrc,
    faceId,
    backgroundId,
    selectedLooks,
    garmentTypeId,
    poseNeedsLower,
    poseNeedsShoes,
    lowerCatalogId,
    shoeCatalogId,
    productId,
  ]);

  useEffect(() => {
    if (!catalogueId) return;
    const interval = setInterval(() => {
      apiFetch<{ items: CatalogGenerateJob[] }>(`/v1/shopify/catalog/jobs?catalogueId=${catalogueId}`)
        .then((res) => setJobs(res.items))
        .catch((err) => setError((err as Error).message));
    }, 3000);
    return () => clearInterval(interval);
  }, [catalogueId]);

  async function publish(jobId: string) {
    try {
      await apiFetch(`/v1/shopify/catalog/jobs/${jobId}/publish`, { method: 'POST' });
      setJobs((prev) => prev.map((j) => (j.jobId === jobId ? { ...j, published: true } : j)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Page title="Generate catalog images" backAction={{ content: 'Product', url: '#' }}>
      <BlockStack gap="400">
        {error && <Text as="p" tone="critical">{error}</Text>}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Garment image</Text>
            <InlineStack gap="200" wrap>
              {images.map((img) => (
                <Button
                  key={img.id}
                  pressed={selectedImageSrc === img.src}
                  onClick={() => setSelectedImageSrc(img.src)}
                >
                  <Thumbnail source={img.src} alt="" size="large" />
                </Button>
              ))}
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Select label="Gender" options={GENDERS} value={gender} onChange={setGender} />
            <Select
              label="Garment type"
              options={[{ label: 'Select...', value: '' }, ...(options?.garmentTypes.map((g) => ({ label: g.label, value: g.id })) ?? [])]}
              value={garmentTypeId}
              onChange={setGarmentTypeId}
            />
          </BlockStack>
        </Card>

        {options && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Model face</Text>
              <InlineStack gap="200" wrap>
                {options.faces.map((f) => (
                  <Button key={f.id} pressed={faceId === f.id} onClick={() => setFaceId(f.id)}>
                    <Thumbnail source={f.thumbnailUrl} alt={f.label} />
                  </Button>
                ))}
              </InlineStack>

              <Text as="h2" variant="headingMd">Background</Text>
              <InlineStack gap="200" wrap>
                {options.backgrounds.map((b) => (
                  <Button key={b.id} pressed={backgroundId === b.id} onClick={() => setBackgroundId(b.id)}>
                    <Thumbnail source={b.thumbnailUrl} alt={b.label} />
                  </Button>
                ))}
              </InlineStack>

              <Text as="h2" variant="headingMd">Poses (select one or more)</Text>
              <InlineStack gap="200" wrap>
                {options.poses.map((p) => (
                  <Button key={p.id} pressed={selectedLooks.has(p.id)} onClick={() => togglePose(p.id)}>
                    <Thumbnail source={p.thumbnailUrl} alt={p.label} />
                  </Button>
                ))}
              </InlineStack>

              {poseNeedsLower && (
                <Select
                  label="Lower garment"
                  options={[{ label: 'Select...', value: '' }, ...options.lowerItems.map((i) => ({ label: i.label, value: i.id }))]}
                  value={lowerCatalogId}
                  onChange={setLowerCatalogId}
                />
              )}
              {poseNeedsShoes && (
                <Select
                  label="Shoes"
                  options={[{ label: 'Select...', value: '' }, ...options.shoeItems.map((i) => ({ label: i.label, value: i.id }))]}
                  value={shoeCatalogId}
                  onChange={setShoeCatalogId}
                />
              )}

              <Button variant="primary" loading={generating} onClick={generate}>
                Generate
              </Button>
            </BlockStack>
          </Card>
        )}

        {jobs.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Results</Text>
              <InlineGrid columns={3} gap="300">
                {jobs.map((j) => (
                  <BlockStack key={j.jobId} gap="200">
                    {j.status === 'COMPLETED' && j.resultUrl ? (
                      <Thumbnail source={j.resultUrl} alt="" size="large" />
                    ) : j.status === 'FAILED' ? (
                      <Text as="p" tone="critical">Generation failed</Text>
                    ) : (
                      <Spinner size="small" />
                    )}
                    {j.status === 'COMPLETED' && (
                      <Button disabled={j.published} onClick={() => publish(j.jobId)}>
                        {j.published ? 'Added to product' : 'Add to product'}
                      </Button>
                    )}
                  </BlockStack>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 3: Register the route**

In `apps/shopify/src/App.tsx`, add the import and route:

```ts
import CatalogGeneratePage from './pages/CatalogGeneratePage';
```

```tsx
          <Route path="/catalog-generate" element={<CatalogGeneratePage />} />
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin exec tsc --noEmit -p .`
Expected: no errors. (Verify the exact package name first — it was `@tryme/shopify-admin` per prior work in this session, not `@tryme/shopify`.)

- [ ] **Step 5: Manual smoke test**

Run: `pnpm --filter @tryme/shopify-admin dev`, open the embedded app in a dev store via the Partner Dashboard, navigate to `/catalog-generate?productId=<a real synced product id>`, confirm: product images load, gender/garment-type/face/background/pose selections populate, "Generate" creates a catalogueId and starts polling, completed results show thumbnails with a working "Add to product" button.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src/types.ts apps/shopify/src/pages/CatalogGeneratePage.tsx apps/shopify/src/App.tsx
git commit -m "feat(shopify-admin): add catalog image generation page"
```

---

### Task 8: Admin UI Extension — product-page block + Modal

**Files:**
- Create: `apps/shopify-extension/extensions/product-catalog-extension/shopify.extension.toml`
- Create: `apps/shopify-extension/extensions/product-catalog-extension/src/BlockExtension.tsx`

**Interfaces:**
- Consumes: `apps/shopify` app's deployed URL (`application_url` from `shopify.app.toml`/`shopify.app.dev.toml`) + `/catalog-generate?productId=` route from Task 7.
- Produces: a `product-details` block visible on the Shopify product page.

No automated tests — Admin UI Extensions are verified via `shopify app dev` against a live dev store, same as the existing `tryon-theme-extension`.

- [ ] **Step 1: Scaffold the extension**

Run: `cd apps/shopify-extension && shopify app generate extension --type=admin_action --name=product-catalog-extension`
When prompted for the extension type/target, choose the Admin block target for product details (`admin.product-details.block.render`) if the CLI offers a choice; otherwise accept the generated action extension and adjust the target in `shopify.extension.toml` per Step 2.
Expected: creates `apps/shopify-extension/extensions/product-catalog-extension/` with a starter `shopify.extension.toml` and `src/` entry file.

- [ ] **Step 2: Set the extension target**

Edit the generated `apps/shopify-extension/extensions/product-catalog-extension/shopify.extension.toml` so it reads:

```toml
api_version = "2026-07"

[[extensions]]
type = "ui_extension"
name = "product-catalog-extension"
handle = "product-catalog-extension"

  [[extensions.targeting]]
  target = "admin.product-details.block.render"
  module = "./src/BlockExtension.tsx"
```

- [ ] **Step 3: Write the block**

Create/replace `apps/shopify-extension/extensions/product-catalog-extension/src/BlockExtension.tsx`:

```tsx
import { reactExtension, useApi, AdminBlock, Button, Modal } from '@shopify/ui-extensions-react/admin';
import { useState } from 'react';

const TARGET = 'admin.product-details.block.render';

export default reactExtension(TARGET, () => <ProductCatalogBlock />);

function ProductCatalogBlock() {
  const { data } = useApi(TARGET);
  const [open, setOpen] = useState(false);
  const productId = data?.selected?.[0]?.id?.split('/').pop() ?? '';

  return (
    <AdminBlock title="TryMe catalog images">
      <Button onClick={() => setOpen(true)} disabled={!productId}>
        Generate catalog images
      </Button>
      {open && (
        <Modal
          id="tryme-catalog-generate-modal"
          src={`https://catalog-admin.tryme.com/catalog-generate?productId=${productId}`}
          title="Generate catalog images"
          onHide={() => setOpen(false)}
        />
      )}
    </AdminBlock>
  );
}
```

The `Modal`'s `src` must point at wherever `apps/shopify` (Task 7) is actually served — replace `https://catalog-admin.tryme.com` with the real `application_url` value from `shopify.app.dev.toml` for local dev, and the production `apps/shopify` deployment URL for `shopify.app.toml`. If `data.selected` is unavailable (unsaved "Add product" page — the open risk flagged in the design spec), `productId` will be empty and the button stays disabled; confirm this behavior against a real dev store in Step 4 and adjust the disabled-state messaging if Shopify's actual behavior differs.

- [ ] **Step 4: Run the extension locally and verify**

Run: `cd apps/shopify-extension && shopify app dev`
Expected: CLI prints a preview URL; opening a product's edit page in the connected dev store shows the "TryMe catalog images" block with a "Generate catalog images" button; clicking it opens a modal iframing `CatalogGeneratePage` from Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-extension/extensions/product-catalog-extension/
git commit -m "feat(shopify-extension): add product-page catalog generation admin block"
```

---

## Self-Review

**Spec coverage:**
- §1 Extension surface → Task 8.
- §2 Frontend page in `apps/shopify` → Task 7.
- §3 Backend route module → Tasks 2, 3, 4, 5.
- §4 Garment source resolution → Task 3 (`downloadProductImageToR2`).
- §5 Job creation reuse (`createJob`) → Task 3.
- §6 Data model (`shopify_catalog_jobs`) → Task 1.
- §7 Publish flow → Task 5.
- §8 Scopes/reauth → Task 6.
- §9 Error handling → covered inline across Tasks 3–5 (402/409/idempotent-200/502 all asserted in tests).
- Testing section → every backend task is TDD'd; frontend/extension tasks call out manual QA explicitly, consistent with the spec's own testing section.

**Placeholder scan:** no TBD/TODO markers; every step has complete, runnable code.

**Type consistency:** `CatalogOptions`/`CatalogGenerateJob`/`ShopifyProductImage` in Task 7 match the exact field names returned by Tasks 2/3/4/5's routes (`garmentTypes`, `faces`, `backgrounds`, `poses`, `lowerItems`, `shoeItems`, `hasLower`, `hasShoes`, `jobId`, `status`, `resultUrl`, `published`). `createProductMedia`'s signature in Task 5's helper matches its two call sites (test + route).
