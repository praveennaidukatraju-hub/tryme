# Developer API Decoupling from Internal Catalog/Tryon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the public developer API (`/v1/dev/*`) its own dedicated backing tables so admins control what those live, merchant-facing endpoints accept — fully independent of the internal Studio/kiosk/merchant `tryon_categories` and `garment_subcategories` rows they currently share — with **zero change to the public endpoint contract**.

**Architecture:** Two new admin-owned tables, `dev_tryon_categories` (slug → workflow template) and single-row `dev_saree_mannequin_config` (workflow template), are backfilled once from the current active internal rows. The dev-API job-creation code resolves its ComfyUI workflow from these new tables only and **snapshots the resolved `workflowTemplateId` into `job_inputs.params`**. The dispatcher already trusts that snapshot (`apps/dispatcher/src/job/processor.ts:664` for tryon, `:896-897` for saree-mannequin) and re-resolves through the internal tables only when the snapshot is absent — so once the dev paths always snapshot, the dispatcher needs **no changes** and stops touching internal catalog rows for dev jobs. Admins manage the new tables through a new "Dev API" admin page; the request body merchants send (`category` slug, `garment` image) is byte-for-byte unchanged.

**Tech Stack:** PostgreSQL 16 + Drizzle ORM, Fastify 5 + `fastify-type-provider-zod`, Vitest (no testcontainers — reuses docker-compose Postgres/Redis/MinIO), Vite + React admin SPA.

## Global Constraints

- pnpm workspaces only — never introduce npm/yarn lockfiles. ESM everywhere (`"type": "module"`, `.js` import specifiers in TS source).
- All shared request/response shapes are Zod schemas in `packages/types/src/*` — single source of truth, imported by both `apps/api` and `apps/admin-web`.
- `@tryme/db` exports `* as schema` from `packages/db/src/index.ts`. New tables go in a schema file re-exported from `packages/db/src/schema/index.ts`. Never add a duplicate `schema` re-export.
- Migrations live in `packages/db/src/migrations/`. **The next free index is `0119`** (highest merged is `0118_seed_saree_mannequin_style`). Generate via `pnpm db:generate`; data-only migrations (backfills/seeds) are hand-written SQL files added to `meta/_journal.json` the same way `0118_seed_saree_mannequin_style.sql` was.
- Logger: pino via `@tryme/logger`. No `console.log` in committed code.
- All `/admin/*` routes must be gated by `requireAdmin([...roles])` from `apps/api/src/modules/admin/guard.js`.
- The public endpoint contract (`/v1/dev/tryon`, `/v1/dev/saree-mannequin`, `/v1/dev/categories`, `/v1/dev/jobs/:id`) — request fields, response fields, status codes, error codes — MUST NOT change. This plan only changes which table the workflow is resolved from.
- Credit cost, watermark, rate-limit, and image-sniff behavior of the dev endpoints stay exactly as they are.
- Tests: `pnpm docker:up` must be running. API tests live under `apps/api/test/`; the plain `pnpm --filter @tryme/api test` runs `vitest run --exclude 'test/integration/**'`, and files directly under `apps/api/test/` (e.g. `dev-tryon-create.test.ts`) ARE included in that default run — run a single file with `pnpm --filter @tryme/api test -- <filename>`.

---

## File Structure

**Create:**
- `packages/db/src/schema/dev-api.ts` — `devTryonCategories`, `devSareeMannequinConfig` Drizzle tables.
- `packages/db/src/migrations/0119_*.sql` — generated DDL for the two tables (name assigned by `pnpm db:generate`).
- `packages/db/src/migrations/0120_backfill_dev_api_tables.sql` — hand-written data migration copying active internal rows.
- `apps/api/src/modules/admin/dev-api.routes.ts` — admin CRUD for dev tryon categories + dev saree config.
- `apps/admin-web/src/pages/DevApiPage.tsx` — admin UI to manage the new tables.
- `apps/api/test/admin-dev-api.test.ts` — admin CRUD route tests.

**Modify:**
- `packages/db/src/schema/index.ts` — add `export * from './dev-api.js';`.
- `packages/types/src/dev.ts` — add admin CRUD Zod bodies (dev tryon category create/update, dev saree config update).
- `apps/api/src/modules/dev/create-job.ts:101-157` — `createDevTryonJob` resolves off `devTryonCategories`.
- `apps/api/src/modules/dev/create-saree-mannequin-job.ts` — resolves off `devSareeMannequinConfig`, snapshots `workflowTemplateId` into params, sets `garmentTypeId: null`.
- `apps/api/src/modules/dev/routes.ts:44-63` — `/v1/dev/categories` reads `devTryonCategories`.
- `apps/api/src/server.ts` — register `adminDevApiRoutes`.
- `apps/admin-web/src/App.tsx` — route + nav label for `/dev-api`.
- `apps/admin-web/src/components/Sidebar.tsx` — sidebar entry under "Content".
- `apps/api/test/helpers/merchant.ts` — add `createTestDevTryonCategory`, `createTestDevSareeMannequinConfig` helpers.
- `apps/api/test/dev-tryon-create.test.ts` — reseed via the new dev helper.
- `apps/api/test/dev-saree-mannequin-create.test.ts` — reseed via the new dev helper.
- `apps/api/test/dev-read-routes.test.ts` — reseed `/v1/dev/categories` via the new dev helper.
- `docs/progress.md` — dated entry.

**Note — the abandoned Postman commit:** branch `feat/saree-mannequin-face-url-workflow` carries one unmerged commit (`9bf790a5`, a hand-written `apps/api/dev-api.postman_collection.json`). Do not merge it. Task 10 documents generating the collection from the live `@fastify/swagger` OpenAPI spec instead; the branch can be deleted after this plan lands.

---

### Task 1: `dev_tryon_categories` schema + migration

**Files:**
- Create: `packages/db/src/schema/dev-api.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/migrations/0119_*.sql` (via `pnpm db:generate`)

**Interfaces:**
- Produces: `schema.devTryonCategories` with columns `id: uuid pk`, `name: text notnull`, `slug: text notnull unique`, `workflowTemplateId: uuid → workflowTemplates.id (onDelete set null)`, `sortOrder: integer notnull default 0`, `isActive: boolean notnull default true`, `createdAt`, `updatedAt` timestamptz notnull defaultNow.

- [ ] **Step 1: Write the schema file**

Create `packages/db/src/schema/dev-api.ts` (mirrors `tryon.ts` exactly, dedicated to the dev API):

```ts
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';

// Dedicated developer-API try-on categories. Deliberately NOT tryon_categories:
// the public /v1/dev/* surface must be controllable independent of the internal
// Studio/kiosk/merchant catalog, so an admin renaming or deactivating an internal
// category never silently changes what third-party API callers can request.
export const devTryonCategories = pgTable('dev_tryon_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
    onDelete: 'set null',
  }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Re-export from the schema barrel**

In `packages/db/src/schema/index.ts`, add the line in alphabetical position (after `./credits.js`):

```ts
export * from './dev-api.js';
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0119_<random-name>.sql` containing `CREATE TABLE "dev_tryon_categories" (...)` and appends an entry to `meta/_journal.json`. Confirm the new file's index is `0119` (rename it and its journal entry to `0119` if drizzle-kit picked a higher number — server's index is canonical, this branch yields upward from the highest merged `0118`).

- [ ] **Step 4: Apply and verify**

Run: `pnpm db:migrate`
Expected: applies cleanly; `psql "$DATABASE_URL" -c '\d dev_tryon_categories'` shows the table with a unique index on `slug`.

- [ ] **Step 5: Typecheck the db package**

Run: `pnpm --filter @tryme/db build`
Expected: `tsc` exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/dev-api.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): add dedicated dev_tryon_categories table"
```

---

### Task 2: `dev_saree_mannequin_config` schema + migration

**Files:**
- Modify: `packages/db/src/schema/dev-api.ts`
- Create: `packages/db/src/migrations/012N_*.sql` (via `pnpm db:generate`)

**Interfaces:**
- Consumes: `workflowTemplates` from `./models.js` (already imported in Task 1).
- Produces: `schema.devSareeMannequinConfig` — single-row config table. Columns `id: uuid pk default '00000000-0000-0000-0000-000000000002'::uuid`, `workflowTemplateId: uuid → workflowTemplates.id (onDelete set null)`, `isActive: boolean notnull default true`, `updatedAt` timestamptz notnull defaultNow. (Fixed sentinel id, upserted — same single-row pattern as `tryon_settings`, which uses `...0001`; this uses `...0002` to avoid collision.)

- [ ] **Step 1: Add the table to the dev-api schema file**

Append to `packages/db/src/schema/dev-api.ts`:

```ts
import { sql } from 'drizzle-orm';

// Single-row global config for the developer-API saree-mannequin endpoint.
// Upsert with the fixed id below. Owns its own workflow pointer so the dev
// endpoint never resolves through garment_subcategories.requires_mannequin_step
// (which the internal saree Studio flow shares).
export const devSareeMannequinConfig = pgTable('dev_saree_mannequin_config', {
  id: uuid('id').primaryKey().default(sql`'00000000-0000-0000-0000-000000000002'::uuid`),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
    onDelete: 'set null',
  }),
  isActive: boolean('is_active').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add `sql` to the existing `drizzle-orm` import if not already present (the Task 1 file imports only from `drizzle-orm/pg-core`; add `import { sql } from 'drizzle-orm';` at the top).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0120_<name>.sql` with `CREATE TABLE "dev_saree_mannequin_config" (...)`. Confirm/rename the index to `0120`.

- [ ] **Step 3: Apply and verify**

Run: `pnpm db:migrate`
Expected: applies cleanly; `psql "$DATABASE_URL" -c '\d dev_saree_mannequin_config'` shows the table.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/db build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/dev-api.ts packages/db/src/migrations/
git commit -m "feat(db): add dev_saree_mannequin_config single-row table"
```

---

### Task 3: One-time backfill migration from internal tables

**Files:**
- Create: `packages/db/src/migrations/0121_backfill_dev_api_tables.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: `tryon_categories`, `garment_subcategories` (read-only source rows), `dev_tryon_categories`, `dev_saree_mannequin_config` (Tasks 1-2).
- Produces: nothing new in code — seeds the two new tables so live merchants keep working the instant the resolution code switches over.

- [ ] **Step 1: Write the hand-authored data migration**

Create `packages/db/src/migrations/0121_backfill_dev_api_tables.sql`:

```sql
-- Backfill dev_tryon_categories from the currently-active internal tryon_categories.
-- Idempotent: ON CONFLICT (slug) DO NOTHING so re-running is safe. Copies slug,
-- name, workflow, sort order — the fields the dev endpoint resolves and lists.
INSERT INTO dev_tryon_categories (name, slug, workflow_template_id, sort_order, is_active)
SELECT name, slug, workflow_template_id, sort_order, TRUE
FROM tryon_categories
WHERE is_active = TRUE
ON CONFLICT (slug) DO NOTHING;

-- Seed the single dev saree-mannequin config row from whichever garment
-- subcategory currently drives the internal mannequin step (exactly one today:
-- Flat Saree, requires_mannequin_step = TRUE). Fixed sentinel id, idempotent.
INSERT INTO dev_saree_mannequin_config (id, workflow_template_id, is_active)
SELECT
  '00000000-0000-0000-0000-000000000002'::uuid,
  gsc.mannequin_workflow_template_id,
  TRUE
FROM garment_subcategories gsc
WHERE gsc.requires_mannequin_step = TRUE
  AND gsc.mannequin_workflow_template_id IS NOT NULL
ORDER BY gsc.id
LIMIT 1
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Register the migration in the journal**

In `packages/db/src/migrations/meta/_journal.json`, append an entry to the `entries` array mirroring the shape of the prior data-migration entry (`0118_seed_saree_mannequin_style`). Use the next `idx` (one above `0120`), `version` matching sibling entries, current epoch millis for `when`, and `"tag": "0121_backfill_dev_api_tables"`, `"breakpoints": true`.

```json
{
  "idx": 121,
  "version": "7",
  "when": <current-epoch-millis>,
  "tag": "0121_backfill_dev_api_tables",
  "breakpoints": true
}
```

(Match `version` to the value the sibling entries actually use — read the last entry in the file and copy it.)

- [ ] **Step 3: Apply and verify**

Run: `pnpm db:migrate`
Expected: applies cleanly. Verify:
```bash
psql "$DATABASE_URL" -c 'SELECT slug, is_active FROM dev_tryon_categories ORDER BY sort_order;'
psql "$DATABASE_URL" -c 'SELECT id, workflow_template_id, is_active FROM dev_saree_mannequin_config;'
```
Expected: dev_tryon_categories has one row per active internal category; dev_saree_mannequin_config has exactly one row (or zero if no local mannequin garment type is seeded — acceptable in a bare dev DB).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/migrations/0121_backfill_dev_api_tables.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): backfill dev-api tables from active internal rows"
```

---

### Task 4: Test helpers for the new dev tables

**Files:**
- Modify: `apps/api/test/helpers/merchant.ts`

**Interfaces:**
- Consumes: `schema.devTryonCategories`, `schema.devSareeMannequinConfig`, `schema.workflowTemplates`, `TestApp`.
- Produces:
  - `createTestDevTryonCategory(app, opts: { slug: string; name?: string; isActive?: boolean; templateIsActive?: boolean; sortOrder?: number }): Promise<{ categoryId: string; workflowTemplateId: string }>`
  - `createTestDevSareeMannequinConfig(app, opts?: { isActive?: boolean; templateIsActive?: boolean; withPersonNode?: boolean }): Promise<{ workflowTemplateId: string }>`

- [ ] **Step 1: Add `createTestDevTryonCategory`**

Append to `apps/api/test/helpers/merchant.ts` (mirrors `createTestTryonCategory` but targets the dev table):

```ts
export async function createTestDevTryonCategory(
  app: TestApp,
  opts: {
    slug: string;
    name?: string;
    isActive?: boolean;
    templateIsActive?: boolean;
    sortOrder?: number;
  },
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `wf-${randomUUID()}`,
      label: 'Test Dev Tryon WF',
      jsonContent: {},
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test workflow template');

  const [cat] = await app.db
    .insert(schema.devTryonCategories)
    .values({
      name: opts.name ?? 'Test Dev Category',
      slug: opts.slug,
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  if (!cat) throw new Error('failed to create test dev tryon category');

  return { categoryId: cat.id, workflowTemplateId: wf.id };
}
```

- [ ] **Step 2: Add `createTestDevSareeMannequinConfig`**

Append to the same file (mirrors `createTestSareeMannequinGarmentType` but writes the single-row dev config instead of a garment subcategory):

```ts
export async function createTestDevSareeMannequinConfig(
  app: TestApp,
  opts: { isActive?: boolean; templateIsActive?: boolean; withPersonNode?: boolean } = {},
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `dev-saree-step1-${randomUUID()}`,
      label: 'Test Dev Saree Step1 WF',
      jsonContent: {
        '31': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '134': { class_type: 'SaveImage', inputs: {} },
      },
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'saree_step1',
      tryonPersonNodeId: opts.withPersonNode ? '1' : null,
      tryonGarmentNodeId: '31',
      tryonOutputNodeId: '134',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test dev saree step1 workflow template');

  await app.db
    .insert(schema.devSareeMannequinConfig)
    .values({
      id: '00000000-0000-0000-0000-000000000002',
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: schema.devSareeMannequinConfig.id,
      set: { workflowTemplateId: wf.id, isActive: opts.isActive ?? true, updatedAt: new Date() },
    });

  return { workflowTemplateId: wf.id };
}
```

- [ ] **Step 3: Typecheck the test helper compiles**

Run: `pnpm --filter @tryme/api typecheck`
Expected: exits 0 (helpers are unused so far — this just confirms they compile against the new schema).

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/helpers/merchant.ts
git commit -m "test(api): add dev-api table test helpers"
```

---

### Task 5: Resolve `/v1/dev/tryon` workflow from `dev_tryon_categories`

**Files:**
- Modify: `apps/api/src/modules/dev/create-job.ts:101-157`
- Modify: `apps/api/test/dev-tryon-create.test.ts`

**Interfaces:**
- Consumes: `schema.devTryonCategories`, `createTestDevTryonCategory` (Task 4).
- Produces: `createDevTryonJob` unchanged signature; internally resolves `categorySlug` → `workflowTemplateId` off `devTryonCategories` and snapshots it into `job_inputs.params.workflowTemplateId` (already the shape the dispatcher reads at `processor.ts:664`).

- [ ] **Step 1: Update the failing test to seed the dev table**

In `apps/api/test/dev-tryon-create.test.ts`, change the import and the seeding calls from `createTestTryonCategory` to `createTestDevTryonCategory`:

Change the import line (currently `createTestTryonCategory,` around line 9) to:
```ts
  createTestDevTryonCategory,
```
And every `await createTestTryonCategory(app, {...})` in the `beforeAll`/setup (lines ~72-75) to `await createTestDevTryonCategory(app, {...})` with the identical options.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-tryon-create`
Expected: FAIL — the happy-path test now seeds only `dev_tryon_categories`, but `createDevTryonJob` still queries `tryon_categories`, so the previously-valid `upper` slug resolves to "unknown or inactive category" (400) → assertion failure on the expected 202.

- [ ] **Step 3: Rewire `createDevTryonJob` to the dev table**

In `apps/api/src/modules/dev/create-job.ts`, replace the category resolution block (lines 117-138, the `.from(schema.tryonCategories)...` query and its two guards) with the same query against `devTryonCategories`:

```ts
  // Resolve off the DEDICATED dev table, not tryon_categories — the public API
  // surface is controlled independent of the internal Studio catalog. Kill-switch
  // parity: an inactive dev category, or one whose workflow template is inactive,
  // must not resolve. Runs before any credit movement, so a rejected request is free.
  const [category] = await app.db
    .select({
      workflowTemplateId: schema.devTryonCategories.workflowTemplateId,
      templateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.devTryonCategories)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.devTryonCategories.workflowTemplateId),
    )
    .where(
      and(
        eq(schema.devTryonCategories.slug, params.categorySlug),
        eq(schema.devTryonCategories.isActive, true),
      ),
    )
    .limit(1);
```

Leave everything else in the function unchanged — the two `if (!category)` / `if (!category.workflowTemplateId ...)` guards, the ban check, and the `createDevJobCore(...)` call whose `buildJobInputs` already sets `params: { personKey, workflowTemplateId: category.workflowTemplateId }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-tryon-create`
Expected: PASS (all cases — happy path 202, unknown slug 400, inactive category 400, dead-workflow 400 — now exercised against the dev table).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/create-job.ts apps/api/test/dev-tryon-create.test.ts
git commit -m "feat(api): resolve /v1/dev/tryon workflow from dev_tryon_categories"
```

---

### Task 6: Serve `/v1/dev/categories` from `dev_tryon_categories`

**Files:**
- Modify: `apps/api/src/modules/dev/routes.ts:44-63`
- Modify: `apps/api/test/dev-read-routes.test.ts`

**Interfaces:**
- Consumes: `schema.devTryonCategories`, `createTestDevTryonCategory` (Task 4).
- Produces: `GET /v1/dev/categories` response shape unchanged (`{ categories: [{ slug, name }] }`), sourced from the dev table.

- [ ] **Step 1: Update the read-routes test to seed the dev table**

In `apps/api/test/dev-read-routes.test.ts`, switch the categories-listing test's seeding from `createTestTryonCategory` to `createTestDevTryonCategory` (import swap + call sites), keeping the same slugs/names/`isActive` flags so the existing assertions on which categories appear still hold.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Expected: FAIL — categories now seeded only into `dev_tryon_categories`, but the route still reads `tryon_categories`, so the listing comes back empty (or missing the seeded rows) and the assertion fails.

- [ ] **Step 3: Rewire the route**

In `apps/api/src/modules/dev/routes.ts`, in the `GET /v1/dev/categories` handler (lines 55-62), replace the three `schema.tryonCategories` references with `schema.devTryonCategories`:

```ts
    async () => {
      const rows = await app.db
        .select({ slug: schema.devTryonCategories.slug, name: schema.devTryonCategories.name })
        .from(schema.devTryonCategories)
        .where(eq(schema.devTryonCategories.isActive, true))
        .orderBy(asc(schema.devTryonCategories.sortOrder));
      return { categories: rows };
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/test/dev-read-routes.test.ts
git commit -m "feat(api): serve /v1/dev/categories from dev_tryon_categories"
```

---

### Task 7: Resolve `/v1/dev/saree-mannequin` from `dev_saree_mannequin_config`

**Files:**
- Modify: `apps/api/src/modules/dev/create-saree-mannequin-job.ts`
- Modify: `apps/api/test/dev-saree-mannequin-create.test.ts`

**Interfaces:**
- Consumes: `schema.devSareeMannequinConfig`, `getSareeMannequinDevCreditCost` (already imported), `createTestDevSareeMannequinConfig` (Task 4).
- Produces: `createDevSareeMannequinJob` unchanged signature; resolves the workflow from the single-row dev config, **snapshots `workflowTemplateId` into `params`**, and sets `garmentTypeId: null` so the dispatcher (`processor.ts:896-907`) uses the snapshot and never reads `garment_subcategories`.

- [ ] **Step 1: Update the test to seed the dev config**

In `apps/api/test/dev-saree-mannequin-create.test.ts`, switch the setup from `createTestSareeMannequinGarmentType` to `createTestDevSareeMannequinConfig` (import swap + call site). The existing assertions (202 on success, relative balance deduction, 400 when not configured) stay — only the seeding source changes. For the "not configured" case, seed with `{ isActive: false }` or seed no config at all (see Step 3 for which guard fires).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-saree-mannequin-create`
Expected: FAIL — job creation still queries `garment_subcategories.requiresMannequinStep`, which the test no longer seeds, so the happy-path request returns 400 `BAD_CATEGORY` instead of 202.

- [ ] **Step 3: Rewire `createDevSareeMannequinJob`**

Replace the body of `apps/api/src/modules/dev/create-saree-mannequin-job.ts` from the `getSareeMannequinDevCreditCost` call through the `return createDevJobCore(...)` with a version that reads the dev config and snapshots the workflow:

```ts
export async function createDevSareeMannequinJob(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    garmentKey: string;
  },
): Promise<{ jobId: string }> {
  const cost = await getSareeMannequinDevCreditCost(app);

  // Resolve off the DEDICATED single-row dev config, not garment_subcategories —
  // the public saree-mannequin endpoint owns its own workflow pointer, so the
  // internal saree Studio flow can change independently. Snapshotting the resolved
  // workflow into params (below) means the dispatcher never re-reads any internal
  // catalog table for this job (see processor.ts processDevSareeMannequin).
  const [config] = await app.db
    .select({
      workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
      isActive: schema.devSareeMannequinConfig.isActive,
    })
    .from(schema.devSareeMannequinConfig)
    .limit(1);

  if (!config || !config.isActive || !config.workflowTemplateId) {
    throw new AppError('BAD_CATEGORY', 400, 'saree mannequin generation is not configured');
  }

  const [template] = await app.db
    .select({ isActive: schema.workflowTemplates.isActive })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, config.workflowTemplateId));
  if (!template?.isActive) {
    throw new AppError('BAD_CATEGORY', 400, 'saree mannequin generation is not configured');
  }

  const [user] = await app.db
    .select({ isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.id, params.merchantUserId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'account suspended');

  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    metricKind: 'saree_mannequin',
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      garmentTypeId: null,
      faceId: null,
      // Snapshot the workflow so the dispatcher routes off params, not internal tables.
      params: { kind: 'saree_mannequin', workflowTemplateId: config.workflowTemplateId },
    }),
  });
}
```

Remove the now-unused `garmentType` query and the `schema.garmentSubcategories` reference. Keep the existing imports (`schema`, `eq`, `AppError`, `getSareeMannequinDevCreditCost`, `createDevJobCore`) — `garmentSubcategories` was accessed via the `schema` namespace so no import line changes; the JSDoc block at the top of the file referencing `garment_subcategories` should be updated to describe the dev-config resolution instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-saree-mannequin-create`
Expected: PASS (all cases).

- [ ] **Step 5: Full dispatcher saree-mannequin regression (no dispatcher code changed, but confirm the snapshot path)**

Run: `pnpm --filter @tryme/dispatcher test -- saree-mannequin`
Expected: PASS — confirms the dispatcher's existing snapshot-first branch handles a dev job whose `params.workflowTemplateId` is set and `garmentTypeId` is null. If the dispatcher integration test seeds a dev saree job, ensure it sets `params.workflowTemplateId` (it exercises the `snapshottedWorkflowTemplateId` branch at `processor.ts:896`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/dev/create-saree-mannequin-job.ts apps/api/test/dev-saree-mannequin-create.test.ts
git commit -m "feat(api): resolve dev saree-mannequin from dev_saree_mannequin_config, snapshot workflow"
```

---

### Task 8: Zod schemas for admin dev-API management

**Files:**
- Modify: `packages/types/src/dev.ts`

**Interfaces:**
- Produces (all exported from `@tryme/types`):
  - `CreateDevTryonCategoryBody = { name: string(1..); slug: string(1..); workflowTemplateId?: string.uuid | null; sortOrder?: int; isActive?: boolean }`
  - `UpdateDevTryonCategoryBody = { name?; workflowTemplateId?: string.uuid | null; sortOrder?: int; isActive?: boolean }`
  - `UpdateDevSareeConfigBody = { workflowTemplateId?: string.uuid | null; isActive?: boolean }`
  - `DevTryonCategoryRow` (response) and `DevSareeConfigRow` (response) inferred types for the admin UI.

- [ ] **Step 1: Add the schemas**

Append to `packages/types/src/dev.ts`:

```ts
// ---- Admin management of the developer-API catalog (see /admin/dev-api/*) ----

const slugRule = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens');

export const CreateDevTryonCategoryBody = z.object({
  name: z.string().min(1).max(120),
  slug: slugRule,
  workflowTemplateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type CreateDevTryonCategoryBody = z.infer<typeof CreateDevTryonCategoryBody>;

export const UpdateDevTryonCategoryBody = z.object({
  name: z.string().min(1).max(120).optional(),
  workflowTemplateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDevTryonCategoryBody = z.infer<typeof UpdateDevTryonCategoryBody>;

export const UpdateDevSareeConfigBody = z.object({
  workflowTemplateId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDevSareeConfigBody = z.infer<typeof UpdateDevSareeConfigBody>;

export const DevTryonCategoryRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  workflowTemplateId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DevTryonCategoryRow = z.infer<typeof DevTryonCategoryRow>;

export const DevSareeConfigRow = z.object({
  workflowTemplateId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  updatedAt: z.string(),
});
export type DevSareeConfigRow = z.infer<typeof DevSareeConfigRow>;
```

`z` is already imported at the top of the file.

- [ ] **Step 2: Build the types package**

Run: `pnpm --filter @tryme/types build`
Expected: `tsc` exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/dev.ts
git commit -m "feat(types): add admin dev-API management schemas"
```

---

### Task 9: Admin CRUD routes for the dev-API catalog

**Files:**
- Create: `apps/api/src/modules/admin/dev-api.routes.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/test/admin-dev-api.test.ts`

**Interfaces:**
- Consumes: `schema.devTryonCategories`, `schema.devSareeMannequinConfig`, `requireAdmin`, the Task 8 Zod bodies.
- Produces: `adminDevApiRoutes(app)` registering:
  - `GET /admin/dev-api/tryon-categories` → `DevTryonCategoryRow[]`
  - `POST /admin/dev-api/tryon-categories` (`CreateDevTryonCategoryBody`) → row; 409 on duplicate slug
  - `PATCH /admin/dev-api/tryon-categories/:id` (`UpdateDevTryonCategoryBody`) → row; 404 if missing
  - `DELETE /admin/dev-api/tryon-categories/:id` → `{ ok: true }`; 404 if missing
  - `GET /admin/dev-api/saree-config` → `DevSareeConfigRow`
  - `PATCH /admin/dev-api/saree-config` (`UpdateDevSareeConfigBody`) → `DevSareeConfigRow` (upsert single row)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/admin-dev-api.test.ts`. Use the existing admin-route test scaffolding (copy the imports and `beforeAll`/`afterAll` from `apps/api/test/dev-read-routes.test.ts` or another admin test — `buildTestApp`, a super-admin auth token helper, a workflow template created via `createTestDevTryonCategory` to reuse its returned `workflowTemplateId`). Cover:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { createSuperAdmin } from './helpers/admin.js'; // whatever the existing helper is called
import { createTestDevTryonCategory } from './helpers/merchant.js';

describe('admin dev-api routes', () => {
  let app: TestApp;
  let token: string;
  let wfId: string;

  beforeAll(async () => {
    app = await buildTestApp(/* container */);
    ({ token } = await createSuperAdmin(app));
    ({ workflowTemplateId: wfId } = await createTestDevTryonCategory(app, { slug: 'seed-cat' }));
  });
  afterAll(async () => { await app.close(); });

  it('creates a dev tryon category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/tryon-categories',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'API Upper', slug: 'api-upper', workflowTemplateId: wfId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('api-upper');
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/tryon-categories',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Dup', slug: 'api-upper', workflowTemplateId: wfId },
    });
    expect(res.statusCode).toBe(409);
  });

  it('patches isActive', async () => {
    const [row] = await app.db
      .select({ id: schema.devTryonCategories.id })
      .from(schema.devTryonCategories)
      .where(eq(schema.devTryonCategories.slug, 'api-upper'));
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/dev-api/tryon-categories/${row!.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('upserts the saree config', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/dev-api/saree-config',
      headers: { authorization: `Bearer ${token}` },
      payload: { workflowTemplateId: wfId, isActive: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflowTemplateId).toBe(wfId);
  });

  it('403s without an admin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dev-api/tryon-categories',
    });
    expect(res.statusCode).toBe(401);
  });
});
```

Match `buildTestApp` invocation, the super-admin helper name, and `app.inject` vs raw-http to whatever the sibling admin tests in `apps/api/test/` actually use — read one first (e.g. an existing `admin-*.test.ts`) and copy its exact harness.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-dev-api`
Expected: FAIL — routes return 404 (not registered yet).

- [ ] **Step 3: Write the routes module**

Create `apps/api/src/modules/admin/dev-api.routes.ts` (patterns copied from `admin/tryon.routes.ts`):

```ts
import { schema } from '@tryme/db';
import {
  CreateDevTryonCategoryBody,
  UpdateDevSareeConfigBody,
  UpdateDevTryonCategoryBody,
} from '@tryme/types';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

const DEV_SAREE_CONFIG_ID = '00000000-0000-0000-0000-000000000002';

export async function adminDevApiRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const R = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/dev-api/tryon-categories', { preHandler: R }, async () => {
    return app.db
      .select()
      .from(schema.devTryonCategories)
      .orderBy(asc(schema.devTryonCategories.sortOrder));
  });

  app.post(
    '/admin/dev-api/tryon-categories',
    { preHandler: W, schema: { body: CreateDevTryonCategoryBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateDevTryonCategoryBody>;
      try {
        const [row] = await app.db
          .insert(schema.devTryonCategories)
          .values({
            name: body.name,
            slug: body.slug,
            workflowTemplateId: body.workflowTemplateId ?? null,
            sortOrder: body.sortOrder ?? 0,
            isActive: body.isActive ?? true,
          })
          .returning();
        return row;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
        }
        throw err;
      }
    },
  );

  app.patch(
    '/admin/dev-api/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam, body: UpdateDevTryonCategoryBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateDevTryonCategoryBody>;
      const [row] = await app.db
        .update(schema.devTryonCategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.workflowTemplateId !== undefined
            ? { workflowTemplateId: body.workflowTemplateId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.devTryonCategories.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'category not found');
      return row;
    },
  );

  app.delete(
    '/admin/dev-api/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const deleted = await app.db
        .delete(schema.devTryonCategories)
        .where(eq(schema.devTryonCategories.id, id))
        .returning({ id: schema.devTryonCategories.id });
      if (!deleted.length) throw new AppError('NOT_FOUND', 404, 'category not found');
      return { ok: true };
    },
  );

  app.get('/admin/dev-api/saree-config', { preHandler: R }, async () => {
    const [row] = await app.db
      .select({
        workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
        isActive: schema.devSareeMannequinConfig.isActive,
        updatedAt: schema.devSareeMannequinConfig.updatedAt,
      })
      .from(schema.devSareeMannequinConfig)
      .where(eq(schema.devSareeMannequinConfig.id, DEV_SAREE_CONFIG_ID));
    return row ?? { workflowTemplateId: null, isActive: false, updatedAt: null };
  });

  app.patch(
    '/admin/dev-api/saree-config',
    { preHandler: W, schema: { body: UpdateDevSareeConfigBody } },
    async (req) => {
      const body = req.body as z.infer<typeof UpdateDevSareeConfigBody>;
      const [row] = await app.db
        .insert(schema.devSareeMannequinConfig)
        .values({
          id: DEV_SAREE_CONFIG_ID,
          workflowTemplateId: body.workflowTemplateId ?? null,
          isActive: body.isActive ?? true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.devSareeMannequinConfig.id,
          set: {
            ...(body.workflowTemplateId !== undefined
              ? { workflowTemplateId: body.workflowTemplateId }
              : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            updatedAt: new Date(),
          },
        })
        .returning({
          workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
          isActive: schema.devSareeMannequinConfig.isActive,
          updatedAt: schema.devSareeMannequinConfig.updatedAt,
        });
      return row;
    },
  );
}
```

- [ ] **Step 4: Register the routes in server.ts**

In `apps/api/src/server.ts`: add the import near the other admin imports (alphabetical, after `adminConfigRoutes` import at line 29):

```ts
import { adminDevApiRoutes } from './modules/admin/dev-api.routes.js';
```

And register it alongside the other admin routes (near line 295, after `adminTryonRoutes`):

```ts
  await app.register(adminDevApiRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-dev-api`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/dev-api.routes.ts apps/api/src/server.ts apps/api/test/admin-dev-api.test.ts
git commit -m "feat(api): admin CRUD for the dev-api catalog"
```

---

### Task 10: Admin-web "Dev API" management page

**Files:**
- Create: `apps/admin-web/src/pages/DevApiPage.tsx`
- Modify: `apps/admin-web/src/App.tsx`
- Modify: `apps/admin-web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `/admin/dev-api/*` routes (Task 9), the admin-web `apiFetch` data helper, `/admin/workflows` (to populate a workflow-template dropdown — reuse whatever endpoint `TryonPage.tsx` already calls to list templates).
- Produces: a page at `/dev-api` where an admin lists/creates/edits/deletes dev tryon categories and sets the saree-mannequin workflow + active toggle.

- [ ] **Step 1: Read the existing TryonPage to copy its patterns**

Read `apps/admin-web/src/pages/TryonPage.tsx` in full. It already does list + create + edit + delete of `tryon_categories` against `/admin/tryon-categories`, and populates a workflow-template dropdown. The Dev API page is the same UI shape pointed at `/admin/dev-api/tryon-categories` plus one extra "Saree Mannequin" config card.

- [ ] **Step 2: Write `DevApiPage.tsx`**

Create `apps/admin-web/src/pages/DevApiPage.tsx` modeled on `TryonPage.tsx`. Requirements (no new visual system — reuse the same components/tokens `TryonPage` uses):
- A header explaining this controls the **public developer API** surface, independent of internal Try-on.
- A table of dev tryon categories (name, slug, workflow template, sort order, active) with create/edit/delete, calling:
  - list: `apiFetch('/admin/dev-api/tryon-categories')`
  - create: `apiFetch('/admin/dev-api/tryon-categories', { method: 'POST', body: JSON.stringify({...}) })`
  - update: `apiFetch(\`/admin/dev-api/tryon-categories/${id}\`, { method: 'PATCH', body: ... })`
  - delete: `apiFetch(\`/admin/dev-api/tryon-categories/${id}\`, { method: 'DELETE' })`
- A single "Saree Mannequin (Dev API)" card with a workflow-template dropdown + active switch, calling:
  - load: `apiFetch('/admin/dev-api/saree-config')`
  - save: `apiFetch('/admin/dev-api/saree-config', { method: 'PATCH', body: JSON.stringify({ workflowTemplateId, isActive }) })`
- On duplicate-slug create (409), surface the backend error message via the existing toast helper — do not swallow it (see the `surface-admin-errors` convention: pass the backend message through, never a generic toast).

- [ ] **Step 3: Register the route**

In `apps/admin-web/src/App.tsx`:
- Add the import alongside the other page imports: `import DevApiPage from './pages/DevApiPage';`
- Add a nav label to the `PAGE_LABELS` map: `'dev-api': 'Dev API',`
- Add the route inside the `<Routes>` block, next to the `/tryon` route: `<Route path="/dev-api" element={<DevApiPage {...pageProps} />} />`

- [ ] **Step 4: Add the sidebar entry**

In `apps/admin-web/src/components/Sidebar.tsx`, add an entry to the "Content" group (after the `tryon` entry around line 57-61):

```tsx
      {
        k: 'dev-api',
        label: 'Dev API',
        icon: Icon.Workflow,
      },
```

(Use an existing icon from the `Icon` map — `Icon.Workflow` or `Icon.Replace` are both already imported/used in that file.)

- [ ] **Step 5: Build the admin app**

Run: `pnpm --filter @tryme/admin build`
Expected: `tsc -b && vite build` succeeds (the only expected warning is the pre-existing ">500kB chunk" notice).

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/DevApiPage.tsx apps/admin-web/src/App.tsx apps/admin-web/src/components/Sidebar.tsx
git commit -m "feat(admin): Dev API catalog management page"
```

---

### Task 11: Full-surface verification + docs

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Whole-monorepo typecheck + lint**

Run:
```bash
pnpm --filter @tryme/db build
pnpm --filter @tryme/types build
pnpm --filter @tryme/storage build
pnpm typecheck
pnpm lint
```
Expected: all exit 0. (The db/types/storage builds first ensure the `dist/` the API typechecks against is fresh — a stale `packages/db/dist` will otherwise report phantom "property does not exist on schema" errors.)

- [ ] **Step 2: Run the full API unit suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS. Pay attention to `dev-tryon-create`, `dev-read-routes`, `dev-saree-mannequin-create`, `admin-dev-api`, and `dev-openapi` (the last regenerates the OpenAPI spec — confirm the dev endpoints still appear with unchanged request/response shapes).

- [ ] **Step 3: Confirm the public contract is byte-identical**

Manually diff the dev section of the generated OpenAPI spec against `main` (or assert in `dev-openapi.test.ts` that `/v1/dev/tryon`, `/v1/dev/saree-mannequin`, `/v1/dev/categories` request bodies and responses are unchanged). Expected: no diff in request/response schemas — only the backing table changed, which is invisible to the spec.

- [ ] **Step 4: Write the progress entry**

Add a dated entry at the **top** of `docs/progress.md`:

```markdown
## 2026-07-22 - Developer API decoupled from internal catalog/tryon tables

The public /v1/dev/* endpoints previously resolved their ComfyUI workflow through
the same tryon_categories / garment_subcategories rows the internal Studio, kiosk,
and merchant flows use — so an admin renaming or deactivating an internal category
silently changed what third-party API callers could request. This branch gives the
dev API two dedicated, admin-owned tables (dev_tryon_categories, single-row
dev_saree_mannequin_config), backfilled once from the active internal rows, and
switches the dev job-creation code to resolve + snapshot the workflow from them.

### Done
- New tables + backfill migration (0119-0121); dev tryon + saree-mannequin creation
  resolve off the dedicated tables and snapshot workflowTemplateId into job_inputs.params.
- Dispatcher unchanged — it already trusts the params snapshot (processor.ts:664, :896);
  dev saree jobs now set garmentTypeId null so no internal-table read happens at dispatch.
- Admin CRUD (/admin/dev-api/*) + a Dev API admin-web page.
- Public endpoint contract byte-identical (verified via dev-openapi test) — merchants change nothing.

### Failed / Not Done
- Postman collection is intentionally NOT hand-maintained (the abandoned commit 9bf790a5
  on feat/saree-mannequin-face-url-workflow); generate it from the live OpenAPI spec instead.

### Open Questions / Decisions
- Whether to eventually retire tryon_categories entirely once nothing but internal Studio
  uses it — out of scope here; the two catalogs now evolve independently.
```

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log dev-api catalog decoupling"
```

---

## Self-Review

**Spec coverage:**
- "Dev endpoints separate from catalog/tryon" → Tasks 1-3 (tables + backfill), 5-7 (resolution switch). ✓
- "Keep endpoint same so devs don't change anything" → Global Constraint + Task 11 Step 3 contract check; resolution-source-only change. ✓
- "Only ComfyUI workflow matters to start a job" → Tasks 5 & 7 snapshot `workflowTemplateId` into `params`; dispatcher trusts it (verified `processor.ts:664`, `:896`). ✓
- "Better control over them" → Tasks 8-10 admin CRUD + UI. ✓
- Postman automation → Task 10 (surface real errors) + Task 11 note (generate from OpenAPI, drop hand-written file). ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full code. Test harness specifics (`buildTestApp` invocation, super-admin helper name) are flagged to copy from a named sibling file rather than invented, because the exact harness call differs per test file and must match the local convention — this is a deliberate "read X and mirror it" instruction, not a placeholder.

**Type consistency:** `workflowTemplateId` used consistently across schema, types, routes, and job params. `devTryonCategories` / `devSareeMannequinConfig` schema names match every reference. `createTestDevTryonCategory` / `createTestDevSareeMannequinConfig` helper names match their call sites in Tasks 5-7 & 9. Single-row sentinel id `...0002` consistent across schema default (Task 2), backfill (Task 3), helper (Task 4), and admin route (Task 9).

**Migration index:** Tasks assume 0119/0120/0121 with the rule "server's index is canonical, rename upward if drizzle-kit picks higher" — matches CLAUDE.md's diverged-branch guidance.
