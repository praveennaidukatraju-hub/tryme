# Mapped-Template Pose Prompt Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins set a custom garment-phase prompt override on a `(catalogue-template-mapping × pose)` workflow assignment, and have the dispatcher use it instead of always falling back to the assigned workflow's hardcoded default prompt.

**Architecture:** Add a nullable `promptGarmentPhase` column to `catalogue_template_pose_workflows`, mirroring the existing `pose_garment_configs.promptGarmentPhase` override mechanism. Thread it through the admin config API, the job-creation snapshot (`job_inputs.params`), and the dispatcher's already-existing snapshot-precedence branch, then expose it in the "Configure workflows" admin modal.

**Tech Stack:** Drizzle ORM/Postgres, Fastify 5 + Zod, Vitest integration tests (real Postgres via `apps/api/test/helpers/containers.ts`), React (admin-web).

**Spec:** `docs/superpowers/specs/2026-07-14-mapped-template-pose-prompt-override-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/models.ts` | Add `promptGarmentPhase` column to `catalogueTemplatePoseWorkflows` |
| `packages/db/src/migrations/0108_*.sql` (generated) | Migration for the new column |
| `apps/api/src/modules/admin/subcategories.routes.ts` | GET/PATCH pose-workflow endpoints read/write the new column |
| `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts` | Covers PATCH set/preserve/clear semantics |
| `apps/api/src/modules/jobs/create.ts` | Snapshot `promptGarmentPhase` into `job_inputs.params` for mapped-template jobs |
| `apps/api/test/integration/jobs-create-looks.test.ts` | Covers the snapshot landing in `job_inputs.params` |
| `apps/dispatcher/src/job/processor.ts` | Read the snapshot instead of hardcoding `null` |
| `apps/admin-web/src/types.ts` | `MappedTemplatePoseWorkflow` gains `promptGarmentPhase` |
| `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx` | `MappedTemplateWorkflowModal` gains an inline prompt editor per pose row |

---

### Task 1: Schema + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts:262-285` (`catalogueTemplatePoseWorkflows` table)
- Create: `packages/db/src/migrations/0108_<generated>.sql` (name chosen by `drizzle-kit`)

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/models.ts`, inside the `catalogueTemplatePoseWorkflows` table definition, add `promptGarmentPhase` immediately after `workflowTemplateId`:

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

`text` is already imported in this file (used by `poseGarmentConfigs.promptGarmentPhase` at line 167) — no new import needed.

- [ ] **Step 2: Generate the migration**

Ensure Postgres is up (`pnpm docker:up` if not already running), then run:

```bash
pnpm db:generate
```

This creates a new file `packages/db/src/migrations/0108_<random-name>.sql` (drizzle-kit picks the name) and a matching `packages/db/src/migrations/meta/0108_snapshot.json`, and appends an `idx: 108` entry to `packages/db/src/migrations/meta/_journal.json`.

Expected SQL content (verify it matches, single `ALTER TABLE`, no other changes):

```sql
ALTER TABLE "catalogue_template_pose_workflows" ADD COLUMN "prompt_garment_phase" text;
```

If drizzle-kit generates anything beyond this single statement, stop and re-check that `packages/db/src/schema/models.ts` has no other uncommitted diffs beyond the one column addition.

- [ ] **Step 3: Apply the migration**

```bash
pnpm db:migrate
```

Expected: no errors; the new column exists. Verify:

```bash
docker exec -it tryme-postgres psql -U postgres -d tryme -c "\d catalogue_template_pose_workflows"
```

(Adjust container/db name if your local compose uses different ones — check `infra/docker-compose.yml` if the exec fails.) Expected: `prompt_garment_phase | text |` appears in the column list.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/0108_*.sql packages/db/src/migrations/meta/0108_snapshot.json packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add promptGarmentPhase override to catalogue_template_pose_workflows"
```

---

### Task 2: Admin API — read/write the prompt override

**Files:**
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts:417-546`
- Test: `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test at the end of the `describe('admin garment-type <-> catalogue-template mapping', ...)` block in `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`, right before the closing `});` that currently follows the `'configures a separate workflow per pose for each garment-template mapping'` test (i.e. after line 272's closing `});`, before line 273's `});`):

```ts
  it('PATCH sets, preserves, and clears the prompt override independently of the workflow', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Prompt override pose',
        genderSlug: 'men',
        r2Key: 'prompt-override-pose.jpg',
        thumbnailKey: 'prompt-override-pose-thumb.jpg',
        scope: 'template',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Prompt override background',
        r2Key: 'prompt-override-background.jpg',
        thumbnailKey: 'prompt-override-background-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: templateA.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `prompt-override-workflow-${Date.now()}`,
        label: 'Prompt override workflow',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();

    const mapResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    const mappingId = mapResponse.json().mappingId as string;

    // Set workflow + prompt together.
    const setResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id, promptGarmentPhase: 'a custom prompt' },
    });
    expect(setResponse.statusCode).toBe(200);

    let getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0]).toMatchObject({
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a custom prompt',
    });

    // A workflow-only PATCH (promptGarmentPhase omitted) must NOT clobber the saved prompt.
    const workflowOnlyResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id },
    });
    expect(workflowOnlyResponse.statusCode).toBe(200);

    getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0].promptGarmentPhase).toBe('a custom prompt');

    // Explicit null clears it.
    const clearResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id, promptGarmentPhase: null },
    });
    expect(clearResponse.statusCode).toBe(200);

    getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0].promptGarmentPhase).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- catalogue-template-subcategories-admin
```

Expected: FAIL — `promptGarmentPhase` is `undefined` in the GET response (the route doesn't select or persist it yet), so the first `toMatchObject` assertion fails.

- [ ] **Step 3: Implement — GET endpoint returns the override**

In `apps/api/src/modules/admin/subcategories.routes.ts`, in the `GET /admin/assets/catalogue-template-mappings/:mappingId/poses` handler (starts at line 417), add `promptGarmentPhase` to the select and the mapped response:

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
        .from(schema.catalogueTemplateLooks)
        .innerJoin(
          schema.modelPoseAssets,
          eq(schema.catalogueTemplateLooks.poseAssetId, schema.modelPoseAssets.id),
        )
        .leftJoin(
          schema.catalogueTemplatePoseWorkflows,
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
            eq(
              schema.catalogueTemplatePoseWorkflows.poseAssetId,
              schema.catalogueTemplateLooks.poseAssetId,
            ),
          ),
        )
        .where(eq(schema.catalogueTemplateLooks.templateId, mapping.templateId))
        .orderBy(asc(schema.modelPoseAssets.sortOrder), asc(schema.modelPoseAssets.label));

      return {
        items: poses.map((pose) => ({
          id: pose.id,
          label: pose.label,
          displayName: pose.displayName,
          workflowTemplateId: pose.workflowTemplateId,
          promptGarmentPhase: pose.promptGarmentPhase,
          thumbnailUrl: app.storage.publicUrl(pose.thumbnailKey),
        })),
      };
```

- [ ] **Step 4: Implement — PATCH endpoint accepts and persists the override**

In the same file, replace the `PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId` handler (lines 470-545) with:

```ts
  app.patch(
    '/admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId',
    {
      preHandler: RW,
      schema: {
        params: z.object({
          mappingId: z.string().uuid(),
          poseAssetId: z.string().uuid(),
        }),
        body: z.object({
          workflowTemplateId: z.string().uuid().nullable(),
          promptGarmentPhase: z.string().nullable().optional(),
        }),
      },
    },
    async (req) => {
      const { mappingId, poseAssetId } = req.params as {
        mappingId: string;
        poseAssetId: string;
      };
      const body = req.body as { workflowTemplateId: string | null; promptGarmentPhase?: string | null };
      const { workflowTemplateId } = body;

      const [validPose] = await app.db
        .select({ id: schema.catalogueTemplateLooks.id })
        .from(schema.catalogueTemplateSubcategories)
        .innerJoin(
          schema.catalogueTemplateLooks,
          and(
            eq(
              schema.catalogueTemplateLooks.templateId,
              schema.catalogueTemplateSubcategories.templateId,
            ),
            eq(schema.catalogueTemplateLooks.poseAssetId, poseAssetId),
          ),
        )
        .where(eq(schema.catalogueTemplateSubcategories.id, mappingId))
        .limit(1);
      if (!validPose) {
        throw new AppError('NOT_FOUND', 404, 'pose does not belong to this template mapping');
      }

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

      // `promptGarmentPhase` absent from the body means "leave it untouched" (the
      // workflow-<select>'s own PATCH calls never send it) — only update it on
      // conflict when the key was actually present in the request.
      const hasPromptKey = 'promptGarmentPhase' in body;
      const updateSet: { workflowTemplateId: string; updatedAt: Date; promptGarmentPhase?: string | null } =
        { workflowTemplateId, updatedAt: new Date() };
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
    },
  );
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- catalogue-template-subcategories-admin
```

Expected: PASS, all tests in the file including the new one.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/subcategories.routes.ts apps/api/test/integration/catalogue-template-subcategories-admin.test.ts
git commit -m "feat(admin): support per-pose prompt override on catalogue-template workflow mappings"
```

---

### Task 3: Job creation — snapshot the prompt override

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:258-266, 323-329, 471-477`
- Test: `apps/api/test/integration/jobs-create-looks.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the existing `'validates a mapped template and snapshots its per-pose workflow into the job'` test in `apps/api/test/integration/jobs-create-looks.test.ts`. Change the `catalogueTemplatePoseWorkflows` insert (currently at lines 199-203) to include a prompt override, and extend the final assertion (lines 229-232):

```ts
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: poseAId,
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a mapped-template custom prompt',
    });
```

```ts
    expect(inputs?.params).toMatchObject({
      catalogueTemplateMappingId: mapping.id,
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a mapped-template custom prompt',
    });
```

Also add a new test right after it (before the `'rejects duplicate (poseId, backgroundId) pairs...'` test) asserting the key is absent when no override is configured:

```ts
  it('omits promptGarmentPhase from the snapshot when no override is configured', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-mapped-no-prompt@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `mapped-shirt-noprompt-${poseAId}`, label: 'Mapped shirt' })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Mapped template no prompt' })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: poseAId,
      backgroundId: bgAId,
    });
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `mapped-job-workflow-noprompt-${poseAId}`,
        label: 'Mapped job workflow no prompt',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: poseAId,
      workflowTemplateId: workflow.id,
    });
    const garmentKey = `inputs/${userId}/garment-noprompt.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          catalogueTemplateMappingId: mapping.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, response.json().jobIds[0]));
    expect(inputs?.params).not.toHaveProperty('promptGarmentPhase');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: FAIL on the extended `'validates a mapped template...'` test — `params.promptGarmentPhase` is `undefined`, not `'a mapped-template custom prompt'`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/jobs/create.ts`, add `promptGarmentPhase` to the `mappingPoseWorkflows` select (inside the block starting at line 248):

```ts
        const rows = await app.db
          .select({
            poseId: schema.catalogueTemplateLooks.poseAssetId,
            backgroundId: schema.catalogueTemplateLooks.backgroundId,
            workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
            promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
            sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
          })
```

Carry it through the returned per-pose objects (the `distinctPoseIds.map(...)` block):

```ts
        const byPose = new Map(rows.map((row) => [row.poseId, row]));
        return distinctPoseIds.map((poseId) => {
          const row = byPose.get(poseId);
          if (!row) {
            throw new AppError('BAD_CATALOG', 400, 'workflow not configured for template pose');
          }
          return {
            poseId,
            workflowTemplateId: row.workflowTemplateId,
            promptGarmentPhase: row.promptGarmentPhase,
            lowerNodeId: row.lowerNodeId,
            shoeNodeId: row.shoeNodeId,
            sizeNodeIds: row.sizeNodeIds,
          };
        });
```

Then update the `params` snapshot block (currently lines 471-476):

```ts
          ...(catalogueTemplateMappingId
            ? {
                catalogueTemplateMappingId,
                workflowTemplateId: pw?.workflowTemplateId,
                ...(pw?.promptGarmentPhase ? { promptGarmentPhase: pw.promptGarmentPhase } : {}),
              }
            : {}),
```

Note: use a conditional spread (not `?? undefined`) for `promptGarmentPhase` — `Record<string, unknown>` values set to `undefined` still show up as an own-enumerable key when the object is JSON-serialized into the JSONB column in some drivers, which would break the `not.toHaveProperty('promptGarmentPhase')` assertion from Step 1's second test. The conditional spread omits the key entirely when there's no override, matching how `aspectRatio` and `platform` are already handled a few lines above in this same object.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- jobs-create-looks
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/jobs-create-looks.test.ts
git commit -m "feat(jobs): snapshot mapped-template pose prompt override into job_inputs.params"
```

---

### Task 4: Dispatcher — consume the snapshotted prompt

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:208-217`

- [ ] **Step 1: Implement**

In `apps/dispatcher/src/job/processor.ts`, replace the current snapshot-precedence block:

```ts
  const snapshottedWorkflowTemplateId =
    typeof rawParams.workflowTemplateId === 'string' ? rawParams.workflowTemplateId : null;
  if (snapshottedWorkflowTemplateId) {
    effectiveWorkflowTemplateId = snapshottedWorkflowTemplateId;
    effectivePromptFacePhase = null;
    effectivePromptGarmentPhase = null;
  } else if (inputs.garmentTypeId) {
```

with:

```ts
  const snapshottedWorkflowTemplateId =
    typeof rawParams.workflowTemplateId === 'string' ? rawParams.workflowTemplateId : null;
  if (snapshottedWorkflowTemplateId) {
    effectiveWorkflowTemplateId = snapshottedWorkflowTemplateId;
    effectivePromptFacePhase = null;
    effectivePromptGarmentPhase =
      typeof rawParams.promptGarmentPhase === 'string' ? rawParams.promptGarmentPhase : null;
  } else if (inputs.garmentTypeId) {
```

`effectivePromptFacePhase` stays hardcoded `null` for mapped-template jobs — no face-phase override exists on `catalogue_template_pose_workflows` (see spec's "Confirmed decisions"), so this line is unchanged from before.

This mirrors the pre-existing `pose_garment_configs` branch three lines below it (`if (cfgRow.promptGarmentPhase) effectivePromptGarmentPhase = cfgRow.promptGarmentPhase;`) — same "only override when a real string is present" semantics, just reading from the job's own snapshot instead of a live table lookup.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/dispatcher typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the dispatcher integration suite to confirm no regression**

```bash
pnpm --filter @tryme/dispatcher test
```

Expected: all existing tests pass unchanged (this is a 2-line mechanical change to an already-covered code path — `happy-path.test.ts` exercises `processJob` end-to-end; no test currently isolates the prompt-selection branch specifically, matching how the sibling `workflowTemplateId` override added in the same block was verified — via the API-layer snapshot test from Task 3, not a dedicated dispatcher unit test).

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): honor mapped-template pose prompt override instead of always nulling it"
```

---

### Task 5: Admin UI — prompt editor in the "Configure workflows" modal

**Files:**
- Modify: `apps/admin-web/src/types.ts:104-110`
- Modify: `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx:944-1099` (`MappedTemplateWorkflowModal`)

- [ ] **Step 1: Update the type**

In `apps/admin-web/src/types.ts`, update `MappedTemplatePoseWorkflow`:

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

- [ ] **Step 2: Add per-row prompt editing state and save handler**

In `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`, inside `MappedTemplateWorkflowModal` (starting at line 952), add state for which row's prompt editor is open and its draft text, plus a save handler. Replace the component body's opening (lines 959-961) with:

```ts
function MappedTemplateWorkflowModal({
  mapping,
  garmentTypeLabel,
  workflows,
  toast,
  onClose,
}: MappedTemplateWorkflowModalProps) {
  const [items, setItems] = useState<MappedTemplatePoseWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
```

Add the prompt-editing handlers right after the existing `setWorkflow` function (after line 1004's closing `};`):

```ts
  const openPromptEditor = (item: MappedTemplatePoseWorkflow) => {
    const assignedWorkflow = workflows.find((w) => w.id === item.workflowTemplateId);
    setPromptDraft(item.promptGarmentPhase ?? assignedWorkflow?.defaultGarmentPhasePrompt ?? '');
    setEditingPromptId(item.id);
  };

  const closePromptEditor = () => {
    setEditingPromptId(null);
    setPromptDraft('');
  };

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

- [ ] **Step 3: Render the prompt toggle and inline editor per row**

Replace the row rendering (lines 1036-1082, the `items.map((item) => (...))` block) with:

```tsx
              {items.map((item) => (
                <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div
                    className="card"
                    style={{
                      padding: 10,
                      display: 'grid',
                      gridTemplateColumns: '58px minmax(140px, 1fr) minmax(220px, 1.4fr) auto',
                      alignItems: 'center',
                      gap: 12,
                      outline: item.workflowTemplateId ? '1px solid var(--pink)' : undefined,
                      opacity: savingId === item.id ? 0.65 : 1,
                    }}
                  >
                    {/* biome-ignore lint/performance/noImgElement: admin panel */}
                    <img
                      src={item.thumbnailUrl}
                      alt={item.displayName ?? item.label}
                      style={{ width: 58, height: 68, borderRadius: 8, objectFit: 'cover' }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 650 }}>
                        {item.displayName ?? item.label}
                      </p>
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
                    </div>
                    <select
                      className="select"
                      aria-label={`Workflow for ${item.displayName ?? item.label}`}
                      value={item.workflowTemplateId ?? ''}
                      disabled={savingId === item.id}
                      onChange={(event) => void setWorkflow(item.id, event.target.value || null)}
                    >
                      <option value="">Select workflow...</option>
                      {workflows.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn sm ghost"
                      disabled={!item.workflowTemplateId || savingId === item.id}
                      onClick={() =>
                        editingPromptId === item.id ? closePromptEditor() : openPromptEditor(item)
                      }
                    >
                      <Icon.MessageSquare /> Prompt
                    </button>
                  </div>
                  {editingPromptId === item.id && (
                    <div className="card" style={{ padding: 10 }}>
                      <div className="field">
                        <label>Garment-phase prompt override</label>
                        <textarea
                          className="input"
                          rows={6}
                          placeholder="Inherited from workflow default"
                          value={promptDraft}
                          disabled={savingId === item.id}
                          onChange={(e) => setPromptDraft(e.target.value)}
                          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
                        />
                        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>
                          Used only for this pose within this template/garment-type mapping. Leave
                          blank to use the assigned workflow's own default prompt.
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                        <button
                          className="btn sm ghost"
                          disabled={savingId === item.id}
                          onClick={closePromptEditor}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn sm primary"
                          disabled={savingId === item.id}
                          onClick={() => void savePrompt(item.id)}
                        >
                          {savingId === item.id ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
```

`Icon.MessageSquare` already exists in `apps/admin-web/src/components/icons.tsx:237` — no new icon needed.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @tryme/admin typecheck
```

Expected: no errors.

- [ ] **Step 5: Manual verification**

```bash
pnpm --filter @tryme/admin dev
```

Navigate to Assets → Garment Types → pick a type → "Setup" → "1. Catalogue templates" → a mapped template's "Configure workflows". For a pose with a workflow assigned:
1. Click "Prompt" — a textarea appears, pre-filled with the assigned workflow's default prompt (since no override is set yet).
2. Type a custom prompt, click "Save" — toast confirms, "Custom prompt" badge appears next to "Ready".
3. Reopen the modal (close and re-click "Configure workflows") — the saved prompt persists and pre-fills the textarea when "Prompt" is clicked again.
4. Change the workflow `<select>` to a different workflow — confirm the saved prompt override is untouched (still shows in the badge/textarea), since the workflow-only PATCH must not clobber it.
5. Clear the textarea and click "Save" — "Custom prompt" badge disappears.

Screenshot each state if using an automated browser check; otherwise describe what you observed at each step.

- [ ] **Step 6: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/assets/GarmentTypesTab.tsx
git commit -m "feat(admin-web): add per-pose prompt override editor to mapped-template workflow modal"
```

---

### Task 6: Full verification pass + progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Run the full API test suite**

```bash
pnpm --filter @tryme/api test
```

Expected: all tests pass (if a `429 Rate limit exceeded` failure appears on an unrelated auth-registration test, that's a known pre-existing shared-rate-limiter flake from running many tests back-to-back — wait ~25s and re-run that single file in isolation to confirm it's not a real regression before treating it as a failure).

- [ ] **Step 2: Typecheck everything touched**

```bash
pnpm --filter @tryme/db typecheck
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/dispatcher typecheck
pnpm --filter @tryme/admin typecheck
```

Expected: no errors in any package.

- [ ] **Step 3: `git diff --check`**

```bash
git diff --check HEAD~6
```

(Adjust the range if more/fewer commits were made than the 6 in this plan.) Expected: no whitespace errors.

- [ ] **Step 4: Update the progress log**

Add a new dated entry at the top of `docs/progress.md` (check the file's existing entries for the exact heading style used) summarizing: added `promptGarmentPhase` override to `catalogue_template_pose_workflows`, threaded through admin API, job-creation snapshot, and dispatcher precedence, plus an inline editor in the "Configure workflows" modal — fixes the gap where mapped-template jobs always discarded the pose's custom prompt in favor of the assigned workflow's hardcoded default.

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs(progress): log mapped-template pose prompt override feature"
```

---

## Self-Review

**Spec coverage:**
- §1 Data model (nullable `promptGarmentPhase` column, no `promptFacePhase`) → Task 1.
- §2 Admin API (GET returns it, PATCH accepts/preserves/clears it) → Task 2.
- §3 Job creation snapshot → Task 3.
- §4 Dispatcher precedence → Task 4.
- §5 Admin UI (toggle, pre-fill from assigned workflow's default, explicit Save, badge) → Task 5.
- §6 Testing (admin API PATCH semantics, job-creation snapshot presence/absence) → Tasks 2 and 3.
- "Out of scope" items (no `promptFacePhase`, no change to `pose_garment_configs` flow, no bulk-apply) → correctly excluded from every task above.

**Placeholder scan:** No TBD/TODO markers; every code step shows complete, concrete code including exact prior context for replacements.

**Type consistency:** `promptGarmentPhase: string | null` used consistently across the Drizzle column (Task 1), the Zod body schema and DB select/insert (Task 2), the `mappingPoseWorkflows` return shape and job snapshot (Task 3), `rawParams.promptGarmentPhase` read in the dispatcher (Task 4), and `MappedTemplatePoseWorkflow.promptGarmentPhase` in the admin UI (Task 5) — no naming drift.
