# Flexible Workflow Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload ComfyUI workflows for lower-wear/inner-wear-only generation and let the job-creation API run them safely end-to-end — generation, regeneration, and every surface that displays a job's source garment — without ever submitting `undefined` to ComfyUI, silently generating a wrong-garment output, leaking a claimed GPU worker, or crashing a page on a null field.

**Architecture:** Relax `workflow_templates`/`job_inputs` nullability, then thread "which roles does this specific resolved workflow actually declare" through every layer: admin validation (create + PATCH, including the schema constraints that block PATCH from ever producing the new shape), admin UI (including a payload field Revision 2 missed), job-creation cross-validation (including the hero-vs-accessory distinction for catalog-picked lower items, and per-pose stripping of irrelevant garment keys), dispatcher patching (fail closed, and release the worker it claimed on that failure), regeneration (fixing two pre-existing bugs this feature's scope now requires working — a 24h ownership TTL and lost mapping context), and three read surfaces (catalogue history, ops results, and `/v1/assets`, the last of which crashes today without this fix).

**Tech Stack:** Drizzle ORM/Postgres, Fastify 5 + Zod, Vitest integration tests, Vitest unit tests for the dispatcher patcher, React (admin-web, catalogues-web).

**Spec:** `docs/superpowers/specs/2026-07-14-flexible-workflow-roles-design.md` (Revision 3 — read this first).

**Revision history:** Revision 1 of this plan was reviewed and found to have 8 blocking gaps; Revision 2 fixed those but introduced/left 10 more (a TypeScript error, an incomplete UI fix, a worker-leak risk, a crash in `/v1/assets`, and others). This is Revision 3, incorporating all fixes from both review rounds.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/models.ts` | Relax `workflow_templates.faceNodeId`/`bgNodeId`/`facePhasePromptNode` to nullable |
| `packages/db/src/schema/jobs.ts` | Relax `job_inputs.upperGarmentKey` to nullable |
| `packages/db/src/migrations/01NN_*.sql` (generated) | Migration for both relaxations |
| `packages/types/src/admin.ts` | `CreateWorkflowBody` floor + `upperNodeIds` min-length; `UpdateWorkflowBody.upperNodeIds` min-length |
| `packages/types/src/jobs.ts` | `CreateTryOnJobInputs.upperGarmentKey` optional |
| `apps/api/src/modules/admin/workflows.routes.ts` | POST conditional validation + `extractDefaultPrompts` split; PATCH merge-then-validate |
| `apps/api/test/integration/admin-workflows.test.ts` (new) | Covers POST/PATCH floor + merge-validation |
| `apps/admin-web/src/components/WorkflowUploadModal.tsx` | Client-side validation + payload construction (including `facePhasePromptNode`) |
| `apps/api/src/modules/jobs/create.ts` | Per-pose `upperNodeIds` cross-validation, hero-vs-accessory lower check, `trustedGarmentKeys` param, per-pose upper-key stripping |
| `apps/api/src/lib/upload-ownership.ts` (new, extracted from `create.ts`) | `assertOwnsUploadKey` + `assertGarmentObjectValid` |
| `apps/api/test/integration/jobs-create-looks.test.ts` | Covers upper-required, lower-hero-requires-upload, mixed-role stripping |
| `apps/dispatcher/src/workflow/patcher.ts` | Fail closed on any mapped-but-unfulfilled role |
| `apps/dispatcher/src/workflow/patcher.test.ts` | Covers the new throw behavior |
| `apps/dispatcher/src/job/processor.ts` | Conditional uploads; catch the new throw, release the worker, route to `markFailed` |
| `apps/api/src/modules/jobs/regenerate.ts` | Drop upper requirement; type fix; trusted-key authorization; preserve mapping context |
| `apps/api/test/integration/regenerate.test.ts` | Covers lower-only regen, mapped-template regen, regen past the 24h TTL |
| `apps/api/src/modules/jobs/routes.ts` | `/v1/catalogues/:id` hero resolution; `/v1/assets` surfaces both upper and lower uploads without crashing |
| `apps/catalogues-web/src/app/(app)/assets/page.tsx` | Defensive null-guard on `r2Key` |
| `apps/api/src/modules/results/routes.ts` | Ops dashboard select includes `lowerGarmentKey` |
| `docs/progress.md` | Log entry |

---

### Task 1: Schema — nullable columns + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts:88-106` (`workflowTemplates` table)
- Modify: `packages/db/src/schema/jobs.ts:56` (`jobInputs` table)
- Create: `packages/db/src/migrations/01NN_<generated>.sql`

- [ ] **Step 1:** In `packages/db/src/schema/models.ts`, remove `.notNull()` from `faceNodeId`, `bgNodeId`, and `facePhasePromptNode`:

```ts
  faceNodeId: text('face_node_id'),
  // ...
  bgNodeId: text('bg_node_id'),
  // ...
  facePhasePromptNode: text('face_phase_prompt_node'),
```

Leave `poseNodeId`, `garmentPhasePromptNode`, `upperNodeIds` untouched.

- [ ] **Step 2:** In `packages/db/src/schema/jobs.ts`, remove `.notNull()` from `upperGarmentKey`:

```ts
  upperGarmentKey: text('upper_garment_key'),
```

- [ ] **Step 3:** Generate and apply:

```bash
pnpm docker:up
pnpm db:generate
```

Expected: a new `packages/db/src/migrations/01NN_<name>.sql` (check `packages/db/src/migrations/meta/_journal.json`'s last `idx` first — 0108 at time of writing) with exactly four `ALTER TABLE ... DROP NOT NULL` statements.

```bash
pnpm db:migrate
```

- [ ] **Step 4:** Typecheck and commit:

```bash
pnpm --filter @tryme/db typecheck
git add packages/db/src/schema/models.ts packages/db/src/schema/jobs.ts packages/db/src/migrations/01NN_*.sql packages/db/src/migrations/meta/
git commit -m "feat(db): relax workflow_templates and job_inputs for lower/inner-only workflows"
```

---

### Task 2: Zod validation — `packages/types`

**Files:**
- Modify: `packages/types/src/admin.ts:158-212` (`CreateWorkflowBody`), `:219-244` (`UpdateWorkflowBody`)
- Modify: `packages/types/src/jobs.ts:36-63` (`CreateTryOnJobInputs`)

- [ ] **Step 1:** In `packages/types/src/admin.ts`, replace `CreateWorkflowBody`'s `superRefine` (lines 191-212):

```ts
  .superRefine((val, ctx) => {
    if (val.workflowType === 'tryon') {
      for (const field of ['facePhasePromptNode', 'garmentPhasePromptNode'] as const) {
        if (!val[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for tryon workflows`,
          });
        }
      }
      return;
    }
    if (!val.poseNodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poseNodeId'],
        message: 'poseNodeId is required for regular workflows',
      });
    }
    if (!val.garmentPhasePromptNode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['garmentPhasePromptNode'],
        message: 'garmentPhasePromptNode is required for regular workflows',
      });
    }
    const hasUpper = (val.upperNodeIds?.length ?? 0) > 0;
    const hasLower = !!val.lowerNodeId;
    if (!hasUpper && !hasLower) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['upperNodeIds'],
        message: 'at least one garment role (upperNodeIds or lowerNodeId) is required',
      });
    }
    if (val.faceNodeId && !val.facePhasePromptNode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['facePhasePromptNode'],
        message: 'facePhasePromptNode is required when faceNodeId is set',
      });
    }
  });
```

Change `upperNodeIds` from `.min(1)` to no minimum:

```ts
    upperNodeIds: z.array(z.string().min(1)).max(8).optional(),
```

- [ ] **Step 2 (Revision 3 fix — Finding 10):** In the same file, find `UpdateWorkflowBody` (currently around line 232) and change:

```ts
  upperNodeIds: z.array(z.string().min(1)).min(1).max(8).optional(),
```

to:

```ts
  upperNodeIds: z.array(z.string().min(1)).max(8).optional(),
```

Without this, Task 4's PATCH merge-validation logic can never actually observe `upperNodeIds: []` — Zod rejects the request body before the handler runs, making the "convert an existing workflow to lower-only via PATCH" transition permanently impossible even though the merge-validation logic is designed to allow it.

- [ ] **Step 3:** In `packages/types/src/jobs.ts`, change:

```ts
export const CreateTryOnJobInputs = z
  .object({
    upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY),
```

to:

```ts
export const CreateTryOnJobInputs = z
  .object({
    upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
```

Do not add a request-level "at least one of upper/lower" refine — Task 6's per-pose check supersedes it.

- [ ] **Step 4:** Typecheck and commit:

```bash
pnpm --filter @tryme/types typecheck
git add packages/types/src/admin.ts packages/types/src/jobs.ts
git commit -m "feat(types): relax workflow and job-creation validation for optional garment roles"
```

---

### Task 3: Admin workflow POST route — conditional validation

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts:62-73` (`extractDefaultPrompts`), `:277-` (regular-workflow insert block)

- [ ] **Step 1 (Revision 3 fix — Finding 6):** `extractDefaultPrompts` (lines 62-73) takes a non-optional `negativePromptNode: string` and cannot be called when there is no face-phase-prompt node. Replace its single combined call site (inside the regular-workflow branch, after node validation) with two independent computations. Find where it's currently called (search for `extractDefaultPrompts(body.jsonContent` inside the non-tryon branch) and replace:

```ts
        const { defaultFacePhasePrompt, defaultGarmentPhasePrompt } = extractDefaultPrompts(
          body.jsonContent,
          facePhasePromptNode,
          garmentPhasePromptNode,
        );
```

with:

```ts
        const garmentNode = body.jsonContent[garmentPhasePromptNode] as
          | { inputs?: { prompt?: unknown } }
          | undefined;
        const defaultGarmentPhasePrompt =
          typeof garmentNode?.inputs?.prompt === 'string' ? garmentNode.inputs.prompt : '';
        let defaultFacePhasePrompt = '';
        if (body.facePhasePromptNode) {
          const faceNode = body.jsonContent[body.facePhasePromptNode] as
            | { inputs?: { prompt?: unknown } }
            | undefined;
          defaultFacePhasePrompt =
            typeof faceNode?.inputs?.prompt === 'string' ? faceNode.inputs.prompt : '';
        }
```

(This inlines the same extraction `extractDefaultPrompts`/`extractPromptText` already do — check the actual `extractPromptText` helper's exact logic before writing this, and call it directly instead of re-deriving it inline if it's exported/reachable, to avoid duplicating logic: `const defaultGarmentPhasePrompt = extractPromptText(body.jsonContent[garmentPhasePromptNode] as WorkflowNode | undefined);` and similarly for face, guarded by `body.facePhasePromptNode ? extractPromptText(...) : ''`.)

- [ ] **Step 2:** Replace the non-null-asserted block (currently lines 277-309):

```ts
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const faceNodeId = body.faceNodeId!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const poseNodeId = body.poseNodeId!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const bgNodeId = body.bgNodeId!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const upperNodeIds = body.upperNodeIds!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const facePhasePromptNode = body.facePhasePromptNode!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const garmentPhasePromptNode = body.garmentPhasePromptNode!;

      validateNodeExists(body.jsonContent, faceNodeId, 'face');
      validateNodeExists(body.jsonContent, poseNodeId, 'pose');
      validateNodeExists(body.jsonContent, bgNodeId, 'background');
      for (const uid of upperNodeIds) {
        validateNodeExists(body.jsonContent, uid, 'upper garment');
      }
      if (body.lowerNodeId) validateNodeExists(body.jsonContent, body.lowerNodeId, 'lower garment');
      if (body.shoeNodeId) validateNodeExists(body.jsonContent, body.shoeNodeId, 'shoes');
      for (const uid of body.sizeNodeIds ?? []) {
        validateNodeExists(body.jsonContent, uid, 'size');
      }
      validateNodeExists(body.jsonContent, facePhasePromptNode, 'negative prompt');
      validateNodeExists(body.jsonContent, garmentPhasePromptNode, 'positive prompt');

      validateNodeType(body.jsonContent, faceNodeId, 'image', 'face');
      validateNodeType(body.jsonContent, poseNodeId, 'image', 'pose');
      validateNodeType(body.jsonContent, bgNodeId, 'image', 'background');
```

with:

```ts
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const poseNodeId = body.poseNodeId!;
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
      const garmentPhasePromptNode = body.garmentPhasePromptNode!;
      const upperNodeIds = body.upperNodeIds ?? [];

      validateNodeExists(body.jsonContent, poseNodeId, 'pose');
      validateNodeType(body.jsonContent, poseNodeId, 'image', 'pose');
      if (body.faceNodeId) {
        validateNodeExists(body.jsonContent, body.faceNodeId, 'face');
        validateNodeType(body.jsonContent, body.faceNodeId, 'image', 'face');
      }
      if (body.bgNodeId) {
        validateNodeExists(body.jsonContent, body.bgNodeId, 'background');
        validateNodeType(body.jsonContent, body.bgNodeId, 'image', 'background');
      }
      for (const uid of upperNodeIds) {
        validateNodeExists(body.jsonContent, uid, 'upper garment');
      }
      if (body.lowerNodeId) validateNodeExists(body.jsonContent, body.lowerNodeId, 'lower garment');
      if (body.shoeNodeId) validateNodeExists(body.jsonContent, body.shoeNodeId, 'shoes');
      for (const uid of body.sizeNodeIds ?? []) {
        validateNodeExists(body.jsonContent, uid, 'size');
      }
      validateNodeExists(body.jsonContent, garmentPhasePromptNode, 'positive prompt');
      validateNodeType(body.jsonContent, garmentPhasePromptNode, 'prompt', 'positive prompt');
      if (body.facePhasePromptNode) {
        validateNodeExists(body.jsonContent, body.facePhasePromptNode, 'negative prompt');
        validateNodeType(body.jsonContent, body.facePhasePromptNode, 'prompt', 'negative prompt');
      }
```

Remove any now-duplicate `validateNodeType` calls further down that referenced the old asserted `faceNodeId`/`bgNodeId` consts. In the `.values({...})` insert call, change `faceNodeId,` → `faceNodeId: body.faceNodeId ?? null,`, `bgNodeId,` → `bgNodeId: body.bgNodeId ?? null,`, `facePhasePromptNode,` → `facePhasePromptNode: body.facePhasePromptNode ?? null,` (keep `upperNodeIds,` as-is — already defaults to `[]`), and use the Step 1 `defaultFacePhasePrompt`/`defaultGarmentPhasePrompt` locals in place of the old destructured ones.

- [ ] **Step 3:** Typecheck and commit:

```bash
pnpm --filter @tryme/api typecheck
git add apps/api/src/modules/admin/workflows.routes.ts
git commit -m "feat(admin): allow creating regular workflows with no face/background/upper role"
```

---

### Task 4: Admin workflow PATCH route — merge-then-validate

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts` (PATCH handler, starts at line 396)
- Test: `apps/api/test/integration/admin-workflows.test.ts` (new file)

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/integration/admin-workflows.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin workflows — floor validation', () => {
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

  const jsonContent = {
    pose_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'pose' } },
    lower_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'lower' } },
    positive_node: {
      inputs: { prompt: 'default' },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'positive_prompt' },
    },
  };

  it('creates a lower-only regular workflow with no face/background/upper node', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `lower_only_${Date.now()}`,
        label: 'Lower only',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.faceNodeId ?? null).toBeNull();
    expect(body.upperNodeIds).toEqual([]);
    expect(body.defaultFacePhasePrompt).toBe('');
  });

  it('rejects a regular workflow with neither upperNodeIds nor lowerNodeId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `no_garment_role_${Date.now()}`,
        label: 'No garment role',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects faceNodeId set without facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `face_no_prompt_${Date.now()}`,
        label: 'Face no prompt',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH rejects clearing the last garment role, and allows converting to lower-only', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `patch_target_${Date.now()}`,
        label: 'Patch target',
        jsonContent: {
          ...jsonContent,
          upper_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'upper' } },
        },
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        upperNodeIds: ['upper_node'],
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    // Clearing the only garment role outright must be rejected.
    const rejectRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { upperNodeIds: [] },
    });
    expect(rejectRes.statusCode).toBe(400);

    // Converting to lower-only by setting lowerNodeId AND clearing upperNodeIds in the
    // same request must succeed — this is the transition Task 2 Step 2's schema fix exists for.
    const convertRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { upperNodeIds: [], lowerNodeId: 'lower_node' },
    });
    expect(convertRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ upperNodeIds: schema.workflowTemplates.upperNodeIds, lowerNodeId: schema.workflowTemplates.lowerNodeId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.upperNodeIds).toEqual([]);
    expect(row?.lowerNodeId).toBe('lower_node');
  });
});
```

- [ ] **Step 2:** Run to verify it fails:

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/admin-workflows.test.ts --reporter=verbose
```

Expected: first three pass once Tasks 2/3 land; the 4th fails at both PATCH assertions (no merge-validation exists yet, and even once added, `upperNodeIds: []` alone in the reject-case PATCH would currently be schema-rejected before Task 2 Step 2 lands — confirm both fixes are in place before expecting this to pass).

- [ ] **Step 3: Implement merge-then-validate.** In the PATCH handler, after the existing per-field validation block and before `updateValues` construction:

```ts
      const mergedUpperNodeIds = body.upperNodeIds ?? existing.upperNodeIds;
      const mergedLowerNodeId =
        body.lowerNodeId !== undefined ? body.lowerNodeId : existing.lowerNodeId;
      const mergedFaceNodeId =
        body.faceNodeId !== undefined ? body.faceNodeId : existing.faceNodeId;
      const mergedFacePhasePromptNode =
        body.facePhasePromptNode !== undefined
          ? body.facePhasePromptNode
          : existing.facePhasePromptNode;

      if (existing.workflowType === 'regular') {
        const hasUpper = mergedUpperNodeIds.length > 0;
        const hasLower = !!mergedLowerNodeId;
        if (!hasUpper && !hasLower) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot clear the last garment role — at least one of upperNodeIds/lowerNodeId must remain set',
          );
        }
        if (mergedFaceNodeId && !mergedFacePhasePromptNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot leave faceNodeId set without facePhasePromptNode',
          );
        }
      }
```

- [ ] **Step 4:** Run to verify it passes; typecheck; commit:

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/admin-workflows.test.ts --reporter=verbose
pnpm --filter @tryme/api typecheck
git add apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/admin-workflows.test.ts
git commit -m "feat(admin): validate the merged workflow shape on PATCH, not just the patch body"
```

---

### Task 5: Admin UI — relax `WorkflowUploadModal.tsx`

**Files:**
- Modify: `apps/admin-web/src/components/WorkflowUploadModal.tsx:246-259` (`handleSubmit`), `:280-300` (payload construction)

- [ ] **Step 1:** Replace the validation block (lines 246-259):

```ts
    } else {
      if (!parsed) return;
      if (!poseNodeId || !positivePromptNode) {
        setError('Pose and positive prompt nodes are required');
        return;
      }
      if (faceNodeId && !negativePromptNode) {
        setError('Negative prompt node is required when a face node is set');
        return;
      }
      const validUpperIds = upperNodeIds.filter(Boolean);
      if (validUpperIds.length === 0 && !lowerNodeId) {
        setError(
          'At least one garment role is required — set an upper garment node or a lower garment node',
        );
        return;
      }
    }
```

- [ ] **Step 2 (Revision 3 fix — Finding 6):** In the payload construction (lines 280-300), change **both** of these — Revision 2 only fixed `faceNodeId`/`bgNodeId` and missed `facePhasePromptNode`, which still sends `''` unconditionally and fails Zod's `.min(1)` check when no face node is set:

```ts
          faceNodeId: faceNodeId || undefined,
          poseNodeId,
          bgNodeId: bgNodeId || undefined,
          upperNodeIds: validUpperIds,
          lowerNodeId: lowerNodeId || undefined,
          shoeNodeId: shoeNodeId || undefined,
          sizeNodeIds: sizeNodeIds.filter(Boolean),
          ...(latentSizeNodeIds.length === 2 ? { latentSizeNodeIds } : {}),
          ...(outputSizeNodeIds.length === 2 ? { outputSizeNodeIds } : {}),
          ...(resultNodeId ? { resultNodeId } : {}),
          facePhasePromptNode: negativePromptNode || undefined,
          garmentPhasePromptNode: positivePromptNode,
```

- [ ] **Step 3:** Add a discoverability hint near the face `NodeSelect` in the render body:

```tsx
<span style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginTop: 4 }}>
  Leave face and background blank for a lower/inner-wear-only workflow — at least one of
  upper or lower garment node is still required.
</span>
```

- [ ] **Step 4:** Typecheck, lint, manual check:

```bash
cd apps/admin-web && pnpm exec tsc --noEmit
pnpm --filter @tryme/admin lint
pnpm --filter @tryme/admin dev
```

Create a lower-only workflow through the UI (no face/background nodes) end to end and confirm it saves without a Zod validation error surfacing for `facePhasePromptNode`.

- [ ] **Step 5:** Commit:

```bash
git add apps/admin-web/src/components/WorkflowUploadModal.tsx
git commit -m "feat(admin-web): allow uploading lower/inner-only workflows through the create form"
```

---

### Task 6: Job creation — garment-slot cross-validation, hero-vs-accessory, per-pose stripping

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts` (multiple sections — see steps)
- Test: `apps/api/test/integration/jobs-create-looks.test.ts`

- [ ] **Step 1: Write the failing tests.** Add to `apps/api/test/integration/jobs-create-looks.test.ts` (reuse the file's existing `seedFaceAndTwoBackgrounds`/`seedTwoPoses`/`registerUser`/`grantCredits`/`bindUploadKey`/`seedCreditPlan` helpers — verify exact names at the top of the file first):

```ts
  it('rejects a lower-only submission against a pose whose workflow requires an upper garment', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-upper-required@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `upper-required-${poseAId}`, label: 'Upper required' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `upper-required-workflow-${poseAId}`,
        label: 'Upper required workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const garmentKey = `inputs/${userId}/lower-only.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          lowerGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a lowerCatalogId as the sole hero for a lower-primary workflow', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-catalog-hero-rejected@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `catalog-hero-rejected-${poseAId}`, label: 'Catalog hero rejected' })
      .returning();
    const [catalogType] = await app.db
      .insert(schema.catalogTypes)
      .values({ slug: `lower-${poseAId}`, label: 'Lower' })
      .returning();
    const [category] = await app.db
      .insert(schema.catalogCategories)
      .values({ typeId: catalogType.id, slug: `pants-${poseAId}`, label: 'Pants' })
      .returning();
    const [catalogItem] = await app.db
      .insert(schema.catalogItems)
      .values({
        typeId: catalogType.id,
        categoryId: category.id,
        genderSlug: 'men',
        label: 'Test pants',
        r2Key: 'catalog/pants.jpg',
        thumbnailKey: 'catalog/pants-thumb.jpg',
      })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `lower-primary-catalog-${poseAId}`,
        label: 'Lower primary catalog test',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: [],
        lowerNodeId: '7',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          faceId,
          garmentTypeId: garmentType.id,
          lowerCatalogId: catalogItem.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('strips an irrelevant upper garment key from a lower-only job row', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-strip-upper@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `strip-upper-${poseAId}`, label: 'Strip upper' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `strip-upper-workflow-${poseAId}`,
        label: 'Strip upper workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: [],
        lowerNodeId: '7',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const upperKey = `inputs/${userId}/irrelevant-upper.jpg`;
    const lowerKey = `inputs/${userId}/actual-lower.jpg`;
    await bindUploadKey(userId, upperKey);
    await bindUploadKey(userId, lowerKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: upperKey,
          lowerGarmentKey: lowerKey,
          faceId,
          garmentTypeId: garmentType.id,
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
    expect(inputs?.upperGarmentKey).toBeNull();
    expect(inputs?.lowerGarmentKey).toBe(lowerKey);
  });
```

Check the exact table/column names used by `catalogTypes`/`catalogCategories`/`catalogItems` in `packages/db/src/schema` before writing the second test — match whatever the schema actually calls them (this plan infers plausible names from CLAUDE.md's catalog table description; verify against `packages/db/src/schema/catalog.ts` directly).

- [ ] **Step 2:** Run to verify failures, matching the expected pre-fix state (all three should currently return 201 where the test expects 400, or fail the strip assertion).

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/jobs-create-looks.test.ts --reporter=verbose
```

- [ ] **Step 3: Thread `upperNodeIds` through both `poseWorkflows` branches.** In `mappingPoseWorkflows`'s select (around line 258):

```ts
        const rows = await app.db
          .select({
            poseId: schema.catalogueTemplateLooks.poseAssetId,
            backgroundId: schema.catalogueTemplateLooks.backgroundId,
            workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
            promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
            upperNodeIds: schema.workflowTemplates.upperNodeIds,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
            sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
          })
```

and its returned per-pose objects:

```ts
          return {
            poseId,
            workflowTemplateId: row.workflowTemplateId,
            promptGarmentPhase: row.promptGarmentPhase,
            upperNodeIds: row.upperNodeIds,
            lowerNodeId: row.lowerNodeId,
            shoeNodeId: row.shoeNodeId,
            sizeNodeIds: row.sizeNodeIds,
          };
```

In the `poseWorkflowRows` select (around line 338), add `defaultUpperNodeIds`/`overrideUpperNodeIds`:

```ts
  const poseWorkflowRows = await app.db
    .select({
      poseId: schema.modelPoseAssets.id,
      defaultWorkflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
      defaultUpperNodeIds: defaultWorkflow.upperNodeIds,
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      defaultSizeNodeIds: defaultWorkflow.sizeNodeIds,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      configIsActive: schema.poseGarmentConfigs.isActive,
      overrideUpperNodeIds: overrideWorkflow.upperNodeIds,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
      overrideSizeNodeIds: overrideWorkflow.sizeNodeIds,
    })
```

and in the fallback `.map(...)`:

```ts
  const poseWorkflows =
    mappingPoseWorkflows ??
    poseWorkflowRows.map((r) => ({
      poseId: r.poseId,
      workflowTemplateId: r.configWorkflowTemplateId ?? r.defaultWorkflowTemplateId,
      promptGarmentPhase: null,
      upperNodeIds:
        r.configWorkflowTemplateId != null ? (r.overrideUpperNodeIds ?? []) : (r.defaultUpperNodeIds ?? []),
      lowerNodeId:
        r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
      shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
      sizeNodeIds:
        r.configWorkflowTemplateId != null ? r.overrideSizeNodeIds : r.defaultSizeNodeIds,
    }));
```

- [ ] **Step 4: The cross-validation check, with the hero-vs-accessory fix.** Replace the validation loop (currently lines 395-402):

```ts
  for (const pw of poseWorkflows) {
    if (pw.upperNodeIds.length > 0 && !upperGarmentKey) {
      throw new AppError('VALIDATION', 400, 'upper garment required for this pose');
    }
    if (pw.lowerNodeId) {
      if (pw.upperNodeIds.length === 0) {
        // Lower is the sole hero for this pose's workflow — must be the customer's
        // own upload, not a generic catalog stock photo.
        if (!lowerGarmentKey) {
          throw new AppError('VALIDATION', 400, 'lower garment upload required for this pose');
        }
      } else if (!lowerCatalogId && !lowerGarmentKey) {
        // Lower is a paired accessory alongside an upper hero — catalog pick remains valid.
        throw new AppError('VALIDATION', 400, 'lower garment required for this pose');
      }
    }
    if (pw.shoeNodeId && !shoeCatalogId) {
      throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
    }
  }
```

- [ ] **Step 5: Per-pose upper-key stripping.** Find the insert loop's existing `effectiveLowerCatalogId`/`effectiveLowerGarmentKey`/`effectiveShoeCatalogId` computation (around line 430) and add a matching upper computation immediately before it:

```ts
      const effectiveUpperGarmentKey =
        pw?.upperNodeIds && pw.upperNodeIds.length > 0 ? upperGarmentKey : null;
      const effectiveLowerCatalogId =
        pw?.lowerNodeId && !lowerGarmentKey ? (lowerCatalogId ?? null) : null;
      const effectiveLowerGarmentKey = pw?.lowerNodeId && lowerGarmentKey ? lowerGarmentKey : null;
```

Then in the `job_inputs` insert `.values({...})` a few lines below, change `upperGarmentKey,` to `upperGarmentKey: effectiveUpperGarmentKey,`.

- [ ] **Step 6: Run to verify all pass; typecheck; commit:**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/jobs-create-looks.test.ts --reporter=verbose
pnpm --filter @tryme/api typecheck
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/jobs-create-looks.test.ts
git commit -m "feat(jobs): validate resolved workflow's garment roles per pose and strip irrelevant keys"
```

---

### Task 7: Dispatcher patcher — fail closed on any mapped-but-unfulfilled role

**Files:**
- Modify: `apps/dispatcher/src/workflow/patcher.ts:74-126` (`applyWorkflowPatch`), `:49-64` (`WorkflowInputs`)
- Test: `apps/dispatcher/src/workflow/patcher.test.ts`

- [ ] **Step 1:** Add to `apps/dispatcher/src/workflow/patcher.test.ts`, reusing the existing `makeWorkflow`/`makeTemplate`/`BASE_INPUTS` fixtures:

```ts
describe('fail-closed on missing garment input for a mapped role', () => {
  it('throws when upperNodeIds is mapped but upperGarmentFile is missing', () => {
    const wf = makeWorkflow();
    const { upperGarmentFile, ...inputsWithoutUpper } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(wf, makeTemplate({ faceNodeId: null, bgNodeId: null }), inputsWithoutUpper),
    ).toThrow(/upper/i);
  });

  it('throws when lowerNodeId is mapped but lowerGarmentFile is missing (no fallback to upper)', () => {
    const wf = makeWorkflow();
    expect(() =>
      applyWorkflowPatch(wf, makeTemplate({ lowerNodeId: '1331' }), BASE_INPUTS),
    ).toThrow(/lower/i);
  });

  it('throws when faceNodeId is mapped but faceSideFile is missing', () => {
    const wf = makeWorkflow();
    const { faceSideFile, ...inputsWithoutFace } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(wf, makeTemplate({ bgNodeId: null }), inputsWithoutFace),
    ).toThrow(/face/i);
  });

  it('does not throw for an unmapped role even when its input is absent', () => {
    const wf = makeWorkflow();
    const { upperGarmentFile, ...inputsWithoutUpper } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(
        wf,
        makeTemplate({ faceNodeId: null, bgNodeId: null, upperNodeIds: [], lowerNodeId: '1331' }),
        { ...inputsWithoutUpper, lowerGarmentFile: 'lower_abc123.jpg' },
      ),
    ).not.toThrow();
  });

  it('patches the lower node with its own file, not a fallback, when both are provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, lowerGarmentFile: 'lower_xyz.jpg' });
    expect(wf['1331']?.inputs.image).toBe('lower_xyz.jpg');
  });
});
```

- [ ] **Step 2:** Run to verify failures:

```bash
pnpm --filter @tryme/dispatcher test
```

- [ ] **Step 3: Implement.** Replace `applyWorkflowPatch`'s body (lines 80-126):

```ts
  if (tmpl.faceNodeId) {
    if (!inputs.faceSideFile) {
      throw new Error(`Workflow "${tmpl.slug}" maps a face node but no face image was provided`);
    }
    requireNode(workflow, tmpl.faceNodeId, 'face').inputs.image = inputs.faceSideFile;
  }
  requireNode(workflow, tmpl.poseNodeId, 'pose').inputs.image = inputs.poseFile;
  if (tmpl.bgNodeId) {
    if (!inputs.backgroundFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a background node but no background image was provided`,
      );
    }
    requireNode(workflow, tmpl.bgNodeId, 'bg').inputs.image = inputs.backgroundFile;
  }

  if (tmpl.upperNodeIds.length > 0) {
    if (!inputs.upperGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps ${tmpl.upperNodeIds.length} upper garment node(s) but no upper garment image was provided`,
      );
    }
    for (const uid of tmpl.upperNodeIds) {
      requireNode(workflow, uid, 'upper garment').inputs.image = inputs.upperGarmentFile;
    }
  }

  if (tmpl.lowerNodeId) {
    if (!inputs.lowerGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a lower garment node but no lower garment image was provided`,
      );
    }
    requireNode(workflow, tmpl.lowerNodeId, 'lower garment').inputs.image = inputs.lowerGarmentFile;
  } else if (inputs.lowerGarmentFile) {
    log?.warn(
      `patchWorkflow: lower garment provided but workflow "${tmpl.slug}" has no lower_node_id — skipping`,
    );
  }

  if (tmpl.shoeNodeId) {
    if (!inputs.shoeGarmentFile) {
      throw new Error(`Workflow "${tmpl.slug}" maps a shoe node but no shoe image was provided`);
    }
    requireNode(workflow, tmpl.shoeNodeId, 'shoes').inputs.image = inputs.shoeGarmentFile;
  } else if (inputs.shoeGarmentFile) {
    log?.warn(
      `patchWorkflow: shoe garment provided but workflow "${tmpl.slug}" has no shoe_node_id — skipping`,
    );
  }
```

- [ ] **Step 4:** Change `WorkflowInputs` (lines 49-64) so `upperGarmentFile`, `faceSideFile`, `backgroundFile` are all optional; `poseFile` stays required:

```ts
export interface WorkflowInputs {
  workflowTemplateId: string;
  poseFile: string;
  upperGarmentFile?: string;
  faceSideFile?: string;
  backgroundFile?: string;
  lowerGarmentFile?: string;
  shoeGarmentFile?: string;
  promptFacePhase?: string;
  promptGarmentPhase?: string;
  aspectRatio?: string;
  outputWidth?: number;
  outputHeight?: number;
}
```

- [ ] **Step 5:** Run to verify all pass; typecheck; commit:

```bash
pnpm --filter @tryme/dispatcher test
pnpm --filter @tryme/dispatcher exec tsc --noEmit
git add apps/dispatcher/src/workflow/patcher.ts apps/dispatcher/src/workflow/patcher.test.ts
git commit -m "feat(dispatcher): fail closed instead of stale-image fallback for any unmapped garment input"
```

---

### Task 8: Dispatcher processor — conditional uploads, catch missing-input failures, release the worker

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts` (around lines 260-420)

- [ ] **Step 1:** After the existing `workflowTemplateId` resolution block, add:

```ts
  const [tmplRoles] = await db
    .select({
      faceNodeId: schema.workflowTemplates.faceNodeId,
      bgNodeId: schema.workflowTemplates.bgNodeId,
      upperNodeIds: schema.workflowTemplates.upperNodeIds,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
  const needsFace = !!tmplRoles?.faceNodeId;
  const needsBg = !!tmplRoles?.bgNodeId;
  const needsUpper = (tmplRoles?.upperNodeIds.length ?? 0) > 0;
```

- [ ] **Step 2:** Replace the upload-list construction (currently around lines 359-368):

```ts
    jobLog.info({ needsFace, needsBg, needsUpper }, 'uploading inputs to ComfyUI');
    const baseTasks: Promise<string>[] = [uploadToComfy(poseKey, 'pose')];
    if (needsUpper && inputs.upperGarmentKey) baseTasks.push(uploadToComfy(inputs.upperGarmentKey, 'garment'));
    if (needsFace) baseTasks.push(uploadToComfy(faceSideKey, 'face'));
    if (needsBg) baseTasks.push(uploadToComfy(bgKey, 'bg'));
    if (lowerKey) baseTasks.push(uploadToComfy(lowerKey, 'lower'));
    if (shoeKey) baseTasks.push(uploadToComfy(shoeKey, 'shoe'));
    const uploaded = await Promise.all(baseTasks);

    let idx = 0;
    // biome-ignore lint/style/noNonNullAssertion: baseTasks always produces the pose entry first
    const poseFile = uploaded[idx++]!;
    const upperGarmentFile = needsUpper && inputs.upperGarmentKey ? uploaded[idx++] : undefined;
    const faceSideFile = needsFace ? uploaded[idx++] : undefined;
    const backgroundFile = needsBg ? uploaded[idx++] : undefined;
    const lowerGarmentFile = lowerKey ? uploaded[idx++] : undefined;
    const shoeGarmentFile = shoeKey ? uploaded[idx++] : undefined;
```

- [ ] **Step 3 (Revision 3 fix — Finding 8, worker release):** Locate the `catch` clause matching the `try` block this upload/patch/submit sequence lives in (search for `} catch (` after the `finalizeOutput` call further down). The worker `w` was claimed via `selectWorker` before this `try` block started, so any failure inside it must release the worker back to IDLE — every other failure path in this file already does this. Add, as the *first* branch in that catch, before any existing retry/failure logic:

```ts
  } catch (err) {
    if (
      err instanceof Error &&
      /no .* image was provided|no .* garment image was provided/.test(err.message)
    ) {
      jobLog.error({ err: err.message }, 'missing garment input for a mapped workflow role');
      await setWorkerStatus(redis, w.id, 'IDLE');
      await markFailed(
        cfg,
        jobId,
        userId,
        stream,
        messageId,
        'MISSING_GARMENT_INPUT',
        jobLog,
        startedAt,
      );
      return;
    }
    // ... existing catch body continues unchanged below ...
```

Read the existing catch body in full before inserting this — confirm `setWorkerStatus` is already imported in this file (it is, per the 8 existing call sites) and that this new branch's `return` correctly bypasses any retry-count logic that follows, since retrying a data/config problem wastes an attempt without any chance of succeeding.

- [ ] **Step 4:** Typecheck; run the dispatcher's happy-path integration test if the environment supports it (see prior review notes about pre-existing harness issues with this suite, unrelated to this change):

```bash
cd apps/dispatcher && pnpm exec tsc --noEmit
pnpm exec vitest run --config vitest.integration.config.ts test/integration/happy-path.test.ts --reporter=verbose
```

- [ ] **Step 5:** Commit:

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): upload only needed inputs, fail closed and release the worker on a garment-input gap"
```

---

### Task 9: Regeneration — drop upper requirement, fix the type error, fix ownership authorization, preserve mapping context

**Files:**
- Create: `apps/api/src/lib/upload-ownership.ts` (extracted from `create.ts`)
- Modify: `apps/api/src/modules/jobs/create.ts` (import the extracted helpers, add `trustedGarmentKeys` param)
- Modify: `apps/api/src/modules/jobs/regenerate.ts`
- Test: `apps/api/test/integration/regenerate.test.ts`

- [ ] **Step 1: Extract the upload-ownership helpers.** In `apps/api/src/modules/jobs/create.ts`, find `assertOwnsUploadKey` (currently lines 37-51):

```ts
export async function assertOwnsUploadKey(app: FastifyInstance, userId: string, key: string) {
  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== userId) {
    throw new AppError('FORBIDDEN', 403, 'upload key not owned by caller');
  }
  let head: { contentLength: number };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, 'uploaded garment not found');
  }
  if (head.contentLength > MAX_GARMENT_BYTES) {
    throw new AppError('BAD_UPLOAD', 413, 'uploaded garment exceeds size limit');
  }
}
```

Create `apps/api/src/lib/upload-ownership.ts` with this split into two functions — one reusable object-existence check, one full ownership check that calls it:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/** Max accepted garment upload size — mirrors the presign zod cap. */
export const MAX_GARMENT_BYTES = 10 * 1024 * 1024;

/**
 * Verifies the object exists in storage and is within the accepted size limit.
 * Does not check ownership — callers that have already established ownership
 * through another means (e.g. regenerating an already-owned completed job)
 * use this directly instead of the full Redis-binding check below.
 */
export async function assertGarmentObjectValid(app: FastifyInstance, key: string) {
  let head: { contentLength: number };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, 'uploaded garment not found');
  }
  if (head.contentLength > MAX_GARMENT_BYTES) {
    throw new AppError('BAD_UPLOAD', 413, 'uploaded garment exceeds size limit');
  }
}

/**
 * Reject a garment key that was not presigned for this user. The presign route
 * records `upload:owner:<key> -> userId` in Redis with a 24h TTL; a key bound
 * to nobody (expired/never issued) or to another user fails here. This is the
 * check for a *fresh* upload — regeneration of an old job uses
 * `trustedGarmentKeys` in `createJob` instead, since the 24h binding will
 * usually have expired long before an old job is regenerated even though the
 * caller's ownership of that job (and therefore its garment keys) is still valid.
 */
export async function assertOwnsUploadKey(app: FastifyInstance, userId: string, key: string) {
  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== userId) {
    throw new AppError('FORBIDDEN', 403, 'upload key not owned by caller');
  }
  await assertGarmentObjectValid(app, key);
}
```

In `apps/api/src/modules/jobs/create.ts`, delete the old `assertOwnsUploadKey` definition and the now-unused `MAX_GARMENT_BYTES` constant, and instead import both from the new module:

```ts
import { assertGarmentObjectValid, assertOwnsUploadKey } from '../../lib/upload-ownership.js';
```

Keep re-exporting `assertOwnsUploadKey` from `create.ts` too if anything else in the codebase imports it from there (`grep -r "from.*jobs/create" apps/api/src` to check) — if so, add `export { assertOwnsUploadKey } from '../../lib/upload-ownership.js';` to avoid breaking those imports.

- [ ] **Step 2: Add `trustedGarmentKeys` to `createJob`.** Change the signature:

```ts
export async function createJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateTryOnJobRequest>,
  opts?: { trustedGarmentKeys?: Set<string> },
) {
```

Replace the ownership-check block (Task 6 already made `upperGarmentKey`'s check conditional — combine that with the trusted-key path):

```ts
  async function verifyGarmentKey(key: string) {
    if (opts?.trustedGarmentKeys?.has(key)) {
      await assertGarmentObjectValid(app, key);
      return;
    }
    await assertOwnsUploadKey(app, userId, key);
  }
  if (upperGarmentKey) await verifyGarmentKey(upperGarmentKey);
  if (lowerGarmentKey) await verifyGarmentKey(lowerGarmentKey);
```

- [ ] **Step 3: Write the failing regeneration tests.** Add to `apps/api/test/integration/regenerate.test.ts` (match this file's actual existing seed helpers — read the rest of the file first):
  - A test creating a lower-only original job (workflow with empty `upperNodeIds`, non-null `lowerNodeId`, `lowerGarmentKey` set, `upperGarmentKey` null) and asserting `POST /v1/jobs/:id/regenerate`-equivalent (check this file's actual route/helper for triggering regeneration) returns 201.
  - A test that manually expires the upload-ownership Redis key (`await app.redis.del('upload:owner:' + garmentKey)`) before calling regenerate, and asserts it still succeeds (proving the `trustedGarmentKeys` path works).
  - A test for a mapped-template original job (seed `catalogueTemplateSubcategories`/`catalogueTemplatePoseWorkflows` similar to `jobs-create-looks.test.ts`'s existing mapped-template test) asserting the regenerated job's `job_inputs.params.catalogueTemplateMappingId` matches the original's.

- [ ] **Step 4:** Run to verify failures:

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/regenerate.test.ts --reporter=verbose
```

- [ ] **Step 5: Implement the `regenerate.ts` fixes.** Replace the studio/catalogue-job branch (currently lines 65-97):

```ts
  // Studio/catalogue job — one poseId per job row, reconstruct the request
  // shape createJob expects with just that single pose. If the original job
  // was created against a catalogue-template mapping, reconstruct the looks[]
  // form with the same mapping ID so the same per-pose workflow resolves again
  // — the legacy backgroundId+poseIds form would fall through to
  // pose_garment_configs/pose-default resolution instead, potentially
  // selecting a different workflow entirely.
  if (!inputs.poseId || !inputs.faceId || !inputs.backgroundId) {
    throw new AppError('VALIDATION', 400, 'original job is missing required inputs to regenerate');
  }
  const mappingId =
    typeof params.catalogueTemplateMappingId === 'string' ? params.catalogueTemplateMappingId : undefined;

  const trustedGarmentKeys = new Set<string>();
  if (inputs.upperGarmentKey) trustedGarmentKeys.add(inputs.upperGarmentKey);
  if (inputs.lowerGarmentKey) trustedGarmentKeys.add(inputs.lowerGarmentKey);

  const body: z.infer<typeof CreateTryOnJobRequest> = {
    catalogueId: original.job.catalogueId ?? undefined,
    inputs: {
      upperGarmentKey: inputs.upperGarmentKey ?? undefined,
      faceId: inputs.faceId,
      garmentTypeId: inputs.garmentTypeId ?? undefined,
      lowerCatalogId: inputs.lowerCatalogId ?? undefined,
      lowerGarmentKey: inputs.lowerGarmentKey ?? undefined,
      shoeCatalogId: inputs.shoeCatalogId ?? undefined,
      ...(mappingId
        ? { catalogueTemplateMappingId: mappingId, looks: [{ poseId: inputs.poseId, backgroundId: inputs.backgroundId }] }
        : { backgroundId: inputs.backgroundId, poseIds: [inputs.poseId] }),
    },
    params: {
      outputWidth: typeof params.outputWidth === 'number' ? params.outputWidth : undefined,
      outputHeight: typeof params.outputHeight === 'number' ? params.outputHeight : undefined,
    },
    userHint: inputs.userHint ?? undefined,
    aspectRatio: (typeof params.aspectRatio === 'string' ? params.aspectRatio : '1:1') as z.infer<
      typeof CreateTryOnJobRequest
    >['aspectRatio'],
    resolution: (typeof params.resolution === 'string' ? params.resolution : '2K') as Resolution,
    platform: typeof params.platform === 'string' ? params.platform : undefined,
  };

  const result = await createJob(app, userId, body, { trustedGarmentKeys });
  const newJobId = result.jobIds[0];
  await setParentJobId(app, newJobId, originalJobId);
  return { jobId: newJobId, catalogueId: result.catalogueId };
```

Note the `inputs.garmentTypeId` read — Task 6's per-pose validation requires `garmentTypeId` when `catalogueTemplateMappingId` is present (per the existing `mappingPoseWorkflows` block's own precondition check in `create.ts`) — confirm `inputs.garmentTypeId` is always set on any job that was itself created via a mapping (it should be, since `createJob` already required it for mapped jobs) before assuming this reconstruction is complete; if not, surface a clear `AppError` rather than letting `createJob` throw an unrelated-looking one.

- [ ] **Step 6:** Run to verify all pass; typecheck; commit:

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/regenerate.test.ts --reporter=verbose
pnpm --filter @tryme/api typecheck
git add apps/api/src/lib/upload-ownership.ts apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/regenerate.ts apps/api/test/integration/regenerate.test.ts
git commit -m "fix(jobs): regenerate lower-only and mapped-template jobs correctly, past the upload-ownership TTL"
```

---

### Task 10: Every surface that displays a job's source garment

**Files:**
- Modify: `apps/api/src/modules/jobs/routes.ts:367-403` (`/v1/catalogues/:id`), `:407-428` (`/v1/assets`)
- Modify: `apps/catalogues-web/src/app/(app)/assets/page.tsx:71`
- Modify: `apps/api/src/modules/results/routes.ts`

- [ ] **Step 1: `/v1/catalogues/:id` hero resolution.** Replace (currently around lines 369-389):

```ts
      const [anyInput] = await app.db
        .select({
          params: schema.jobInputs.params,
          upperGarmentKey: schema.jobInputs.upperGarmentKey,
          lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
          lowerCatalogId: schema.jobInputs.lowerCatalogId,
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(and(eq(schema.jobs.catalogueId, id), eq(schema.jobs.userId, req.userId)))
        .limit(1);
      const aspectRatio =
        (anyInput?.params as { aspectRatio?: string } | null)?.aspectRatio ?? null;

      let garmentUrl: string | null = null;
      const heroKey = anyInput?.upperGarmentKey ?? anyInput?.lowerGarmentKey ?? null;
      if (heroKey) {
        try {
          const { url } = await app.storage.presignGet(heroKey, 3600);
          garmentUrl = url;
        } catch {
          // non-fatal
        }
      } else if (anyInput?.lowerCatalogId) {
        const [catalogItem] = await app.db
          .select({ thumbnailKey: schema.catalogItems.thumbnailKey })
          .from(schema.catalogItems)
          .where(eq(schema.catalogItems.id, anyInput.lowerCatalogId));
        if (catalogItem?.thumbnailKey) garmentUrl = app.storage.publicUrl(catalogItem.thumbnailKey);
      }
```

- [ ] **Step 2 (Revision 3 fix — Finding 2): `/v1/assets` must not crash, and must surface lower uploads too.** Replace the query (currently lines 407-428):

```ts
  app.get('/v1/assets', { preHandler: app.requireUser }, async (req) => {
    const excludeReuse = sql`${schema.jobInputs.params}->>'sourceJobId' is null`;
    const [upperRows, lowerRows] = await Promise.all([
      app.db
        .select({
          r2Key: schema.jobInputs.upperGarmentKey,
          uploadedAt: sql<Date>`MAX(${schema.jobs.createdAt})`.as('uploadedAt'),
          jobCount: sql<number>`COUNT(${schema.jobs.id})`.as('jobCount'),
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            sql`${schema.jobInputs.upperGarmentKey} is not null`,
            excludeReuse,
          ),
        )
        .groupBy(schema.jobInputs.upperGarmentKey),
      app.db
        .select({
          r2Key: schema.jobInputs.lowerGarmentKey,
          uploadedAt: sql<Date>`MAX(${schema.jobs.createdAt})`.as('uploadedAt'),
          jobCount: sql<number>`COUNT(${schema.jobs.id})`.as('jobCount'),
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(and(eq(schema.jobs.userId, req.userId), sql`${schema.jobInputs.lowerGarmentKey} is not null`))
        .groupBy(schema.jobInputs.lowerGarmentKey),
    ]);

    // Merge, de-duplicating by r2Key — a garment could theoretically appear as
    // both an upper and lower upload across different jobs. Keep the most
    // recent uploadedAt and sum jobCount when a key appears in both sets.
    const merged = new Map<string, { r2Key: string; uploadedAt: Date; jobCount: number }>();
    for (const row of [...upperRows, ...lowerRows]) {
      if (!row.r2Key) continue;
      const existing = merged.get(row.r2Key);
      if (existing) {
        existing.jobCount += row.jobCount;
        if (row.uploadedAt > existing.uploadedAt) existing.uploadedAt = row.uploadedAt;
      } else {
        merged.set(row.r2Key, { r2Key: row.r2Key, uploadedAt: row.uploadedAt, jobCount: row.jobCount });
      }
    }
    const result = [...merged.values()].sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );

    return Promise.all(
      result.map(async (asset) => {
        let thumbnailUrl: string | null = null;
        try {
          const { url } = await app.storage.presignGet(asset.r2Key, 3600);
          thumbnailUrl = url;
        } catch {
          /* missing object — leave null, client shows placeholder */
        }
        return { ...asset, thumbnailUrl };
      }),
    );
  });
```

Read the rest of the original handler below line 440 first (the current `.map(...)` closure this replaces continues past what's quoted above) to confirm the exact returned shape and adjust the final `return { ...asset, thumbnailUrl }` to match whatever fields the original response included beyond `r2Key`/`uploadedAt`/`jobCount`/`thumbnailUrl`.

- [ ] **Step 3: Defensive frontend null-guard.** In `apps/catalogues-web/src/app/(app)/assets/page.tsx:71`, change:

```ts
  const filtered = assets.filter((a) => a.r2Key.toLowerCase().includes(search.toLowerCase()));
```

to:

```ts
  const filtered = assets.filter((a) => a.r2Key?.toLowerCase().includes(search.toLowerCase()));
```

This is defense-in-depth on top of Step 2's backend fix (which should never produce a null `r2Key` after the change) — a frontend that assumes an API response field is never null is exactly the class of bug this whole review has been finding.

- [ ] **Step 4: Ops dashboard.** In `apps/api/src/modules/results/routes.ts`, find the select with `upperGarmentKey: schema.jobInputs.upperGarmentKey,` (around line 145) and add:

```ts
          lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
```

Then find wherever `upperGarmentKey` is turned into a displayed thumbnail URL further down in this file and apply the same `?? lowerGarmentKey` fallback.

- [ ] **Step 5:** Typecheck; commit:

```bash
pnpm --filter @tryme/api typecheck
cd apps/catalogues-web && pnpm exec tsc --noEmit
git add apps/api/src/modules/jobs/routes.ts apps/api/src/modules/results/routes.ts apps/catalogues-web/src/app/\(app\)/assets/page.tsx
git commit -m "fix(jobs): show a lower-only job's source garment everywhere, fix /v1/assets crash on null upperGarmentKey"
```

---

### Task 11: Progress log + rollout note

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1:** Add a dated entry summarizing the full feature (schema, admin create/PATCH validation and UI, job-creation cross-validation with hero-vs-accessory and per-pose stripping, dispatcher fail-closed patching with worker release, regeneration fixes including the pre-existing TTL and mapping-loss bugs, and the `/v1/assets` crash fix). Note explicitly: **deploy dispatcher before api/admin-web** (Section 10 of the spec).

- [ ] **Step 2:** Commit:

```bash
git add docs/progress.md
git commit -m "docs(progress): log flexible workflow roles implementation"
```

---

## Self-Review

**Spec coverage:** every numbered section (1-10) and every Revision-3-tagged finding (1-10) in the spec maps to a task above — Findings 1/7 → Task 6; Finding 2 → Task 10 Steps 2-3; Findings 3/4/5 → Task 9; Finding 6 → Tasks 3 Step 1 and 5 Step 2; Finding 8 → Task 8 Step 3; Finding 9 → spec wording only, no code task needed; Finding 10 → Task 2 Step 2.

**Placeholder scan:** no TBD/TODO. Two steps (Task 6 Step 1's catalog schema names, Task 9 Step 3/5's exact existing regenerate-trigger route and `garmentTypeId` precondition) explicitly instruct verifying against the current schema/file before writing, rather than guessing — this is a deliberate "confirm current state" instruction, not an unresolved placeholder, since the surrounding code is complete either way.

**Type consistency:** `WorkflowInputs` optional fields (Task 7) match the conditional extraction in Task 8. `pw.upperNodeIds: string[]` threaded consistently from Task 6's selects through its validation and stripping logic. `createJob`'s new `opts?: { trustedGarmentKeys?: Set<string> }` (Task 9 Step 2) is additive and optional, so the existing call site in `routes.ts:47` (which doesn't pass it) is unaffected. `assertOwnsUploadKey`/`assertGarmentObjectValid`'s extraction (Task 9 Step 1) preserves the original function's exact behavior for existing callers while adding the new object-only check as a separate export.
