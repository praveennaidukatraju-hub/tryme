# Shopify App Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the funnel rules engine and the catalog-generation UI, move workflow routing to a single admin-set default template, and rebuild the surviving Shopify admin pages on Polaris behind App Bridge navigation.

**Architecture:** Workflow resolution moves from a per-product funnel chain to an `is_default` flag on `shopify_funnel_templates`, resolved once in the API at job creation and pinned onto `job_inputs.params.workflowTemplateId`; the dispatcher then trusts that value. The embedded admin app drops its custom pill nav and `BRAND` styling in favour of App Bridge `<ui-nav-menu>` plus stock Polaris, leaving three pages: Dashboard, Manage, Support.

**Tech Stack:** Fastify 5 + Drizzle (Postgres 16), React 18 + react-router 7 + `@shopify/polaris` 13, Vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-30-shopify-app-restructure-design.md`

## Global Constraints

- ESM only. Every relative import inside `apps/api` and `apps/dispatcher` ends in `.js`; imports inside `apps/shopify` have no extension.
- Never inline-mutate a workflow template — `structuredClone` then patch.
- Credit deduct and job insert stay in one Postgres transaction.
- No `console.log` in committed code. `apps/api` uses `app.log`.
- `pnpm docker:up` must be running before any test command.
- Integration tests live in `apps/api/test/integration/**`, which `vitest.config.ts` excludes. They run only via `--config vitest.integration.config.ts`.
- Migration index is canonical from `origin/main`. This plan uses `0133`; if `origin/main` already has a `0133_*`, renumber upward before starting.
- Do not touch `apps/admin-mobile` (development paused).
- Do not commit or push beyond the commits this plan specifies. No `git push` at all.
- `shopify_catalog_jobs`, `catalog.routes.ts`, `catalog-options.routes.ts`, `catalog-publish.ts` and their four test files stay untouched and passing throughout.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/db/src/migrations/0133_shopify_funnel_default.sql` | Adds `is_default`, its partial unique index, and the backfill |
| `apps/shopify/src/components/AppNavMenu.tsx` | Renders `<ui-nav-menu>`; dev fallback when App Bridge is absent |
| `apps/shopify/src/pages/ManagePage.tsx` | Product list, search, status filter, enable toggle, sync (was `ProductsPage.tsx`) |
| `apps/shopify/src/pages/SupportPage.tsx` | Static support contact options |

**Modified**

| File | Change |
|---|---|
| `packages/db/src/schema/shopify.ts` | `isDefault` column + partial unique index |
| `apps/api/src/modules/admin/shopify-funnels.routes.ts` | `isDefault` on create/patch, last-default guard |
| `apps/api/src/modules/shopify/customer.routes.ts` | `resolveWorkflowTemplateId` reads the default template |
| `apps/api/src/modules/shopify/me.routes.ts` | Drop `funnelCounts` / `funnelConfigured` |
| `apps/api/src/modules/shopify/products.routes.ts` | Drop funnel fields from the list response |
| `apps/api/src/modules/shopify/routes.ts` | Unregister `shopifyFunnelRoutes` |
| `apps/dispatcher/src/job/processor.ts` | `processShopifyJob` trusts `params.workflowTemplateId` |
| `apps/shopify/src/App.tsx` | Polaris `Frame`, three routes, `/products` redirect |
| `apps/shopify/src/pages/DashboardPage.tsx` | 3-step checklist, Polaris rewrite |
| `apps/shopify/src/components/LinkAccountGate.tsx` | Polaris rewrite |
| `apps/shopify/src/types.ts` | Drop funnel and catalog types |
| `apps/shopify/package.json` | Add `@shopify/polaris-icons` |
| `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx` | Show and set the default template; warn when none |

**Deleted**

`apps/api/src/modules/shopify/funnel.routes.ts`, `funnel-rules.ts`, `funnel-rules.test.ts`, `apps/api/test/shopify-funnel-routes.test.ts`, `apps/shopify/src/pages/{CatalogGeneratePage,GeneratedImagesPage,FunnelSetupPage,ProductsPage}.tsx`, `apps/shopify/src/components/{AppShell,CatalogJobThumb,PageHeader,Toast,icons}.tsx`, `apps/shopify/src/lib/useToast.ts`, `apps/shopify/src/theme.ts`, `apps/shopify/src/theme.css`.

---

### Task 1: Default flag on the funnel template registry

**Files:**
- Modify: `packages/db/src/schema/shopify.ts:53-64`
- Create: `packages/db/src/migrations/0133_shopify_funnel_default.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.shopifyFunnelTemplates.isDefault` (`boolean`, not null, default `false`). At most one row in the table may have it `true`.

- [ ] **Step 1: Add the column and index to the Drizzle schema**

In `packages/db/src/schema/shopify.ts`, add `uniqueIndex` to the `drizzle-orm/pg-core` import list and `sql` to a new `import { sql } from 'drizzle-orm';` at the top, then replace the `shopifyFunnelTemplates` definition:

```ts
export const shopifyFunnelTemplates = pgTable(
  'shopify_funnel_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id),
    isActive: boolean('is_active').notNull().default(true),
    // Exactly one row carries this. It is the workflow every Shopify product
    // resolves unless something more specific claims it — today nothing does,
    // so it is the only routing input. Enforced by the partial unique index
    // below rather than by application code, because two defaults would make
    // resolution non-deterministic rather than merely wrong.
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singleDefault: uniqueIndex('shopify_funnel_templates_single_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
  }),
);
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/src/migrations/0133_shopify_funnel_default.sql`:

```sql
ALTER TABLE "shopify_funnel_templates" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_funnel_templates_single_default_idx" ON "shopify_funnel_templates" ("is_default") WHERE "is_default";
--> statement-breakpoint
UPDATE "shopify_funnel_templates" SET "is_default" = true WHERE "id" = (
  SELECT "id" FROM "shopify_funnel_templates" WHERE "is_active" ORDER BY "sort_order" ASC, "created_at" ASC LIMIT 1
);
```

The `created_at` tiebreak matters: `sort_order` defaults to `0`, so a table where nobody set it would otherwise pick an arbitrary row. The `UPDATE` is a no-op when no active template exists — that case is handled in Task 2.

- [ ] **Step 3: Register the migration in the journal**

Append to the `entries` array in `packages/db/src/migrations/meta/_journal.json`, after the `idx: 132` entry:

```json
{
  "idx": 133,
  "version": "7",
  "when": 1785484800000,
  "tag": "0133_shopify_funnel_default",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:migrate`
Expected: completes without error. A `NOTICE ... already exists` line is safe. If the migration is silently skipped, follow the Drizzle-gap procedure in `CLAUDE.md`.

- [ ] **Step 5: Verify the constraint holds**

Run:

```bash
node_modules/.bin/tsx --env-file=.env -e "
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL);
const rows = await sql\`SELECT id, slug, is_default FROM shopify_funnel_templates ORDER BY sort_order\`;
console.log(rows);
console.log('defaults:', rows.filter(r => r.is_default).length);
await sql.end();
"
```

Expected: `defaults: 1` if the table had any active row, `defaults: 0` if it was empty. Never more than 1.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @tryme/db typecheck`
Expected: passes.

```bash
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/0133_shopify_funnel_default.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add is_default to shopify funnel templates"
```

---

### Task 2: Admin control over the default template

**Files:**
- Modify: `apps/api/src/modules/admin/shopify-funnels.routes.ts:8-24,59-73`
- Test: `apps/api/test/shopify-funnel-templates-admin.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyFunnelTemplates.isDefault` from Task 1.
- Produces: `POST /admin/shopify/funnel-templates` and `PATCH /admin/shopify/funnel-templates/:id` both accept `isDefault?: boolean`. Setting it `true` clears the previous default in the same transaction. Setting it `false` on the only default returns 400. `GET /admin/shopify/funnel-templates` returns `{ items, hasDefault: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe('admin shopify funnel templates CRUD', ...)` block in `apps/api/test/shopify-funnel-templates-admin.test.ts`:

```ts
  it('promotes a template to default and demotes the previous one atomically', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'default-a', label: 'A', workflowTemplateId, sortOrder: 0, isDefault: true },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().isDefault).toBe(true);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'default-b', label: 'B', workflowTemplateId, sortOrder: 1, isDefault: true },
    });
    expect(second.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second.json().id);
  });

  it('refuses to clear the last default', async () => {
    const [current] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
    expect(current).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify/funnel-templates/${current.id}`,
      headers: adminHeaders,
      payload: { isDefault: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('default');

    const [still] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, current.id));
    expect(still.isDefault).toBe(true);
  });

  it('reports whether a default exists so admin can surface it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasDefault).toBe(true);
  });
```

These three run in order and share state: the second depends on the first having set a default. Vitest runs `it` blocks in file order within a describe, so this is stable — but do not reorder them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-funnel-templates-admin.test.ts`
Expected: FAIL. The first new case fails on `expect(first.json().isDefault).toBe(true)` receiving `false`, because the route strips the unknown body key.

- [ ] **Step 3: Accept isDefault in the request bodies**

In `apps/api/src/modules/admin/shopify-funnels.routes.ts`, add the field to both schemas:

```ts
const CreateFunnelTemplateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  workflowTemplateId: z.string().uuid(),
  sortOrder: z.number().int().default(0),
  isDefault: z.boolean().default(false),
});

const PatchFunnelTemplateBody = z.object({
  label: z.string().min(1).max(120).optional(),
  workflowTemplateId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  isDefault: z.boolean().optional(),
});
```

- [ ] **Step 4: Implement promotion and the last-default guard**

Still in `apps/api/src/modules/admin/shopify-funnels.routes.ts`, replace the `GET`, `POST` and `PATCH` handler bodies:

```ts
  app.get('/admin/shopify/funnel-templates', { preHandler: RW }, async () => {
    const items = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .orderBy(asc(schema.shopifyFunnelTemplates.sortOrder));
    // Surfaced so the admin list can warn on it. With no default, every Shopify
    // try-on is refused at creation and nothing else reveals why until a shopper
    // hits it.
    return { items, hasDefault: items.some((i) => i.isDefault) };
  });

  app.post(
    '/admin/shopify/funnel-templates',
    { preHandler: RW, schema: { body: CreateFunnelTemplateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateFunnelTemplateBody>;
      try {
        return await app.db.transaction(async (tx) => {
          // Demote first: the partial unique index rejects a second default, so
          // insert-then-demote would fail on the constraint rather than swap.
          if (body.isDefault) {
            await tx
              .update(schema.shopifyFunnelTemplates)
              .set({ isDefault: false, updatedAt: new Date() })
              .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
          }
          const [row] = await tx.insert(schema.shopifyFunnelTemplates).values(body).returning();
          return row;
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
        }
        throw err;
      }
    },
  );

  app.patch(
    '/admin/shopify/funnel-templates/:id',
    { preHandler: RW, schema: { params: uuidParam, body: PatchFunnelTemplateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof PatchFunnelTemplateBody>;

      if (body.isDefault === false) {
        const [row] = await app.db
          .select({ isDefault: schema.shopifyFunnelTemplates.isDefault })
          .from(schema.shopifyFunnelTemplates)
          .where(eq(schema.shopifyFunnelTemplates.id, id))
          .limit(1);
        if (!row) throw new AppError('NOT_FOUND', 404, 'funnel template not found');
        if (row.isDefault) {
          throw new AppError(
            'VALIDATION',
            400,
            'Cannot clear the default funnel template. Promote another template instead — with no default, every Shopify try-on is refused.',
          );
        }
      }

      const updated = await app.db.transaction(async (tx) => {
        if (body.isDefault === true) {
          await tx
            .update(schema.shopifyFunnelTemplates)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
        }
        const [row] = await tx
          .update(schema.shopifyFunnelTemplates)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.shopifyFunnelTemplates.id, id))
          .returning({ id: schema.shopifyFunnelTemplates.id });
        return row;
      });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'funnel template not found');
      return { ok: true };
    },
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-funnel-templates-admin.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/shopify-funnels.routes.ts apps/api/test/shopify-funnel-templates-admin.test.ts
git commit -m "feat(admin): let admins set the default shopify funnel template"
```

---

### Task 3: Resolve the workflow from the default template

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts:74-100,235-253,275-283`
- Test: `apps/api/test/integration/shopify-customer.test.ts:51-105,194-263`

**Interfaces:**
- Consumes: `schema.shopifyFunnelTemplates.isDefault` from Task 1.
- Produces: `resolveWorkflowTemplateId(app): Promise<string | null>` — no longer takes `store` or `garment`. `POST /v1/shopify/customer/jobs` returns 202 with `{ message }` and charges nothing when it resolves `null`.

- [ ] **Step 1: Rewrite the test fixtures and resolution cases**

In `apps/api/test/integration/shopify-customer.test.ts`, replace the `getFunnelTemplateId` helper and `seedGarment` (lines 51-105) with:

```ts
  /** The single default funnel template every product now resolves. Created
   *  lazily so the test that asserts the no-default path isn't forced to depend
   *  on it — that test runs against a database where this was never called. */
  let defaultFunnelTemplateId: string | null = null;
  let defaultWorkflowTemplateId: string | null = null;
  async function seedDefaultFunnelTemplate() {
    if (defaultFunnelTemplateId) return defaultFunnelTemplateId;
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `shopify-tryon-${Date.now()}`,
        label: 'Shopify try-on test workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        garmentPhasePromptNode: '6',
        workflowType: 'tryon',
        tryonPersonNodeId: '10',
        tryonGarmentNodeId: '11',
        tryonOutputNodeId: '12',
      })
      .returning();
    const [funnel] = await app.db
      .insert(schema.shopifyFunnelTemplates)
      .values({
        slug: `default-${Date.now()}`,
        label: 'Default',
        workflowTemplateId: workflow.id,
        isDefault: true,
      })
      .returning();
    defaultFunnelTemplateId = funnel.id;
    defaultWorkflowTemplateId = workflow.id;
    return defaultFunnelTemplateId;
  }

  async function seedGarment(storeId: string, shopifyProductId: number) {
    const [garment] = await app.db
      .insert(schema.shopifyProductGarments)
      .values({
        storeId,
        shopifyProductId,
        r2Key: `shopify-garments/${storeId}/${shopifyProductId}/garment.jpg`,
        title: 'Test Product',
        status: 'active',
        enabled: true,
      })
      .returning();
    return garment;
  }
```

Then replace the two resolution tests at lines 194-263 with:

```ts
  it('refuses to enqueue when no default funnel template exists, without charging credits', async () => {
    // Runs before any test calls seedDefaultFunnelTemplate(), so the table is
    // empty. Ordering matters — do not move this below a test that seeds one.
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 71);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 71 },
    });
    // 202, not 4xx: same shape the widget already handles for a product that is
    // still syncing or switched off.
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty('jobId');

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, owner.id));
    expect(credits.balance).toBe(100);

    const jobs = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.shopifyStoreId, store.id));
    expect(jobs).toHaveLength(0);
  });

  it('pins the default template workflow onto the job params', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 72);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 72 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputs.params as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      defaultWorkflowTemplateId,
    );
  });

  it('ignores a store-level workflowTemplateId setting', async () => {
    // settings.workflowTemplateId is vestigial — nothing writes it in production
    // and it must not silently override the admin-set default.
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { workflowTemplateId: '00000000-0000-0000-0000-000000000001' } })
      .where(eq(schema.shopifyStores.id, store.id));
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 73);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 73 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputs.params as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      defaultWorkflowTemplateId,
    );
  });
```

Search the rest of the file for any other `seedGarment(..., { withFunnel: ... })` call and drop the options argument — the helper no longer takes one. Any test that needs a creatable job must `await seedDefaultFunnelTemplate()` first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts shopify-customer`
Expected: FAIL. `pins the default template workflow onto the job params` gets 202 instead of 201, because `resolveWorkflowTemplateId` still reads `garment.funnelTemplateId` and the never-written store setting.

- [ ] **Step 3: Rewrite the resolver**

In `apps/api/src/modules/shopify/customer.routes.ts`, replace the function at lines 74-100:

```ts
/**
 * The workflow every Shopify try-on runs. Resolved here, at creation, and pinned
 * onto job_inputs.params so the dispatcher never has to look it up again — and so
 * an admin promoting a different default mid-flight cannot change the workflow
 * under a job whose credits are already deducted.
 *
 * Returning null means no active default is configured at all, which is a system
 * misconfiguration rather than anything the merchant did. The caller refuses the
 * job before deducting credits: enqueueing would burn a credit and produce a
 * FAILED row with NO_WORKFLOW_CONFIGURED for something no merchant can fix.
 */
async function resolveWorkflowTemplateId(app: FastifyInstance): Promise<string | null> {
  const [row] = await app.db
    .select({ workflowTemplateId: schema.shopifyFunnelTemplates.workflowTemplateId })
    .from(schema.shopifyFunnelTemplates)
    .where(
      and(
        eq(schema.shopifyFunnelTemplates.isDefault, true),
        eq(schema.shopifyFunnelTemplates.isActive, true),
      ),
    )
    .limit(1);
  return row?.workflowTemplateId ?? null;
}
```

- [ ] **Step 4: Update the call site and its log**

Replace lines 235-253:

```ts
      const workflowTemplateId = await resolveWorkflowTemplateId(app);
      if (!workflowTemplateId) {
        // error, not warn: after the funnel removal this can only mean no active
        // default template exists, which is ours to fix, not the merchant's. The
        // shopper still sees the same soft message as a disabled product — no
        // internal state leaks to the storefront.
        app.log.error(
          { storeId, shopifyProductId, garmentId: garment.id },
          'shopify try-on blocked before enqueue: no active default funnel template is configured',
        );
        return reply
          .code(202)
          .send({ message: 'This product is not available for try-on right now.' });
      }
```

And replace the comment on the `workflowTemplateId` param at lines 278-282 with:

```ts
            // Resolved above and pinned here so the dispatcher trusts it rather
            // than re-resolving — a default promoted mid-flight can't change the
            // workflow under a job whose credits are already deducted.
            workflowTemplateId,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts shopify-customer`
Expected: PASS, 15 tests.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `pnpm --filter @tryme/api typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "feat(shopify): resolve try-on workflow from the default funnel template"
```

---

### Task 4: Dispatcher trusts the pinned workflow

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1832-1850`

**Interfaces:**
- Consumes: `params.workflowTemplateId` written by Task 3.
- Produces: no new exports. `processShopifyJob` fails terminally with `NO_WORKFLOW_CONFIGURED` when `params.workflowTemplateId` is absent, unchanged.

- [ ] **Step 1: Delete the funnel lookup**

In `apps/dispatcher/src/job/processor.ts`, replace lines 1832-1850 (the `garmentRow` select through the `if (!workflowTemplateId)` fallback) with:

```ts
  // The API resolves the workflow at creation and pins it onto params. Looking it
  // up again here would reintroduce the split-brain the funnel removal closed: a
  // default promoted after this job was charged would silently run a different
  // workflow than the one the merchant was billed for.
  const workflowTemplateId = params.workflowTemplateId as string | undefined;
```

Leave the `if (!workflowTemplateId || !garmentKey || !customerPhotoKey)` block that follows exactly as it is.

- [ ] **Step 2: Remove the now-unused import if it is orphaned**

Run: `grep -n "shopifyFunnelTemplates\|shopifyProductGarments" apps/dispatcher/src/job/processor.ts`
Expected: if neither name appears anywhere else in the file, nothing needs changing — both come from the `schema` namespace import, which stays. If `grep` shows other uses, also leave it alone. This step is a check, not an edit.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: passes. If it reports `garmentRow` or `funnelTemplate` as unused, the replacement in Step 1 left a fragment behind — delete it.

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "refactor(dispatcher): trust the workflow the api pinned on shopify jobs"
```

---

### Task 5: Remove the funnel and catalog UI

**Files:**
- Delete: `apps/shopify/src/pages/CatalogGeneratePage.tsx`, `apps/shopify/src/pages/GeneratedImagesPage.tsx`, `apps/shopify/src/pages/FunnelSetupPage.tsx`, `apps/shopify/src/components/CatalogJobThumb.tsx`
- Modify: `apps/shopify/src/App.tsx:14-18,91-99`, `apps/shopify/src/components/AppShell.tsx:4-19`
- Modify: `apps/shopify/src/pages/ProductsPage.tsx` (remove `FunnelDropdown`, the `unassigned` filter, `setFunnel`, the funnel fetch)
- Modify: `apps/shopify/src/pages/DashboardPage.tsx:326-334,446-460,495-570`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task removes UI only — it must land before Task 6 deletes the endpoints these pages call, or the app 404s at runtime.

- [ ] **Step 1: Delete the four files**

```bash
git rm apps/shopify/src/pages/CatalogGeneratePage.tsx \
      apps/shopify/src/pages/GeneratedImagesPage.tsx \
      apps/shopify/src/pages/FunnelSetupPage.tsx \
      apps/shopify/src/components/CatalogJobThumb.tsx
```

- [ ] **Step 2: Drop their routes and nav entries**

In `apps/shopify/src/App.tsx`, delete the three imports (`CatalogGeneratePage`, `FunnelSetupPage`, `GeneratedImagesPage`) and their three `<Route>` lines, leaving:

```tsx
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
        </Routes>
```

In `apps/shopify/src/components/AppShell.tsx`, reduce `NAV_ITEMS` to:

```ts
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon },
  { to: '/products', label: 'Products', icon: ProductsIcon },
];
```

and drop `CatalogGenerateIcon`, `FunnelIcon` and `GeneratedImagesIcon` from the import at lines 4-11.

- [ ] **Step 3: Strip the funnel column from ProductsPage**

In `apps/shopify/src/pages/ProductsPage.tsx`:

- Delete the whole `FunnelDropdown` component (lines 126-253).
- Delete the `funnelTemplates` and `openDropdownId` state, the `unassignedCount` memo, and the `setFunnel` function.
- In `load`, drop the second promise so it becomes:

```tsx
  const load = useCallback(() => {
    setLoading(true);
    apiFetch<{ items: ShopifyProductListItem[] }>('/v1/shopify/products?pageSize=100')
      .then((products) => setItems(products.items))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);
```

- In `filteredItems`, drop the `unassigned` branch:

```tsx
  const filteredItems = useMemo(() => {
    return items
      .filter((item) => statusFilter === 'all' || displayStatus(item) === statusFilter)
      .filter((item) => (item.title ?? '').toLowerCase().includes(searchQuery.toLowerCase()));
  }, [items, statusFilter, searchQuery]);
```

- Delete the `<option value="unassigned">` element, the `<FunnelDropdown ... />` usage in the row, and the click-outside overlay guarded by `openDropdownId !== null`.
- Remove `CheckIcon` and `ChevronDownIcon` from the icons import and `FunnelTemplateItem` from the types import.
- The row container's `gridTemplateColumns` still allocates a column for the dropdown. Find it near line 528 and remove the trailing track so the remaining columns still line up with the header.

- [ ] **Step 4: Reduce the Dashboard checklist to three steps**

In `apps/shopify/src/pages/DashboardPage.tsx`:

- Replace lines 326-334 with:

```tsx
  const doneCount = [synced, enabled, themeBlockDone].filter(Boolean).length;
  const allDone = doneCount === 3;
  const collapsed = allDone && !expanded;
```

- Change the progress bar width at line 362 from `(doneCount / 4)` to `(doneCount / 3)`, and the counter text at line 398 from `{doneCount}/4` to `{doneCount}/3`.
- Delete the fourth `<StepRow>` (lines 446-460) entirely.
- Change the stat grid at line 498 back to `gridTemplateColumns: 'repeat(3,1fr)'` and delete the "Funnel Mapped" `<StatCard>` that follows the enabled-products card.

- [ ] **Step 5: Verify the app still builds**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: passes. Any error naming `funnelCounts`, `FunnelTemplateItem` or a deleted icon means a reference was missed.

- [ ] **Step 6: Commit**

```bash
git add -A apps/shopify/src
git commit -m "feat(shopify): remove funnel setup and catalog generation UI"
```

---

### Task 6: Retire the funnel API

**Files:**
- Delete: `apps/api/src/modules/shopify/funnel.routes.ts`, `apps/api/src/modules/shopify/funnel-rules.ts`, `apps/api/src/modules/shopify/funnel-rules.test.ts`, `apps/api/test/shopify-funnel-routes.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts:6,26`
- Modify: `apps/api/src/modules/shopify/me.routes.ts:50-67,81-84`
- Modify: `apps/api/src/modules/shopify/products.routes.ts:63-87`
- Modify: `apps/api/test/shopify-me.test.ts:96-98,104-180`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /v1/shopify/me` returns `stats` without `funnelConfigured` or `funnelCounts`. `GET /v1/shopify/products` items carry `{ shopifyProductId, title, thumbnailUrl, status, enabled }` only.

- [ ] **Step 1: Update the failing tests first**

In `apps/api/test/shopify-me.test.ts`, delete the `funnelConfigured` and `funnelCounts` keys from the expected object at lines 96-98, and delete the entire `describe('GET /v1/shopify/me stats.funnelCounts', ...)` block at lines 104-180.

Add this case to the remaining describe block:

```ts
  it('no longer reports funnel state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: await shopifySessionHeader(app, store),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).not.toHaveProperty('funnelConfigured');
    expect(res.json().stats).not.toHaveProperty('funnelCounts');
  });
```

Match the header helper to whatever the surrounding tests in that file already use for an authenticated Shopify session — read the top of the file and reuse it verbatim rather than inventing `shopifySessionHeader`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-me.test.ts`
Expected: FAIL on `not.toHaveProperty('funnelConfigured')`.

- [ ] **Step 3: Delete the funnel module and unregister it**

```bash
git rm apps/api/src/modules/shopify/funnel.routes.ts \
       apps/api/src/modules/shopify/funnel-rules.ts \
       apps/api/src/modules/shopify/funnel-rules.test.ts \
       apps/api/test/shopify-funnel-routes.test.ts
```

In `apps/api/src/modules/shopify/routes.ts`, delete the `shopifyFunnelRoutes` import (line 6) and its `await app.register(shopifyFunnelRoutes);` line (line 26).

- [ ] **Step 4: Drop funnel state from /v1/shopify/me**

In `apps/api/src/modules/shopify/me.routes.ts`, delete the `funnelCounts` query at lines 50-67 and the two `stats` keys at lines 81-84, leaving:

```ts
      stats: {
        totalTryOns,
        syncedProductCount,
        enabledProductCount,
        statusCounts: {
          active: activeCount,
          processing: processingCount,
          failed: failedCount,
          disabled: disabledCount,
        },
      },
```

- [ ] **Step 5: Drop funnel fields from the products list**

In `apps/api/src/modules/shopify/products.routes.ts`, delete `funnelTemplateId` and `funnelAssignmentSource` from both the `select` at lines 63-72 and the `items` mapping at lines 79-87.

- [ ] **Step 6: Drop the frontend types**

In `apps/shopify/src/types.ts`, delete `ShopifyFunnelCounts`, `FunnelRuleCondition`, `FunnelRule`, `FunnelTemplateItem`, `CatalogOptionItem`, `CatalogPoseOption`, `CatalogOptions` and `CatalogGenerateJob`. Remove `funnelConfigured` and `funnelCounts` from `ShopifyStats`, and `funnelTemplateId` and `funnelAssignmentSource` from `ShopifyProductListItem`.

- [ ] **Step 7: Run the full API suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS. Then run the integration suite:

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck both apps**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/shopify-admin typecheck`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add -A apps/api apps/shopify/src/types.ts
git commit -m "feat(shopify): remove the funnel rules api"
```

---

### Task 7: App Bridge navigation and the Polaris frame

**Files:**
- Create: `apps/shopify/src/components/AppNavMenu.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/package.json`
- Delete: `apps/shopify/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<AppNavMenu />` — renders `<ui-nav-menu>` when App Bridge is present, a Polaris `Navigation` otherwise. Takes no props. `App.tsx` wraps routes in Polaris `Frame`.

- [ ] **Step 1: Add the icon package**

Run: `pnpm --filter @tryme/shopify-admin add @shopify/polaris-icons`
Expected: installs and updates `pnpm-lock.yaml`. Confirm no `package-lock.json` or `yarn.lock` appeared.

- [ ] **Step 2: Write the nav component**

Create `apps/shopify/src/components/AppNavMenu.tsx`:

```tsx
import { Navigation } from '@shopify/polaris';
import { HomeIcon, ProductIcon, QuestionCircleIcon } from '@shopify/polaris-icons';
import { useLocation, useNavigate } from 'react-router-dom';

// Must match BrowserRouter's basename in main.tsx. <ui-nav-menu> hands its
// hrefs to Shopify admin, which navigates the iframe to that exact path — a
// bare "/manage" would land outside the app's base in production.
const BASENAME = import.meta.env.PROD ? '/shopify-admin' : '';

const ITEMS = [
  { path: '/', label: 'Dashboard', icon: HomeIcon },
  { path: '/manage', label: 'Manage', icon: ProductIcon },
  { path: '/support', label: 'Support', icon: QuestionCircleIcon },
];

export function AppNavMenu() {
  const navigate = useNavigate();
  const location = useLocation();

  // window.shopify is only defined inside the Shopify admin iframe
  // (see lib/appBridge.ts). Outside it, <ui-nav-menu> renders nothing at all,
  // which would leave local dev with no way to change page.
  if (!window.shopify) {
    return (
      <Navigation location={location.pathname}>
        <Navigation.Section
          title="TryMe (dev)"
          items={ITEMS.map((item) => ({
            label: item.label,
            icon: item.icon,
            url: item.path,
            selected: location.pathname === item.path,
            onClick: () => navigate(item.path),
          }))}
        />
      </Navigation>
    );
  }

  return (
    <ui-nav-menu>
      {/* Shopify requires the first child to be the app's home link and ignores
          its label, but it must still be present or the menu does not render. */}
      <a href={`${BASENAME}/`} rel="home">
        Dashboard
      </a>
      {ITEMS.slice(1).map((item) => (
        <a
          key={item.path}
          href={`${BASENAME}${item.path}`}
          onClick={(e) => {
            // Let Shopify keep the admin URL in sync, but do the actual route
            // change in-app — a real navigation would reload the iframe and
            // re-run the App Bridge handshake on every nav click.
            e.preventDefault();
            navigate(item.path);
          }}
        >
          {item.label}
        </a>
      ))}
    </ui-nav-menu>
  );
}
```

- [ ] **Step 3: Declare the custom element for TypeScript**

Append to `apps/shopify/src/lib/appBridge.ts`, inside the existing `declare global` block, so `<ui-nav-menu>` typechecks in JSX:

```ts
  namespace JSX {
    interface IntrinsicElements {
      'ui-nav-menu': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
```

Add `import type React from 'react';` at the top of that file if it is not already imported.

- [ ] **Step 4: Wrap the app in a Polaris Frame**

In `apps/shopify/src/App.tsx`, replace the `AppShell` import with `import { AppNavMenu } from './components/AppNavMenu';`, add `Frame` to the `@shopify/polaris` import, and replace the final return:

```tsx
  return (
    <AppProvider i18n={{}}>
      <AppNavMenu />
      <Frame>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
        </Routes>
      </Frame>
    </AppProvider>
  );
```

The `/manage` and `/support` routes referenced by the nav do not exist yet — Tasks 9 and 10 add them. Until then those links render a blank page, which is expected and resolved before the branch is finished.

- [ ] **Step 5: Delete the old shell**

```bash
git rm apps/shopify/src/components/AppShell.tsx
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add -A apps/shopify package.json pnpm-lock.yaml
git commit -m "feat(shopify): navigate via app bridge nav menu inside a polaris frame"
```

---

### Task 8: Rebuild the Dashboard on Polaris

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx` (full rewrite)

**Interfaces:**
- Consumes: `apiFetch` from `lib/api`, `ShopifyMe` and `ShopifyOnboardingConfirmResponse` from `types`.
- Produces: default-exported `DashboardPage` component, no props.

- [ ] **Step 1: Rewrite the page**

Replace the entire contents of `apps/shopify/src/pages/DashboardPage.tsx`. Preserve every behaviour below exactly — this is a restyle, not a redesign:

- `load()` fetches `/v1/shopify/me` into `me`, sets `loading` and `error`.
- `syncProducts()` POSTs `/v1/shopify/products/sync`, toasts `Products synced from Shopify.`, then reloads.
- `openThemeEditor()` GETs `/v1/shopify/onboarding/theme-editor-url` and `window.open(url, '_blank', 'noopener')`.
- `confirmThemeBlock()` POSTs `/v1/shopify/onboarding/confirm-theme-block` and merges the returned `settings` into `me`, toasting `Got it — Try It On block confirmed.`
- `disconnectAccount()` POSTs `/v1/shopify/store/account/unlink` then `window.location.reload()` — the reload is load-bearing, because `App.tsx` must re-gate to `LinkAccountGate` once `ownerUserId` is cleared.

Structure it as:

- `<Page title="Dashboard" subtitle="Here's how virtual try-on is performing on your store.">`
- `error && <Banner tone="critical">{error}</Banner>`
- Setup card: `<Card>` containing `<ProgressBar progress={(doneCount / 3) * 100} size="small" />`, a `<Button variant="plain">` toggling `expanded`, and the three steps. Collapsed when `doneCount === 3 && !expanded`, showing `All set — virtual try-on is live on your store.` as `<Text tone="success">`.
- Each step is a `<Box>` row with `<Badge tone={done ? 'success' : undefined}>{done ? 'Done' : 'To do'}</Badge>`, a `<Text variant="bodyMd" fontWeight="semibold">` title, a `<Text tone="subdued">` description, and its buttons. The three steps, verbatim:

| Done when | Title | Description | Primary | Secondary |
|---|---|---|---|---|
| `syncedProductCount > 0` | Sync your products | Import your Shopify catalog so TryMe can generate try-on images. | `Sync products now` → `syncProducts()`, `loading={syncing}` | — |
| `enabledProductCount > 0` | Enable try-on on a product | Turn on virtual try-on for at least one product. | `Go to Manage` → `navigate('/manage')` | — |
| `settings.themeBlockConfirmed` | Add the Try It On block to your theme | Add the block in the theme editor so shoppers can see it on your product pages. | `I've added it` → `confirmThemeBlock()`, `loading={confirming}` | `Open theme editor` → `openThemeEditor()` |

- Stats: `<InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">` of three `<Card>`s — `Try-Ons` (`stats.totalTryOns`), `Products Synced` (`stats.syncedProductCount`), `Try-On Enabled` (`stats.enabledProductCount`, subtitle `of {syncedProductCount} synced`).
- Credit balance `<Card>`: `creditBalance ?? 0` plus a `<Button url="https://app.tryme.com/pricing" target="_blank">Top up on tryme.com</Button>`.
- Sync status `<Card>`: one row per `statusCounts` key using `<Badge>` with tone `success` / `attention` / `critical` / `info` for active / processing / failed / disabled.
- Footer: a `<Button variant="plain">` to `/manage`, `Connected since {new Date(connectedSince).toLocaleDateString()}`, and a `<Button variant="plain" tone="critical">Disconnect account</Button>` opening the modal.
- Disconnect `<Modal open={showDisconnect} title="Disconnect TryMe?" primaryAction={{ content: 'Disconnect', destructive: true, loading: disconnecting, onAction: disconnectAccount }} secondaryActions={[{ content: 'Cancel', onAction: () => setShowDisconnect(false) }]}>` with body text `Shoppers will stop seeing the Try It On button on your storefront until you reconnect. Your TryMe account, credits, and history stay safe at app.tryme.com.`
- Toast: local `toastMessage` state rendered as `{toastMessage && <Toast content={toastMessage} onDismiss={() => setToastMessage(null)} />}`. Polaris `Toast` must be inside the `Frame` from Task 7 — it is, because the page renders as a `Frame` child.
- Loading: `loading && <SkeletonPage primaryAction><SkeletonBodyText /></SkeletonPage>`.

Import nothing from `../theme`, `../components/icons`, `../components/Toast` or `../lib/useToast` — those are deleted in Task 11.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/shopify/src/pages/DashboardPage.tsx
git commit -m "feat(shopify): rebuild the dashboard on polaris"
```

---

### Task 9: Products becomes Manage, on Polaris

**Files:**
- Create: `apps/shopify/src/pages/ManagePage.tsx`
- Delete: `apps/shopify/src/pages/ProductsPage.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ShopifyProductListItem`.
- Produces: default-exported `ManagePage`, no props. Route `/manage`; `/products` redirects to it.

- [ ] **Step 1: Create the page**

Create `apps/shopify/src/pages/ManagePage.tsx`, carrying over these behaviours from `ProductsPage.tsx` unchanged:

- `displayStatus(item)` — a product that is not `enabled`, or whose `status` is `deleted`, reads as `disabled`; otherwise its raw `status` is the bucket. Copy the function and its comment verbatim.
- `load()` fetches `/v1/shopify/products?pageSize=100` into `items`.
- `refreshProducts()` POSTs `/v1/shopify/products/sync`, toasts `Refreshing your catalog from Shopify — this can take a minute.`, then re-polls once after `4000` ms and clears `syncing`. Keep the comment explaining why the delay exists — the sync is Redis-queued and paginated server-side, so there is nothing to await.
- `toggleEnabled(id, enabled)` PATCHes `/v1/shopify/products/{id}` with `{ enabled }` and replaces that row in `items` with the response.
- `filteredItems` applies the status filter then a case-insensitive substring match of `searchQuery` against `title ?? ''`.

Structure it as:

- `<Page title="Manage" subtitle={`${items.length} product${items.length === 1 ? '' : 's'} synced from Shopify.`} primaryAction={{ content: syncing ? 'Syncing…' : 'Sync now', onAction: refreshProducts, loading: syncing }}>`
- `error && <Banner tone="critical">{error}</Banner>`
- Empty state when `!loading && items.length === 0`: `<Card><EmptyState heading="No products synced yet" action={{ content: 'Sync now', onAction: refreshProducts }}>Sync now to bring in your Shopify catalog.</EmptyState></Card>`
- Otherwise a `<Card>` holding `<IndexFilters>` and `<IndexTable>`:
  - `IndexFilters` with `queryValue={searchQuery}`, `queryPlaceholder="Search products"`, `onQueryChange={setSearchQuery}`, `onQueryClear={() => setSearchQuery('')}`, `filters={[]}`, `selected` bound to a tab index, and `tabs` for All / Active / Processing / Failed / Disabled mapping to `statusFilter` values `all` / `active` / `processing` / `failed` / `disabled`. Pass `mode` and `setMode` from `useSetIndexFiltersMode()`. Pass `cancelAction={{ onAction: () => { setSearchQuery(''); setStatusFilter('all'); } }}`.
  - `IndexTable` with `selectable={false}`, `itemCount={filteredItems.length}`, `resourceName={{ singular: 'product', plural: 'products' }}`, and headings `[{ title: 'Product' }, { title: 'Status' }, { title: 'Try-on' }]`.
  - Each row: `<IndexTable.Row id={String(item.shopifyProductId)} key={item.shopifyProductId} position={index}>` containing a `<Thumbnail source={item.thumbnailUrl} alt={item.title ?? 'Product'} size="small" />` beside the title, a `<Badge>` whose tone is `success` / `attention` / `critical` / `info` for active / processing / failed / disabled, and a `<Button size="slim" onClick={() => toggleEnabled(item.shopifyProductId, !item.enabled)} disabled={locked}>` reading `Disable` when enabled and `Enable` when not.
  - `locked` is `!item.enabled && item.status !== 'active'` — the API rejects enabling a product that is not active (`products.routes.ts:125-127`), so the control must not offer it.
  - `emptyState` on the table: `<EmptyState heading="No products match your filters" action={{ content: 'Clear filters', onAction: () => { setSearchQuery(''); setStatusFilter('all'); } }}>Try a different search term or status.</EmptyState>`
- Toast: same local-state pattern as Task 8.

- [ ] **Step 2: Swap the route and redirect the old path**

```bash
git rm apps/shopify/src/pages/ProductsPage.tsx
```

In `apps/shopify/src/App.tsx`, replace the `ProductsPage` import with `import ManagePage from './pages/ManagePage';` and the routes with:

```tsx
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/manage" element={<ManagePage />} />
          {/* Merchants may have bookmarked the old path while it was the only
              product surface. */}
          <Route path="/products" element={<Navigate to="/manage" replace />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
        </Routes>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add -A apps/shopify/src
git commit -m "feat(shopify): rebuild products as the manage page on polaris"
```

---

### Task 10: Support page

**Files:**
- Create: `apps/shopify/src/pages/SupportPage.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: nothing — the page is static.
- Produces: default-exported `SupportPage`, no props. Route `/support`.

- [ ] **Step 1: Create the page**

Create `apps/shopify/src/pages/SupportPage.tsx`:

```tsx
import {
  BlockStack,
  Banner,
  Button,
  Card,
  InlineGrid,
  Page,
  Text,
} from '@shopify/polaris';

const CHANNELS = [
  {
    title: 'Email support',
    body: 'Send us the details and we usually reply within 24 hours.',
    action: 'Email us',
    url: 'mailto:support@tryme.com',
  },
  {
    title: 'Live chat',
    body: 'Talk to the team in real time during business hours.',
    action: 'Start a chat',
    url: 'https://app.tryme.com/support',
  },
  {
    title: 'Book a demo',
    body: 'Schedule a walkthrough or a discovery call with the team.',
    action: 'Pick a time',
    url: 'https://app.tryme.com/demo',
  },
];

export default function SupportPage() {
  return (
    <Page title="Support" subtitle="Three ways to reach the team.">
      <BlockStack gap="400">
        <Banner tone="info">
          Live chat is the fastest option during business hours. Email is answered within 24
          hours the rest of the time.
        </Banner>
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          {CHANNELS.map((channel) => (
            <Card key={channel.title}>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {channel.title}
                </Text>
                <Text as="p" tone="subdued">
                  {channel.body}
                </Text>
                <Button url={channel.url} target="_blank">
                  {channel.action}
                </Button>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
```

Confirm the three URLs with the team before this ships — they are the addresses the GUI document describes, not verified endpoints.

- [ ] **Step 2: Add the route**

In `apps/shopify/src/App.tsx`, add the import and the route:

```tsx
          <Route path="/support" element={<SupportPage />} />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/shopify-admin typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify/src/pages/SupportPage.tsx apps/shopify/src/App.tsx
git commit -m "feat(shopify): add the support page"
```

---

### Task 11: Delete the bespoke design system

**Files:**
- Modify: `apps/shopify/src/components/LinkAccountGate.tsx` (full rewrite)
- Modify: `apps/shopify/src/App.tsx:1-2`
- Delete: `apps/shopify/src/theme.ts`, `apps/shopify/src/theme.css`, `apps/shopify/src/components/icons.tsx`, `apps/shopify/src/components/PageHeader.tsx`, `apps/shopify/src/components/Toast.tsx`, `apps/shopify/src/lib/useToast.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task removes the last `BRAND` consumers so the deletions typecheck.

- [ ] **Step 1: Confirm what still references the old system**

Run: `grep -rn "from '../theme'\|from './theme'\|components/icons\|components/Toast\|lib/useToast\|components/PageHeader" apps/shopify/src`
Expected: only `LinkAccountGate.tsx` and the `./theme.css` import in `App.tsx`. Anything else means an earlier task left a reference behind — fix it there before continuing.

- [ ] **Step 2: Rewrite LinkAccountGate on Polaris**

Keep `TRYME_APP_URL` and the entire `openLinkPopup` function byte-for-byte — the nonce check, the `event.origin` guard and the `popup.closed` poll are security-relevant and unrelated to styling. Replace only the component below it:

```tsx
export function LinkAccountGate({ onLinked }: { onLinked: () => void }) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setLinking(true);
    setError(null);
    try {
      const code = await openLinkPopup();
      await apiFetch('/v1/shopify/store/account/link', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLinking(false);
    }
  }

  return (
    <Page narrowWidth>
      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h1" variant="headingLg">
              Connect your TryMe account
            </Text>
            <Text as="p" tone="subdued">
              Billing and credits live on app.tryme.com — nothing is charged through Shopify.
              Link your store to start offering virtual try-on.
            </Text>
          </BlockStack>

          {error && (
            <Banner tone="critical" title="Couldn't complete the connection">
              Please try linking your account again.
            </Banner>
          )}

          <Button variant="primary" size="large" loading={linking} onClick={link} fullWidth>
            Link account
          </Button>

          <Text as="p" tone="subdued" alignment="center" variant="bodySm">
            You'll be redirected to app.tryme.com to sign in
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
```

Replace the `BRAND`/`FONT_STACK` and `icons` imports at lines 3-4 with
`import { Banner, BlockStack, Button, Card, Page, Text } from '@shopify/polaris';`.

This component renders outside the `Frame` (`App.tsx` returns it directly under `AppProvider` when `ownerUserId` is null), so it must not use `Toast`.

- [ ] **Step 3: Delete the bespoke files**

```bash
git rm apps/shopify/src/theme.ts \
       apps/shopify/src/theme.css \
       apps/shopify/src/components/icons.tsx \
       apps/shopify/src/components/PageHeader.tsx \
       apps/shopify/src/components/Toast.tsx \
       apps/shopify/src/lib/useToast.ts
```

In `apps/shopify/src/App.tsx`, delete the `import './theme.css';` line. Keep `import '@shopify/polaris/build/esm/styles.css';` — that is Polaris itself.

- [ ] **Step 4: Typecheck and build**

Run: `pnpm --filter @tryme/shopify-admin typecheck && pnpm --filter @tryme/shopify-admin build`
Expected: both pass. A build failure mentioning `theme.css` means the import was missed.

- [ ] **Step 5: Commit**

```bash
git add -A apps/shopify/src
git commit -m "refactor(shopify): drop the bespoke theme for stock polaris"
```

---

### Task 12: Admin panel default control

**Files:**
- Modify: `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx:12-19,62-73,110-121,270-305`

**Interfaces:**
- Consumes: `{ items, hasDefault }` from `GET /admin/shopify/funnel-templates` and the `isDefault` body field on `PATCH /admin/shopify/funnel-templates/:id`, both from Task 2.
- Produces: nothing consumed elsewhere.

Without this, an admin has no way to see or change which template is the default, and no warning when none is set — a state in which every Shopify try-on is refused.

- [ ] **Step 1: Extend the row type and load the flag**

In `apps/admin-web/src/pages/ShopifyFunnelsPage.tsx`, add `isDefault: boolean;` to the `FunnelTemplate` interface after `isActive`, add `const [hasDefault, setHasDefault] = useState(true);` beside the other state, and widen the fetch in `load`:

```tsx
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ items: FunnelTemplate[]; hasDefault: boolean }>('/admin/shopify/funnel-templates'),
      apiFetch<WorkflowOption[]>('/admin/workflows'),
    ])
      .then(([f, w]) => {
        setItems(f.items);
        setHasDefault(f.hasDefault);
        setWorkflows(w);
      })
      .finally(() => setLoading(false));
  }, []);
```

`hasDefault` starts `true` so the warning banner does not flash during the first load.

- [ ] **Step 2: Add the promote handler**

Add beside `toggleActive`:

```tsx
  async function makeDefault(item: FunnelTemplate) {
    setTogglingId(item.id);
    try {
      await apiFetch(`/admin/shopify/funnel-templates/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      load();
    } catch (err) {
      toast({ kind: 'error', title: 'Could not set default', body: apiErrorMessage(err) });
    } finally {
      setTogglingId(null);
    }
  }
```

There is deliberately no "clear default" action — the API rejects it, and offering a control that always fails is worse than not offering it.

- [ ] **Step 3: Warn when no default is set**

Immediately before the `{items.length === 0 ? (` ternary in the render, add:

```tsx
      {!loading && !hasDefault && (
        <div className="banner error" style={{ marginBottom: 16 }}>
          <b>No default funnel template.</b> Every Shopify try-on is refused until one template
          here is set as the default.
        </div>
      )}
```

Check `apps/admin-web/src/` for the class name this codebase already uses for an inline error banner and use that instead of `banner error` if it differs — match the surrounding convention rather than inventing one.

- [ ] **Step 4: Surface and set the default in the table**

Add a `<th style={{ textAlign: 'right' }}>Default</th>` between the `Workflow` and `Status` headers, and the matching cell in each row between the workflow cell and the status cell:

```tsx
                  <td style={{ textAlign: 'right' }}>
                    {item.isDefault ? (
                      <span style={{ fontWeight: 600 }}>Default</span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={togglingId === item.id || !item.isActive}
                        title={
                          item.isActive
                            ? 'Route every Shopify product through this workflow'
                            : 'Activate this template before making it the default'
                        }
                        onClick={() => makeDefault(item)}
                      >
                        {togglingId === item.id ? '…' : 'Set default'}
                      </button>
                    )}
                  </td>
```

An inactive template is not offerable as the default because `resolveWorkflowTemplateId` filters on `isActive` — promoting one would silently break every try-on.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/admin typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/ShopifyFunnelsPage.tsx
git commit -m "feat(admin): set and surface the default shopify funnel template"
```

---

### Task 13: Full verification

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence the branch is shippable.

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: passes for every package.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: passes. Biome also runs on staged files via lefthook at each commit, so this should be clean already.

- [ ] **Step 3: Run the unit suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS, with no reference to funnel rules or funnel routes in the file list.

- [ ] **Step 4: Run the integration suite**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the catalog surface is untouched**

Run: `git diff --stat main..HEAD -- apps/api/src/modules/shopify/catalog.routes.ts apps/api/src/modules/shopify/catalog-options.routes.ts apps/api/src/modules/shopify/catalog-publish.ts packages/db/src/schema/jobs.ts`
Expected: empty output. Any diff here means the removal went further than the spec allows.

- [ ] **Step 6: Manual smoke in a real embedded admin**

Not automatable — `<ui-nav-menu>` only renders inside the Shopify admin iframe. On a dev store, confirm:

- the sidebar shows Dashboard, Manage and Support, and each navigates without a full iframe reload
- Dashboard shows a 3-step checklist and collapses to `All set` once all three are done
- `Sync now` toasts and refreshes the list
- enabling and disabling a product persists across a reload
- the disconnect modal cancels cleanly and, when confirmed, returns you to the link-account gate
- visiting `/products` redirects to `/manage`

Record the result in `docs/progress.md` as a new dated entry at the top, with Done / Failed / Open Questions sections per `CLAUDE.md`.

- [ ] **Step 7: Commit the progress entry**

```bash
git add docs/progress.md
git commit -m "docs: record shopify restructure verification"
```

---

## Deploy Notes

Ordering is not optional. Migration → API → dispatcher.

A dispatcher that has dropped the funnel lookup (Task 4) paired with an API that does not yet pin `params.workflowTemplateId` (Task 3) fails every Shopify job with `NO_WORKFLOW_CONFIGURED`. Reverse the order on rollback: dispatcher first, then API, then the migration.

After the migration, verify in the target environment that exactly one `shopify_funnel_templates` row has `is_default = true`. If the table had no active row, the backfill set none, and every Shopify try-on will be refused until an admin promotes one through the admin panel.
