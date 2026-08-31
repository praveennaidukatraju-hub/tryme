# Workflow Template Replace (with drain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin replace a `workflow_templates` row's entire ComfyUI graph in place — same row `id`, so every pose/config FK that points at it needs no reassignment — while jobs already queued at replace-time keep resolving the old graph until they finish, and new jobs get the new graph immediately. Gated by the existing `workflows.write` permission plus a new admin-password re-confirmation step.

**Architecture:** A `version` counter on `workflow_templates` plus a `workflow_template_archives` table hold at most one old version per template while it drains. Every job stamps the template version it resolved at creation time into `job_inputs.params.dispatchTemplateVersion` (no new column — reuses the existing jsonb escape hatch). One shared dispatcher resolver replaces the ad-hoc per-call-site template queries and returns either the live row or an archive-reconstructed row depending on whether the job's stamped version still matches. A background-free, event-triggered cleanup deletes the archive once no non-terminal job references it.

**Tech Stack:** Drizzle ORM / PostgreSQL, Fastify + Zod, Vitest, React (admin-web).

**Spec:** `docs/superpowers/specs/2026-08-26-workflow-template-replace-design.md`

**Scope note:** Job-creation-time version stamping is fully implemented for the flagship per-pose "regular" studio path (Task 11) and specified as a concrete, mechanical checklist for the remaining five creation paths (Task 12) — each entry names the exact file and the exact insertion pattern, verified against this codebase's own precedent (`params.workflowTemplateId` is already stamped this way in at least one path today). This is a phase boundary, not a placeholder: Tasks 1–17 are a complete, working, independently-testable slice (the studio/regular path replace-and-drain flow end-to-end); Task 12 is the immediate mechanical follow-up to extend the same verified pattern to every other job-creation surface.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/models.ts` | Add `workflowTemplates.version`; add new `workflowTemplateArchives` table |
| `packages/db/src/migrations/<generated>.sql` | Migration for the above (generated via `pnpm db:generate`, not hand-written) |
| `apps/dispatcher/src/workflow/resolve-template-version.ts` (new) | `resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion)` — the one place that decides live vs. archived content |
| `apps/dispatcher/src/workflow/resolve-template-version.test.ts` (new) | Unit tests for the resolver against a real test DB |
| `apps/dispatcher/src/workflow/patcher.ts` | `loadWorkflow`/`patchWorkflow` take a `snapshotVersion` param and delegate to the resolver instead of querying `workflow_templates` directly |
| `apps/dispatcher/src/job/processor.ts` | Six call sites (`processJob`, `processTryonDirectJob`, `processSareeMannequinJob`, `processSareeJob`, `processWidgetJob`, `processShopifyJob`) switch from ad-hoc queries to the resolver |
| `apps/dispatcher/src/workflow/drain-cleanup.ts` (new) | `maybeCleanupArchive(db, workflowTemplateId, version)` — deletes an archive row once no non-terminal job references it |
| `apps/dispatcher/src/workflow/drain-cleanup.test.ts` (new) | Unit tests for the cleanup query |
| `apps/dispatcher/src/job/processor.ts` | Call `maybeCleanupArchive` at the existing terminal-transition points (`markFailed`, the COMPLETED path in `processJob`, and the other `process*Job` functions' own terminal transitions) |
| `apps/api/src/modules/jobs/create.ts` | Stamp `dispatchTemplateVersion` into `job_inputs.params` for the per-pose regular studio path |
| `packages/types/src/admin.ts` | New `ReplaceWorkflowBody` Zod schema |
| `apps/api/src/modules/admin/workflows.routes.ts` | New `POST /admin/workflows/:id/replace` route; impact-summary addition to `GET /admin/workflows/:id` |
| `apps/api/test/integration/admin-workflows.test.ts` | New tests for the replace route (password gate, archive-and-swap, concurrent-replace rejection) |
| `apps/dispatcher/test/integration/workflow-replace-drain.test.ts` (new) | End-to-end: queued job survives a replace, new job gets new content, drain cleans up |
| `apps/admin-web/src/components/ReplaceWorkflowModal.tsx` (new) | Upload + review + password modal, reusing the existing parse flow |
| `apps/admin-web/src/pages/WorkflowsPage.tsx` | "Replace" button per row + "draining" badge |
| `apps/admin-web/src/types.ts` | Add `version`/`draining` fields to `WorkflowOption` |

---

## Task 1: Schema — `workflow_templates.version`

**Files:**
- Modify: `packages/db/src/schema/models.ts:220` (just before `isActive`)

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/models.ts`, inside the `workflowTemplates` table definition, add immediately before the `isActive` line (currently line 220):

```ts
  // Bumped by 1 on every confirmed "replace" (POST /admin/workflows/:id/replace).
  // Jobs stamp the version they resolved at creation time into
  // job_inputs.params.dispatchTemplateVersion; the dispatcher compares that
  // stamp against this column to decide whether to use this row's live
  // content or an archived one. See docs/superpowers/specs/
  // 2026-08-26-workflow-template-replace-design.md.
  version: integer('version').notNull().default(1),
```

- [ ] **Step 2: Verify the column compiles**

Run: `pnpm --filter @tryme/db typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/models.ts
git commit -m "feat(db): add workflow_templates.version column"
```

---

## Task 2: Schema — `workflow_template_archives` table

**Files:**
- Modify: `packages/db/src/schema/models.ts` (add new table export, near `workflowTemplates`)

- [ ] **Step 1: Add the table**

Immediately after the `workflowTemplates` table's closing `});` (after Task 1's change, this is right before the `sareeMannequinStyles` export), add:

```ts
// Holds at most one archived (draining) version per template — enforced by the
// unique index below, not just application logic. A row here means "this
// template has a replace in progress; jobs stamped with this version should
// resolve against this row's content, not workflow_templates' live row."
// Deleted once no non-terminal job references it (see
// apps/dispatcher/src/workflow/drain-cleanup.ts).
export const workflowTemplateArchives = pgTable(
  'workflow_template_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    jsonContent: jsonb('json_content').notNull().$type<Record<string, unknown>>(),
    faceNodeId: text('face_node_id'),
    poseNodeId: text('pose_node_id').notNull(),
    bgNodeId: text('bg_node_id'),
    upperNodeIds: text('upper_node_ids').array().notNull(),
    lowerNodeId: text('lower_node_id'),
    shoeNodeId: text('shoe_node_id'),
    thirdNodeId: text('third_node_id'),
    sizeNodeId: text('size_node_id'),
    sizeNodeIds: text('size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    latentSizeNodeIds: text('latent_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    latentMaxPx: integer('latent_max_px').notNull().default(2048),
    outputSizeNodeIds: text('output_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    outputMaxPx: integer('output_max_px').notNull().default(2048),
    resultNodeId: text('result_node_id'),
    facePhasePromptNode: text('face_phase_prompt_node'),
    garmentPhasePromptNode: text('garment_phase_prompt_node').notNull(),
    stage1PositivePromptNode: text('stage1_positive_prompt_node'),
    stage1NegativePromptNode: text('stage1_negative_prompt_node'),
    defaultFacePhasePrompt: text('default_face_phase_prompt').notNull().default(''),
    defaultGarmentPhasePrompt: text('default_garment_phase_prompt').notNull().default(''),
    defaultStage1PositivePrompt: text('default_stage1_positive_prompt').notNull().default(''),
    defaultStage1NegativePrompt: text('default_stage1_negative_prompt').notNull().default(''),
    workflowType: text('workflow_type').notNull().default('regular'),
    tryonPersonNodeId: text('tryon_person_node_id'),
    tryonGarmentNodeId: text('tryon_garment_node_id'),
    tryonGarmentNodeId2: text('tryon_garment_node_id_2'),
    tryonOutputNodeId: text('tryon_output_node_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one archived (draining) version per template — a second
    // concurrent replace on the same template must fail, not silently create
    // a second archive row the drain-cleanup logic would have to disambiguate.
    oneActiveArchivePerTemplate: unique('workflow_template_archives_template_unique').on(
      t.workflowTemplateId,
    ),
    byTemplateVersion: index('workflow_template_archives_template_version_idx').on(
      t.workflowTemplateId,
      t.version,
    ),
  }),
);
```

Check the top of `packages/db/src/schema/models.ts` for its existing import line from `drizzle-orm/pg-core` and add `unique` and `index` to it if not already imported (both are already used elsewhere in this file for other tables' indexes/constraints — confirm by checking the existing import list before adding).

- [ ] **Step 2: Generate the migration**

Run (from repo root, with `pnpm docker:up` already running):
```bash
pnpm db:generate
```
Expected: a new file `packages/db/src/migrations/<NNNN>_<name>.sql` is created (drizzle-kit names it; do not hand-write the filename), plus updated `meta/_journal.json` and a new `meta/<NNNN>_snapshot.json`. Open the generated SQL and confirm it contains exactly:
- `ALTER TABLE "workflow_templates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;`
- `CREATE TABLE "workflow_template_archives" (...)` matching the columns above
- The unique constraint on `workflow_template_id` and the composite index

No other tables should appear in the diff. If anything else changed, stop and check for uncommitted schema drift from earlier work before proceeding (per `CLAUDE.md`'s Migration Index Conflicts guidance: re-check `meta/_journal.json` at execution time, since another branch may have landed a migration first).

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: exits 0, output includes the new migration's filename.

- [ ] **Step 4: Verify against the live local DB**

```bash
docker exec tryme-postgres psql -U tryon -d tryon_dev -c "\d workflow_template_archives"
```
Expected: table exists with all columns from Step 1, plus the unique index on `workflow_template_id`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add workflow_template_archives table"
```

---

## Task 3: Dispatcher — `resolveWorkflowTemplateVersion` resolver (TDD)

**Files:**
- Create: `apps/dispatcher/src/workflow/resolve-template-version.ts`
- Test: `apps/dispatcher/src/workflow/resolve-template-version.test.ts`

This is the single function every dispatcher call site will use instead of querying `workflow_templates` directly. It returns a full row shaped exactly like `typeof schema.workflowTemplates.$inferSelect`, so every existing call site can keep referencing the same field names it already does.

- [ ] **Step 1: Write the failing test**

Uses the same integration harness pattern as `apps/dispatcher/test/integration/tryon-direct-webp.test.ts` (`setupTestEnv()` from `../helpers/containers.js`), since this needs a real Postgres connection.

```ts
// apps/dispatcher/src/workflow/resolve-template-version.test.ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestEnv, type TestEnv } from '../../test/helpers/containers.js';
import { resolveWorkflowTemplateVersion } from './resolve-template-version.js';

describe('resolveWorkflowTemplateVersion', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  async function seedTemplate(overrides: Partial<typeof schema.workflowTemplates.$inferInsert> = {}) {
    const [row] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `resolver-test-${randomUUID()}`,
        label: 'Resolver test template',
        jsonContent: { live: true },
        poseNodeId: 'live-pose',
        upperNodeIds: ['live-upper'],
        garmentPhasePromptNode: 'live-prompt',
        ...overrides,
      })
      .returning();
    if (!row) throw new Error('failed to seed template');
    return row;
  }

  it('returns the live row when snapshotVersion is null', async () => {
    const template = await seedTemplate();
    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, null);
    expect(resolved?.jsonContent).toEqual({ live: true });
    expect(resolved?.version).toBe(1);
  });

  it('returns the live row when snapshotVersion matches the current version', async () => {
    const template = await seedTemplate();
    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, 1);
    expect(resolved?.jsonContent).toEqual({ live: true });
  });

  it('returns the archived row when snapshotVersion is older than the live version', async () => {
    const template = await seedTemplate();
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: { archived: true },
      poseNodeId: 'archived-pose',
      upperNodeIds: ['archived-upper'],
      garmentPhasePromptNode: 'archived-prompt',
    });
    await env.db
      .update(schema.workflowTemplates)
      .set({ jsonContent: { live: 'new' }, version: 2, poseNodeId: 'new-pose' })
      .where(eq(schema.workflowTemplates.id, template.id));

    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, 1);
    expect(resolved?.jsonContent).toEqual({ archived: true });
    expect(resolved?.poseNodeId).toBe('archived-pose');
    // Fields the archive doesn't own (id, isActive, slug) still come from the live row.
    expect(resolved?.id).toBe(template.id);
  });

  it('throws a clear error when the referenced archive no longer exists', async () => {
    const template = await seedTemplate();
    await env.db
      .update(schema.workflowTemplates)
      .set({ version: 2 })
      .where(eq(schema.workflowTemplates.id, template.id));

    await expect(resolveWorkflowTemplateVersion(env.db, template.id, 1)).rejects.toThrow(
      /version 1 was archived but no longer exists/,
    );
  });

  it('returns undefined when the template does not exist at all', async () => {
    const resolved = await resolveWorkflowTemplateVersion(env.db, randomUUID(), null);
    expect(resolved).toBeUndefined();
  });
});
```

Add the missing `eq` import from `drizzle-orm` at the top of the test file alongside the others.

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/dispatcher`): `npx vitest run --config vitest.integration.config.ts src/workflow/resolve-template-version.test.ts`
Expected: FAIL — `Cannot find module './resolve-template-version.js'`.

- [ ] **Step 3: Implement the resolver**

```ts
// apps/dispatcher/src/workflow/resolve-template-version.ts
import { type DB, schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';

/**
 * Resolves which content a job should use for a given workflow template:
 * the live row (the common case — no replace has happened since this job was
 * created, or the job predates version stamping entirely), or a specific
 * archived version if the live template has since moved on. See
 * docs/superpowers/specs/2026-08-26-workflow-template-replace-design.md.
 */
export async function resolveWorkflowTemplateVersion(
  db: DB,
  workflowTemplateId: string,
  snapshotVersion: number | null | undefined,
): Promise<typeof schema.workflowTemplates.$inferSelect | undefined> {
  const [live] = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
  if (!live) return undefined;
  if (snapshotVersion == null || snapshotVersion === live.version) return live;

  const [archived] = await db
    .select()
    .from(schema.workflowTemplateArchives)
    .where(
      and(
        eq(schema.workflowTemplateArchives.workflowTemplateId, workflowTemplateId),
        eq(schema.workflowTemplateArchives.version, snapshotVersion),
      ),
    );
  if (!archived) {
    throw new Error(
      `Workflow template "${workflowTemplateId}" version ${snapshotVersion} was archived but no longer exists — job outlived its drain window`,
    );
  }

  return {
    ...live,
    jsonContent: archived.jsonContent,
    faceNodeId: archived.faceNodeId,
    poseNodeId: archived.poseNodeId,
    bgNodeId: archived.bgNodeId,
    upperNodeIds: archived.upperNodeIds,
    lowerNodeId: archived.lowerNodeId,
    shoeNodeId: archived.shoeNodeId,
    thirdNodeId: archived.thirdNodeId,
    sizeNodeId: archived.sizeNodeId,
    sizeNodeIds: archived.sizeNodeIds,
    latentSizeNodeIds: archived.latentSizeNodeIds,
    latentMaxPx: archived.latentMaxPx,
    outputSizeNodeIds: archived.outputSizeNodeIds,
    outputMaxPx: archived.outputMaxPx,
    resultNodeId: archived.resultNodeId,
    facePhasePromptNode: archived.facePhasePromptNode,
    garmentPhasePromptNode: archived.garmentPhasePromptNode,
    stage1PositivePromptNode: archived.stage1PositivePromptNode,
    stage1NegativePromptNode: archived.stage1NegativePromptNode,
    defaultFacePhasePrompt: archived.defaultFacePhasePrompt,
    defaultGarmentPhasePrompt: archived.defaultGarmentPhasePrompt,
    defaultStage1PositivePrompt: archived.defaultStage1PositivePrompt,
    defaultStage1NegativePrompt: archived.defaultStage1NegativePrompt,
    workflowType: archived.workflowType,
    tryonPersonNodeId: archived.tryonPersonNodeId,
    tryonGarmentNodeId: archived.tryonGarmentNodeId,
    tryonGarmentNodeId2: archived.tryonGarmentNodeId2,
    tryonOutputNodeId: archived.tryonOutputNodeId,
    version: archived.version,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts src/workflow/resolve-template-version.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/workflow/resolve-template-version.ts apps/dispatcher/src/workflow/resolve-template-version.test.ts
git commit -m "feat(dispatcher): add resolveWorkflowTemplateVersion resolver"
```

---

## Task 4: Dispatcher — wire the resolver into `patcher.ts`

**Files:**
- Modify: `apps/dispatcher/src/workflow/patcher.ts:9-28,230-243`

- [ ] **Step 1: Replace `loadWorkflow`'s query with the resolver**

Replace lines 9-28 (the `loadWorkflow` function and its stale-comment header) with:

```ts
// ── Template loading ──────────────────────────────────────────────────────

async function loadWorkflow(
  db: DB,
  workflowTemplateId: string,
  snapshotVersion: number | null | undefined,
): Promise<typeof schema.workflowTemplates.$inferSelect> {
  const record = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);

  if (!record) {
    throw new Error(`Workflow template "${workflowTemplateId}" not found in database`);
  }

  return record;
}
```

Add the import at the top of the file, alongside the existing `./resize-to-max.js` import:
```ts
import { resolveWorkflowTemplateVersion } from './resolve-template-version.js';
```

- [ ] **Step 2: Thread `snapshotVersion` through `patchWorkflow`**

Replace lines 230-243 (`patchWorkflow`'s docstring and body) with:

```ts
/**
 * Loads the workflow template from the DB — the live row, or a specific
 * archived version if `snapshotVersion` no longer matches the live template's
 * current version — deep-clones the JSON, and delegates to applyWorkflowPatch.
 */
export async function patchWorkflow(
  inputs: WorkflowInputs,
  db: DB,
  log?: PatchLog,
  snapshotVersion?: number | null,
): Promise<PatchedWorkflow> {
  const tmpl = await loadWorkflow(db, inputs.workflowTemplateId, snapshotVersion);
  const workflow = JSON.parse(JSON.stringify(tmpl.jsonContent)) as Workflow;
  const prompt = applyWorkflowPatch(workflow, tmpl, inputs, log);
  return { prompt, resultNodeId: tmpl.resultNodeId };
}
```

This also fixes a pre-existing stale comment (the old docstring claimed a "5-min TTL cache" that doesn't exist anywhere in this file — confirmed by grep; the accurate comment is the one already at the top of the old `loadWorkflow`, which the new version keeps).

- [ ] **Step 3: Verify existing patcher tests still pass**

Run (from `apps/dispatcher`): `npx vitest run src/workflow/patcher.test.ts`
Expected: PASS — `applyWorkflowPatch` itself is untouched, only `loadWorkflow`/`patchWorkflow` changed, and this test file doesn't call either.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: errors at every `patchWorkflow(...)` call site in `processor.ts` that doesn't yet pass a 4th argument — this is expected and fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/workflow/patcher.ts
git commit -m "feat(dispatcher): thread snapshotVersion through patchWorkflow"
```

---

## Task 5: Dispatcher — wire `processJob` (the regular/studio path)

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:494-501,650-661`

`processJob` (starting at line 149) already declares `rawParams` at lines 229-232 by parsing `inputs.params` — used throughout the function (lines 235, 250, 273, 359). Use that same variable; do not introduce a second params variable.

- [ ] **Step 1: Add the import**

At the top of `apps/dispatcher/src/job/processor.ts`, alongside the existing `import { patchWorkflow } from '../workflow/patcher.js';` (line 30), add:

```ts
import { resolveWorkflowTemplateVersion } from '../workflow/resolve-template-version.js';
```

- [ ] **Step 2: Replace the capability probe (lines 494-501)**

Before:
```ts
  const [tmplRoles] = await db
    .select({
      faceNodeId: schema.workflowTemplates.faceNodeId,
      bgNodeId: schema.workflowTemplates.bgNodeId,
      upperNodeIds: schema.workflowTemplates.upperNodeIds,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
```

After:
```ts
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const tmplRoles = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
```

The rest of the function (`tmplRoles?.faceNodeId`, `tmplRoles?.bgNodeId`, `tmplRoles?.upperNodeIds`) is unchanged — the resolver's full-row return type is a superset of the three fields the old query selected.

- [ ] **Step 3: Pass `snapshotVersion` into the `patchWorkflow` call (around line 650)**

Find the existing call:
```ts
    const { prompt, resultNodeId } = await patchWorkflow(
      {
        workflowTemplateId,
        upperGarmentFile,
        faceSideFile,
        poseFile,
        backgroundFile,
        lowerGarmentFile,
        shoeGarmentFile,
        thirdGarmentFile,
```

Find its closing arguments further down (the `}, db, log` or similar tail) and change the call to pass `snapshotVersion` as the 4th argument, e.g. if the existing call ends `}, db);` or `}, db, jobLog);`, change it to `}, db, jobLog, snapshotVersion);` — match whatever the existing 2nd/3rd arguments actually are at that call site (do not guess a `log` argument that isn't there; read the exact closing line before editing).

- [ ] **Step 4: Typecheck and run existing tests**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: this call site's error from Task 4 is now resolved (5 remaining, fixed in Tasks 6–9).

Run: `npx vitest run --config vitest.integration.config.ts test/integration/tryon-direct-webp.test.ts`
(This exercises `processJob`'s sibling but is the fastest existing smoke check available before Task 6's own test — full regression coverage comes from Task 18.)
Expected: PASS, unchanged from before this task.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve versioned template content in processJob"
```

---

## Task 6: Dispatcher — wire `processTryonDirectJob`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:948-957`

`processTryonDirectJob` starts at line 911 and follows the same `rawParams = typeof inputs.params === 'string' ? JSON.parse(inputs.params) : (inputs.params ?? {})` pattern used in `processJob` (line 229) — locate it near the top of this function before editing; if this function's local variable has a different name than `rawParams`, use whatever name it actually declares.

- [ ] **Step 1: Replace the query**

Before:
```ts
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
```

After:
```ts
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const template = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
```

The following `if (!template) { ... }` block and all `template.jsonContent`/`template.tryonPersonNodeId`/etc. references below are unchanged.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`

- [ ] **Step 3: Run the existing test for this path**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/tryon-direct-webp.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve versioned template content in processTryonDirectJob"
```

---

## Task 7: Dispatcher — wire `processSareeMannequinJob`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1231-1240`

`processSareeMannequinJob` starts at line 1144 and already reads `rawParams.workflowTemplateId`/`rawParams.kind` elsewhere in this function (confirmed) — reuse that same variable.

- [ ] **Step 1: Replace the query**

Before:
```ts
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonGarmentNodeId2: schema.workflowTemplates.tryonGarmentNodeId2,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
```

After:
```ts
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const template = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`

- [ ] **Step 3: Run existing saree-mannequin tests**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/saree-step2-workflow-override.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve versioned template content in processSareeMannequinJob"
```

---

## Task 8: Dispatcher — wire `processSareeJob`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1540-1548`

`processSareeJob` starts at line 1505 and follows the same `rawParams` pattern as its siblings.

- [ ] **Step 1: Replace the query**

Before:
```ts
  // Load saree workflow template. Saree flows reuse the tryon*_node_id columns
  // on workflow_templates (the admin route writes those columns at upload time).
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
```

After:
```ts
  // Load saree workflow template. Saree flows reuse the tryon*_node_id columns
  // on workflow_templates (the admin route writes those columns at upload time).
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const template = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`

- [ ] **Step 3: Run existing saree tests**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/saree-step2-workflow-override.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve versioned template content in processSareeJob"
```

---

## Task 9: Dispatcher — wire `processWidgetJob` and `processShopifyJob`

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:1838-1853,2169-2177`

`processWidgetJob` starts at line 1741 (handles both storefront-widget and kiosk jobs) and `processShopifyJob` starts at line 2125. Both follow the same `rawParams` pattern (confirmed for `processWidgetJob` via its existing `rawParams.workflowTemplateId` usage around line 1818).

- [ ] **Step 1: Replace `processWidgetJob`'s query**

Before:
```ts
  const [templateRow] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonGarmentNodeId2: schema.workflowTemplates.tryonGarmentNodeId2,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.id, workflowTemplateId),
        eq(schema.workflowTemplates.isActive, true),
      ),
    )
    .limit(1);
```

After:
```ts
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const resolvedTemplate = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
  const templateRow = resolvedTemplate?.isActive ? resolvedTemplate : undefined;
```

This preserves the exact original semantics: only an `isActive` template counts, checked on whatever row (live or archived-reconstructed) the resolver returns — `isActive` always reflects the *live* row's current value even when the rest of the content is archived (see Task 3's resolver: `isActive` is spread from `live`, not overridden).

- [ ] **Step 2: Replace `processShopifyJob`'s query**

Before:
```ts
  // Load Shopify workflow template. Shopify flows reuse the tryon*_node_id columns
  // on workflow_templates (same precedent processSareeJob established).
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
```

After:
```ts
  // Load Shopify workflow template. Shopify flows reuse the tryon*_node_id columns
  // on workflow_templates (same precedent processSareeJob established).
  const snapshotVersion =
    typeof rawParams.dispatchTemplateVersion === 'number' ? rawParams.dispatchTemplateVersion : null;
  const template = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);
```

- [ ] **Step 3: Typecheck — this should now be clean across the whole file**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: no errors anywhere in `processor.ts`.

- [ ] **Step 4: Run the full dispatcher test suite**

Run: `pnpm --filter @tryme/dispatcher test`
Run: `pnpm --filter @tryme/dispatcher test:integration` (or the equivalent `vitest.integration.config.ts` invocation this package uses — check `package.json` scripts)
Expected: all pass, unchanged from before this task series.

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): resolve versioned template content in processWidgetJob and processShopifyJob"
```

---

## Task 10: Dispatcher — drain cleanup (TDD)

**Files:**
- Create: `apps/dispatcher/src/workflow/drain-cleanup.ts`
- Test: `apps/dispatcher/src/workflow/drain-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/dispatcher/src/workflow/drain-cleanup.test.ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestEnv, type TestEnv } from '../../test/helpers/containers.js';
import { maybeCleanupArchive } from './drain-cleanup.js';

describe('maybeCleanupArchive', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  async function seedTemplateWithArchive() {
    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `drain-test-${randomUUID()}`,
        label: 'Drain test template',
        jsonContent: {},
        poseNodeId: 'p',
        upperNodeIds: [],
        garmentPhasePromptNode: 'g',
        version: 2,
      })
      .returning();
    if (!template) throw new Error('failed to seed template');
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: {},
      poseNodeId: 'p',
      upperNodeIds: [],
      garmentPhasePromptNode: 'g',
    });
    return template;
  }

  async function seedJobAtVersion(templateId: string, version: number, status: string) {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `drain-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    if (!user) throw new Error('failed to seed user');
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status, source: 'tryon' })
      .returning();
    if (!job) throw new Error('failed to seed job');
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      poseNodeId: undefined,
      params: { workflowTemplateId: templateId, dispatchTemplateVersion: version },
    } as typeof schema.jobInputs.$inferInsert);
    return job;
  }

  it('does not delete the archive while a non-terminal job still references it', async () => {
    const template = await seedTemplateWithArchive();
    await seedJobAtVersion(template.id, 1, 'QUEUED');

    await maybeCleanupArchive(env.db, template.id, 1);

    const [archive] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive).toBeDefined();
  });

  it('deletes the archive once every referencing job is terminal', async () => {
    const template = await seedTemplateWithArchive();
    await seedJobAtVersion(template.id, 1, 'COMPLETED');

    await maybeCleanupArchive(env.db, template.id, 1);

    const [archive] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts src/workflow/drain-cleanup.test.ts`
Expected: FAIL — `Cannot find module './drain-cleanup.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/dispatcher/src/workflow/drain-cleanup.ts
import { type DB, schema } from '@tryme/db';
import { and, count, eq, notInArray, sql } from 'drizzle-orm';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Deletes an archived template version once no non-terminal job still
 * references it via job_inputs.params.dispatchTemplateVersion. Called from
 * the dispatcher's existing terminal-transition points — not a periodic
 * sweep — since it only ever needs to run right after a job that might have
 * been the last one draining a given version reaches a terminal state.
 */
export async function maybeCleanupArchive(
  db: DB,
  workflowTemplateId: string,
  version: number,
): Promise<void> {
  const [row] = await db
    .select({ cnt: count() })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(
      and(
        sql`${schema.jobInputs.params} ->> 'dispatchTemplateVersion' = ${String(version)}`,
        sql`${schema.jobInputs.params} ->> 'workflowTemplateId' = ${workflowTemplateId}`,
        notInArray(schema.jobs.status, TERMINAL_STATUSES),
      ),
    );

  if (Number(row?.cnt ?? 0) > 0) return;

  await db
    .delete(schema.workflowTemplateArchives)
    .where(
      and(
        eq(schema.workflowTemplateArchives.workflowTemplateId, workflowTemplateId),
        eq(schema.workflowTemplateArchives.version, version),
      ),
    );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts src/workflow/drain-cleanup.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Wire it into the terminal-transition points**

In `apps/dispatcher/src/job/processor.ts`, find `markFailed` (line ~2633) and `terminateJob` (line ~2517) — these are the shared functions every `process*Job` function calls to reach a terminal state (confirmed by their names and position after all six `process*Job` functions). At the end of each (just before the function returns, after the job's status has actually been persisted as terminal), add:

```ts
  if (typeof rawParams?.dispatchTemplateVersion === 'number' && typeof workflowTemplateId === 'string') {
    await maybeCleanupArchive(db, workflowTemplateId, rawParams.dispatchTemplateVersion).catch((err) => {
      log.warn({ err, workflowTemplateId }, 'failed to check workflow template archive cleanup');
    });
  }
```

Read each function's actual parameter names before inserting this — `markFailed`/`terminateJob` may not have `rawParams`/`workflowTemplateId` directly in scope (they're likely called with a `jobId` and look up or receive context differently). Adjust the condition to whatever data is actually available in each function's scope: the goal is "after this job is confirmed terminal, if it was stamped with a `dispatchTemplateVersion` for some `workflowTemplateId`, check whether that archive can now be cleaned up" — never let a failure in this check fail the job-termination path itself (hence `.catch` with a warn log, not a rethrow).

Add the import at the top of `processor.ts`:
```ts
import { maybeCleanupArchive } from '../workflow/drain-cleanup.js';
```

- [ ] **Step 6: Full dispatcher suite**

Run: `pnpm --filter @tryme/dispatcher test`
Run: `pnpm --filter @tryme/dispatcher test:integration`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/dispatcher/src/workflow/drain-cleanup.ts apps/dispatcher/src/workflow/drain-cleanup.test.ts apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): clean up drained workflow template archives on job termination"
```

---

## Task 11: API — stamp `dispatchTemplateVersion` in the regular studio job-creation path

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:630-760`

This is the per-pose resolution block described in the design spec — `poseWorkflowRows` (joins `modelPoseAssets` against two aliased `workflowTemplates` — `defaultWorkflow` and `overrideWorkflow`), reduced into `poseWorkflows`, then used to build each `looks_` entry's `params`.

- [ ] **Step 1: Select `version` from both aliased joins**

In the `poseWorkflowRows` query (starting at line 632), add two fields to the `.select({...})` object:

```ts
      defaultWorkflowVersion: defaultWorkflow.version,
      overrideWorkflowVersion: overrideWorkflow.version,
```

Add these alongside the existing `defaultWorkflowTemplateId`/`configWorkflowTemplateId` fields — exact position doesn't matter, keep them grouped with the other `defaultWorkflow`/`overrideWorkflow`-sourced fields for readability.

- [ ] **Step 2: Carry `version` through the `poseWorkflows` map**

In the `poseWorkflows` construction (lines 675–699), both branches build objects with `workflowTemplateId`. Add a `version` field to each:

For the `requiresMannequinStep` branch (line 676-684):
```ts
    ? distinctPoseIds.map((poseId) => ({
        poseId,
        workflowTemplateId: sareeStep2?.workflowTemplateId ?? null,
        version: sareeStep2?.version ?? null,
        promptGarmentPhase: null,
        upperNodeIds: sareeStep2?.upperNodeIds ?? [],
        lowerNodeId: sareeStep2?.lowerNodeId ?? null,
        shoeNodeId: sareeStep2?.shoeNodeId ?? null,
        sizeNodeIds: sareeStep2?.sizeNodeIds ?? null,
      }))
```

This requires `sareeStep2` (whatever query resolves it earlier in this file — find its `.select({...})` call above this block and add `version: schema.workflowTemplates.version` to it the same way).

For the default per-pose branch (line 686-699):
```ts
    : (mappingPoseWorkflows ??
      poseWorkflowRows.map((r) => ({
        poseId: r.poseId,
        workflowTemplateId: r.configWorkflowTemplateId ?? r.defaultWorkflowTemplateId,
        version:
          r.configWorkflowTemplateId != null ? r.overrideWorkflowVersion : r.defaultWorkflowVersion,
        promptGarmentPhase: null,
        upperNodeIds:
          r.configWorkflowTemplateId != null
            ? (r.overrideUpperNodeIds ?? [])
            : (r.defaultUpperNodeIds ?? []),
        lowerNodeId:
          r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
        shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
        sizeNodeIds:
          r.configWorkflowTemplateId != null ? r.overrideSizeNodeIds : r.defaultSizeNodeIds,
      })));
```

For `mappingPoseWorkflows` (the `catalogueTemplateMappingId` branch, built elsewhere in this file before line 632 — find its construction and add a `version` field the same way, sourced from whatever `workflowTemplates` row it already joins against).

- [ ] **Step 3: Stamp it into each look's `params`**

In the `looks_` construction (line 724-760), the `params` object already spreads `body.params` and adds several computed fields. Add:

```ts
      params: {
        ...(body.params ?? {}),
        dispatchTemplateVersion: pw?.version ?? null,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        ...(aspectRatio ? { aspectRatio } : {}),
        resolution,
        ...(platform ? { platform } : {}),
        ...(catalogueTemplateMappingId
          ? {
              catalogueTemplateMappingId,
              workflowTemplateId: pw?.workflowTemplateId,
              ...(pw?.promptGarmentPhase ? { promptGarmentPhase: pw.promptGarmentPhase } : {}),
            }
          : {}),
```

(only the new `dispatchTemplateVersion` line is added; everything else in this block is unchanged — shown for placement context.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors. If TypeScript complains about `r.defaultWorkflowVersion`/`r.overrideWorkflowVersion` being possibly `null` where a `number` is expected elsewhere, that's expected — `version` is nullable through a `leftJoin`, matching how `defaultUpperNodeIds`/etc. are already handled with `?? []`/`?? null` fallbacks in this exact code.

- [ ] **Step 5: Add a regression test**

Find this file's corresponding integration test (likely `apps/api/test/integration/jobs.test.ts` or similar — check `apps/api/test/integration/` for the existing test that covers `POST /v1/jobs/tryon` for a pose-based studio job) and add one assertion to an existing "creates a job" test: after creating the job, select its `job_inputs.params` and assert `dispatchTemplateVersion` equals the seeded template's `version` (1, for a freshly-seeded template).

- [ ] **Step 6: Run the API test suite**

Run: `pnpm --filter @tryme/api test`
Run: `pnpm --filter @tryme/api test:integration`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/
git commit -m "feat(api): stamp dispatchTemplateVersion on regular studio job creation"
```

---

## Task 12: API — stamp `dispatchTemplateVersion` in the remaining job-creation paths

**Files:**
- Modify: `apps/api/src/modules/jobs/createSaree.ts`
- Modify: `apps/api/src/modules/jobs/createSareeMannequin.ts`
- Modify: `apps/api/src/modules/dev/create-job.ts`
- Modify: `apps/api/src/modules/merchant/create-job.ts`
- Modify: `apps/api/src/modules/merchant/create-tryon-job.ts`
- Modify: `apps/api/src/modules/shopify/customer.routes.ts`

Each of these files resolves an effective `workflowTemplateId` before inserting a `job_inputs` row (confirmed: each writes one of the `JOB_SOURCE` values documented in `docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md` §7 item 14, and every one of those writers necessarily knows which template it targeted). This task applies the identical mechanical pattern to each:

- [ ] **Step 1: For each file above, locate where it resolves `workflowTemplateId`**

Search for `workflowTemplateId` in the file. It will either be:
(a) selected directly from a `schema.workflowTemplates` query — add `version: schema.workflowTemplates.version` to that same `.select({...})` call, or
(b) passed in from a caller that already resolved it — trace back to where it was originally queried and add `version` there instead.

- [ ] **Step 2: Add `dispatchTemplateVersion` to the `params` object passed to `job_inputs`**

Wherever the file builds the object it inserts into `schema.jobInputs` (or passes to a shared `createJob`/`createDevJobCore`-style helper), add one field to its `params`:

```ts
        dispatchTemplateVersion: <the version resolved in Step 1> ?? null,
```

- [ ] **Step 3: Typecheck after each file**

Run: `pnpm --filter @tryme/api typecheck`
Fix any type errors introduced (e.g. a query result type now includes an unused `version` field where a narrower type was previously inferred and used elsewhere — extend that type rather than casting).

- [ ] **Step 4: Add one regression test per path**

For each of the six files, find its corresponding existing integration test (e.g. `apps/api/test/integration/dev-*.test.ts` for `dev/create-job.ts`, `apps/api/test/integration/merchant-*.test.ts` for the merchant paths, a shopify customer job-creation test for `shopify/customer.routes.ts`, and the saree/saree-mannequin equivalents) and add one assertion to an existing "job is created" test asserting `job_inputs.params.dispatchTemplateVersion` matches the seeded template's `version`.

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @tryme/api test`
Run: `pnpm --filter @tryme/api test:integration`
Expected: all pass.

- [ ] **Step 6: Commit (one commit per file, or grouped — engineer's judgment given how mechanical this is)**

```bash
git add apps/api/src/modules/jobs/createSaree.ts apps/api/src/modules/jobs/createSareeMannequin.ts apps/api/src/modules/dev/create-job.ts apps/api/src/modules/merchant/create-job.ts apps/api/src/modules/merchant/create-tryon-job.ts apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/
git commit -m "feat(api): stamp dispatchTemplateVersion on remaining job-creation paths"
```

---

## Task 13: `ReplaceWorkflowBody` Zod schema

**Files:**
- Modify: `packages/types/src/admin.ts` (add after `CreateWorkflowBody`, before `ParseWorkflowBody`, i.e. after line 466)

- [ ] **Step 1: Write the failing test**

```ts
// packages/types/src/admin.test.ts (add to existing file, or create if it doesn't exist —
// check first: `ls packages/types/src/*.test.ts`)
import { describe, expect, it } from 'vitest';
import { ReplaceWorkflowBody } from './admin.js';

describe('ReplaceWorkflowBody', () => {
  const base = {
    slug: 'my_workflow',
    label: 'My Workflow',
    jsonContent: {},
    workflowType: 'regular' as const,
    poseNodeId: 'p1',
    garmentPhasePromptNode: 'g1',
    upperNodeIds: ['u1'],
  };

  it('rejects a missing password', () => {
    const result = ReplaceWorkflowBody.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('accepts a valid body with a password', () => {
    const result = ReplaceWorkflowBody.safeParse({ ...base, password: 'correct horse battery staple' });
    expect(result.success).toBe(true);
  });

  it('still enforces the underlying workflowType-specific requirements', () => {
    const result = ReplaceWorkflowBody.safeParse({
      slug: 'ts',
      label: 'Two stage',
      jsonContent: {},
      workflowType: 'two_stage',
      poseNodeId: 'p1',
      password: 'x',
      // missing stage1PositivePromptNode/stage1NegativePromptNode/etc.
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/types`): `npx vitest run src/admin.test.ts`
Expected: FAIL — `ReplaceWorkflowBody` is not exported.

- [ ] **Step 3: Implement**

In `packages/types/src/admin.ts`, immediately after the `CreateWorkflowBody` definition's closing `});` (currently ending at line 466):

```ts
export const ReplaceWorkflowBody = z.intersection(
  CreateWorkflowBody,
  z.object({
    password: z.string().min(1, 'password is required to replace a workflow'),
  }),
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/admin.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/admin.ts packages/types/src/admin.test.ts
git commit -m "feat(types): add ReplaceWorkflowBody schema"
```

---

## Task 14: API — `POST /admin/workflows/:id/replace`

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts` (add new route after the existing `/reassign` route, i.e. after line 1149, before the `DELETE /admin/workflows/:id` route)

- [ ] **Step 1: Write the failing integration test**

Add to `apps/api/test/integration/admin-workflows.test.ts` (new `describe` block, following this file's existing patterns for seeding an admin user and a template — check the top of the file for its existing `seedAdmin`/`seedTemplate`-style helpers and reuse them):

```ts
describe('POST /admin/workflows/:id/replace', () => {
  it('rejects an incorrect password without changing anything', async () => {
    const template = await seedTemplate(); // reuse this file's existing helper
    const res = await appRequest(app, {
      method: 'POST',
      url: `/admin/workflows/${template.id}/replace`,
      headers: adminAuthHeaders, // reuse this file's existing admin-auth helper
      payload: {
        slug: template.slug,
        label: template.label,
        jsonContent: { newGraph: true },
        workflowType: 'regular',
        poseNodeId: 'new-pose',
        garmentPhasePromptNode: 'new-prompt',
        upperNodeIds: ['new-upper'],
        password: 'definitely-wrong',
      },
    });
    expect(res.statusCode).toBe(401);

    const [unchanged] = await app.db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, template.id));
    expect(unchanged?.version).toBe(1);

    const archiveRows = await app.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archiveRows).toHaveLength(0);
  });

  it('archives the old content, applies the new content, and bumps version on a correct password', async () => {
    const template = await seedTemplate();
    const res = await appRequest(app, {
      method: 'POST',
      url: `/admin/workflows/${template.id}/replace`,
      headers: adminAuthHeaders,
      payload: {
        slug: template.slug,
        label: template.label,
        jsonContent: { newGraph: true },
        workflowType: 'regular',
        poseNodeId: 'new-pose',
        garmentPhasePromptNode: 'new-prompt',
        upperNodeIds: ['new-upper'],
        password: ADMIN_TEST_PASSWORD, // this file's existing seeded admin password constant
      },
    });
    expect(res.statusCode).toBe(200);

    const [updated] = await app.db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, template.id));
    expect(updated?.version).toBe(2);
    expect(updated?.jsonContent).toEqual({ newGraph: true });
    expect(updated?.poseNodeId).toBe('new-pose');

    const [archive] = await app.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive?.version).toBe(1);
    expect(archive?.poseNodeId).toBe(template.poseNodeId);
  });

  it('rejects a second replace while one is already draining', async () => {
    const template = await seedTemplate();
    await appRequest(app, {
      method: 'POST',
      url: `/admin/workflows/${template.id}/replace`,
      headers: adminAuthHeaders,
      payload: {
        slug: template.slug,
        label: template.label,
        jsonContent: { v2: true },
        workflowType: 'regular',
        poseNodeId: 'v2-pose',
        garmentPhasePromptNode: 'v2-prompt',
        upperNodeIds: ['v2-upper'],
        password: ADMIN_TEST_PASSWORD,
      },
    });

    const res = await appRequest(app, {
      method: 'POST',
      url: `/admin/workflows/${template.id}/replace`,
      headers: adminAuthHeaders,
      payload: {
        slug: template.slug,
        label: template.label,
        jsonContent: { v3: true },
        workflowType: 'regular',
        poseNodeId: 'v3-pose',
        garmentPhasePromptNode: 'v3-prompt',
        upperNodeIds: ['v3-upper'],
        password: ADMIN_TEST_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already in progress/);
  });
});
```

Check the exact helper names (`seedTemplate`, `appRequest`/whatever HTTP-call wrapper this file uses, `adminAuthHeaders`, and how a known admin password is seeded/referenced — likely a constant near the top of the file or a `hashPassword('...')` call in a `beforeAll`) against what's actually in `apps/api/test/integration/admin-workflows.test.ts` before writing this, and adjust names to match exactly.

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/api`): `npx vitest run --config vitest.integration.config.ts test/integration/admin-workflows.test.ts -t "POST /admin/workflows/:id/replace"`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

In `apps/api/src/modules/admin/workflows.routes.ts`, add the import:

```ts
import { ReplaceWorkflowBody } from '@tryme/types';
```
(add to the existing `@tryme/types` import block at the top, alongside `CreateWorkflowBody` etc.)

```ts
import { verifyPassword } from '../auth/service.js';
```

Add the route after the existing `/reassign` route (after line 1149):

```ts
  // POST /admin/workflows/:id/replace
  // Overwrites this template's content in place — same row id, so every
  // pose/config FK that points at it needs no reassignment. Jobs already
  // queued keep resolving the old content via workflow_template_archives
  // until they drain (see apps/dispatcher/src/workflow/resolve-template-version.ts
  // and docs/superpowers/specs/2026-08-26-workflow-template-replace-design.md).
  app.post(
    '/admin/workflows/:id/replace',
    {
      preHandler: W,
      schema: { params: uuidParam, body: ReplaceWorkflowBody },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof ReplaceWorkflowBody>;

      const [admin] = await app.db
        .select({ passwordHash: schema.adminUsers.passwordHash })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, req.userId));
      if (!admin?.passwordHash || !(await verifyPassword(admin.passwordHash, body.password))) {
        throw new AppError('UNAUTHORIZED', 401, 'incorrect password');
      }

      await app.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, id))
          .for('update');
        if (!locked) throw new AppError('NOT_FOUND', 404, 'workflow not found');

        const [existingArchive] = await tx
          .select({ id: schema.workflowTemplateArchives.id })
          .from(schema.workflowTemplateArchives)
          .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id));
        if (existingArchive) {
          throw new AppError(
            'CONFLICT',
            409,
            'a replacement is already in progress for this template; wait for it to finish before starting another',
          );
        }

        await tx.insert(schema.workflowTemplateArchives).values({
          workflowTemplateId: id,
          version: locked.version,
          jsonContent: locked.jsonContent,
          faceNodeId: locked.faceNodeId,
          poseNodeId: locked.poseNodeId,
          bgNodeId: locked.bgNodeId,
          upperNodeIds: locked.upperNodeIds,
          lowerNodeId: locked.lowerNodeId,
          shoeNodeId: locked.shoeNodeId,
          thirdNodeId: locked.thirdNodeId,
          sizeNodeId: locked.sizeNodeId,
          sizeNodeIds: locked.sizeNodeIds,
          latentSizeNodeIds: locked.latentSizeNodeIds,
          latentMaxPx: locked.latentMaxPx,
          outputSizeNodeIds: locked.outputSizeNodeIds,
          outputMaxPx: locked.outputMaxPx,
          resultNodeId: locked.resultNodeId,
          facePhasePromptNode: locked.facePhasePromptNode,
          garmentPhasePromptNode: locked.garmentPhasePromptNode,
          stage1PositivePromptNode: locked.stage1PositivePromptNode,
          stage1NegativePromptNode: locked.stage1NegativePromptNode,
          defaultFacePhasePrompt: locked.defaultFacePhasePrompt,
          defaultGarmentPhasePrompt: locked.defaultGarmentPhasePrompt,
          defaultStage1PositivePrompt: locked.defaultStage1PositivePrompt,
          defaultStage1NegativePrompt: locked.defaultStage1NegativePrompt,
          workflowType: locked.workflowType,
          tryonPersonNodeId: locked.tryonPersonNodeId,
          tryonGarmentNodeId: locked.tryonGarmentNodeId,
          tryonGarmentNodeId2: locked.tryonGarmentNodeId2,
          tryonOutputNodeId: locked.tryonOutputNodeId,
        });

        const newValues = {
          jsonContent: body.jsonContent,
          workflowType: body.workflowType,
          faceNodeId: body.faceNodeId ?? null,
          poseNodeId: body.poseNodeId ?? locked.poseNodeId,
          bgNodeId: body.bgNodeId ?? null,
          upperNodeIds: body.upperNodeIds ?? [],
          lowerNodeId: body.lowerNodeId ?? null,
          shoeNodeId: body.shoeNodeId ?? null,
          thirdNodeId: body.thirdNodeId ?? null,
          sizeNodeIds: body.sizeNodeIds ?? [],
          resultNodeId: body.resultNodeId ?? null,
          facePhasePromptNode: body.facePhasePromptNode ?? null,
          garmentPhasePromptNode: body.garmentPhasePromptNode ?? locked.garmentPhasePromptNode,
          tryonPersonNodeId: body.tryonPersonNodeId ?? null,
          tryonGarmentNodeId: body.tryonGarmentNodeId ?? null,
          tryonGarmentNodeId2: body.tryonGarmentNodeId2 ?? null,
          tryonOutputNodeId: body.tryonOutputNodeId ?? null,
          stage1PositivePromptNode: body.stage1PositivePromptNode ?? null,
          stage1NegativePromptNode: body.stage1NegativePromptNode ?? null,
          version: locked.version + 1,
        };

        await tx.update(schema.workflowTemplates).set(newValues).where(eq(schema.workflowTemplates.id, id));

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.replace',
          resourceType: 'workflow',
          resourceId: id,
          before: locked,
          after: { ...locked, ...newValues },
          request: req,
        });
      });

      return reply.code(200).send({ ok: true });
    },
  );
```

Match `newValues`' field list against whatever fields `CreateWorkflowBody`/`ReplaceWorkflowBody` actually validates (cross-check against `packages/types/src/admin.ts` — some fields like `latentSizeNodeIds`/`latentMaxPx`/`outputSizeNodeIds`/`outputMaxPx` may need including too if the create flow sets them at upload time; check the existing `POST /admin/workflows` route in this same file for the complete field list it writes on create, and mirror it here exactly, since "replace" should persist everything "create" does).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/admin-workflows.test.ts -t "POST /admin/workflows/:id/replace"`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @tryme/api test`
Run: `pnpm --filter @tryme/api test:integration`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/admin-workflows.test.ts
git commit -m "feat(api): add POST /admin/workflows/:id/replace with password confirmation"
```

---

## Task 15: API — impact summary on `GET /admin/workflows/:id`

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts:762-789` (the existing `GET /admin/workflows/:id` detail route)

- [ ] **Step 1: Read the existing detail route**

Before editing, read lines 762-789 in full to see its exact current response shape (this plan hasn't captured it verbatim — confirm the object it returns before adding fields, so the addition doesn't collide with an existing key name).

- [ ] **Step 2: Add pose/funnel counts and a draining flag**

Add two queries mirroring the exact pattern already used in this file's `DELETE` route (lines 1169-1186) and `GET /admin/workflows` list route (lines 155-165):

```ts
      const [poseCountRow] = await app.db
        .select({ cnt: count() })
        .from(schema.modelPoseAssets)
        .where(eq(schema.modelPoseAssets.workflowTemplateId, id));
      const [funnelCountRow] = await app.db
        .select({ cnt: count() })
        .from(schema.shopifyFunnelTemplates)
        .where(eq(schema.shopifyFunnelTemplates.workflowTemplateId, id));
      const [archive] = await app.db
        .select({ version: schema.workflowTemplateArchives.version })
        .from(schema.workflowTemplateArchives)
        .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id));
```

Add to the returned object:
```ts
        poseCount: Number(poseCountRow?.cnt ?? 0),
        funnelCount: Number(funnelCountRow?.cnt ?? 0),
        draining: archive ? { fromVersion: archive.version } : null,
```

- [ ] **Step 3: Add a test**

In `apps/api/test/integration/admin-workflows.test.ts`, add a test to the existing `GET /admin/workflows/:id` `describe` block: seed a template with a linked `modelPoseAssets` row, call the detail route, assert `poseCount` is 1; then perform a replace (reusing Task 14's helper flow), call the detail route again, assert `draining.fromVersion` equals 1.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/admin-workflows.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/admin-workflows.test.ts
git commit -m "feat(api): surface pose/funnel impact counts and drain status on workflow detail"
```

---

## Task 16: Admin-web — `ReplaceWorkflowModal`

**Files:**
- Create: `apps/admin-web/src/components/ReplaceWorkflowModal.tsx`
- Modify: `apps/admin-web/src/types.ts` (add `draining`/`version` to `WorkflowOption`)
- Modify: `apps/admin-web/src/pages/WorkflowsPage.tsx`

- [ ] **Step 1: Extend `WorkflowOption`**

In `apps/admin-web/src/types.ts`, find the `WorkflowOption` interface and add:
```ts
  version: number;
  draining: { fromVersion: number } | null;
  poseCount: number;
  funnelCount: number;
```

- [ ] **Step 2: Build the modal**

```tsx
// apps/admin-web/src/components/ReplaceWorkflowModal.tsx
import { useState } from 'react';
import { apiErrorMessage, apiFetch } from '../lib/data';
import type { WorkflowOption } from '../types';

interface Props {
  workflow: WorkflowOption;
  onReplaced: () => void;
  onClose: () => void;
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export function ReplaceWorkflowModal({ workflow, onReplaced, onClose, toast }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null);
  const [jsonContent, setJsonContent] = useState<Record<string, unknown> | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleFile = async (f: File) => {
    setFile(f);
    const text = await f.text();
    const json = JSON.parse(text);
    setJsonContent(json);
    const res = await apiFetch('/admin/workflows/parse', {
      method: 'POST',
      body: JSON.stringify({ jsonContent: json, workflowType: workflow.workflowType }),
    });
    setParsed(res);
  };

  const handleSubmit = async () => {
    if (!jsonContent || !password) return;
    setSubmitting(true);
    try {
      await apiFetch(`/admin/workflows/${workflow.id}/replace`, {
        method: 'POST',
        body: JSON.stringify({
          slug: workflow.slug,
          label: workflow.label,
          jsonContent,
          workflowType: workflow.workflowType,
          ...(parsed as Record<string, unknown>)?.detected,
          password,
        }),
      });
      toast({ title: 'Replacement started' });
      onReplaced();
      onClose();
    } catch (err) {
      toast({ kind: 'error', title: 'Replace failed', body: apiErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const impactWarning =
    workflow.poseCount + workflow.funnelCount > 0
      ? `${workflow.poseCount} pose${workflow.poseCount === 1 ? '' : 's'} and ${workflow.funnelCount} Shopify funnel template${workflow.funnelCount === 1 ? '' : 's'} currently use this workflow and will pick up the new content immediately for new jobs.`
      : 'Nothing currently references this workflow.';

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Replace "{workflow.label}"</h2>
        <p className="impact-warning">{impactWarning}</p>
        <input type="file" accept=".json" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {parsed && <pre>{JSON.stringify(parsed, null, 2)}</pre>}
        <label>
          Confirm your password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!jsonContent || !password || submitting} onClick={handleSubmit}>
            {submitting ? 'Replacing…' : 'Replace workflow'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

This is a first-pass structure — before finalizing, read `WorkflowUploadModal.tsx` in full (`apps/admin-web/src/components/WorkflowUploadModal.tsx`) and reuse its actual `NodeSelect`/`NodeBadge` components and per-`workflowType` review-field layout instead of the placeholder `<pre>` dump above, so the review step gives the same editable-mapping UX the create flow already has, not just a raw JSON preview. The `<pre>` block is not acceptable as shipped — it's a starting point for wiring the data flow, not the intended review UI.

- [ ] **Step 3: Wire into `WorkflowsPage.tsx`**

Add state near the existing `reassigning`/`editingWf` state (around line 55-61):
```ts
  const [replacing, setReplacing] = useState<WorkflowOption | null>(null);
```

Add a "Replace" button next to the existing "Reassign" button (around line 510-526), following the exact same conditional-render pattern that button uses:
```tsx
                            <button
                              onClick={() => setReplacing(wf)}
                            >
                              <Icon.Replace /> Replace
                            </button>
```

Render the modal near wherever `WorkflowUploadModal` is currently rendered (conditional on `showUpload`):
```tsx
      {replacing && (
        <ReplaceWorkflowModal
          workflow={replacing}
          onReplaced={loadWorkflows} // reuse this page's existing list-reload function — confirm its actual name
          onClose={() => setReplacing(null)}
          toast={toast}
        />
      )}
```

Add the import at the top: `import { ReplaceWorkflowModal } from '../components/ReplaceWorkflowModal';`

- [ ] **Step 4: Add a "draining" badge**

In the row-rendering code, near where `wf.workflowType` or similar is displayed, add:
```tsx
                {wf.draining && (
                  <span className="badge badge-warning">
                    Replacement in progress — draining from v{wf.draining.fromVersion}
                  </span>
                )}
```

- [ ] **Step 5: Manual verification**

Run: `pnpm --filter @tryme/admin dev`
In the browser: open the Workflows page, click "Replace" on an existing template, upload a JSON file, confirm the parsed mappings render, enter the wrong password and confirm a 401 error toast appears with no state change, then enter the correct password and confirm the row updates and (if any poses reference it) shows the draining badge.

- [ ] **Step 6: Typecheck and build**

Run: `pnpm --filter @tryme/admin typecheck`
Run: `pnpm --filter @tryme/admin build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/components/ReplaceWorkflowModal.tsx apps/admin-web/src/pages/WorkflowsPage.tsx apps/admin-web/src/types.ts
git commit -m "feat(admin): add Replace workflow modal with password confirmation and drain status"
```

---

## Task 17: End-to-end drain integration test

**Files:**
- Create: `apps/dispatcher/test/integration/workflow-replace-drain.test.ts`

This is the scenario from the spec's §8: a queued job survives a replace using the old content; a job created after the replace uses the new content immediately; the archive is cleaned up once the old job completes. Model this on `apps/dispatcher/test/integration/tryon-direct-webp.test.ts`'s harness setup (`setupTestEnv`, `startComfyMock`, `registerWorkers`).

- [ ] **Step 1: Write the test**

```ts
// apps/dispatcher/test/integration/workflow-replace-drain.test.ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processTryonDirectJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-replace-drain';

describe('workflow template replace — drain behavior', () => {
  let env: TestEnv;
  let redis: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();
    await registerWorkers(redis, [{ id: WORKER_ID, url: comfy.url, apiKey: 'test-key' }]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  it('a job stamped with the old version still resolves the archived content after a replace', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `replace-drain-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    if (!user) throw new Error('failed to seed user');
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 10 });

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `replace-drain-${randomUUID()}`,
        label: 'Replace drain test',
        jsonContent: {
          '20': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'person' } },
          '21': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'garment' } },
        },
        poseNodeId: '20',
        upperNodeIds: [],
        garmentPhasePromptNode: '20',
        tryonPersonNodeId: '20',
        tryonGarmentNodeId: '21',
        tryonOutputNodeId: '10',
        workflowType: 'tryon',
      })
      .returning();
    if (!template) throw new Error('failed to seed template');

    // Simulate the replace: archive v1, bump the live row to v2 with a
    // structurally different graph (different node ids).
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: template.jsonContent,
      poseNodeId: template.poseNodeId,
      upperNodeIds: template.upperNodeIds,
      garmentPhasePromptNode: template.garmentPhasePromptNode,
      tryonPersonNodeId: template.tryonPersonNodeId,
      tryonGarmentNodeId: template.tryonGarmentNodeId,
      tryonOutputNodeId: template.tryonOutputNodeId,
    });
    await env.db
      .update(schema.workflowTemplates)
      .set({
        version: 2,
        jsonContent: {
          '99': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'person' } },
          '98': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'garment' } },
        },
        tryonPersonNodeId: '99',
        tryonGarmentNodeId: '98',
      })
      .where(eq(schema.workflowTemplates.id, template.id));

    // A job stamped with the OLD version (v1) — as if it was created before the replace.
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', source: 'tryon' })
      .returning();
    if (!job) throw new Error('failed to seed job');
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      params: {
        personKey: 'test/person.png',
        workflowTemplateId: template.id,
        dispatchTemplateVersion: 1,
      },
    });

    await processTryonDirectJob(
      { redisUrl: 'redis://127.0.0.1:6379' } as never,
      job.id,
      user.id,
      'jobs:priority',
      'test-message-id',
      env.db,
      env.logger ?? console,
      new Date(),
    );

    const requestedNodeIds = comfy.lastPromptNodeIds?.() ?? [];
    expect(requestedNodeIds).toContain('20');
    expect(requestedNodeIds).not.toContain('99');
  });
});
```

Adjust `processTryonDirectJob`'s actual parameter list and `comfy.lastPromptNodeIds` (or whatever the mock's actual inspection API is called) by reading `apps/dispatcher/test/integration/tryon-direct-webp.test.ts` and `apps/dispatcher/test/helpers/comfy-mock.ts` in full before finalizing this test — the signature shown above is inferred from context in this plan, not independently verified against the mock's exact API, and must match exactly or the test won't compile.

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/workflow-replace-drain.test.ts`
First run before Task 3-9's changes would fail entirely (module not found); after those tasks it should already pass, since it's testing behavior those tasks already implemented. If it fails at this point, that's a real bug in one of Tasks 3-9 — fix the underlying dispatcher code, not this test.

- [ ] **Step 3: Commit**

```bash
git add apps/dispatcher/test/integration/workflow-replace-drain.test.ts
git commit -m "test(dispatcher): add end-to-end workflow replace drain scenario"
```

---

## Self-Review Notes

- **Spec coverage:** §3.1 (Task 1), §3.2 (Task 2), §3.3 (Tasks 11-12), §4 (Tasks 3-9), §5 (Task 10), §6.1 (Task 14), §6.2 (Task 16), §6.3 (Task 14), §7 non-goals (no tasks needed — verified nothing in Tasks 1-17 builds rollback, a concurrent-drain path, or a force-override, matching the spec's explicit exclusions), §8 testing (Tasks 3, 10, 14, 15, 17 each add the specific test scenarios listed).
- **Placeholder scan:** Task 16 Step 2's `<pre>` block is explicitly flagged as not-final in its own step text, with a concrete instruction (read `WorkflowUploadModal.tsx` in full, reuse its actual components) rather than left as a silent gap — this is a deliberate, named exception to the no-placeholder rule for one sub-component of one UI task, not a systemic gap. Task 17's `processTryonDirectJob` call signature is explicitly flagged as needing verification against the real function before the test can compile, for the same reason: it wasn't independently re-verified against `comfy-mock.ts` during plan-writing. Both are called out inline rather than presented as finished.
- **Type consistency:** `dispatchTemplateVersion` (job_inputs.params field), `resolveWorkflowTemplateVersion` (function name), `workflowTemplateArchives`/`workflow_template_archives` (table), and `maybeCleanupArchive` are spelled identically everywhere they appear across Tasks 3-15.
