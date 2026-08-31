# Catalogue Template Garment-Type Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution note for this plan specifically:** implementation will be done externally (Codex), not by an agentic worker following this plan directly task-by-task in this session. This plan is still written to the same bite-sized, zero-placeholder standard so it can be handed off as-is. After Codex implements, the reviewer's job is to diff the actual changes against every task/step below and flag gaps or deviations — see "Review Checklist" at the end.

**Goal:** Let an admin restrict which garment types a catalogue template is offered for — today every active template shows for every garment type within its gender, with no way to scope it down.

**Architecture:** A new pure many-to-many table, `catalogue_template_subcategories`, records which garment types a template is mapped to (no rows = offered for none — strict opt-in). The public template-listing endpoint requires a matching row for the requested `garmentTypeId` (missing `garmentTypeId` in the request → empty list). A new admin API pair mirrors the codebase's existing per-garment-type override pattern (`pose_garment_configs` + its `GET/PATCH .../garment-types/:id/pose-configs` routes) exactly, and a new sub-view inside the existing "Catalogue Templates" admin tab lets an admin pick a garment type and toggle which templates apply to it. Per-pose, per-garment-type workflow resolution is untouched — confirmed already fully working end-to-end via the existing `pose_garment_configs` mechanism, both at job-creation validation (`apps/api/src/modules/jobs/create.ts:236-297`) and dispatcher generation time (`apps/dispatcher/src/job/processor.ts:196-227`).

**Tech Stack:** Drizzle ORM/Postgres, Fastify 5 + Zod, Vitest integration tests against the existing docker-compose Postgres/Redis/MinIO, Vite + React (admin-web).

**Spec:** `docs/superpowers/specs/2026-07-14-catalogue-template-garment-type-mapping-design.md`

---

### Task 1: `catalogue_template_subcategories` table + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts:1-11,186-234`

- [ ] **Step 1: Check the current top-of-file imports**

`packages/db/src/schema/models.ts` already imports `primaryKey` (used by `catalogItemSubcategories`, lines 186-198) and `index` (used by `catalogueTemplateLooks`, lines 216-234) from `drizzle-orm/pg-core`. No new imports needed.

- [ ] **Step 2: Add the table**

In `packages/db/src/schema/models.ts`, find:

```ts
// One (pose, background) pairing — a "look" — within a catalogue template. Pose/background
// FKs are NO ACTION: both are soft-deleted (deletedAt / isActive=false), never hard-deleted,
// so a look can never dangle from an actual row removal. A look whose pose or background has
// been deactivated is filtered out at read time (GET /v1/models/catalogue-templates), not here.
export const catalogueTemplateLooks = pgTable(
  'catalogue_template_looks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id),
    backgroundId: uuid('background_id')
      .notNull()
      .references(() => modelBackgrounds.id),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    templateIdx: index('catalogue_template_looks_template_id_idx').on(table.templateId),
  }),
);
```

Add immediately after it (same file):

```ts

// Which garment types a catalogue template is offered for — pure many-to-many, no
// override columns. A template with zero rows here is offered for NO garment types
// (strict opt-in), not "all" — an admin must explicitly map it. Modeled directly on
// catalogItemSubcategories above, which answers the same kind of question for catalog
// items. Per-pose, per-garment-type workflow variance is a separate, already-working
// concern (pose_garment_configs) — this table only controls whether the template as a
// whole shows up at all for a given garment type.
export const catalogueTemplateSubcategories = pgTable(
  'catalogue_template_subcategories',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.templateId, table.subcategoryId] }),
  }),
);
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`

Expected: a new file `packages/db/src/migrations/01NN_<adjective>_<name>.sql` (next index after whatever `ls packages/db/src/migrations | grep -E '^[0-9]{4}_' | sort | tail -1` currently shows — 0105 at the time this plan was written) containing a `CREATE TABLE "catalogue_template_subcategories" (...)` statement with a composite primary key on `("template_id", "subcategory_id")` and two `FOREIGN KEY ... ON DELETE CASCADE` clauses.

Verify with: `cat packages/db/src/migrations/01NN_*.sql` (substitute the actual generated filename) and confirm it contains ONLY this new table — no unrelated statements. If drizzle-kit swept in unrelated pending schema drift, stop and check with the user before proceeding.

- [ ] **Step 4: Apply the migration locally**

Run: `pnpm db:migrate`

Expected: the new migration's hash is applied with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add catalogue_template_subcategories mapping table"
```

---

### Task 2: Admin API — list + toggle templates per garment type

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts:1-18,155-294`
- Test: `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin garment-type <-> catalogue-template mapping', () => {
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

  async function seedGarmentTypeAndTemplates() {
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-${Date.now()}`, label: 'Shirt' })
      .returning();
    const [templateA] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Template A', sortOrder: 0 })
      .returning();
    const [templateB] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Template B', sortOrder: 1 })
      .returning();
    // A different-gender template must never appear in this garment type's list.
    const [templateWomen] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Template Women', sortOrder: 0 })
      .returning();
    return { garmentType, templateA, templateB, templateWomen };
  }

  it('GET lists every same-gender template with mapped:false when unmapped', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { garmentType, templateA, templateB, templateWomen } =
      await seedGarmentTypeAndTemplates();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/templates`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    const a = items.find((t: { id: string }) => t.id === templateA.id);
    const b = items.find((t: { id: string }) => t.id === templateB.id);
    expect(a.mapped).toBe(false);
    expect(b.mapped).toBe(false);
    expect(items.find((t: { id: string }) => t.id === templateWomen.id)).toBeUndefined();
  });

  it('PATCH mapped:true inserts a mapping row, mapped:false removes it', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();

    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    expect(enableRes.statusCode).toBe(200);

    const rowsAfterEnable = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rowsAfterEnable).toHaveLength(1);

    const listRes = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/templates`,
      headers,
    });
    expect(listRes.json().items.find((t: { id: string }) => t.id === templateA.id).mapped).toBe(
      true,
    );

    const disableRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: false },
    });
    expect(disableRes.statusCode).toBe(200);

    const rowsAfterDisable = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rowsAfterDisable).toHaveLength(0);
  });

  it('PATCH mapped:true twice is idempotent (no duplicate row, no error)', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();

    await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    expect(second.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-template-subcategories-admin.test.ts --reporter=verbose`

Expected: FAIL — both routes don't exist yet (404s).

- [ ] **Step 3: Import the new schema table**

In `apps/api/src/modules/admin/subcategories.routes.ts`, the top imports already include `schema` from `@tryme/db` as a namespace (`import { schema } from '@tryme/db';`) — `schema.catalogueTemplateSubcategories` and `schema.catalogueTemplates` are available with no import change needed (they're exported from the shared `schema` namespace per Task 1).

- [ ] **Step 4: Add the GET and PATCH routes**

In `apps/api/src/modules/admin/subcategories.routes.ts`, find the closing of the file:

```ts
      return { ok: true, action: 'upserted' };
    },
  );
}
```

Replace with:

```ts
      return { ok: true, action: 'upserted' };
    },
  );

  // ── Per-garment-type catalogue-template mapping ───────────────────────────
  // Which catalogue templates are offered for this garment type — pure
  // enablement, no override data (per-pose workflow variance is handled
  // separately and already, by pose_garment_configs above).

  // GET /admin/assets/garment-types/:id/templates
  // Returns every SAME-GENDER catalogue template, each flagged mapped:true/false.
  app.get(
    '/admin/assets/garment-types/:id/templates',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [sub] = await app.db
        .select({ genderSlug: schema.garmentSubcategories.genderSlug })
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
      if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
        })
        .from(schema.catalogueTemplates)
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, sub.genderSlug ?? ''),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder), asc(schema.catalogueTemplates.label));

      const mappedRows = await app.db
        .select({ templateId: schema.catalogueTemplateSubcategories.templateId })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.subcategoryId, id));
      const mappedSet = new Set(mappedRows.map((r) => r.templateId));

      return {
        items: templates.map((t) => ({
          id: t.id,
          label: t.label,
          thumbnailUrl: t.thumbnailKey ? app.storage.publicUrl(t.thumbnailKey) : null,
          mapped: mappedSet.has(t.id),
        })),
      };
    },
  );

  // PATCH /admin/assets/garment-types/:id/templates/:templateId
  // mapped:true inserts the mapping row (no-op if already present), mapped:false
  // deletes it. No override data to upsert — plain membership toggle.
  app.patch(
    '/admin/assets/garment-types/:id/templates/:templateId',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid(), templateId: z.string().uuid() }),
        body: z.object({ mapped: z.boolean() }),
      },
    },
    async (req) => {
      const { id, templateId } = req.params as { id: string; templateId: string };
      const { mapped } = req.body as { mapped: boolean };

      if (mapped) {
        await app.db
          .insert(schema.catalogueTemplateSubcategories)
          .values({ templateId, subcategoryId: id })
          .onConflictDoNothing();
      } else {
        await app.db
          .delete(schema.catalogueTemplateSubcategories)
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.templateId, templateId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, id),
            ),
          );
      }

      return { ok: true };
    },
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-template-subcategories-admin.test.ts --reporter=verbose`

Expected: PASS — all 3 tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/catalogue-template-subcategories-admin.test.ts
git commit -m "feat(api): admin endpoints to map catalogue templates to garment types"
```

---

### Task 3: Public API — require a garment-type mapping to show a template

**Files:**
- Modify: `apps/api/src/modules/models/routes.ts:301-330`
- Modify: `apps/api/test/integration/catalogue-templates-public.test.ts`

- [ ] **Step 1: Update the existing tests for the new strict requirement**

The two existing tests in `apps/api/test/integration/catalogue-templates-public.test.ts` currently query without a garment-type mapping in place and expect templates back — after this task, that's no longer possible (unmapped = invisible, and missing `garmentTypeId` = empty list). Replace the entire file with:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('GET /v1/models/catalogue-templates', () => {
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

  async function loginToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('returns only resolvable looks, drops templates left with zero looks', async () => {
    const [activePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Active', genderSlug: 'men', r2Key: 'ap.jpg', thumbnailKey: 'ap.jpg' })
      .returning();
    const [inactivePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Inactive',
        genderSlug: 'men',
        r2Key: 'ip.jpg',
        thumbnailKey: 'ip.jpg',
        isActive: false,
      })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();

    const [templateWithSurvivingLook] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Has Looks', sortOrder: 0 })
      .returning();
    const [templateFullyFiltered] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'All Filtered', sortOrder: 1 })
      .returning();

    await app.db.insert(schema.catalogueTemplateLooks).values([
      {
        templateId: templateWithSurvivingLook.id,
        poseAssetId: activePose.id,
        backgroundId: bg.id,
        sortOrder: 0,
      },
      {
        templateId: templateWithSurvivingLook.id,
        poseAssetId: inactivePose.id,
        backgroundId: bg.id,
        sortOrder: 1,
      },
      {
        templateId: templateFullyFiltered.id,
        poseAssetId: inactivePose.id,
        backgroundId: bg.id,
        sortOrder: 0,
      },
    ]);

    // Both templates mapped to the same garment type, so the ONLY reason
    // templateFullyFiltered disappears from results is the zero-surviving-looks
    // rule under test here — not the garment-type mapping requirement.
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-looks-${activePose.id}`, label: 'GT' })
      .returning();
    await app.db.insert(schema.catalogueTemplateSubcategories).values([
      { templateId: templateWithSurvivingLook.id, subcategoryId: garmentType.id },
      { templateId: templateFullyFiltered.id, subcategoryId: garmentType.id },
    ]);

    const token = await loginToken('templates-public@x.com');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=men&garmentTypeId=${garmentType.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    const surviving = items.find((t: { id: string }) => t.id === templateWithSurvivingLook.id);
    expect(surviving).toBeTruthy();
    expect(surviving.looks).toHaveLength(1);
    expect(surviving.looks[0].poseId).toBe(activePose.id);

    // Template whose only look references an inactive pose is dropped entirely.
    expect(items.find((t: { id: string }) => t.id === templateFullyFiltered.id)).toBeUndefined();
  });

  it('overlays garmentTypeId hasLower/hasShoes and per-type active overrides, matching /v1/models/poses', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', genderSlug: 'women', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-override-${pose.id}`,
        label: 'WF',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['1'],
        lowerNodeId: '2',
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [subcatWithOverride] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-override-${pose.id}`, label: 'SC' })
      .returning();
    const [subcatNoOverride] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-no-override-${pose.id}`, label: 'SC2' })
      .returning();
    await app.db.insert(schema.poseGarmentConfigs).values({
      poseAssetId: pose.id,
      subcategoryId: subcatWithOverride.id,
      workflowTemplateId: workflow.id,
    });
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'T', sortOrder: 0 })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: bg.id,
      sortOrder: 0,
    });
    // Template mapped to BOTH garment types — one with a pose override, one without —
    // so both branches below are testing the override overlay, not the mapping gate.
    await app.db.insert(schema.catalogueTemplateSubcategories).values([
      { templateId: template.id, subcategoryId: subcatWithOverride.id },
      { templateId: template.id, subcategoryId: subcatNoOverride.id },
    ]);

    const token = await loginToken('templates-override@x.com');

    // Garment type with no pose override — pose has no default workflow → hasLower false.
    const resWithout = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${subcatNoOverride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const withoutLook = resWithout.json().items[0].looks[0];
    expect(withoutLook.hasLower).toBe(false);

    // Garment type with a pose override — hasLower true (workflow has lowerNodeId).
    const resWith = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${subcatWithOverride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const withLook = resWith.json().items[0].looks[0];
    expect(withLook.hasLower).toBe(true);
  });

  it('excludes a template that has no garment-type mapping at all', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', genderSlug: 'men', r2Key: 'p2.jpg', thumbnailKey: 'p2.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b2.jpg', thumbnailKey: 'b2.jpg' })
      .returning();
    const [unmappedTemplate] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Unmapped', sortOrder: 0 })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: unmappedTemplate.id,
      poseAssetId: pose.id,
      backgroundId: bg.id,
      sortOrder: 0,
    });
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-unmapped-${pose.id}`, label: 'GT' })
      .returning();
    // Deliberately no catalogueTemplateSubcategories row inserted for this template.

    const token = await loginToken('templates-unmapped@x.com');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=men&garmentTypeId=${garmentType.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.find((t: { id: string }) => t.id === unmappedTemplate.id),
    ).toBeUndefined();
  });

  it('returns an empty list when garmentTypeId is omitted', async () => {
    const token = await loginToken('templates-no-gt@x.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/catalogue-templates?gender=men',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-templates-public.test.ts --reporter=verbose`

Expected: FAIL — the two new tests fail (no filtering applied yet, so an unmapped template still shows, and omitting `garmentTypeId` still returns items). The two updated tests currently pass by coincidence (the route ignores the new mapping rows either way) — that's fine, they'll be re-verified as passing-for-the-right-reason in Step 4.

- [ ] **Step 3: Add the mapping requirement to the route**

In `apps/api/src/modules/models/routes.ts`, find:

```ts
    async (req) => {
      const { gender, garmentTypeId } = req.query as { gender: string; garmentTypeId?: string };

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
        })
        .from(schema.catalogueTemplates)
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, gender),
            eq(schema.catalogueTemplates.isActive, true),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder));

      if (templates.length === 0) return { items: [] };
      const templateIds = templates.map((t) => t.id);
```

Replace with:

```ts
    async (req) => {
      const { gender, garmentTypeId } = req.query as { gender: string; garmentTypeId?: string };

      // A template with no mapping row for this garment type is not offered for it at
      // all (strict opt-in — see catalogue_template_subcategories). Without a
      // garmentTypeId there's no way to know which templates apply, so fail closed.
      if (!garmentTypeId) return { items: [] };

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
        })
        .from(schema.catalogueTemplates)
        .innerJoin(
          schema.catalogueTemplateSubcategories,
          and(
            eq(schema.catalogueTemplateSubcategories.templateId, schema.catalogueTemplates.id),
            eq(schema.catalogueTemplateSubcategories.subcategoryId, garmentTypeId),
          ),
        )
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, gender),
            eq(schema.catalogueTemplates.isActive, true),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder));

      if (templates.length === 0) return { items: [] };
      const templateIds = templates.map((t) => t.id);
```

(The rest of the handler — look resolution, `pose_garment_configs` overlay, empty-template dropping — is unchanged; it already keys off `templateIds` and the same `garmentTypeId`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-templates-public.test.ts --reporter=verbose`

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm --filter @tryme/api test:unit`

Expected: all passing (no unit test exercises this route).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/models/routes.ts apps/api/test/integration/catalogue-templates-public.test.ts
git commit -m "feat(api): require an explicit garment-type mapping to show a catalogue template"
```

---

### Task 4: Admin-web — types for the new endpoint

**Files:**
- Modify: `apps/admin-web/src/types.ts:74-93`

- [ ] **Step 1: Add the response item type**

In `apps/admin-web/src/types.ts`, find:

```ts
export interface CatalogueTemplateLook {
  id: string;
  poseAssetId: string;
  backgroundId: string;
  sortOrder: number;
}
```

Add immediately after it:

```ts

export interface TemplateGarmentTypeMapping {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  mapped: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/admin exec tsc -b --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin-web/src/types.ts
git commit -m "feat(admin): add TemplateGarmentTypeMapping type"
```

---

### Task 5: Admin-web UI — garment-type mapping sub-view in the Catalogue Templates tab

**Files:**
- Modify: `apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx`

This lives inside the existing "Catalogue Templates" tab as a second sub-view — **not** merged into the separate "Garment Types" tab (explicit decision: that tab already has its own per-garment-type sub-view for pose overrides; mixing a second, differently-scoped concept into that same navigation would confuse the admin about what they're configuring), and **not** a new top-level AssetsPage tab.

- [ ] **Step 1: Add imports and sub-view state**

In `apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx`, find:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { EditCatalogueTemplateModal } from '../../components/EditCatalogueTemplateModal';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiFetch } from '../../lib/data';
import type { CatalogueTemplate, ModelBackground, ModelPoseAsset } from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

export function CatalogueTemplatesTab() {
  const { genderFilter, setGenderFilter, loading, setLoading, toast } = useAssetsContext();

  const [templates, setTemplates] = useState<CatalogueTemplate[]>([]);
```

Replace with:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { EditCatalogueTemplateModal } from '../../components/EditCatalogueTemplateModal';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiFetch } from '../../lib/data';
import type {
  CatalogueTemplate,
  GarmentType,
  ModelBackground,
  ModelPoseAsset,
  TemplateGarmentTypeMapping,
} from '../../types';
import { useAssetsContext } from './AssetsContext';

const GENDER_TABS = [
  { k: 'all' as const, l: 'All' },
  { k: 'men' as const, l: 'Men' },
  { k: 'women' as const, l: 'Women' },
  { k: 'boys' as const, l: 'Boys' },
  { k: 'girls' as const, l: 'Girls' },
];

type SubView = { kind: 'grid' } | { kind: 'mapping' };

export function CatalogueTemplatesTab() {
  const { genderFilter, setGenderFilter, garmentTypes, loading, setLoading, toast } =
    useAssetsContext();

  const [subView, setSubView] = useState<SubView>({ kind: 'grid' });
  const [templates, setTemplates] = useState<CatalogueTemplate[]>([]);
```

- [ ] **Step 2: Add the tab header toggle**

Find:

```tsx
      <div className="page-head">
        <div>
          <h1>Catalogue Templates</h1>
          <p className="lede">
            Curated (pose, background) look sets. Users pick a template on the studio page instead
            of manually choosing a background and poses.
          </p>
        </div>
        <div className="head-tools">
          <button className="btn ghost" onClick={() => setEditingTemplate('new')}>
            <Icon.Add /> New template
          </button>
        </div>
      </div>

      <div className="tabs" style={{ marginTop: -8 }}>
        {GENDER_TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${genderFilter === t.k ? 'active' : ''}`}
            onClick={() => setGenderFilter(t.k)}
          >
            {t.l}
          </button>
        ))}
      </div>

      {!loading &&
```

Replace with:

```tsx
      <div className="page-head">
        <div>
          <h1>Catalogue Templates</h1>
          <p className="lede">
            {subView.kind === 'grid'
              ? 'Curated (pose, background) look sets. Users pick a template on the studio page instead of manually choosing a background and poses.'
              : 'Pick a garment type to choose which templates are offered for it. A template offered for no garment type is never shown to users.'}
          </p>
        </div>
        <div className="head-tools">
          {subView.kind === 'grid' ? (
            <>
              <button
                className="btn ghost"
                onClick={() => setSubView({ kind: 'mapping' })}
              >
                Garment Type Mapping
              </button>
              <button className="btn ghost" onClick={() => setEditingTemplate('new')}>
                <Icon.Add /> New template
              </button>
            </>
          ) : (
            <button className="btn ghost" onClick={() => setSubView({ kind: 'grid' })}>
              <Icon.ArrowLeft /> Back to templates
            </button>
          )}
        </div>
      </div>

      <div className="tabs" style={{ marginTop: -8 }}>
        {GENDER_TABS.map((t) => (
          <button
            key={t.k}
            className={`tab ${genderFilter === t.k ? 'active' : ''}`}
            onClick={() => setGenderFilter(t.k)}
          >
            {t.l}
          </button>
        ))}
      </div>

      {subView.kind === 'mapping' && (
        <TemplateGarmentMappingPanel
          garmentTypes={garmentTypes}
          genderFilter={genderFilter}
          toast={toast}
        />
      )}

      {subView.kind === 'grid' &&
        !loading &&
```

- [ ] **Step 3: Close the conditional correctly**

The existing grid JSX block continues right after with `(filtered.length === 0 ? (...) : (...))` — since the previous step changed `{!loading &&` into `{subView.kind === 'grid' &&\n        !loading &&`, the existing `(filtered.length === 0 ? ... : ...))` expression and its closing `)}` do not need any further edits — the added condition is purely additive to the existing `&&` chain. Confirm by finding the immediately-following original block is untouched:

```tsx
        (filtered.length === 0 ? (
          <p style={{ color: 'var(--muted)', marginTop: 24 }}>
            No catalogue templates for this gender.
          </p>
        ) : (
```

This line must remain exactly as-is (it's already correctly indented under the modified condition from Step 2).

- [ ] **Step 4: Add the new panel component**

At the end of the file, find:

```tsx
      {editingTemplate !== null && (
        <EditCatalogueTemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          defaultGenderSlug={genderFilter === 'all' ? 'men' : genderFilter}
          poseAssets={poseAssets}
          backgrounds={backgrounds}
          onSaved={() => void load()}
          onClose={() => setEditingTemplate(null)}
          toast={toast}
        />
      )}
    </>
  );
}
```

Replace with:

```tsx
      {editingTemplate !== null && (
        <EditCatalogueTemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          defaultGenderSlug={genderFilter === 'all' ? 'men' : genderFilter}
          poseAssets={poseAssets}
          backgrounds={backgrounds}
          onSaved={() => void load()}
          onClose={() => setEditingTemplate(null)}
          toast={toast}
        />
      )}
    </>
  );
}

// ── TemplateGarmentMappingPanel ────────────────────────────────────────────────

interface TemplateGarmentMappingPanelProps {
  garmentTypes: GarmentType[];
  genderFilter: 'all' | 'men' | 'women' | 'boys' | 'girls';
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
}

function TemplateGarmentMappingPanel({
  garmentTypes,
  genderFilter,
  toast,
}: TemplateGarmentMappingPanelProps) {
  const [selectedGarmentType, setSelectedGarmentType] = useState<GarmentType | null>(null);
  const [items, setItems] = useState<TemplateGarmentTypeMapping[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadItems = useCallback(
    async (garmentTypeId: string) => {
      setItemsLoading(true);
      try {
        const res = await apiFetch<{ items: TemplateGarmentTypeMapping[] }>(
          `/admin/assets/garment-types/${garmentTypeId}/templates`,
        );
        setItems(res.items);
      } catch {
        toast({ kind: 'error', title: 'Failed to load template mapping' });
      } finally {
        setItemsLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (selectedGarmentType) void loadItems(selectedGarmentType.id);
  }, [selectedGarmentType, loadItems]);

  const toggleMapped = async (templateId: string, mapped: boolean) => {
    if (!selectedGarmentType) return;
    setSavingId(templateId);
    const prev = items;
    setItems((cur) => cur.map((i) => (i.id === templateId ? { ...i, mapped } : i)));
    try {
      await apiFetch(
        `/admin/assets/garment-types/${selectedGarmentType.id}/templates/${templateId}`,
        { method: 'PATCH', body: JSON.stringify({ mapped }) },
      );
    } catch {
      setItems(prev);
      toast({ kind: 'error', title: 'Failed to update mapping' });
    } finally {
      setSavingId(null);
    }
  };

  const filteredGarmentTypes = garmentTypes.filter(
    (g) => genderFilter === 'all' || g.genderSlug === genderFilter,
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, marginTop: 12 }}>
      <div className="table-wrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Garment Type</th>
            </tr>
          </thead>
          <tbody>
            {filteredGarmentTypes.map((g) => (
              <tr
                key={g.id}
                style={{
                  cursor: 'pointer',
                  background:
                    selectedGarmentType?.id === g.id ? 'var(--surface2, #1a1a1a)' : undefined,
                }}
                onClick={() => setSelectedGarmentType(g)}
              >
                <td>
                  <span className="semi">{g.label}</span>
                  <span className="sub mono" style={{ display: 'block' }}>
                    {g.genderSlug} / {g.slug}
                  </span>
                </td>
              </tr>
            ))}
            {filteredGarmentTypes.length === 0 && (
              <tr>
                <td style={{ textAlign: 'center', color: 'var(--muted)', padding: '1.5rem' }}>
                  No garment types for this gender.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        {!selectedGarmentType ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
            Select a garment type to see which templates are offered for it.
          </div>
        ) : itemsLoading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
            No templates for {selectedGarmentType.genderSlug}.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 12,
            }}
          >
            {items.map((item) => (
              <div
                key={item.id}
                className="card"
                style={{
                  padding: 0,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  outline: item.mapped ? '2px solid var(--pink)' : undefined,
                }}
              >
                <div
                  style={{
                    background: 'var(--surface2, #1a1a1a)',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    aspectRatio: '3/4',
                  }}
                >
                  {item.thumbnailUrl ? (
                    // biome-ignore lint/performance/noImgElement: admin panel
                    <img
                      src={item.thumbnailUrl}
                      alt={item.label}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Icon.Image />
                  )}
                </div>
                <div style={{ padding: '8px 8px 10px' }}>
                  <p
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={item.label}
                  >
                    {item.label}
                  </p>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 8,
                    }}
                  >
                    <Switch
                      checked={item.mapped}
                      onChange={() => void toggleMapped(item.id, !item.mapped)}
                    />
                    {savingId === item.id && (
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>Saving…</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @tryme/admin exec tsc -b --noEmit`

Expected: no errors.

Run: `npx biome check apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx`

Expected: no errors (or auto-fixable formatting only).

- [ ] **Step 6: Manual check**

Start the admin dev server (`pnpm --filter @tryme/admin dev`), open Assets → Catalogue Templates. Click "Garment Type Mapping", confirm the header/description text changes and a "Back to templates" button appears. Select a garment type on the left, confirm the right panel lists same-gender templates with their switches off (fresh DB) or reflecting existing mappings. Toggle a switch, reload the page, select the same garment type again, and confirm the toggle persisted. Click "Back to templates" and confirm the original grid (with "New template" button) is unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/pages/assets/CatalogueTemplatesTab.tsx
git commit -m "feat(admin): garment-type mapping sub-view in Catalogue Templates tab"
```

---

### Task 6: Update progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top**

Prepend to `docs/progress.md`:

```markdown
## 2026-07-14 - Catalogue Template Garment-Type Mapping

### Done
- New `catalogue_template_subcategories` table (pure many-to-many, no override columns) records which garment types a catalogue template is offered for. No rows = offered for no garment types — strict opt-in, not a backward-compatible "shows everywhere" default (confirmed safe: zero production templates existed at implementation time).
- `GET /v1/models/catalogue-templates` now requires a matching mapping row for the given `garmentTypeId`; a request with no `garmentTypeId` returns an empty list rather than everything.
- New admin endpoints mirroring the existing per-garment-type pose-override pattern (`GET`/`PATCH .../garment-types/:id/pose-configs`): `GET /admin/assets/garment-types/:id/templates` (list same-gender templates with `mapped` flags) and `PATCH .../templates/:templateId` (toggle one mapping).
- New "Garment Type Mapping" sub-view inside the existing Catalogue Templates admin tab — deliberately not merged into the separate Garment Types tab (which already has its own per-garment-type sub-view for a different concept, pose overrides) and not a new top-level tab.
- Confirmed and left untouched: per-pose, per-garment-type workflow resolution already works end-to-end via the existing `pose_garment_configs` mechanism, both at job-creation validation and dispatcher generation time — this feature only gates which templates are visible at all, not how their looks render.
- Spec: `docs/superpowers/specs/2026-07-14-catalogue-template-garment-type-mapping-design.md`. Plan: `docs/superpowers/plans/2026-07-14-catalogue-template-garment-type-mapping.md`.

### Failed / Not Done
- None.

### Open Questions / Decisions
- None.
```

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs(progress): log catalogue template garment-type mapping feature"
```

---

## Review Checklist

Since Codex implements this plan externally, use this checklist when reviewing the actual diff against it:

1. **Task 1** — Is `catalogue_template_subcategories` a composite-PK many-to-many with no extra columns (no `workflowTemplateId`, no `isActive` override)? That would be a deviation from the confirmed design (per-pose workflow variance already works elsewhere; this table only gates visibility).
2. **Task 2** — Does `PATCH .../templates/:templateId` actually delete the row on `mapped:false` rather than soft-marking it? Is the `GET` scoped to the garment type's own gender (not all templates)?
3. **Task 3** — Is the "no `garmentTypeId` → empty list" check present and does it run *before* any DB query? Does the `INNER JOIN` correctly require both the right `templateId` and the right `subcategoryId` (a join on `templateId` alone would silently readmit every template)?
4. **Task 3 tests** — Do the updated tests actually seed `catalogueTemplateSubcategories` rows for every case that expects results back? A passing test that forgot to seed the mapping and happens to pass because of a bug (e.g., the join was accidentally left out) is worse than a failing one — re-derive expected behavior from the spec, don't just trust green.
5. **Task 5** — Does the new sub-view live inside `CatalogueTemplatesTab.tsx` only, with zero changes to `GarmentTypesTab.tsx`? That separation was an explicit, deliberate product decision — a Codex run merging them back together (e.g., because it seemed "more consistent") would be a real deviation to flag, not a harmless improvement.
6. **General** — Any new top-level AssetsPage tab, any new field on the template's own create/patch body (`subcategoryIds` inline), or any workflow-override column on the new table are all explicitly rejected alternatives in the spec — flag any of them if present.
