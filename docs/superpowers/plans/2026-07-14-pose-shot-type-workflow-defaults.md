# Pose Shot-Type Default Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure catalogue-template pose workflow assignment for an entire garment type — regardless of how many templates are mapped to it, now or later — with three actions (one per shot-type category) instead of one action per pose-per-template.

**Architecture:** Tag each template-scoped pose with a shot-type category (`full` / `half` / `closeup`) at upload time. Give each garment type a 3-slot default (shot-type → workflow). A single shared SQL helper module resolves `catalogue_template_pose_workflows` rows from those defaults via an atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE source = 'auto'` statement, fired from four trigger points (default changed, template newly mapped, template looks replaced, manual override cleared). A `source` column (`'auto' | 'manual'`) on the resolved table makes "never clobber an explicit admin pick" a database-level guarantee.

**Tech Stack:** Fastify 5, Drizzle ORM (Postgres), Zod, Vitest (integration tests against real Postgres via `pnpm docker:up`), React (admin-web, no test framework wired).

**Design doc:** `docs/superpowers/specs/2026-07-14-pose-shot-type-workflow-defaults-design.md` — read it first for the full rationale; this plan implements it task by task.

---

## Before you start

Run `pnpm docker:up` and leave it running — every backend task's tests need real Postgres. Confirm the baseline is green before touching anything:

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-template-subcategories-admin.test.ts
```
Expected: all tests in that file pass (this is the closest existing analog to what you're about to modify — if it's red before you start, stop and investigate that first, don't build on a broken baseline).

---

### Task 1: Schema — `shot_type`, `source`, and the `garment_shot_type_workflows` table

**Files:**
- Modify: `packages/db/src/schema/models.ts`
- Generate: `packages/db/src/migrations/0110_*.sql` + `packages/db/src/migrations/meta/0110_snapshot.json` + `packages/db/src/migrations/meta/_journal.json` (via `pnpm db:generate` — do not hand-write this SQL)

- [ ] **Step 1: Add `shotType` to `modelPoseAssets`**

In `packages/db/src/schema/models.ts`, find the `modelPoseAssets` table (around line 129):

```ts
export const modelPoseAssets = pgTable('model_pose_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  displayName: text('display_name'),
  poseVariant: text('pose_variant'),
  r2Key: text('r2_key').notNull(),
```

Change it to add `shotType` right after `poseVariant`:

```ts
export const modelPoseAssets = pgTable('model_pose_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  displayName: text('display_name'),
  poseVariant: text('pose_variant'),
  // 'full' | 'half' | 'closeup' — validated at the Zod layer, not a DB enum, so
  // adding a category later is a one-line change, not a migration. Set once at
  // pose-upload time; drives garment_shot_type_workflows auto-resolution for
  // template-scoped poses.
  shotType: text('shot_type'),
  r2Key: text('r2_key').notNull(),
```

- [ ] **Step 2: Add `source` to `catalogueTemplatePoseWorkflows`**

Find the `catalogueTemplatePoseWorkflows` table (around line 262):

```ts
export const catalogueTemplatePoseWorkflows = pgTable(
  'catalogue_template_pose_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => catalogueTemplateSubcategories.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id, { onDelete: 'cascade' }),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    promptGarmentPhase: text('prompt_garment_phase'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqMappingPose: unique('catalogue_template_pose_workflows_mapping_pose_unique').on(
      table.mappingId,
      table.poseAssetId,
    ),
    mappingIdx: index('catalogue_template_pose_workflows_mapping_id_idx').on(table.mappingId),
  }),
);
```

Add `source` right after `promptGarmentPhase`. The `NOT NULL DEFAULT 'manual'` is what backfills every pre-existing row to `'manual'` for free when the migration runs, protecting all of today's admin-configured workflows from ever being touched by auto-resolve:

```ts
export const catalogueTemplatePoseWorkflows = pgTable(
  'catalogue_template_pose_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => catalogueTemplateSubcategories.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id, { onDelete: 'cascade' }),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    promptGarmentPhase: text('prompt_garment_phase'),
    // 'auto' = written or last refreshed by the shot-type-default resolver; safe to
    // overwrite on the next resolve. 'manual' = an admin picked this explicitly via
    // the per-pose dropdown; the resolver's ON CONFLICT ... WHERE source = 'auto'
    // guard means it will never touch this row again until the admin clears it.
    source: text('source').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqMappingPose: unique('catalogue_template_pose_workflows_mapping_pose_unique').on(
      table.mappingId,
      table.poseAssetId,
    ),
    mappingIdx: index('catalogue_template_pose_workflows_mapping_id_idx').on(table.mappingId),
  }),
);
```

- [ ] **Step 3: Add the `garmentShotTypeWorkflows` table**

Immediately after the `catalogueTemplatePoseWorkflows` block you just edited (right after its closing `);`), add:

```ts

// The 3-slot default per garment type: "poses tagged X use workflow Y". A join
// table, not fixed columns on garment_subcategories — a 4th shot type later is new
// rows, not a migration. Setting/changing a row here immediately re-resolves every
// matching pose across every template mapped to this garment type — see
// apps/api/src/modules/admin/shot-type-resolve.ts.
export const garmentShotTypeWorkflows = pgTable(
  'garment_shot_type_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    garmentTypeId: uuid('garment_type_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
    shotType: text('shot_type').notNull(), // 'full' | 'half' | 'closeup'
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqGarmentTypeShotType: unique(
      'garment_shot_type_workflows_garment_type_shot_type_unique',
    ).on(table.garmentTypeId, table.shotType),
    garmentTypeIdx: index('garment_shot_type_workflows_garment_type_id_idx').on(
      table.garmentTypeId,
    ),
  }),
);
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

Expected: a new `packages/db/src/migrations/0110_<random-name>.sql` and matching `meta/0110_snapshot.json` appear, and `meta/_journal.json` gets a new entry with `"idx": 110`. Open the generated `.sql` file and confirm it contains **exactly** these statements and nothing else:
- `ALTER TABLE "model_pose_assets" ADD COLUMN "shot_type" text;`
- `ALTER TABLE "catalogue_template_pose_workflows" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;`
- `CREATE TABLE IF NOT EXISTS "garment_shot_type_workflows" (...)` with the FK constraints and the unique index on `(garment_type_id, shot_type)`.

If any of these are missing, OR if the file contains anything beyond these three changes, stop — don't proceed on the assumption that extra statements are harmless. Drizzle diffs your schema file against the last-recorded snapshot, so unrelated statements mean either the working tree has uncommitted schema drift from something else, or a schema edit elsewhere in `models.ts` got picked up by accident. Investigate and resolve that before continuing; fix the schema file and re-run `pnpm db:generate` (delete the wrong migration files first) once the diff is clean.

- [ ] **Step 5: Apply the migration**

```bash
pnpm db:migrate
```

Expected: no errors. `garment_shot_type_workflows` now exists in your local dev Postgres, and `model_pose_assets` / `catalogue_template_pose_workflows` have their new columns.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/0110_*.sql packages/db/src/migrations/meta/0110_snapshot.json packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add shot-type tagging and garment-type shot-type-workflow defaults"
```

---

### Task 2: Shared resolve-cascade helper module

**Files:**
- Create: `apps/api/src/modules/admin/shot-type-resolve.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts`

This is the core correctness-critical piece: three functions, each a single atomic SQL statement, each honoring "insert into gaps, refresh `'auto'` rows, never touch `'manual'` rows."

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/shot-type-workflow-resolve.test.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveForGarmentTypeShotType,
  resolveForMapping,
  resolveForTemplate,
} from '../../src/modules/admin/shot-type-resolve.js';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('shot-type workflow resolve', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedWorkflow(label: string) {
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()}`,
        label,
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        lowerNodeId: '7',
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    return wf;
  }

  async function seedMappedPose(opts: { shotType: string | null }) {
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-${Date.now()}-${Math.random()}`, label: 'Shirt' })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Template', sortOrder: 0 })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Pose',
        genderSlug: 'women',
        r2Key: `pose-${Date.now()}-${Math.random()}.jpg`,
        thumbnailKey: 'pose-thumb.jpg',
        scope: 'template',
        shotType: opts.shotType,
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Background',
        r2Key: `bg-${Date.now()}-${Math.random()}.jpg`,
        thumbnailKey: 'bg-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    return { garmentType, template, pose, background, mapping };
  }

  it('resolveForGarmentTypeShotType fills a gap from the configured default', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Full default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflow.id);
    expect(row.source).toBe('auto');
  });

  it('resolveForGarmentTypeShotType never touches a manually-set row', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const defaultWorkflow = await seedWorkflow('Default (should be ignored)');
    const manualWorkflow = await seedWorkflow('Manual pick');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: defaultWorkflow.id,
    });
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: pose.id,
      workflowTemplateId: manualWorkflow.id,
      source: 'manual',
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(manualWorkflow.id);
    expect(row.source).toBe('manual');
  });

  it('resolveForGarmentTypeShotType refreshes a previously-auto row when the default changes', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const oldDefault = await seedWorkflow('Old default');
    const newDefault = await seedWorkflow('New default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: oldDefault.id,
    });
    await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');

    await app.db
      .update(schema.garmentShotTypeWorkflows)
      .set({ workflowTemplateId: newDefault.id })
      .where(eq(schema.garmentShotTypeWorkflows.garmentTypeId, garmentType.id));
    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(newDefault.id);
    expect(row.source).toBe('auto');
  });

  it('resolveForMapping resolves every shot type for one mapping in a single call', async () => {
    const { garmentType, mapping, pose: fullPose } = await seedMappedPose({ shotType: 'full' });
    const [halfPose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Half pose',
        genderSlug: 'women',
        r2Key: `half-${Date.now()}.jpg`,
        thumbnailKey: 'half-thumb.jpg',
        scope: 'template',
        shotType: 'half',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Background 2',
        r2Key: `bg2-${Date.now()}.jpg`,
        thumbnailKey: 'bg2-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: mapping.templateId,
      poseAssetId: halfPose.id,
      backgroundId: background.id,
    });
    const fullWorkflow = await seedWorkflow('Full');
    const halfWorkflow = await seedWorkflow('Half');
    await app.db.insert(schema.garmentShotTypeWorkflows).values([
      { garmentTypeId: garmentType.id, shotType: 'full', workflowTemplateId: fullWorkflow.id },
      { garmentTypeId: garmentType.id, shotType: 'half', workflowTemplateId: halfWorkflow.id },
    ]);

    const resolvedCount = await resolveForMapping(app.db, mapping.id);
    expect(resolvedCount).toBe(2);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows.find((r) => r.poseAssetId === fullPose.id)?.workflowTemplateId).toBe(
      fullWorkflow.id,
    );
    expect(rows.find((r) => r.poseAssetId === halfPose.id)?.workflowTemplateId).toBe(
      halfWorkflow.id,
    );
  });

  it('resolveForTemplate resolves across every garment type the template is mapped to', async () => {
    const { template, pose } = await seedMappedPose({ shotType: 'full' });
    const [garmentTypeB] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-b-${Date.now()}`, label: 'Suit' })
      .returning();
    const [mappingB] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentTypeB.id })
      .returning();
    const workflowB = await seedWorkflow('Garment type B default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentTypeB.id,
      shotType: 'full',
      workflowTemplateId: workflowB.id,
    });

    const resolvedCount = await resolveForTemplate(app.db, template.id);
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingB.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflowB.id);
  });

  it('resolve is a no-op when the pose has no shot type or no matching default exists', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: null });
    const workflow = await seedWorkflow('Unused default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForMapping(app.db, mapping.id);
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('resolveForGarmentTypeShotType ignores a deactivated pose', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: false })
      .where(eq(schema.modelPoseAssets.id, pose.id));
    const workflow = await seedWorkflow('Ignored — pose inactive');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows).toHaveLength(0);
  });

  it('resolveForGarmentTypeShotType ignores a soft-deleted template', async () => {
    const { garmentType, template, mapping } = await seedMappedPose({ shotType: 'full' });
    await app.db
      .update(schema.catalogueTemplates)
      .set({ deletedAt: new Date() })
      .where(eq(schema.catalogueTemplates.id, template.id));
    const workflow = await seedWorkflow('Ignored — template deleted');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows).toHaveLength(0);
  });

  it('resolve does not rewrite a row already at the correct value', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Stable default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });
    const firstRun = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(firstRun).toBe(1);

    const [before] = await app.db
      .select({ updatedAt: schema.catalogueTemplatePoseWorkflows.updatedAt })
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );

    const secondRun = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(secondRun).toBe(0);

    const [after] = await app.db
      .select({ updatedAt: schema.catalogueTemplatePoseWorkflows.updatedAt })
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('resolve functions accept a transaction handle', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Resolved inside a transaction');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await app.db.transaction(async (tx) => {
      return resolveForGarmentTypeShotType(tx, garmentType.id, 'full');
    });
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflow.id);
  });

  it('resolves to one row when the same pose appears in two looks with different backgrounds', async () => {
    const { garmentType, template, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const [secondBackground] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Second background',
        r2Key: `second-bg-${Date.now()}.jpg`,
        thumbnailKey: 'second-bg-thumb.jpg',
        scope: 'template',
      })
      .returning();
    // Same pose as the one seedMappedPose already put in a look — the template's
    // dedupe check only rejects duplicate (poseAssetId, backgroundId) pairs, so this
    // (same pose, different background) combination is a valid second look.
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: secondBackground.id,
    });
    const workflow = await seedWorkflow('Reused-pose default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForTemplate(app.db, template.id);
    expect(resolvedCount).toBe(1);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowTemplateId).toBe(workflow.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: FAIL — `Cannot find module '../../src/modules/admin/shot-type-resolve.js'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/admin/shot-type-resolve.ts`:

```ts
import type { DB } from '@tryme/db';
import { sql } from 'drizzle-orm';

// Auto-resolves catalogue_template_pose_workflows rows from garment_shot_type_workflows
// defaults. Every function here is a single atomic INSERT ... SELECT ... ON CONFLICT
// statement — no per-row loop — so resolving thousands of (mapping, pose) rows at once
// is one round trip. The `WHERE catalogue_template_pose_workflows.source = 'auto'` guard
// on the conflict branch is what makes re-running this safe at any time: it inserts into
// any gap, refreshes any row this same auto-resolver previously wrote, and never touches
// a row an admin explicitly picked (source = 'manual') via the per-pose dropdown. The
// `IS DISTINCT FROM` clause alongside it means a row already at the correct value is left
// completely untouched — no wasted UPDATE, no bumped updated_at — so most re-runs at scale
// touch nothing. Excludes deactivated/soft-deleted poses and soft-deleted templates: a
// retired asset should never get a workflow row written or refreshed for it.
//
// SELECT DISTINCT is required, not cosmetic: a template's look-dedupe check only
// rejects duplicate (poseAssetId, backgroundId) PAIRS, so the same pose paired with two
// different backgrounds is a perfectly valid template (two separate looks). That
// produces two source rows with the identical (mapping_id, pose_asset_id) key in one
// INSERT — and Postgres's ON CONFLICT DO UPDATE raises "command cannot affect row a
// second time" if a single statement tries to upsert the same target row twice. Every
// non-DISTINCT column here (the mapping id, the pose id, and the resolved workflow —
// which depends only on the pose's shot type, never on which background it's paired
// with) is already identical across such duplicates, so DISTINCT collapses them
// losslessly.
//
// Every function accepts an `Executor` — a plain `DB` or a transaction handle (`tx` from
// `db.transaction(async (tx) => ...)`) — because every caller must run its mutation (the
// upsert, the mapping insert, the override delete) and its resolve call in ONE transaction.
// Two separate round trips would mean a resolve failure after a successful mutation leaves
// permanently-unresolved state with no automatic retry path (worst case: a new mapping insert
// uses ON CONFLICT DO NOTHING, so retrying `mapped: true` after a partial failure would hit
// the "already exists" branch and never call resolve again). Wrapping both in one transaction
// means a resolve failure rolls back the mutation too, so a retry re-enters the same path.
type Executor = Pick<DB, 'execute'>;

const UPSERT_TAIL = sql`
  ON CONFLICT (mapping_id, pose_asset_id) DO UPDATE SET
    workflow_template_id = excluded.workflow_template_id,
    source = 'auto',
    updated_at = now()
  WHERE catalogue_template_pose_workflows.source = 'auto'
    AND catalogue_template_pose_workflows.workflow_template_id
      IS DISTINCT FROM excluded.workflow_template_id
  RETURNING catalogue_template_pose_workflows.id
`;

const ACTIVE_POSE_AND_TEMPLATE_JOIN = sql`
    JOIN catalogue_templates t ON t.id = m.template_id AND t.deleted_at IS NULL
    JOIN catalogue_template_looks l ON l.template_id = m.template_id
    JOIN model_pose_assets p
      ON p.id = l.pose_asset_id AND p.is_active AND p.deleted_at IS NULL
`;

/** Resolves every shot-type default for one specific (template × garment type) mapping. */
export async function resolveForMapping(db: Executor, mappingId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.id = ${mappingId}::uuid
    ${UPSERT_TAIL}
  `);
  return result.length;
}

/** Resolves every shot-type default across every garment type a template is mapped to. */
export async function resolveForTemplate(db: Executor, templateId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.template_id = ${templateId}::uuid
    ${UPSERT_TAIL}
  `);
  return result.length;
}

/** Resolves one shot-type's default across every template mapped to one garment type. */
export async function resolveForGarmentTypeShotType(
  db: Executor,
  garmentTypeId: string,
  shotType: string,
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.subcategory_id = ${garmentTypeId}::uuid AND p.shot_type = ${shotType}
    ${UPSERT_TAIL}
  `);
  return result.length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 11/11 tests green.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/shot-type-resolve.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): shot-type-default auto-resolve helper for catalogue_template_pose_workflows"
```

---

### Task 3: Shot-type-workflows admin routes

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/integration/shot-type-workflow-resolve.test.ts`, inside the existing `describe('shot-type workflow resolve', ...)` block, right after the last `it(...)` (before the closing `});` of the describe block):

```ts

  describe('routes', () => {
    it('GET shot-type-workflows always returns all three slots', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `route-get-${Date.now()}`, label: 'Shirt' })
        .returning();

      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items).toHaveLength(3);
      expect(items.map((i: { shotType: string }) => i.shotType).sort()).toEqual([
        'closeup',
        'full',
        'half',
      ]);
      expect(items.every((i: { workflowTemplateId: null }) => i.workflowTemplateId === null)).toBe(
        true,
      );
    });

    it('GET shot-type-workflows 404s for a nonexistent garment type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${crypto.randomUUID()}/shot-type-workflows`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH shot-type-workflows upserts the default and cascades to existing poses', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Route default');

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ ok: true, action: 'upserted', resolvedCount: 1 });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);

      const getRes = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      const full = getRes
        .json()
        .items.find((i: { shotType: string }) => i.shotType === 'full');
      expect(full.workflowTemplateId).toBe(workflow.id);
    });

    it('PATCH shot-type-workflows with null clears the default without touching resolved poses', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Cleared default');
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });

      const clearRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json()).toMatchObject({ ok: true, action: 'cleared' });

      const getRes = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      const full = getRes
        .json()
        .items.find((i: { shotType: string }) => i.shotType === 'full');
      expect(full.workflowTemplateId).toBeNull();

      // Already-resolved poses stay exactly as they are.
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
    });

    it('PATCH shot-type-workflows rejects an inactive or non-regular workflow', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `route-invalid-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [inactiveWorkflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `inactive-${Date.now()}`,
          label: 'Inactive',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
          isActive: false,
        })
        .returning();

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: inactiveWorkflow.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH shot-type-workflows 404s for a nonexistent garment type', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${crypto.randomUUID()}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(res.statusCode).toBe(404);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: the 11 tests from Task 2 still pass; the 6 new route tests FAIL (the 404 tests fail because the routes return 200/whatever-else instead of 404 with no existence check yet; the rest fail with 404 because the routes don't exist yet).

- [ ] **Step 3: Implement the routes**

In `apps/api/src/modules/admin/subcategories.routes.ts`, add the import at the top of the file, alongside the existing imports:

```ts
import { requireAdmin } from './guard.js';
import { resolveForGarmentTypeShotType } from './shot-type-resolve.js';
```

Then add the two new routes. Insert them right before the closing `}` of `adminGarmentTypesRoutes` (after the last existing route, the `PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId` handler, which currently ends the file around line 570):

```ts

  // ── Per-garment-type shot-type default workflows ──────────────────────────
  // The 3-slot default that auto-resolves catalogue_template_pose_workflows for
  // every template mapped to this garment type — see shot-type-resolve.ts.

  const SHOT_TYPES = ['full', 'half', 'closeup'] as const;

  async function requireGarmentType(id: string) {
    const [sub] = await app.db
      .select({ id: schema.garmentSubcategories.id })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, id));
    if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');
  }

  app.get(
    '/admin/assets/garment-types/:id/shot-type-workflows',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await requireGarmentType(id);
      const rows = await app.db
        .select({
          shotType: schema.garmentShotTypeWorkflows.shotType,
          workflowTemplateId: schema.garmentShotTypeWorkflows.workflowTemplateId,
        })
        .from(schema.garmentShotTypeWorkflows)
        .where(eq(schema.garmentShotTypeWorkflows.garmentTypeId, id));
      const byShotType = new Map(rows.map((r) => [r.shotType, r.workflowTemplateId]));
      return {
        items: SHOT_TYPES.map((shotType) => ({
          shotType,
          workflowTemplateId: byShotType.get(shotType) ?? null,
        })),
      };
    },
  );

  app.patch(
    '/admin/assets/garment-types/:id/shot-type-workflows/:shotType',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid(), shotType: z.enum(SHOT_TYPES) }),
        body: z.object({ workflowTemplateId: z.string().uuid().nullable() }),
      },
    },
    async (req) => {
      const { id, shotType } = req.params as {
        id: string;
        shotType: (typeof SHOT_TYPES)[number];
      };
      const { workflowTemplateId } = req.body as { workflowTemplateId: string | null };
      await requireGarmentType(id);

      if (!workflowTemplateId) {
        await app.db
          .delete(schema.garmentShotTypeWorkflows)
          .where(
            and(
              eq(schema.garmentShotTypeWorkflows.garmentTypeId, id),
              eq(schema.garmentShotTypeWorkflows.shotType, shotType),
            ),
          );
        // Deliberately does not touch already-resolved 'auto' rows — clearing a
        // default shouldn't retroactively break templates that are already working.
        return { ok: true, action: 'cleared', resolvedCount: 0 };
      }

      const [workflow] = await app.db
        .select({ id: schema.workflowTemplates.id })
        .from(schema.workflowTemplates)
        .where(
          and(
            eq(schema.workflowTemplates.id, workflowTemplateId),
            eq(schema.workflowTemplates.workflowType, 'regular'),
            eq(schema.workflowTemplates.isActive, true),
          ),
        );
      if (!workflow) throw new AppError('BAD_CATALOG', 400, 'workflow not found or inactive');

      // Upsert + cascade run in one transaction — see shot-type-resolve.ts's header
      // comment for why: if the resolve half failed after a non-transactional upsert
      // had already committed, the default would be saved but never actually applied,
      // with no automatic way to notice or retry.
      const resolvedCount = await app.db.transaction(async (tx) => {
        await tx
          .insert(schema.garmentShotTypeWorkflows)
          .values({ garmentTypeId: id, shotType, workflowTemplateId })
          .onConflictDoUpdate({
            target: [
              schema.garmentShotTypeWorkflows.garmentTypeId,
              schema.garmentShotTypeWorkflows.shotType,
            ],
            set: { workflowTemplateId, updatedAt: new Date() },
          });
        return resolveForGarmentTypeShotType(tx, id, shotType);
      });
      return { ok: true, action: 'upserted', resolvedCount };
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 17/17 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): add GET/PATCH garment-type shot-type-workflow default routes"
```

---

### Task 4: Auto-resolve on template-looks replace

**Files:**
- Modify: `apps/api/src/modules/admin/catalogue-templates.routes.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('routes', ...)` block from Task 3, after the last `it(...)`:

```ts

    it('PUT template looks resolves the new look across every garment type the template is mapped to', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `looks-put-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [template] = await app.db
        .insert(schema.catalogueTemplates)
        .values({ genderSlug: 'women', label: 'Looks PUT template', sortOrder: 0 })
        .returning();
      await app.db
        .insert(schema.catalogueTemplateSubcategories)
        .values({ templateId: template.id, subcategoryId: garmentType.id });
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Fresh pose',
          genderSlug: 'women',
          r2Key: `fresh-${Date.now()}.jpg`,
          thumbnailKey: 'fresh-thumb.jpg',
          scope: 'template',
          shotType: 'closeup',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'Fresh background',
          r2Key: `fresh-bg-${Date.now()}.jpg`,
          thumbnailKey: 'fresh-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();
      const workflow = await seedWorkflow('Closeup default');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'closeup',
        workflowTemplateId: workflow.id,
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/admin/assets/catalogue-templates/${template.id}/looks`,
        headers,
        payload: { looks: [{ poseAssetId: pose.id, backgroundId: background.id }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, count: 1, resolvedCount: 1 });

      const [mapping] = await app.db
        .select({ id: schema.catalogueTemplateSubcategories.id })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.templateId, template.id));
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
      expect(row.source).toBe('auto');
    });

    it('PUT template looks deletes stale workflow rows for poses no longer in the template', async () => {
      const { garmentType, template, mapping, pose: oldPose } = await seedMappedPose({
        shotType: 'full',
      });
      const workflow = await seedWorkflow('Stale-row cleanup default');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: workflow.id,
      });
      // Resolve once so the old pose has a real row to clean up.
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });
      const [beforeRow] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, oldPose.id),
          ),
        );
      expect(beforeRow).toBeDefined();

      // Simulate "correct a mis-tagged pose by re-uploading it" — a brand-new pose
      // asset replaces the old one in this template's only look.
      const [newPose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Replacement pose',
          genderSlug: 'women',
          r2Key: `replacement-${Date.now()}.jpg`,
          thumbnailKey: 'replacement-thumb.jpg',
          scope: 'template',
          shotType: 'full',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'Replacement background',
          r2Key: `replacement-bg-${Date.now()}.jpg`,
          thumbnailKey: 'replacement-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();

      await app.inject({
        method: 'PUT',
        url: `/admin/assets/catalogue-templates/${template.id}/looks`,
        headers,
        payload: { looks: [{ poseAssetId: newPose.id, backgroundId: background.id }] },
      });

      const oldRows = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, oldPose.id),
          ),
        );
      expect(oldRows).toHaveLength(0);

      const [newRow] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, newPose.id),
          ),
        );
      expect(newRow.workflowTemplateId).toBe(workflow.id);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: FAIL — the first new test fails because the response has no `resolvedCount` key; the second fails because the old pose's row is still present (no cleanup yet).

- [ ] **Step 3: Wire the resolve call**

In `apps/api/src/modules/admin/catalogue-templates.routes.ts`, update the drizzle-orm import to add `notInArray`:

```ts
import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
```

Add the import for the resolver:

```ts
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';
import { resolveForTemplate } from './shot-type-resolve.js';
```

Then find the `PUT /admin/assets/catalogue-templates/:id/looks` handler's ending:

```ts
      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.catalogueTemplateLooks)
          .where(eq(schema.catalogueTemplateLooks.templateId, id));
        if (looks.length > 0) {
          await tx.insert(schema.catalogueTemplateLooks).values(
            looks.map((l, i) => ({
              templateId: id,
              poseAssetId: l.poseAssetId,
              backgroundId: l.backgroundId,
              sortOrder: i,
            })),
          );
        }
      });

      return { ok: true, count: looks.length };
    },
  );
```

Change to run the cleanup and the resolve inside the same transaction as the looks-replace, so none of this is a separate non-atomic round trip:

```ts
      const resolvedCount = await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.catalogueTemplateLooks)
          .where(eq(schema.catalogueTemplateLooks.templateId, id));
        if (looks.length > 0) {
          await tx.insert(schema.catalogueTemplateLooks).values(
            looks.map((l, i) => ({
              templateId: id,
              poseAssetId: l.poseAssetId,
              backgroundId: l.backgroundId,
              sortOrder: i,
            })),
          );
        }

        // Every pose upload in this builder is fresh (a new pose_asset_id), so
        // "correct a mis-tagged pose by re-uploading it" — or simply removing a
        // look — always leaves the old pose's workflow row behind with nothing
        // pointing at it anymore. Delete any catalogue_template_pose_workflows row,
        // across every garment type this template is mapped to, whose pose is no
        // longer among the template's current looks.
        const mappingRows = await tx
          .select({ id: schema.catalogueTemplateSubcategories.id })
          .from(schema.catalogueTemplateSubcategories)
          .where(eq(schema.catalogueTemplateSubcategories.templateId, id));
        const mappingIds = mappingRows.map((m) => m.id);
        if (mappingIds.length > 0) {
          const currentPoseIds = looks.map((l) => l.poseAssetId);
          const staleConditions = [
            inArray(schema.catalogueTemplatePoseWorkflows.mappingId, mappingIds),
          ];
          if (currentPoseIds.length > 0) {
            staleConditions.push(
              notInArray(schema.catalogueTemplatePoseWorkflows.poseAssetId, currentPoseIds),
            );
          }
          await tx
            .delete(schema.catalogueTemplatePoseWorkflows)
            .where(and(...staleConditions));
        }

        return resolveForTemplate(tx, id);
      });

      return { ok: true, count: looks.length, resolvedCount };
    },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 19/19 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/catalogue-templates.routes.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): auto-resolve shot-type workflows when a template's looks are replaced, and clean up stale rows"
```

---

### Task 5: Auto-resolve on new template mapping

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append inside the `describe('routes', ...)` block, after the test added in Task 4:

```ts

    it('PATCH templates mapped:true resolves the new mapping against existing defaults', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `new-mapping-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [template] = await app.db
        .insert(schema.catalogueTemplates)
        .values({ genderSlug: 'women', label: 'New mapping template', sortOrder: 0 })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'New mapping pose',
          genderSlug: 'women',
          r2Key: `new-mapping-${Date.now()}.jpg`,
          thumbnailKey: 'new-mapping-thumb.jpg',
          scope: 'template',
          shotType: 'half',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'New mapping background',
          r2Key: `new-mapping-bg-${Date.now()}.jpg`,
          thumbnailKey: 'new-mapping-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();
      await app.db.insert(schema.catalogueTemplateLooks).values({
        templateId: template.id,
        poseAssetId: pose.id,
        backgroundId: background.id,
      });
      const workflow = await seedWorkflow('Half default for new mapping');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'half',
        workflowTemplateId: workflow.id,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/templates/${template.id}`,
        headers,
        payload: { mapped: true },
      });
      expect(res.statusCode).toBe(200);
      const { mappingId, resolvedCount } = res.json();
      expect(resolvedCount).toBe(1);

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: FAIL — `resolvedCount` is `undefined`.

- [ ] **Step 3: Wire the resolve call**

In `apps/api/src/modules/admin/subcategories.routes.ts`, add `resolveForMapping` to the existing import from Task 3:

```ts
import { resolveForGarmentTypeShotType, resolveForMapping } from './shot-type-resolve.js';
```

Find the `PATCH /admin/assets/garment-types/:id/templates/:templateId` handler's `mapped` branch:

```ts
      if (mapped) {
        const [inserted] = await app.db
          .insert(schema.catalogueTemplateSubcategories)
          .values({ templateId, subcategoryId: id })
          .onConflictDoNothing()
          .returning({ id: schema.catalogueTemplateSubcategories.id });
        if (inserted) return { ok: true, mappingId: inserted.id };

        const [existing] = await app.db
          .select({ id: schema.catalogueTemplateSubcategories.id })
          .from(schema.catalogueTemplateSubcategories)
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.templateId, templateId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, id),
            ),
          );
        return { ok: true, mappingId: existing?.id ?? null };
      } else {
```

Change the `if (inserted)` branch to insert-and-resolve inside one transaction — this is the trigger where atomicity matters most: `onConflictDoNothing()` means a resolve failure after a non-transactional insert would leave the mapping permanently stranded unresolved, since retrying `mapped: true` would then hit the "already exists" branch below and never call resolve again. Wrapping both in a transaction means a resolve failure rolls the insert back too, so a retry re-enters this same branch instead of silently skipping resolution:

```ts
      if (mapped) {
        const inserted = await app.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.catalogueTemplateSubcategories)
            .values({ templateId, subcategoryId: id })
            .onConflictDoNothing()
            .returning({ id: schema.catalogueTemplateSubcategories.id });
          if (!row) return null;
          const resolvedCount = await resolveForMapping(tx, row.id);
          return { id: row.id, resolvedCount };
        });
        if (inserted) return { ok: true, mappingId: inserted.id, resolvedCount: inserted.resolvedCount };

        const [existing] = await app.db
          .select({ id: schema.catalogueTemplateSubcategories.id })
          .from(schema.catalogueTemplateSubcategories)
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.templateId, templateId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, id),
            ),
          );
        return { ok: true, mappingId: existing?.id ?? null };
      } else {
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 20/20 tests green.

- [ ] **Step 5: Run the pre-existing subcategories admin test file to confirm no regression**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-template-subcategories-admin.test.ts
```
Expected: PASS — the `mappingId` assertions in that file (e.g. `expect(shirtMappingId).toMatch(/^[0-9a-f-]{36}$/)`) don't check for absence of extra response keys, so adding `resolvedCount` to the response is additive and safe.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): auto-resolve shot-type workflows when a template is newly mapped to a garment type"
```

---

### Task 6: Manual-override provenance (`source`) and clear-resolves-to-default

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('routes', ...)` block, after the test added in Task 5:

```ts

    it('PATCH per-pose workflow sets source to manual, protecting it from later auto-resolve', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const defaultWorkflow = await seedWorkflow('Should be ignored');
      const manualWorkflow = await seedWorkflow('Manual pick via route');

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: manualWorkflow.id },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({
        workflowTemplateId: manualWorkflow.id,
        source: 'manual',
      });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.source).toBe('manual');

      // Setting the garment type's default afterwards must not override the manual pick.
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: defaultWorkflow.id,
      });
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: defaultWorkflow.id },
      });

      const [rowAfter] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(rowAfter.workflowTemplateId).toBe(manualWorkflow.id);
      expect(rowAfter.source).toBe('manual');
    });

    it('clearing a manual override falls back to the live category default', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const defaultWorkflow = await seedWorkflow('Fallback default');
      const manualWorkflow = await seedWorkflow('To be cleared');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: defaultWorkflow.id,
      });
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: manualWorkflow.id },
      });

      const clearRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(clearRes.statusCode).toBe(200);
      // The response reflects the row's actual resulting state (the live default it
      // just fell back to), not a blind echo of "cleared" — the admin UI depends on
      // this to avoid showing a stale "Workflow required" after a clear that instantly
      // repopulated a real workflow.
      expect(clearRes.json()).toMatchObject({
        workflowTemplateId: defaultWorkflow.id,
        source: 'auto',
      });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(defaultWorkflow.id);
      expect(row.source).toBe('auto');
    });

    it('GET poses-in-mapping surfaces source', async () => {
      const { mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Source visibility check');
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses`,
        headers,
      });
      expect(res.json().items[0].source).toBe('manual');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: FAIL — the first test's response-shape assertion fails because the route doesn't return `workflowTemplateId`/`source` yet; the second fails both on response shape and because clearing currently deletes the row with no fallback (`row` is `undefined`); the third fails because `source` is `undefined` in the GET response (not yet selected).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/admin/subcategories.routes.ts`, find the `GET /admin/assets/catalogue-template-mappings/:mappingId/poses` handler's select:

```ts
      const poses = await app.db
        .selectDistinct({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          displayName: schema.modelPoseAssets.displayName,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          sortOrder: schema.modelPoseAssets.sortOrder,
          workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
          promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
        })
```

Add `source`:

```ts
      const poses = await app.db
        .selectDistinct({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          displayName: schema.modelPoseAssets.displayName,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          sortOrder: schema.modelPoseAssets.sortOrder,
          workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
          promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
          source: schema.catalogueTemplatePoseWorkflows.source,
        })
```

And its `return`:

```ts
      return {
        items: poses.map((pose) => ({
          id: pose.id,
          label: pose.label,
          displayName: pose.displayName,
          workflowTemplateId: pose.workflowTemplateId,
          promptGarmentPhase: pose.promptGarmentPhase,
          source: pose.source,
          thumbnailUrl: app.storage.publicUrl(pose.thumbnailKey),
        })),
      };
```

Now find the `PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId` handler. Its clear branch:

```ts
      if (!workflowTemplateId) {
        await app.db
          .delete(schema.catalogueTemplatePoseWorkflows)
          .where(
            and(
              eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
              eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, poseAssetId),
            ),
          );
        return { ok: true, action: 'deleted' };
      }
```

Change to delete, resolve, and re-read the row's actual resulting state, all inside one transaction:

```ts
      if (!workflowTemplateId) {
        // "Clear override" and "reset to category default" unified: deleting can
        // immediately let resolveForMapping fall back to a live default for this
        // pose's shot type — the response returns the row's real resulting state
        // (possibly a re-populated workflow, possibly nothing) rather than a blind
        // "cleared", so the admin UI never shows stale "Workflow required" after a
        // clear that actually just repopulated a different workflow. Delete + resolve
        // + re-read run in one transaction so this is one atomic unit.
        const result = await app.db.transaction(async (tx) => {
          await tx
            .delete(schema.catalogueTemplatePoseWorkflows)
            .where(
              and(
                eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
                eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, poseAssetId),
              ),
            );
          const resolvedCount = await resolveForMapping(tx, mappingId);
          const [row] = await tx
            .select({
              workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
              source: schema.catalogueTemplatePoseWorkflows.source,
            })
            .from(schema.catalogueTemplatePoseWorkflows)
            .where(
              and(
                eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
                eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, poseAssetId),
              ),
            );
          return {
            resolvedCount,
            workflowTemplateId: row?.workflowTemplateId ?? null,
            source: row?.source ?? null,
          };
        });
        return { ok: true, action: 'deleted', ...result };
      }
```

Then find the upsert further down in the same handler:

```ts
      const hasPromptKey = 'promptGarmentPhase' in body;
      const updateSet: {
        workflowTemplateId: string;
        updatedAt: Date;
        promptGarmentPhase?: string | null;
      } = { workflowTemplateId, updatedAt: new Date() };
      if (hasPromptKey) updateSet.promptGarmentPhase = body.promptGarmentPhase ?? null;

      await app.db
        .insert(schema.catalogueTemplatePoseWorkflows)
        .values({
          mappingId,
          poseAssetId,
          workflowTemplateId,
          promptGarmentPhase: body.promptGarmentPhase ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.catalogueTemplatePoseWorkflows.mappingId,
            schema.catalogueTemplatePoseWorkflows.poseAssetId,
          ],
          set: updateSet,
        });

      return { ok: true, action: 'upserted' };
```

Change to always stamp `source: 'manual'` — this route is only ever reached by an explicit admin pick, never by the auto-resolver:

```ts
      const hasPromptKey = 'promptGarmentPhase' in body;
      const updateSet: {
        workflowTemplateId: string;
        updatedAt: Date;
        source: 'manual';
        promptGarmentPhase?: string | null;
      } = { workflowTemplateId, source: 'manual', updatedAt: new Date() };
      if (hasPromptKey) updateSet.promptGarmentPhase = body.promptGarmentPhase ?? null;

      await app.db
        .insert(schema.catalogueTemplatePoseWorkflows)
        .values({
          mappingId,
          poseAssetId,
          workflowTemplateId,
          source: 'manual',
          promptGarmentPhase: body.promptGarmentPhase ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.catalogueTemplatePoseWorkflows.mappingId,
            schema.catalogueTemplatePoseWorkflows.poseAssetId,
          ],
          set: updateSet,
        });

      return { ok: true, action: 'upserted', workflowTemplateId, source: 'manual' as const };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 23/23 tests green.

- [ ] **Step 5: Run the full pre-existing subcategories admin test file to confirm no regression**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogue-template-subcategories-admin.test.ts
```
Expected: PASS — that file's `'PATCH sets, preserves, and clears the prompt override independently of the workflow'` test never asserts on `source` or `resolvedCount`, so it's unaffected by these additive changes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): track manual-vs-auto provenance on catalogue_template_pose_workflows"
```

---

### Task 7: `shotType` on pose-asset creation, and on the pose-assets list

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts`
- Test: `apps/api/test/integration/shot-type-workflow-resolve.test.ts` (append)

This task covers both directions: `POST` must accept and persist `shotType`, and the
existing `GET /admin/assets/pose-assets` list must return it too. Without the `GET` fix,
the admin-web template-looks builder (Task 10) has no way to know a pose's already-saved
shot type when reopening an existing template — every pose would appear untagged
(and, worse, silently default to "Full" in the UI) regardless of what's actually in the
database.

- [ ] **Step 1: Write the failing tests**

Append two new top-level `it`s inside the outer `describe('shot-type workflow resolve', ...)` block, after the `describe('routes', ...)` block closes (i.e., as siblings of it, not nested inside):

```ts

  it('POST pose-assets persists shotType', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/pose-assets',
      headers,
      payload: {
        label: 'Shot type creation test',
        r2Key: `shot-type-create-${Date.now()}.jpg`,
        thumbnailKey: `shot-type-create-thumb-${Date.now()}.jpg`,
        genderSlug: 'women',
        scope: 'template',
        shotType: 'closeup',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shotType).toBe('closeup');

    const [row] = await app.db
      .select({ shotType: schema.modelPoseAssets.shotType })
      .from(schema.modelPoseAssets)
      .where(eq(schema.modelPoseAssets.id, res.json().id));
    expect(row.shotType).toBe('closeup');
  });

  it('GET pose-assets returns shotType for an already-tagged pose', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Already tagged pose',
        genderSlug: 'women',
        r2Key: `already-tagged-${Date.now()}.jpg`,
        thumbnailKey: 'already-tagged-thumb.jpg',
        scope: 'template',
        shotType: 'half',
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: '/admin/assets/pose-assets?scope=all',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().items.find((i: { id: string }) => i.id === pose.id);
    expect(found.shotType).toBe('half');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: FAIL — the first fails because `res.json().shotType` is `undefined` (the field isn't accepted or returned yet on create); the second fails because `found.shotType` is `undefined` (the list route doesn't select it).

- [ ] **Step 3: Implement**

First, find the `GET /admin/assets/pose-assets` handler's select:

```ts
      const rows = await app.db
        .select({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          r2Key: schema.modelPoseAssets.r2Key,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          genderSlug: schema.modelPoseAssets.genderSlug,
          workflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
          promptGarmentPhase: schema.modelPoseAssets.promptGarmentPhase,
          promptFacePhase: schema.modelPoseAssets.promptFacePhase,
          poseVariant: schema.modelPoseAssets.poseVariant,
          displayName: schema.modelPoseAssets.displayName,
          isActive: schema.modelPoseAssets.isActive,
          sortOrder: schema.modelPoseAssets.sortOrder,
          createdAt: schema.modelPoseAssets.createdAt,
        })
```

Add `shotType`:

```ts
      const rows = await app.db
        .select({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          r2Key: schema.modelPoseAssets.r2Key,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          genderSlug: schema.modelPoseAssets.genderSlug,
          workflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
          promptGarmentPhase: schema.modelPoseAssets.promptGarmentPhase,
          promptFacePhase: schema.modelPoseAssets.promptFacePhase,
          poseVariant: schema.modelPoseAssets.poseVariant,
          shotType: schema.modelPoseAssets.shotType,
          displayName: schema.modelPoseAssets.displayName,
          isActive: schema.modelPoseAssets.isActive,
          sortOrder: schema.modelPoseAssets.sortOrder,
          createdAt: schema.modelPoseAssets.createdAt,
        })
```

Now, in the same file, find the `POST /admin/assets/pose-assets` body schema:

```ts
        body: z.object({
          label: z.string().min(1),
          displayName: z.string().optional(),
          genderSlug: z.string().optional(),
          r2Key: z.string(),
          thumbnailKey: z.string(),
          workflowTemplateId: z.string().uuid().optional(),
          promptGarmentPhase: z.string().optional(),
          promptFacePhase: z.string().optional(),
          isActive: z.boolean().optional(),
          sortOrder: z.number().int().optional(),
          // 'template' = uploaded from a catalogue template's looks builder — hidden
          // from the admin Pose Assets tab and studio "create your own look".
          scope: z.enum(['general', 'template']).optional(),
        }),
```

Add `shotType`:

```ts
        body: z.object({
          label: z.string().min(1),
          displayName: z.string().optional(),
          genderSlug: z.string().optional(),
          r2Key: z.string(),
          thumbnailKey: z.string(),
          workflowTemplateId: z.string().uuid().optional(),
          promptGarmentPhase: z.string().optional(),
          promptFacePhase: z.string().optional(),
          isActive: z.boolean().optional(),
          sortOrder: z.number().int().optional(),
          // 'template' = uploaded from a catalogue template's looks builder — hidden
          // from the admin Pose Assets tab and studio "create your own look".
          scope: z.enum(['general', 'template']).optional(),
          shotType: z.enum(['full', 'half', 'closeup']).optional(),
        }),
```

Find the handler's body type and insert:

```ts
      const body = req.body as {
        label: string;
        displayName?: string;
        genderSlug?: string;
        r2Key: string;
        thumbnailKey: string;
        workflowTemplateId?: string;
        promptGarmentPhase?: string;
        promptFacePhase?: string;
        isActive?: boolean;
        sortOrder?: number;
        scope?: 'general' | 'template';
      };

      const [inserted] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: body.label,
          displayName: body.displayName ?? null,
          genderSlug: body.genderSlug ?? null,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
          workflowTemplateId: body.workflowTemplateId ?? null,
          promptGarmentPhase: body.promptGarmentPhase ?? null,
          promptFacePhase: body.promptFacePhase ?? null,
          isActive: body.isActive ?? true,
          sortOrder: body.sortOrder ?? 0,
          scope: body.scope ?? 'general',
        })
        .returning();

      return inserted;
```

Change to:

```ts
      const body = req.body as {
        label: string;
        displayName?: string;
        genderSlug?: string;
        r2Key: string;
        thumbnailKey: string;
        workflowTemplateId?: string;
        promptGarmentPhase?: string;
        promptFacePhase?: string;
        isActive?: boolean;
        sortOrder?: number;
        scope?: 'general' | 'template';
        shotType?: 'full' | 'half' | 'closeup';
      };

      const [inserted] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: body.label,
          displayName: body.displayName ?? null,
          genderSlug: body.genderSlug ?? null,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
          workflowTemplateId: body.workflowTemplateId ?? null,
          promptGarmentPhase: body.promptGarmentPhase ?? null,
          promptFacePhase: body.promptFacePhase ?? null,
          isActive: body.isActive ?? true,
          sortOrder: body.sortOrder ?? 0,
          scope: body.scope ?? 'general',
          shotType: body.shotType ?? null,
        })
        .returning();

      return inserted;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/shot-type-workflow-resolve.test.ts
```
Expected: PASS — 25/25 tests green.

- [ ] **Step 5: Run the full backend unit + integration suite**

```bash
pnpm --filter @tryme/api test
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts
pnpm --filter @tryme/api typecheck
```
Expected: all green, matching the pre-existing baseline count plus this task's new tests (the pre-existing `catalog.test.ts` `'GET /v1/catalog/models returns category tree with items'` failure is a known, unrelated, pre-existing issue documented in `vitest.config.ts` — do not treat it as a regression from this work).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts apps/api/test/integration/shot-type-workflow-resolve.test.ts
git commit -m "feat(api): accept shotType on pose-asset creation"
```

---

### Task 8: Admin-web types

**Files:**
- Modify: `apps/admin-web/src/types.ts`

- [ ] **Step 1: Update `ModelPoseAsset`**

Find:

```ts
export interface ModelPoseAsset {
  id: string;
  label: string;
  displayName: string | null;
  r2Key: string;
  thumbnailKey: string;
  genderSlug: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  promptFacePhase: string | null;
  poseVariant: string | null;
  scope: 'general' | 'template';
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
}
```

Add `shotType`:

```ts
export interface ModelPoseAsset {
  id: string;
  label: string;
  displayName: string | null;
  r2Key: string;
  thumbnailKey: string;
  genderSlug: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  promptFacePhase: string | null;
  poseVariant: string | null;
  shotType: 'full' | 'half' | 'closeup' | null;
  scope: 'general' | 'template';
  isActive: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Update `MappedTemplatePoseWorkflow` and add `ShotTypeWorkflow`**

Find:

```ts
export interface MappedTemplatePoseWorkflow {
  id: string;
  label: string;
  displayName: string | null;
  thumbnailUrl: string;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
}
```

Change to:

```ts
export interface MappedTemplatePoseWorkflow {
  id: string;
  label: string;
  displayName: string | null;
  thumbnailUrl: string;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  source: 'auto' | 'manual' | null;
}

export interface ShotTypeWorkflow {
  shotType: 'full' | 'half' | 'closeup';
  workflowTemplateId: string | null;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```
Expected: this may come back clean, and that's fine — don't treat it as suspicious. `GarmentTypesTab.tsx` and `EditCatalogueTemplateModal.tsx` consume these types through `apiFetch<T>()` generic calls, not object literals, so the compiler trusts the annotation rather than checking the runtime response shape; adding a new field to the interface doesn't retroactively require every existing call site to prove it's present. Real errors (or their absence) show up once Tasks 9-11 write code that actually reads `.shotType` / `.source` off these values. If this step *does* show errors, confirm they're only in those two files and only about the fields you just added — anything else means something unrelated broke.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/types.ts
git commit -m "feat(admin-web): add shotType and source types for shot-type workflow defaults"
```

---

### Task 9: Admin UI — shot-type default workflows panel

**Files:**
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`

- [ ] **Step 1: Add the `ShotTypeWorkflow` import**

Find the type import block near the top of the file:

```ts
import type {
  GarmentType,
  GenderSlug,
  MappedTemplatePoseWorkflow,
  PoseGarmentConfig,
  TemplateGarmentTypeMapping,
  TryonCategory,
  WorkflowOption,
} from '../../types';
```

Add `ShotTypeWorkflow`:

```ts
import type {
  GarmentType,
  GenderSlug,
  MappedTemplatePoseWorkflow,
  PoseGarmentConfig,
  ShotTypeWorkflow,
  TemplateGarmentTypeMapping,
  TryonCategory,
  WorkflowOption,
} from '../../types';
```

- [ ] **Step 2: Add the `ShotTypeWorkflowsPanel` component**

Add this new component in the file, right before `GarmentTemplateMappingPanel`'s definition (i.e., right after the closing `}` of the top-level `GarmentTypesTab` function and before `interface GarmentTemplateMappingPanelProps`):

```tsx
const SHOT_TYPE_LABELS: Record<ShotTypeWorkflow['shotType'], string> = {
  full: 'Full pose',
  half: 'Half pose',
  closeup: 'Closeup',
};

interface ShotTypeWorkflowsPanelProps {
  sub: GarmentType;
  workflows: WorkflowOption[];
  toast: (opts: { kind?: 'error'; title: string; body?: string }) => void;
}

function ShotTypeWorkflowsPanel({ sub, workflows, toast }: ShotTypeWorkflowsPanelProps) {
  const [items, setItems] = useState<ShotTypeWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingShotType, setSavingShotType] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ items: ShotTypeWorkflow[] }>(
        `/admin/assets/garment-types/${sub.id}/shot-type-workflows`,
      );
      setItems(res.items);
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Failed to load shot-type defaults',
        body: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [sub.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const setDefault = async (
    shotType: ShotTypeWorkflow['shotType'],
    workflowTemplateId: string | null,
  ) => {
    setSavingShotType(shotType);
    try {
      const res = await apiFetch<{ ok: true; resolvedCount: number }>(
        `/admin/assets/garment-types/${sub.id}/shot-type-workflows/${shotType}`,
        { method: 'PATCH', body: JSON.stringify({ workflowTemplateId }) },
      );
      setItems((prev) =>
        prev.map((i) => (i.shotType === shotType ? { ...i, workflowTemplateId } : i)),
      );
      toast({
        title: workflowTemplateId
          ? `${SHOT_TYPE_LABELS[shotType]} default saved`
          : `${SHOT_TYPE_LABELS[shotType]} default cleared`,
        body: res.resolvedCount > 0 ? `Applied to ${res.resolvedCount} poses` : undefined,
      });
    } catch (error) {
      toast({
        kind: 'error',
        title: 'Failed to save shot-type default',
        body: (error as Error).message,
      });
    } finally {
      setSavingShotType(null);
    }
  };

  return (
    <section style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>1. Shot-type default workflows</h2>
      <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13 }}>
        Set once per shot type — applies to every pose tagged with it, across every template
        mapped to {sub.label}, now and in the future.
      </p>
      {loading ? (
        <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--muted)' }}>
          Loading…
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 14, maxWidth: 420 }}>
          {items.map((item) => (
            <div key={item.shotType} className="field" style={{ margin: 0 }}>
              <label>{SHOT_TYPE_LABELS[item.shotType]}</label>
              <select
                className="select"
                value={item.workflowTemplateId ?? ''}
                disabled={savingShotType === item.shotType}
                onChange={(e) => void setDefault(item.shotType, e.target.value || null)}
              >
                <option value="">— none —</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Render the panel and renumber the sibling headings**

Find the configs subview render block:

```tsx
      {/* Pose configs subview */}
      {subView.kind === 'configs' && (
        <>
          <GarmentTemplateMappingPanel sub={subView.sub} workflows={workflows} toast={toast} />

          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>2. Custom look poses</h2>
```

Change to insert the new panel first and renumber:

```tsx
      {/* Pose configs subview */}
      {subView.kind === 'configs' && (
        <>
          <ShotTypeWorkflowsPanel sub={subView.sub} workflows={workflows} toast={toast} />

          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <GarmentTemplateMappingPanel sub={subView.sub} workflows={workflows} toast={toast} />
          </div>

          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: '1px solid var(--border)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>3. Custom look poses</h2>
```

Then, inside `GarmentTemplateMappingPanel`'s own render (in the same file, further down), find:

```tsx
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>1. Catalogue templates</h2>
```

Change the number:

```tsx
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>2. Catalogue templates</h2>
```

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm --filter @tryme/admin typecheck
pnpm --filter @tryme/admin lint
```
Expected: no errors from this file (some errors may remain in `EditCatalogueTemplateModal.tsx` until Task 10).

- [ ] **Step 5: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```
Open the admin panel, go to Assets → Garment Types → click into any garment type. Confirm: a new "1. Shot-type default workflows" section appears above "2. Catalogue templates", with three rows (Full pose / Half pose / Closeup), each a workflow dropdown defaulting to "— none —". Pick a workflow for one row, confirm a success toast appears, and re-navigate away and back to confirm the selection persisted.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin-web): add shot-type default workflows panel to garment type setup"
```

---

### Task 10: Admin UI — shot-type selector on template look rows

**Files:**
- Modify: `apps/admin-web/src/components/EditCatalogueTemplateModal.tsx`

- [ ] **Step 1: Add `shotType` to `LookRow`**

Find:

```ts
interface LookRow {
  key: string; // stable React key — random per row, independent of the eventual saved id
  poseAssetId: string;
  backgroundId: string;
}
```

Change to:

```ts
interface LookRow {
  key: string; // stable React key — random per row, independent of the eventual saved id
  poseAssetId: string;
  backgroundId: string;
  // Drives the shotType sent the next time this row's pose image is (re-)uploaded.
  // `null` = not tagged (a legacy pose that predates this feature, or a row the admin
  // hasn't touched yet) — distinct from 'full', never silently coerced to it, so an
  // untagged pose doesn't look already-correct when it's actually unresolved. The
  // select stays editable at all times regardless of whether poseAssetId is already
  // set — picking a different value here doesn't retroactively change an
  // already-uploaded pose, but it's exactly what lets an admin correct a mis-tagged
  // pose: pick the right value, then re-upload.
  shotType: 'full' | 'half' | 'closeup' | null;
}
```

- [ ] **Step 2: Default new rows to `'full'`**

Find:

```ts
  function addLookRow() {
    setLooks((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        poseAssetId: '',
        backgroundId: '',
      },
    ]);
  }
```

Change to:

```ts
  function addLookRow() {
    setLooks((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        poseAssetId: '',
        backgroundId: '',
        shotType: 'full',
      },
    ]);
  }
```

- [ ] **Step 3: Initialize `shotType` when loading an existing template's looks**

Find:

```ts
  useEffect(() => {
    if (!isEditing || !template) return;
    apiFetch<{ items: { id: string; poseAssetId: string; backgroundId: string }[] }>(
      `/admin/assets/catalogue-templates/${template.id}/looks`,
    )
      .then((res) => {
        setLooks(
          (res.items ?? []).map((l) => ({
            key: l.id,
            poseAssetId: l.poseAssetId,
            backgroundId: l.backgroundId,
          })),
        );
      })
      .catch(() => setLooks([]))
      .finally(() => setLooksLoaded(true));
  }, [isEditing, template]);
```

Change to look up each pose's already-stored shot type. `localPoseAssets` now actually carries `shotType` (Task 7 added it to the `GET /admin/assets/pose-assets` projection this prop is populated from) — fall back to `null` ("not tagged"), never to `'full'`, since a legacy pose that predates this feature is genuinely untagged in the database and must not be displayed as if it were already correctly set:

```ts
  useEffect(() => {
    if (!isEditing || !template) return;
    apiFetch<{ items: { id: string; poseAssetId: string; backgroundId: string }[] }>(
      `/admin/assets/catalogue-templates/${template.id}/looks`,
    )
      .then((res) => {
        setLooks(
          (res.items ?? []).map((l) => ({
            key: l.id,
            poseAssetId: l.poseAssetId,
            backgroundId: l.backgroundId,
            shotType: localPoseAssets.find((p) => p.id === l.poseAssetId)?.shotType ?? null,
          })),
        );
      })
      .catch(() => setLooks([]))
      .finally(() => setLooksLoaded(true));
    // localPoseAssets is intentionally excluded — this effect should only re-run when
    // isEditing/template change, reading whatever localPoseAssets holds at that point
    // (already seeded from the poseAssets prop before this effect can fire).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, template]);
```

- [ ] **Step 4: Send `shotType` on pose creation, snapshotted before the upload starts**

The selector must stay enabled while a row's upload is in flight (Step 5 relies on
that for correcting a mis-tagged pose), but that means the admin could change it
*during* an upload that's already running. `handlePoseFileSelected` is an async
closure created once per invocation — if it reads `looks` only after its `await`s
resolve, it reads whatever `looks` looks like at that later point in time, not what
was selected when the upload started. Reading it late here isn't just imprecise, it's
actively misleading: the dropdown will already be showing the *new* value (since the
`<select>` renders straight off live `looks` state) while the in-flight upload is
still going to persist whatever it captures. Snapshot the value as the very first
thing in the function, before any `await`, so the created pose always gets the value
that was showing when the admin triggered *this specific* upload.

Find the full function:

```ts
  async function handlePoseFileSelected(file: File) {
    const rowKey = poseUploadRowKeyRef.current;
    if (!rowKey) return;
    setUploadingPoseForRow(rowKey);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/assets/pose-assets/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type }),
      });
      await Promise.all([
        putFile(presign.uploadUrl, file),
        makeThumbnail(file).then((t) => putFile(presign.thumbnailUploadUrl, t)),
      ]);
      const created = await apiFetch<ModelPoseAsset>('/admin/assets/pose-assets', {
        method: 'POST',
        body: JSON.stringify({
          label: file.name.replace(/\.[^.]+$/, ''),
          r2Key: presign.r2Key,
          thumbnailKey: presign.thumbnailKey,
          genderSlug,
          scope: 'template',
        }),
      });
      setLocalPoseAssets((prev) => [...prev, created]);
      updateLookRow(rowKey, { poseAssetId: created.id });
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Pose upload failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingPoseForRow(null);
      poseUploadRowKeyRef.current = null;
    }
  }
```

Change to:

```ts
  async function handlePoseFileSelected(file: File) {
    const rowKey = poseUploadRowKeyRef.current;
    if (!rowKey) return;
    // Snapshot now, before any await — this is what "shot type at the moment this
    // upload started" means, and it must not be recomputed after the network calls
    // below, since the admin can still edit this row's selector while they're in
    // flight (the selector is disabled only for the row currently uploading, which is
    // this one, but that guard is enforced by the render, not by this closure).
    const rowShotType = looks.find((l) => l.key === rowKey)?.shotType ?? null;
    setUploadingPoseForRow(rowKey);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/assets/pose-assets/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type }),
      });
      await Promise.all([
        putFile(presign.uploadUrl, file),
        makeThumbnail(file).then((t) => putFile(presign.thumbnailUploadUrl, t)),
      ]);
      const created = await apiFetch<ModelPoseAsset>('/admin/assets/pose-assets', {
        method: 'POST',
        body: JSON.stringify({
          label: file.name.replace(/\.[^.]+$/, ''),
          r2Key: presign.r2Key,
          thumbnailKey: presign.thumbnailKey,
          genderSlug,
          scope: 'template',
          // shotType is optional server-side — omit it entirely rather than sending
          // null, since the API's Zod schema validates it as an enum, not nullable.
          ...(rowShotType ? { shotType: rowShotType } : {}),
        }),
      });
      setLocalPoseAssets((prev) => [...prev, created]);
      updateLookRow(rowKey, { poseAssetId: created.id });
    } catch (err: unknown) {
      toast({
        kind: 'error',
        title: 'Pose upload failed',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploadingPoseForRow(null);
      poseUploadRowKeyRef.current = null;
    }
  }
```

- [ ] **Step 5: Add the selector to the look row UI**

Find the look row rendering:

```tsx
                      <UploadTile
                        label="Background"
                        thumbnailKey={backgroundById.get(row.backgroundId)?.thumbnailKey}
                        storageBase={storagePublicUrl}
                        disabled={saving || uploadingBackgroundForRow === row.key}
                        loading={uploadingBackgroundForRow === row.key}
                        onClick={() => openBackgroundUpload(row.key)}
                      />
                      <button
                        type="button"
                        className="iconbtn"
                        disabled={saving}
                        onClick={() => removeLookRow(row.key)}
                        title="Remove look"
                      >
                        <Icon.Trash />
                      </button>
```

Insert the selector between the background tile and the remove button:

```tsx
                      <UploadTile
                        label="Background"
                        thumbnailKey={backgroundById.get(row.backgroundId)?.thumbnailKey}
                        storageBase={storagePublicUrl}
                        disabled={saving || uploadingBackgroundForRow === row.key}
                        loading={uploadingBackgroundForRow === row.key}
                        onClick={() => openBackgroundUpload(row.key)}
                      />
                      <div className="field" style={{ margin: 0, width: 120 }}>
                        <label style={{ fontSize: 10 }}>Shot type</label>
                        <select
                          className="select"
                          style={{ fontSize: 12, padding: '3px 6px', height: 30 }}
                          value={row.shotType ?? ''}
                          disabled={saving || uploadingPoseForRow === row.key}
                          title={
                            uploadingPoseForRow === row.key
                              ? 'Wait for the current upload to finish before changing this'
                              : "Applies the next time this row's pose image is (re-)uploaded — picking a value here alone does not retag an already-uploaded pose"
                          }
                          onChange={(e) =>
                            updateLookRow(row.key, {
                              shotType: (e.target.value || null) as LookRow['shotType'],
                            })
                          }
                        >
                          <option value="">— not tagged —</option>
                          <option value="full">Full pose</option>
                          <option value="half">Half pose</option>
                          <option value="closeup">Closeup</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        className="iconbtn"
                        disabled={saving}
                        onClick={() => removeLookRow(row.key)}
                        title="Remove look"
                      >
                        <Icon.Trash />
                      </button>
```

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @tryme/admin typecheck
pnpm --filter @tryme/admin lint
```
Expected: no errors.

- [ ] **Step 7: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```
Open Assets → Catalogue Templates → New template. Add a look row, confirm the "Shot type" dropdown appears defaulting to "Full pose" and is editable before uploading a pose image for that row. Pick "Closeup", upload a pose image, save the template, then re-open it for editing — confirm the dropdown shows "Closeup" (not "Full pose"). Now change the dropdown to "Half pose" *without* re-uploading, close and reopen the template again — confirm it still shows "Closeup" (proving the select alone doesn't retag an already-uploaded pose; only re-uploading does). Open the browser devtools' network panel and throttle to "Slow 3G", start a pose upload for a row, and while it's in flight confirm that row's "Shot type" dropdown is now disabled (can't be changed mid-upload) — this is what prevents the created pose from silently storing a different value than whatever's displayed. Finally, open an existing template created before this feature shipped (or manually null out a pose's `shot_type` in the DB) and confirm its look row shows "— not tagged —", not "Full pose".

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/components/EditCatalogueTemplateModal.tsx
git commit -m "feat(admin-web): tag catalogue-template look poses with a shot type at upload time"
```

---

### Task 11: Admin UI — surface `source` in the mapped-template workflow modal

**Files:**
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`

- [ ] **Step 1: Sync `setWorkflow` from the PATCH response, not a blind optimistic guess**

Task 6's PATCH route now returns the row's actual resulting `workflowTemplateId`/`source`
— because clearing an override can immediately cause the resolver to write back a
*different*, non-null workflow (the live category default), and because a manual pick
flips `source` to `'manual'` server-side. The modal's optimistic update has no way to
know either of those things on its own, so it must sync from the response once the
request completes.

Find, inside `MappedTemplateWorkflowModal`, the `setWorkflow` function:

```ts
  const setWorkflow = async (poseAssetId: string, workflowTemplateId: string | null) => {
    const previous = items;
    const currentItem = items.find((i) => i.id === poseAssetId);
    const workflowChanged = currentItem?.workflowTemplateId !== workflowTemplateId;
    // A workflow change (or clear) invalidates any saved prompt override - it was
    // written for a different workflow's prompt/node structure. Clear it instead of
    // letting it silently carry over, mirroring PoseConfigsPanel's existing
    // workflow-change convention.
    const promptGarmentPhase = workflowChanged ? null : (currentItem?.promptGarmentPhase ?? null);
    setSavingId(poseAssetId);
    setItems((current) =>
      current.map((item) =>
        item.id === poseAssetId ? { ...item, workflowTemplateId, promptGarmentPhase } : item,
      ),
    );
    if (workflowChanged && editingPromptId === poseAssetId) closePromptEditor();
    try {
      await apiFetch(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ workflowTemplateId, promptGarmentPhase }),
        },
      );
      toast({ title: workflowTemplateId ? 'Pose workflow saved' : 'Pose workflow cleared' });
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save pose workflow',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };
```

Change to:

```ts
  const setWorkflow = async (poseAssetId: string, workflowTemplateId: string | null) => {
    const previous = items;
    const currentItem = items.find((i) => i.id === poseAssetId);
    const workflowChanged = currentItem?.workflowTemplateId !== workflowTemplateId;
    // A workflow change (or clear) invalidates any saved prompt override - it was
    // written for a different workflow's prompt/node structure. Clear it instead of
    // letting it silently carry over, mirroring PoseConfigsPanel's existing
    // workflow-change convention.
    const promptGarmentPhase = workflowChanged ? null : (currentItem?.promptGarmentPhase ?? null);
    setSavingId(poseAssetId);
    setItems((current) =>
      current.map((item) =>
        item.id === poseAssetId
          ? {
              ...item,
              workflowTemplateId,
              promptGarmentPhase,
              source: workflowTemplateId ? 'manual' : item.source,
            }
          : item,
      ),
    );
    if (workflowChanged && editingPromptId === poseAssetId) closePromptEditor();
    try {
      const res = await apiFetch<{
        workflowTemplateId: string | null;
        source: 'auto' | 'manual' | null;
      }>(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ workflowTemplateId, promptGarmentPhase }),
        },
      );
      // The response reflects the row's actual resulting state, not an echo of the
      // request — clearing can immediately fall back to a live category default (a
      // different, non-null workflow), which the optimistic update above has no way
      // to predict. Sync from it so the modal never shows a stale "Workflow
      // required" after a clear that just repopulated a workflow, and never shows a
      // stale "auto" badge after an explicit pick.
      setItems((current) =>
        current.map((item) =>
          item.id === poseAssetId
            ? { ...item, workflowTemplateId: res.workflowTemplateId, source: res.source }
            : item,
        ),
      );
      toast({ title: res.workflowTemplateId ? 'Pose workflow saved' : 'Pose workflow cleared' });
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save pose workflow',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };
```

- [ ] **Step 2: Sync `savePrompt` from the PATCH response too**

Task 6's route stamps `source: 'manual'` on *every* successful call that sets a
non-null `workflowTemplateId` — including `savePrompt`, which re-sends the pose's
existing `workflowTemplateId` alongside the new prompt text (see the route: the
"manual" stamp isn't conditional on the workflow value actually changing). That's the
right server behavior — an admin who bothered to write a custom prompt for a specific
pose has expressed enough intent about that pose to protect it from a future
auto-resolve silently swapping its workflow out from under a prompt that may have
been written for the old workflow's structure. But `savePrompt`'s optimistic update
only touches `promptGarmentPhase`, so a previously-`'auto'` row stays displayed with
the "auto" badge until the modal reloads, even though the server already flipped it.

Find, inside `MappedTemplateWorkflowModal`, the `savePrompt` function:

```ts
  const savePrompt = async (poseAssetId: string) => {
    const item = items.find((i) => i.id === poseAssetId);
    if (!item?.workflowTemplateId) return;
    const previous = items;
    setSavingId(poseAssetId);
    const promptGarmentPhase = promptDraft || null;
    setItems((current) =>
      current.map((i) => (i.id === poseAssetId ? { ...i, promptGarmentPhase } : i)),
    );
    try {
      await apiFetch(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ workflowTemplateId: item.workflowTemplateId, promptGarmentPhase }),
        },
      );
      toast({ title: promptGarmentPhase ? 'Prompt saved' : 'Prompt override cleared' });
      closePromptEditor();
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save prompt',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };
```

Change to:

```ts
  const savePrompt = async (poseAssetId: string) => {
    const item = items.find((i) => i.id === poseAssetId);
    if (!item?.workflowTemplateId) return;
    const previous = items;
    setSavingId(poseAssetId);
    const promptGarmentPhase = promptDraft || null;
    setItems((current) =>
      current.map((i) =>
        i.id === poseAssetId ? { ...i, promptGarmentPhase, source: 'manual' } : i,
      ),
    );
    try {
      const res = await apiFetch<{
        workflowTemplateId: string | null;
        source: 'auto' | 'manual' | null;
      }>(
        `/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ workflowTemplateId: item.workflowTemplateId, promptGarmentPhase }),
        },
      );
      setItems((current) =>
        current.map((i) =>
          i.id === poseAssetId
            ? { ...i, workflowTemplateId: res.workflowTemplateId, source: res.source }
            : i,
        ),
      );
      toast({ title: promptGarmentPhase ? 'Prompt saved' : 'Prompt override cleared' });
      closePromptEditor();
    } catch (error) {
      setItems(previous);
      toast({
        kind: 'error',
        title: 'Failed to save prompt',
        body: (error as Error).message,
      });
    } finally {
      setSavingId(null);
    }
  };
```

- [ ] **Step 3: Show an "auto" badge for auto-resolved poses**

Find, inside `MappedTemplateWorkflowModal`, the badge block:

```tsx
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <span
                          className={`badge ${item.workflowTemplateId ? 'dot accent' : ''}`}
                          style={{ fontSize: 9 }}
                        >
                          {item.workflowTemplateId ? 'Ready' : 'Workflow required'}
                        </span>
                        {item.promptGarmentPhase && (
                          <span className="badge dot" style={{ fontSize: 9 }}>
                            Custom prompt
                          </span>
                        )}
                      </div>
```

Add an "auto" badge when the current value came from the shot-type default rather than an explicit pick:

```tsx
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <span
                          className={`badge ${item.workflowTemplateId ? 'dot accent' : ''}`}
                          style={{ fontSize: 9 }}
                        >
                          {item.workflowTemplateId ? 'Ready' : 'Workflow required'}
                        </span>
                        {item.workflowTemplateId && item.source === 'auto' && (
                          <span
                            className="badge"
                            style={{ fontSize: 9, opacity: 0.7 }}
                            title="Filled from this garment type's shot-type default — picking a workflow here overrides it"
                          >
                            auto
                          </span>
                        )}
                        {item.promptGarmentPhase && (
                          <span className="badge dot" style={{ fontSize: 9 }}>
                            Custom prompt
                          </span>
                        )}
                      </div>
```

`MappedTemplatePoseWorkflow.source` (added to the type in Task 8) is already returned by the `GET /admin/assets/catalogue-template-mappings/:mappingId/poses` route (Task 6) — no data-fetching change needed here, only the render.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```
Expected: no errors.

- [ ] **Step 5: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```
Set a shot-type default for a garment type that has a mapped template with a matching-shot-type pose (Task 9's panel). Open that template's "Configure workflows" modal (Task 10's flow, or an existing mapped template). Confirm the resolved pose shows a "Ready" badge plus a subtle "auto" badge. Manually pick a different workflow from that pose's dropdown, confirm the "auto" badge disappears immediately (no reload needed — proving Step 1's sync fix), since `source` is now `'manual'`. Then clear that same pose's workflow back to "Select workflow..." and confirm it immediately shows the *original* auto-resolved workflow again with the "auto" badge restored (not "Workflow required") — this is the clear-falls-back-to-live-default behavior, and it must appear instantly, not after a reload. Finally, on a *different* pose that's still showing the "auto" badge, open its prompt editor and save a custom prompt — confirm the "auto" badge disappears immediately (proving Step 2's `savePrompt` sync fix), without needing to touch the workflow dropdown or reload.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin-web): show auto-resolved badge in the mapped-template workflow modal, keep prompt saves in sync"
```

---

### Task 12: Progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top of the log**

Follow the existing entry format in the file. Summarize: what shipped (shot-type tagging + garment-type shot-type-workflow defaults + auto-resolve cascade), why (manual per-pose-per-template workflow assignment doesn't scale to hundreds/thousands of templates), and note the explicit non-goal (no bulk-backfill tooling for existing untagged poses — tagging happens as templates get touched going forward, or via a manual re-upload per look row).

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs(progress): log pose shot-type default workflows feature"
```

---

## Post-implementation checklist

- [ ] `pnpm --filter @tryme/api test` — full unit suite green
- [ ] `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts` — full integration suite green (aside from the pre-existing unrelated `catalog.test.ts` failure documented in `vitest.config.ts`)
- [ ] `pnpm --filter @tryme/api typecheck` and `pnpm --filter @tryme/admin typecheck` — both clean
- [ ] `pnpm lint` — clean
- [ ] Manual pass through the admin UI: set a garment type's 3 shot-type defaults, create a new template with tagged look poses, map it to that garment type, confirm workflows resolve with zero per-pose clicks; then hand-override one pose and confirm it survives a subsequent default change.
