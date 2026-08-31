# Saree Two-Input (Body + Pallu) Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user submitting the "Flat Saree" garment type in the studio wizard choose, via a dropdown, between today's single flat-lay-saree upload and a new two-image "Body + Pallu" upload — each routed through its own admin-configured step-1 ("mannequin") ComfyUI workflow.

**Architecture:** Additive, gated entirely behind two new nullable columns (`workflow_templates.tryonGarmentNodeId2`, `garment_subcategories.mannequinTwoInputWorkflowTemplateId`) and a new `workflowType: 'saree_step1_two_input'`. The frontend dropdown only renders once admin has configured the second workflow. The chosen two-input workflow ID is snapshotted into the mannequin job's `params.workflowTemplateId`, reusing the exact snapshot-precedence mechanism the dispatcher already honors for merchant saree styles — no new dispatcher-side discriminator field. Step 2 (drape + pose + background) and every other garment type are completely untouched.

**Tech Stack:** Fastify 5 + zod (API), Drizzle ORM + Postgres (DB), Redis Streams (dispatcher), Next.js 15 (catalogues-web studio wizard), Vite + React (admin-web).

## Global Constraints

- pnpm workspaces only — never introduce npm/yarn lockfiles.
- ESM only, Node 20+, TypeScript 5.6.
- `pnpm docker:up` must be running before any integration test (`apps/api`, `apps/dispatcher`) — they create fresh Postgres DBs/MinIO buckets per test file, no testcontainers.
- Credit deduct + job insert stays one Postgres transaction (unaffected here — no changes to `atomicDeduct` call sites).
- `@tryme/db` exports `* as schema` — do not add a duplicate `schema` re-export.
- Migration index: next free index is `0130` (verified against both local and `origin/main` — no collision as of writing). Re-check with `git diff --name-only HEAD..origin/main -- packages/db/src/migrations/` before running `db:generate` if time has passed since this plan was written.
- Never hand-run `drizzle-kit`/migrations against production — local/staging only, per CLAUDE.md.
- No comments explaining *what* code does — only non-obvious *why*, matching existing file style.
- `apps/admin-web` and `apps/catalogues-web` have no automated test runner — verify those tasks via `tsc`/build, not `vitest`.

---

### Task 1: DB schema — two-input mannequin columns

**Files:**
- Modify: `packages/db/src/schema/models.ts:121-124` (garmentSubcategories)
- Modify: `packages/db/src/schema/models.ts:167-170` (workflowTemplates)
- Create: `packages/db/src/migrations/0130_saree_two_input_mannequin.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId` (uuid, nullable, FK → `workflow_templates.id`, `onDelete: 'set null'`), `schema.workflowTemplates.tryonGarmentNodeId2` (text, nullable). Every later task reads/writes these two columns by these exact names.

- [ ] **Step 1: Add `mannequinTwoInputWorkflowTemplateId` to `garmentSubcategories`**

In `packages/db/src/schema/models.ts`, the `garmentSubcategories` table currently has (around line 119-124):

```ts
  // Step-2 workflow: used for EVERY pose in a job for this garment type, overriding
  // the normal per-pose pose_garment_configs/model_pose_assets.workflowTemplateId lookup.
  sareeStep2WorkflowTemplateId: uuid('saree_step2_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
```

Add immediately after it:

```ts
  // Optional second step-1 workflow: takes two garment images (body + pallu)
  // instead of one. Presence of this column is what gates the studio wizard's
  // "Full Saree / Body & Pallu" upload-mode dropdown for this garment type.
  // See docs/superpowers/specs/2026-07-29-saree-two-input-upload-design.md.
  mannequinTwoInputWorkflowTemplateId: uuid(
    'mannequin_two_input_workflow_template_id',
  ).references(() => workflowTemplates.id, { onDelete: 'set null' }),
```

- [ ] **Step 2: Add `tryonGarmentNodeId2` to `workflowTemplates`**

Same file, the `workflowTemplates` table currently has (around line 167-170):

```ts
  // Tryon workflow node IDs — only set when workflowType = 'tryon'
  tryonPersonNodeId: text('tryon_person_node_id'),
  tryonGarmentNodeId: text('tryon_garment_node_id'),
  tryonOutputNodeId: text('tryon_output_node_id'),
```

Change to:

```ts
  // Tryon workflow node IDs — only set when workflowType = 'tryon'
  tryonPersonNodeId: text('tryon_person_node_id'),
  tryonGarmentNodeId: text('tryon_garment_node_id'),
  // Second garment node (pallu) — only set when workflowType = 'saree_step1_two_input'.
  // tryonGarmentNodeId carries the body image in that case.
  tryonGarmentNodeId2: text('tryon_garment_node_id_2'),
  tryonOutputNodeId: text('tryon_output_node_id'),
```

- [ ] **Step 3: Generate and apply the migration**

Ensure infra is up, then generate:

```bash
pnpm docker:up
pnpm db:generate
```

Confirm a new file `packages/db/src/migrations/0130_<auto-name>.sql` was created containing two `ALTER TABLE ... ADD COLUMN` statements (one on `garment_subcategories`, one on `workflow_templates`). If drizzle picked a different next index than `0130` because migrations landed on `origin/main` since this plan was written, follow CLAUDE.md's "Migration Index Conflicts" section instead of forcing `0130`.

Apply it:

```bash
pnpm db:migrate
```

- [ ] **Step 4: Verify the columns exist and the package still typechecks**

```bash
pnpm --filter @tryme/db typecheck
```

Expected: no errors.

```bash
psql "$DATABASE_URL" -c "\d garment_subcategories" | grep mannequin_two_input
psql "$DATABASE_URL" -c "\d workflow_templates" | grep tryon_garment_node_id_2
```

Expected: both commands print a matching column row.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add two-input mannequin workflow columns for Flat Saree"
```

---

### Task 2: `PatchGarmentTypeBody` + `CreateSareeMannequinJobRequest` schema widening

**Files:**
- Modify: `packages/types/src/admin.ts:482-500` (`PatchGarmentTypeBody`)
- Modify: `packages/types/src/jobs.ts:129-132` (`CreateSareeMannequinJobRequest`)
- Test: `apps/api/test/integration/garment-type-mannequin-fields.test.ts`

**Interfaces:**
- Consumes: `schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId` (Task 1).
- Produces: `PatchGarmentTypeBody` accepts `mannequinTwoInputWorkflowTemplateId?: string | null`; `CreateSareeMannequinJobRequest` accepts `secondGarmentKey?: string`. Task 6 consumes both.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/garment-type-mannequin-fields.test.ts`, add a new `it` block after the existing one (before the closing `});` of the `describe`):

```ts
  it('persists mannequinTwoInputWorkflowTemplateId', async () => {
    const token = await registerAdmin('gt-mannequin-two-input-admin@x.com');
    const twoInputId = await seedWorkflow('saree_step1_two_input');
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: 'flat-saree-two-input-test', label: 'Flat Saree' })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${gt.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { mannequinTwoInputWorkflowTemplateId: twoInputId },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, gt.id));
    expect(row?.mannequinTwoInputWorkflowTemplateId).toBe(twoInputId);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- garment-type-mannequin-fields
```

Expected: FAIL — 400 (zod rejects the unknown field `mannequinTwoInputWorkflowTemplateId`) instead of 200.

- [ ] **Step 3: Widen `PatchGarmentTypeBody`**

In `packages/types/src/admin.ts`, the schema currently ends (line 497-499):

```ts
  requiresMannequinStep: z.boolean().optional(),
  mannequinWorkflowTemplateId: z.string().uuid().nullable().optional(),
  sareeStep2WorkflowTemplateId: z.string().uuid().nullable().optional(),
});
```

Change to:

```ts
  requiresMannequinStep: z.boolean().optional(),
  mannequinWorkflowTemplateId: z.string().uuid().nullable().optional(),
  sareeStep2WorkflowTemplateId: z.string().uuid().nullable().optional(),
  mannequinTwoInputWorkflowTemplateId: z.string().uuid().nullable().optional(),
});
```

- [ ] **Step 4: Add `secondGarmentKey` to `CreateSareeMannequinJobRequest`**

In `packages/types/src/jobs.ts`, the schema currently is (line 129-132):

```ts
export const CreateSareeMannequinJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  garmentKey: z.string().regex(INPUT_GARMENT_KEY),
  faceId: z.string().uuid(),
```

Change to:

```ts
export const CreateSareeMannequinJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  garmentKey: z.string().regex(INPUT_GARMENT_KEY),
  // Pallu image for the "Body & Pallu" two-input upload mode — only valid when
  // the garment type has mannequinTwoInputWorkflowTemplateId configured
  // (enforced server-side in createSareeMannequinJob, see Task 6).
  secondGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  faceId: z.string().uuid(),
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @tryme/types build
pnpm --filter @tryme/api test -- garment-type-mannequin-fields
```

Expected: both existing tests in the file plus the new one PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/admin.ts packages/types/src/jobs.ts apps/api/test/integration/garment-type-mannequin-fields.test.ts
git commit -m "feat(types): accept mannequinTwoInputWorkflowTemplateId and secondGarmentKey"
```

---

### Task 3: Two-input node auto-detection (`detectTryonTwoInputMappings`)

**Files:**
- Create: `apps/api/src/modules/admin/tryon-two-input-detect.ts`
- Test: `apps/api/src/modules/admin/tryon-two-input-detect.test.ts`

**Interfaces:**
- Produces: `detectTryonTwoInputMappings(json): { detected: DetectedTryonTwoInputMappings; allImageNodes: ParsedNode[]; allPromptNodes: ParsedNode[] }` where `DetectedTryonTwoInputMappings = { personNodeId?: string; bodyNodeId?: string; palluNodeId?: string; outputNodeId?: string; positivePromptNode?: string; negativePromptNode?: string; defaultPositivePrompt: string; defaultNegativePrompt: string }`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/admin/tryon-two-input-detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectTryonTwoInputMappings } from './tryon-two-input-detect.js';

// Inline fixture — 3 LoadImage inputs (person, body, pallu), 1 output, 2 prompts.
const sample: Record<string, unknown> = {
  '994': {
    inputs: { filename_prefix: ['1098', 0], images: ['1036', 0] },
    class_type: 'Save Image With Callback',
    _meta: { title: 'Save Image With Callback' },
  },
  '1000': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '1006': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'body' },
  },
  '1007': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'pallu' },
  },
  '1001:111': {
    inputs: {
      prompt: 'drape image2 body and image3 pallu onto image1 person',
      positive: undefined,
      image1: ['1024:456', 0],
      image2: ['1104', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '1117': {
    inputs: { text: 'extra hands, distorted pallu, artifacts' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '1001:842': {
    inputs: {
      positive: ['1001:111', 0],
      negative: ['1117', 0],
      control_net: ['1001:809', 0],
      image: ['1024:456', 0],
    },
    class_type: 'ControlNetInpaintingAliMamaApply',
    _meta: { title: 'ControlNetInpaintingAliMamaApply' },
  },
};

describe('detectTryonTwoInputMappings', () => {
  it('detects person, body, pallu and output nodes from the sample JSON', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.personNodeId).toBe('1000');
    expect(detected.bodyNodeId).toBe('1006');
    expect(detected.palluNodeId).toBe('1007');
    expect(detected.outputNodeId).toBe('994');
  });

  it('detects positive and negative prompt nodes via the positive/negative input links', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.positivePromptNode).toBe('1001:111');
    expect(detected.negativePromptNode).toBe('1117');
  });

  it('extracts default prompt text from the detected prompt nodes', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('drape image2 body');
    expect(detected.defaultNegativePrompt).toContain('distorted pallu');
  });

  it('returns the full image and prompt node lists for manual override', () => {
    const { allImageNodes, allPromptNodes } = detectTryonTwoInputMappings(sample);
    expect(allImageNodes.map((n) => n.id).sort()).toEqual(['1000', '1006', '1007']);
    expect(allPromptNodes.map((n) => n.id).sort()).toEqual(['1001:111', '1117']);
  });

  it('falls back to the leftover image node for person when untitled', () => {
    const untitledPerson = structuredClone(sample) as Record<string, { _meta: { title: string } }>;
    untitledPerson['1000']._meta.title = '1000';
    const { detected } = detectTryonTwoInputMappings(untitledPerson);
    expect(detected.personNodeId).toBe('1000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- tryon-two-input-detect
```

Expected: FAIL with a module-not-found error for `./tryon-two-input-detect.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/admin/tryon-two-input-detect.ts` (mirrors `tryon-detect.ts` exactly, extended for a 3rd image role):

```ts
// Saree two-input (body + pallu) step-1 mannequin workflow node auto-detection.
// Structurally identical to detectTryonMappings (tryon-detect.ts) except it has
// a third image input: person/face, body, and pallu, each a separate LoadImage.
import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

const PERSON_TITLES = new Set(['person', 'face']);
const BODY_TITLES = new Set(['body', 'garment', 'upper_garment', 'saree', 'flat_saree']);
const PALLU_TITLES = new Set(['pallu', 'palu']);

export interface DetectedTryonTwoInputMappings {
  personNodeId?: string;
  bodyNodeId?: string;
  palluNodeId?: string;
  outputNodeId?: string;
  positivePromptNode?: string;
  negativePromptNode?: string;
  defaultPositivePrompt: string;
  defaultNegativePrompt: string;
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

function promptText(node: WorkflowNode | undefined): string {
  const inputs = node?.inputs;
  return (inputs?.prompt as string | undefined) ?? (inputs?.text as string | undefined) ?? '';
}

function buildReverseLinks(
  json: Record<string, unknown>,
): Map<string, { consumerId: string; inputName: string }[]> {
  const rev = new Map<string, { consumerId: string; inputName: string }[]>();
  for (const [consumerId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.inputs) continue;
    for (const [inputName, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        const srcId = val[0] as string;
        if (!rev.has(srcId)) rev.set(srcId, []);
        rev.get(srcId)?.push({ consumerId, inputName });
      }
    }
  }
  return rev;
}

export function detectTryonTwoInputMappings(json: Record<string, unknown>): {
  detected: DetectedTryonTwoInputMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedTryonTwoInputMappings = {
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (PERSON_TITLES.has(norm)) detected.personNodeId = nodeId;
      else if (PALLU_TITLES.has(norm)) detected.palluNodeId = nodeId;
      else if (BODY_TITLES.has(norm)) detected.bodyNodeId = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    if (!detected.outputNodeId && classType.includes('Save Image')) {
      detected.outputNodeId = nodeId;
    }
  }

  if (!detected.outputNodeId) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNodeId = nodeId;
        break;
      }
    }
  }

  // Fallback: if person isn't titled, and exactly one image node is neither
  // body nor pallu, that leftover node is person. No fallback for body vs
  // pallu — they need distinct titles, there is no safe heuristic between them.
  if (!detected.personNodeId) {
    const candidate = allImageNodes.find(
      (n) => n.id !== detected.bodyNodeId && n.id !== detected.palluNodeId,
    );
    if (candidate) detected.personNodeId = candidate.id;
  }

  if (!detected.positivePromptNode || !detected.negativePromptNode) {
    const rev = buildReverseLinks(json);
    for (const node of allPromptNodes) {
      if (detected.positivePromptNode && detected.negativePromptNode) break;
      for (const { inputName } of rev.get(node.id) ?? []) {
        if (inputName === 'positive' && !detected.positivePromptNode) {
          detected.positivePromptNode = node.id;
        } else if (inputName === 'negative' && !detected.negativePromptNode) {
          detected.negativePromptNode = node.id;
        }
      }
    }
  }

  if (detected.positivePromptNode) {
    detected.defaultPositivePrompt = promptText(json[detected.positivePromptNode] as WorkflowNode);
  }
  if (detected.negativePromptNode) {
    detected.defaultNegativePrompt = promptText(json[detected.negativePromptNode] as WorkflowNode);
  }

  allImageNodes.sort((a, b) => a.title.localeCompare(b.title));
  allPromptNodes.sort((a, b) => a.title.localeCompare(b.title));

  return { detected, allImageNodes, allPromptNodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- tryon-two-input-detect
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/tryon-two-input-detect.ts apps/api/src/modules/admin/tryon-two-input-detect.test.ts
git commit -m "feat(api): add body+pallu step-1 workflow node auto-detection"
```

---

### Task 4: Wire `saree_step1_two_input` into admin workflow routes

**Files:**
- Modify: `packages/types/src/admin.ts:237-357` (`CreateWorkflowBody`, `ParseWorkflowBody`, `UpdateWorkflowBody`)
- Modify: `apps/api/src/modules/admin/workflows.routes.ts`
- Test: `apps/api/test/integration/saree-step1-workflow.test.ts` (extend) — or a new file if that one doesn't fit; check its current scope first.

**Interfaces:**
- Consumes: `detectTryonTwoInputMappings` (Task 3), `schema.workflowTemplates.tryonGarmentNodeId2` (Task 1).
- Produces: `POST /admin/workflows` and `POST /admin/workflows/parse` accept `workflowType: 'saree_step1_two_input'`; `GET /admin/workflows` and `PATCH /admin/workflows/:id` expose/accept `tryonGarmentNodeId2`. Consumed by admin-web (Tasks 8-10).

- [ ] **Step 1: Read the existing test file to confirm conventions**

```bash
grep -n "describe\|it(" apps/api/test/integration/saree-step1-workflow.test.ts | head -20
```

Follow whatever `registerAdmin`/request pattern it already uses (same shape as Task 2's `garment-type-mannequin-fields.test.ts`).

- [ ] **Step 2: Write the failing test**

Add to `apps/api/test/integration/saree-step1-workflow.test.ts` (adjust helper names to match what Step 1 found):

```ts
  it('creates a saree_step1_two_input workflow with auto-detected body/pallu/output nodes', async () => {
    const token = await registerAdmin('wf-two-input-admin@x.com');
    const jsonContent = {
      '10': { class_type: 'SaveImage', inputs: {}, _meta: { title: 'output' } },
      '1': { class_type: 'LoadImage', inputs: {}, _meta: { title: 'person' } },
      '2': { class_type: 'LoadImage', inputs: {}, _meta: { title: 'body' } },
      '3': { class_type: 'LoadImage', inputs: {}, _meta: { title: 'pallu' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'pos' }, _meta: { title: 'positive_prompt' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'neg' }, _meta: { title: 'negative_prompt' } },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: `saree-two-input-${Date.now()}`,
        label: 'Saree Two Input',
        jsonContent,
        workflowType: 'saree_step1_two_input',
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '4',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tryonPersonNodeId).toBe('1');
    expect(body.tryonGarmentNodeId).toBe('2');
    expect(body.tryonGarmentNodeId2).toBe('3');
    expect(body.tryonOutputNodeId).toBe('10');
    expect(body.workflowType).toBe('saree_step1_two_input');
  });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- saree-step1-workflow
```

Expected: FAIL — zod rejects `workflowType: 'saree_step1_two_input'` (not in the enum) with 400.

- [ ] **Step 4: Widen the zod enums and add `tryonGarmentNodeId2`**

In `packages/types/src/admin.ts`:

Line 247 — `CreateWorkflowBody`'s `workflowType`:
```ts
    workflowType: z.enum(['regular', 'tryon', 'saree_step1']).default('regular'),
```
→
```ts
    workflowType: z
      .enum(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input'])
      .default('regular'),
```

Lines 269-272 — add the new node field next to the existing tryon fields:
```ts
    // Tryon workflow fields (required when workflowType = 'tryon')
    tryonPersonNodeId: z.string().min(1).optional(),
    tryonGarmentNodeId: z.string().min(1).optional(),
    tryonOutputNodeId: z.string().min(1).optional(),
```
→
```ts
    // Tryon workflow fields (required when workflowType = 'tryon')
    tryonPersonNodeId: z.string().min(1).optional(),
    tryonGarmentNodeId: z.string().min(1).optional(),
    // Pallu node — only used when workflowType = 'saree_step1_two_input'
    tryonGarmentNodeId2: z.string().min(1).optional(),
    tryonOutputNodeId: z.string().min(1).optional(),
```

Line 275 — the `superRefine` prompt-node requirement condition:
```ts
    if (val.workflowType === 'tryon' || val.workflowType === 'saree_step1') {
```
→
```ts
    if (
      val.workflowType === 'tryon' ||
      val.workflowType === 'saree_step1' ||
      val.workflowType === 'saree_step1_two_input'
    ) {
```

Line 321 — `ParseWorkflowBody.workflowType`:
```ts
export const ParseWorkflowBody = z.object({
  jsonContent: z.record(z.any()),
  workflowType: z.enum(['regular', 'tryon', 'saree_step1']).optional(),
});
```
→
```ts
export const ParseWorkflowBody = z.object({
  jsonContent: z.record(z.any()),
  workflowType: z.enum(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input']).optional(),
});
```

Lines 353-356 — `UpdateWorkflowBody`'s tryon node fields:
```ts
  // Tryon workflow node IDs
  tryonPersonNodeId: z.string().min(1).nullable().optional(),
  tryonGarmentNodeId: z.string().min(1).nullable().optional(),
  tryonOutputNodeId: z.string().min(1).nullable().optional(),
```
→
```ts
  // Tryon workflow node IDs
  tryonPersonNodeId: z.string().min(1).nullable().optional(),
  tryonGarmentNodeId: z.string().min(1).nullable().optional(),
  tryonGarmentNodeId2: z.string().min(1).nullable().optional(),
  tryonOutputNodeId: z.string().min(1).nullable().optional(),
```

- [ ] **Step 5: Wire the route handlers**

In `apps/api/src/modules/admin/workflows.routes.ts`:

Add the import (line 13):
```ts
import { detectTryonMappings } from './tryon-detect.js';
```
→
```ts
import { detectTryonMappings } from './tryon-detect.js';
import { detectTryonTwoInputMappings } from './tryon-two-input-detect.js';
```

`GET /admin/workflows` response mapping (lines 118-120) — add the new field:
```ts
      tryonPersonNodeId: r.tryonPersonNodeId,
      tryonGarmentNodeId: r.tryonGarmentNodeId,
      tryonOutputNodeId: r.tryonOutputNodeId,
```
→
```ts
      tryonPersonNodeId: r.tryonPersonNodeId,
      tryonGarmentNodeId: r.tryonGarmentNodeId,
      tryonGarmentNodeId2: r.tryonGarmentNodeId2,
      tryonOutputNodeId: r.tryonOutputNodeId,
```

`POST /admin/workflows/parse` (lines 141-145) — add a branch:
```ts
      const parseWorkflowType = (req.body as { workflowType?: string }).workflowType;
      if (parseWorkflowType === 'tryon' || parseWorkflowType === 'saree_step1') {
        const { detected, allImageNodes, allPromptNodes } = detectTryonMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }
```
→
```ts
      const parseWorkflowType = (req.body as { workflowType?: string }).workflowType;
      if (parseWorkflowType === 'tryon' || parseWorkflowType === 'saree_step1') {
        const { detected, allImageNodes, allPromptNodes } = detectTryonMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }
      if (parseWorkflowType === 'saree_step1_two_input') {
        const { detected, allImageNodes, allPromptNodes } = detectTryonTwoInputMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }
```

`POST /admin/workflows` body type (lines 182-184) — add the field:
```ts
        tryonPersonNodeId?: string;
        tryonGarmentNodeId?: string;
        tryonOutputNodeId?: string;
```
→
```ts
        tryonPersonNodeId?: string;
        tryonGarmentNodeId?: string;
        tryonGarmentNodeId2?: string;
        tryonOutputNodeId?: string;
```

`POST /admin/workflows` handler — insert a new branch immediately **before** the existing `if (workflowType === 'tryon' || workflowType === 'saree_step1') {` block (line 197):

```ts
      if (workflowType === 'saree_step1_two_input') {
        const { detected: autoDetected } = detectTryonTwoInputMappings(body.jsonContent);
        const personNodeId = body.tryonPersonNodeId ?? autoDetected.personNodeId ?? '';
        const bodyNodeId = body.tryonGarmentNodeId ?? autoDetected.bodyNodeId ?? '';
        const palluNodeId = body.tryonGarmentNodeId2 ?? autoDetected.palluNodeId ?? '';
        const outputNodeId = body.tryonOutputNodeId ?? autoDetected.outputNodeId ?? '';
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
        const negNode = body.facePhasePromptNode!;
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by CreateWorkflowBody's superRefine
        const posNode = body.garmentPhasePromptNode!;

        if (!bodyNodeId)
          throw new AppError(
            'VALIDATION',
            400,
            'Could not detect body node — set tryonGarmentNodeId manually',
          );
        if (!palluNodeId)
          throw new AppError(
            'VALIDATION',
            400,
            'Could not detect pallu node — set tryonGarmentNodeId2 manually',
          );
        if (!outputNodeId)
          throw new AppError(
            'VALIDATION',
            400,
            'Could not detect output node — set tryonOutputNodeId manually',
          );

        if (personNodeId) {
          validateNodeExists(body.jsonContent, personNodeId, 'person');
          validateNodeType(body.jsonContent, personNodeId, 'image', 'person');
        }
        validateNodeExists(body.jsonContent, bodyNodeId, 'body');
        validateNodeExists(body.jsonContent, palluNodeId, 'pallu');
        validateNodeExists(body.jsonContent, outputNodeId, 'output');
        validateNodeExists(body.jsonContent, negNode, 'negative prompt');
        validateNodeExists(body.jsonContent, posNode, 'positive prompt');
        validateNodeType(body.jsonContent, bodyNodeId, 'image', 'body');
        validateNodeType(body.jsonContent, palluNodeId, 'image', 'pallu');
        validateNodeType(body.jsonContent, negNode, 'prompt', 'negative prompt');
        validateNodeType(body.jsonContent, posNode, 'prompt', 'positive prompt');

        const { defaultFacePhasePrompt, defaultGarmentPhasePrompt } = extractDefaultPrompts(
          body.jsonContent,
          negNode,
          posNode,
        );

        const [row] = await app.db
          .insert(schema.workflowTemplates)
          .values({
            slug: body.slug,
            label: body.label,
            jsonContent: body.jsonContent,
            workflowType,
            faceNodeId: '',
            poseNodeId: '',
            bgNodeId: '',
            upperNodeIds: [],
            facePhasePromptNode: negNode,
            garmentPhasePromptNode: posNode,
            defaultFacePhasePrompt,
            defaultGarmentPhasePrompt,
            tryonPersonNodeId: personNodeId || null,
            tryonGarmentNodeId: bodyNodeId,
            tryonGarmentNodeId2: palluNodeId,
            tryonOutputNodeId: outputNodeId,
          })
          .returning();

        return {
          id: row?.id,
          slug: row?.slug,
          label: row?.label,
          workflowType: row?.workflowType,
          isActive: row?.isActive,
          poseCount: 0,
          defaultFacePhasePrompt: row?.defaultFacePhasePrompt,
          defaultGarmentPhasePrompt: row?.defaultGarmentPhasePrompt,
          tryonPersonNodeId: row?.tryonPersonNodeId,
          tryonGarmentNodeId: row?.tryonGarmentNodeId,
          tryonGarmentNodeId2: row?.tryonGarmentNodeId2,
          tryonOutputNodeId: row?.tryonOutputNodeId,
          createdAt: row?.createdAt,
        };
      }

      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
```

(The rest of the existing `tryon`/`saree_step1` block is unchanged — only the new block is inserted above it.)

`PATCH /admin/workflows/:id` — find the body type cast (around line 432-433) and the update-values assignment (around line 560-563):

```ts
        tryonPersonNodeId?: string | null;
        tryonGarmentNodeId?: string | null;
```
→
```ts
        tryonPersonNodeId?: string | null;
        tryonGarmentNodeId?: string | null;
        tryonGarmentNodeId2?: string | null;
```

```ts
      if ('tryonPersonNodeId' in body)
        updateValues.tryonPersonNodeId = body.tryonPersonNodeId ?? null;
      if ('tryonGarmentNodeId' in body)
        updateValues.tryonGarmentNodeId = body.tryonGarmentNodeId ?? null;
```
→
```ts
      if ('tryonPersonNodeId' in body)
        updateValues.tryonPersonNodeId = body.tryonPersonNodeId ?? null;
      if ('tryonGarmentNodeId' in body)
        updateValues.tryonGarmentNodeId = body.tryonGarmentNodeId ?? null;
      if ('tryonGarmentNodeId2' in body)
        updateValues.tryonGarmentNodeId2 = body.tryonGarmentNodeId2 ?? null;
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @tryme/types build
pnpm --filter @tryme/api test -- saree-step1-workflow
```

Expected: PASS, including all pre-existing tests in that file (regression check).

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/admin.ts apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/saree-step1-workflow.test.ts
git commit -m "feat(api): accept saree_step1_two_input workflows in admin CRUD"
```

---

### Task 5: Admin-web — `WorkflowOption`/`GarmentType` types + third garment-type dropdown

**Files:**
- Modify: `apps/admin-web/src/types.ts:39-80`
- Modify: `apps/admin-web/src/components/EditGarmentTypeModal.tsx`

**Interfaces:**
- Consumes: `mannequinTwoInputWorkflowTemplateId` (Task 2), `tryonGarmentNodeId2`/`workflowType: 'saree_step1_two_input'` (Task 4).
- Produces: `EditGarmentTypeModal` persists `mannequinTwoInputWorkflowTemplateId` via the existing `PATCH /admin/assets/garment-types/:id`.

- [ ] **Step 1: Widen the types**

In `apps/admin-web/src/types.ts`, the `GarmentType` interface (line 51-53):
```ts
  requiresMannequinStep?: boolean;
  mannequinWorkflowTemplateId?: string | null;
  sareeStep2WorkflowTemplateId?: string | null;
```
→
```ts
  requiresMannequinStep?: boolean;
  mannequinWorkflowTemplateId?: string | null;
  sareeStep2WorkflowTemplateId?: string | null;
  mannequinTwoInputWorkflowTemplateId?: string | null;
```

The `WorkflowOption` interface (line 67, 77):
```ts
  workflowType: 'regular' | 'tryon' | 'saree_step1';
```
→
```ts
  workflowType: 'regular' | 'tryon' | 'saree_step1' | 'saree_step1_two_input';
```
and
```ts
  tryonPersonNodeId: string | null;
  tryonGarmentNodeId: string | null;
  tryonOutputNodeId: string | null;
```
→
```ts
  tryonPersonNodeId: string | null;
  tryonGarmentNodeId: string | null;
  tryonGarmentNodeId2: string | null;
  tryonOutputNodeId: string | null;
```

- [ ] **Step 2: Add state + dirty/save wiring in `EditGarmentTypeModal.tsx`**

Line 366-368, after `sareeStep2WorkflowTemplateId` state:
```ts
  const [sareeStep2WorkflowTemplateId, setSareeStep2WorkflowTemplateId] = useState(
    garmentType.sareeStep2WorkflowTemplateId ?? '',
  );
```
→
```ts
  const [sareeStep2WorkflowTemplateId, setSareeStep2WorkflowTemplateId] = useState(
    garmentType.sareeStep2WorkflowTemplateId ?? '',
  );
  const [mannequinTwoInputWorkflowTemplateId, setMannequinTwoInputWorkflowTemplateId] = useState(
    garmentType.mannequinTwoInputWorkflowTemplateId ?? '',
  );
```

Line 406-408, the `dirty` check:
```ts
    requiresMannequinStep !== (garmentType.requiresMannequinStep ?? false) ||
    mannequinWorkflowTemplateId !== (garmentType.mannequinWorkflowTemplateId ?? '') ||
    sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '');
```
→
```ts
    requiresMannequinStep !== (garmentType.requiresMannequinStep ?? false) ||
    mannequinWorkflowTemplateId !== (garmentType.mannequinWorkflowTemplateId ?? '') ||
    sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '') ||
    mannequinTwoInputWorkflowTemplateId !== (garmentType.mannequinTwoInputWorkflowTemplateId ?? '');
```

Lines 473-475, the `save()` patchBody assembly, right after the `sareeStep2WorkflowTemplateId` block:
```ts
      if (sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '')) {
        patchBody.sareeStep2WorkflowTemplateId = sareeStep2WorkflowTemplateId || null;
      }
```
→
```ts
      if (sareeStep2WorkflowTemplateId !== (garmentType.sareeStep2WorkflowTemplateId ?? '')) {
        patchBody.sareeStep2WorkflowTemplateId = sareeStep2WorkflowTemplateId || null;
      }
      if (
        mannequinTwoInputWorkflowTemplateId !==
        (garmentType.mannequinTwoInputWorkflowTemplateId ?? '')
      ) {
        patchBody.mannequinTwoInputWorkflowTemplateId = mannequinTwoInputWorkflowTemplateId || null;
      }
```

- [ ] **Step 3: Add the third dropdown to the JSX**

Lines 696-713, right after the "Mannequin (Step 1) Workflow" field, before the closing `</>`:
```ts
                  <div className="field">
                    <label>Mannequin (Step 1) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={mannequinWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setMannequinWorkflowTemplateId}
                    />
                    <span className="hint">
                      Drapes the uploaded garment onto the selected face, once per job.
                    </span>
                  </div>
                  <div className="field">
                    <label>Draping (Step 2) Workflow</label>
```
→ (insert between them)
```ts
                  <div className="field">
                    <label>Mannequin (Step 1) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={mannequinWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setMannequinWorkflowTemplateId}
                    />
                    <span className="hint">
                      Drapes the uploaded garment onto the selected face, once per job.
                    </span>
                  </div>
                  <div className="field">
                    <label>Two-Input Mannequin (Body + Pallu) Workflow</label>
                    <SearchableSelect
                      options={workflows
                        .filter((w) => w.workflowType === 'saree_step1_two_input' && w.isActive)
                        .map((w) => ({ id: w.id, label: `${w.label} (${w.slug})` }))}
                      value={mannequinTwoInputWorkflowTemplateId}
                      disabled={saving}
                      emptyLabel="— none —"
                      placeholder="— search workflow —"
                      onChange={setMannequinTwoInputWorkflowTemplateId}
                    />
                    <span className="hint">
                      Optional. When set, the studio wizard offers a "Body & Pallu" two-image
                      upload mode for this garment type, using this workflow instead of the one
                      above.
                    </span>
                  </div>
                  <div className="field">
                    <label>Draping (Step 2) Workflow</label>
```

- [ ] **Step 4: Verify it typechecks and builds**

```bash
pnpm --filter @tryme/admin build
```

Expected: no TypeScript errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/components/EditGarmentTypeModal.tsx
git commit -m "feat(admin): add two-input mannequin workflow field to garment type editor"
```

---

### Task 6: Admin-web — `WorkflowUploadModal.tsx` four-type upload form

**Files:**
- Modify: `apps/admin-web/src/components/WorkflowUploadModal.tsx`

**Interfaces:**
- Consumes: `detectTryonTwoInputMappings`'s response shape (via `POST /admin/workflows/parse`, Task 4), `WorkflowOption` (Task 5).
- Produces: admins can create `saree_step1_two_input` workflows end-to-end from the upload modal.

- [ ] **Step 1: Add state**

Line 121, widen the type:
```ts
  const [workflowType, setWorkflowType] = useState<'regular' | 'tryon' | 'saree_step1'>('regular');
```
→
```ts
  const [workflowType, setWorkflowType] = useState<
    'regular' | 'tryon' | 'saree_step1' | 'saree_step1_two_input'
  >('regular');
```

Line 144, after `tryonGarmentNodeId` state:
```ts
  const [tryonGarmentNodeId, setTryonGarmentNodeId] = useState('');
```
→
```ts
  const [tryonGarmentNodeId, setTryonGarmentNodeId] = useState('');
  const [tryonGarmentNodeId2, setTryonGarmentNodeId2] = useState('');
```

- [ ] **Step 2: Update `handleParse` to read the two-input detection response**

Line 187-205:
```ts
      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
        const d = result.detected as {
          personNodeId?: string;
          garmentNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
          defaultPositivePrompt?: string;
          defaultNegativePrompt?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.garmentNodeId ?? '');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
        setTryonPositivePrompt(d.defaultPositivePrompt ?? '');
        setTryonNegativePrompt(d.defaultNegativePrompt ?? '');
        return;
      }
```
→
```ts
      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
        const d = result.detected as {
          personNodeId?: string;
          garmentNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
          defaultPositivePrompt?: string;
          defaultNegativePrompt?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.garmentNodeId ?? '');
        setTryonGarmentNodeId2('');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
        setTryonPositivePrompt(d.defaultPositivePrompt ?? '');
        setTryonNegativePrompt(d.defaultNegativePrompt ?? '');
        return;
      }

      if (workflowType === 'saree_step1_two_input') {
        const d = result.detected as {
          personNodeId?: string;
          bodyNodeId?: string;
          palluNodeId?: string;
          outputNodeId?: string;
          positivePromptNode?: string;
          negativePromptNode?: string;
          defaultPositivePrompt?: string;
          defaultNegativePrompt?: string;
        };
        setTryonPersonNodeId(d.personNodeId ?? '');
        setTryonGarmentNodeId(d.bodyNodeId ?? '');
        setTryonGarmentNodeId2(d.palluNodeId ?? '');
        setTryonOutputNodeId(d.outputNodeId ?? '');
        setPositivePromptNode(d.positivePromptNode ?? '');
        setNegativePromptNode(d.negativePromptNode ?? '');
        setTryonPositivePrompt(d.defaultPositivePrompt ?? '');
        setTryonNegativePrompt(d.defaultNegativePrompt ?? '');
        return;
      }
```

- [ ] **Step 3: Update submit validation, payload, and `canSubmit`**

Line 235-243, `handleSubmit`'s validation:
```ts
    if (workflowType === 'tryon' || workflowType === 'saree_step1') {
      if (!tryonGarmentNodeId.trim() || !tryonOutputNodeId.trim()) {
        setError('Garment and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else {
```
→
```ts
    if (workflowType === 'tryon' || workflowType === 'saree_step1') {
      if (!tryonGarmentNodeId.trim() || !tryonOutputNodeId.trim()) {
        setError('Garment and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else if (workflowType === 'saree_step1_two_input') {
      if (!tryonGarmentNodeId.trim() || !tryonGarmentNodeId2.trim() || !tryonOutputNodeId.trim()) {
        setError('Body, pallu, and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else {
```

Line 270-281, the payload assembly:
```ts
      let payload: Record<string, unknown>;
      if (workflowType === 'tryon' || workflowType === 'saree_step1') {
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType,
          tryonPersonNodeId: tryonPersonNodeId.trim() || undefined,
          tryonGarmentNodeId: tryonGarmentNodeId.trim(),
          tryonOutputNodeId: tryonOutputNodeId.trim(),
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
        };
      } else {
```
→
```ts
      let payload: Record<string, unknown>;
      if (
        workflowType === 'tryon' ||
        workflowType === 'saree_step1' ||
        workflowType === 'saree_step1_two_input'
      ) {
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType,
          tryonPersonNodeId: tryonPersonNodeId.trim() || undefined,
          tryonGarmentNodeId: tryonGarmentNodeId.trim(),
          ...(workflowType === 'saree_step1_two_input'
            ? { tryonGarmentNodeId2: tryonGarmentNodeId2.trim() }
            : {}),
          tryonOutputNodeId: tryonOutputNodeId.trim(),
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
        };
      } else {
```

Line 361-376, `canSubmit`:
```ts
  const canSubmit =
    !saving &&
    jsonFile &&
    slug.trim() &&
    label.trim() &&
    (workflowType === 'tryon' || workflowType === 'saree_step1'
      ? parsed &&
        tryonGarmentNodeId &&
        tryonOutputNodeId &&
        positivePromptNode &&
        negativePromptNode
      : parsed &&
        poseNodeId &&
        positivePromptNode &&
        (!faceNodeId || negativePromptNode) &&
        (upperNodeIds.filter(Boolean).length > 0 || lowerNodeId));
```
→
```ts
  const canSubmit =
    !saving &&
    jsonFile &&
    slug.trim() &&
    label.trim() &&
    (workflowType === 'tryon' || workflowType === 'saree_step1'
      ? parsed &&
        tryonGarmentNodeId &&
        tryonOutputNodeId &&
        positivePromptNode &&
        negativePromptNode
      : workflowType === 'saree_step1_two_input'
        ? parsed &&
          tryonGarmentNodeId &&
          tryonGarmentNodeId2 &&
          tryonOutputNodeId &&
          positivePromptNode &&
          negativePromptNode
        : parsed &&
          poseNodeId &&
          positivePromptNode &&
          (!faceNodeId || negativePromptNode) &&
          (upperNodeIds.filter(Boolean).length > 0 || lowerNodeId));
```

- [ ] **Step 4: Update the workflow-type selector buttons**

Line 409-426:
```ts
            {(['regular', 'tryon', 'saree_step1'] as const).map((t) => (
              <button
                key={t}
                className={`btn sm ${workflowType === t ? 'primary' : 'ghost'}`}
                disabled={saving}
                onClick={() => {
                  setWorkflowType(t);
                  setError(null);
                }}
                style={{ textTransform: 'capitalize' }}
              >
                {t === 'tryon'
                  ? 'Tryon (person + garment)'
                  : t === 'saree_step1'
                    ? 'Saree Step 1 (mannequin)'
                    : 'Catalogue workflows (pose-based)'}
              </button>
            ))}
```
→
```ts
            {(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input'] as const).map((t) => (
              <button
                key={t}
                className={`btn sm ${workflowType === t ? 'primary' : 'ghost'}`}
                disabled={saving}
                onClick={() => {
                  setWorkflowType(t);
                  setError(null);
                }}
                style={{ textTransform: 'capitalize' }}
              >
                {t === 'tryon'
                  ? 'Tryon (person + garment)'
                  : t === 'saree_step1'
                    ? 'Saree Step 1 (mannequin)'
                    : t === 'saree_step1_two_input'
                      ? 'Saree Step 1 (body + pallu)'
                      : 'Catalogue workflows (pose-based)'}
              </button>
            ))}
```

- [ ] **Step 5: Gate the Parse button and node-field section, add the pallu input**

Line 535-537:
```ts
              {(workflowType === 'regular' ||
                workflowType === 'tryon' ||
                workflowType === 'saree_step1') && (
```
→
```ts
              {(workflowType === 'regular' ||
                workflowType === 'tryon' ||
                workflowType === 'saree_step1' ||
                workflowType === 'saree_step1_two_input') && (
```

Line 567:
```ts
          {(workflowType === 'tryon' || workflowType === 'saree_step1') && parsed && (
```
→
```ts
          {(workflowType === 'tryon' ||
            workflowType === 'saree_step1' ||
            workflowType === 'saree_step1_two_input') &&
            parsed && (
```

The paren/brace count is unchanged from the original (same `{(...) && parsed && (<>...</>)}` shape, condition just reformatted onto multiple lines) — the existing closing `)}` at the end of this fragment stays exactly as-is.

Inside that block, after the "Garment node" field (lines 608-618), add a pallu field only for the two-input type:
```ts
                <div className="field">
                  <label>
                    Garment node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={tryonGarmentNodeId}
                    disabled={saving}
                    onChange={(e) => setTryonGarmentNodeId(e.target.value.trim())}
                  />
                </div>
                <div className="field">
                  <label>
                    Output node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
```
→
```ts
                <div className="field">
                  <label>
                    {workflowType === 'saree_step1_two_input' ? 'Body node' : 'Garment node'}{' '}
                    <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    className="input"
                    value={tryonGarmentNodeId}
                    disabled={saving}
                    onChange={(e) => setTryonGarmentNodeId(e.target.value.trim())}
                  />
                </div>
                {workflowType === 'saree_step1_two_input' && (
                  <div className="field">
                    <label>
                      Pallu node <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <input
                      className="input"
                      value={tryonGarmentNodeId2}
                      disabled={saving}
                      onChange={(e) => setTryonGarmentNodeId2(e.target.value.trim())}
                    />
                  </div>
                )}
                <div className="field">
                  <label>
                    Output node <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
```

- [ ] **Step 6: Verify it typechecks and builds**

```bash
pnpm --filter @tryme/admin build
```

Expected: no TypeScript/JSX errors. If the grid layout (`gridTemplateColumns: '1fr 1fr 1fr'` around the person/garment/output row) looks cramped with 4 fields in the two-input case, that's a cosmetic follow-up, not a build blocker — confirm visually in Task 11's manual pass.

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/components/WorkflowUploadModal.tsx
git commit -m "feat(admin): support creating saree_step1_two_input workflows"
```

---

### Task 7: Admin-web — `WorkflowsPage.tsx` badge + detail view

**Files:**
- Modify: `apps/admin-web/src/pages/WorkflowsPage.tsx`

**Interfaces:**
- Consumes: `WorkflowOption.workflowType`/`tryonGarmentNodeId2` (Task 5).

- [ ] **Step 1: Add `tryonGarmentNodeId2` to `WorkflowDetail`**

Line 9-28, `WorkflowDetail` interface — after `upperNodeIds`:
```ts
interface WorkflowDetail extends WorkflowOption {
  faceNodeId: string;
  poseNodeId: string;
  bgNodeId: string;
  upperNodeIds: string[];
```
stays the same (it already extends `WorkflowOption`, which now carries `tryonGarmentNodeId2` from Task 5) — no change needed here.

- [ ] **Step 2: Add the badge color/label**

Lines 289-307:
```ts
                        background:
                          wf.workflowType === 'tryon'
                            ? 'rgba(236,72,153,0.12)'
                            : wf.workflowType === 'saree_step1'
                              ? 'rgba(217,119,6,0.12)'
                              : 'rgba(37,99,235,0.1)',
                        color:
                          wf.workflowType === 'tryon'
                            ? '#be185d'
                            : wf.workflowType === 'saree_step1'
                              ? '#b45309'
                              : '#1d4ed8',
                      }}
                    >
                      {wf.workflowType === 'tryon'
                        ? 'Tryon'
                        : wf.workflowType === 'saree_step1'
                          ? 'Saree Step 1'
                          : 'Catalogue workflows'}
```
→
```ts
                        background:
                          wf.workflowType === 'tryon'
                            ? 'rgba(236,72,153,0.12)'
                            : wf.workflowType === 'saree_step1'
                              ? 'rgba(217,119,6,0.12)'
                              : wf.workflowType === 'saree_step1_two_input'
                                ? 'rgba(139,92,246,0.12)'
                                : 'rgba(37,99,235,0.1)',
                        color:
                          wf.workflowType === 'tryon'
                            ? '#be185d'
                            : wf.workflowType === 'saree_step1'
                              ? '#b45309'
                              : wf.workflowType === 'saree_step1_two_input'
                                ? '#6d28d9'
                                : '#1d4ed8',
                      }}
                    >
                      {wf.workflowType === 'tryon'
                        ? 'Tryon'
                        : wf.workflowType === 'saree_step1'
                          ? 'Saree Step 1'
                          : wf.workflowType === 'saree_step1_two_input'
                            ? 'Saree Step 1 (2-input)'
                            : 'Catalogue workflows'}
```

- [ ] **Step 3: Add the pallu row to the node-mappings detail view**

Lines 460-466:
```ts
                    {(viewingDetail.workflowType === 'tryon' ||
                    viewingDetail.workflowType === 'saree_step1'
                      ? [
                          ['Person node', viewingDetail.tryonPersonNodeId ?? '—'],
                          ['Garment node', viewingDetail.tryonGarmentNodeId ?? '—'],
                          ['Output node', viewingDetail.tryonOutputNodeId ?? '—'],
                        ]
                      : [
```
→
```ts
                    {(viewingDetail.workflowType === 'tryon' ||
                    viewingDetail.workflowType === 'saree_step1' ||
                    viewingDetail.workflowType === 'saree_step1_two_input'
                      ? [
                          ['Person node', viewingDetail.tryonPersonNodeId ?? '—'],
                          [
                            viewingDetail.workflowType === 'saree_step1_two_input'
                              ? 'Body node'
                              : 'Garment node',
                            viewingDetail.tryonGarmentNodeId ?? '—',
                          ],
                          ...(viewingDetail.workflowType === 'saree_step1_two_input'
                            ? [['Pallu node', viewingDetail.tryonGarmentNodeId2 ?? '—']]
                            : []),
                          ['Output node', viewingDetail.tryonOutputNodeId ?? '—'],
                        ]
                      : [
```

- [ ] **Step 4: Verify it typechecks and builds**

```bash
pnpm --filter @tryme/admin build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/pages/WorkflowsPage.tsx
git commit -m "feat(admin): show saree_step1_two_input badge and pallu node in workflow detail"
```

---

### Task 8: API — `createSareeMannequinJob` two-input support

**Files:**
- Modify: `apps/api/src/modules/jobs/createSareeMannequin.ts`
- Modify: `apps/api/src/modules/models/routes.ts:18-34`
- Test: `apps/api/test/integration/saree-mannequin-job.test.ts`

**Interfaces:**
- Consumes: `secondGarmentKey` (Task 2), `schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId` (Task 1).
- Produces: `POST /v1/jobs/saree-mannequin` accepts `secondGarmentKey`, snapshots the two-input workflow into `params.workflowTemplateId`, and stores the pallu key in `job_inputs.thirdGarmentKey`. Consumed by Task 9 (dispatcher). `GET /v1/models/garment-types` exposes `mannequinTwoInputWorkflowTemplateId` for the frontend gate (Task 11).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/saree-mannequin-job.test.ts`, a new helper and test (place the helper near `seedFlatSareeGarmentType`, the test after the existing happy-path test):

```ts
  async function seedFlatSareeGarmentTypeTwoInput(
    mannequinWorkflowTemplateId: string | null,
    mannequinTwoInputWorkflowTemplateId: string | null,
  ) {
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-two-input-${Date.now()}`,
        label: 'Flat Saree',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId,
        mannequinTwoInputWorkflowTemplateId,
      })
      .returning();
    return gt.id;
  }
```

```ts
  it('creates a two-input mannequin job snapshotting the two-input workflow into params', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('mannequin-two-input@x.com');
    await grantCredits(userId, 100);
    const faceId = await seedFace();
    const backgroundId = await seedActiveBackground();
    const poseId = await seedActivePose();

    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-${Date.now()}`,
        label: 'Step1',
        jsonContent: {},
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
      })
      .returning();
    const [twoInputWf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-two-input-${Date.now()}`,
        label: 'Step1 Two Input',
        jsonContent: {},
        workflowType: 'saree_step1_two_input',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonGarmentNodeId2: '3',
        tryonOutputNodeId: '4',
      })
      .returning();
    const [step2Wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step2-${Date.now()}`,
        label: 'Step2',
        jsonContent: {},
        workflowType: 'saree_step2',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: ['10'],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
      })
      .returning();
    const garmentTypeId = await seedFlatSareeGarmentTypeTwoInput(wf.id, twoInputWf.id);
    await app.db
      .update(schema.garmentSubcategories)
      .set({ sareeStep2WorkflowTemplateId: step2Wf.id })
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));

    const garmentKey = `inputs/${userId}/garment.jpg`;
    const secondGarmentKey = `inputs/${userId}/pallu.jpg`;
    await bindUploadKey(userId, garmentKey);
    await bindUploadKey(userId, secondGarmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree-mannequin',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId,
        garmentKey,
        secondGarmentKey,
        faceId,
        step2: {
          inputs: { faceId, backgroundId, poseIds: [poseId], garmentTypeId },
          aspectRatio: '1:1',
          resolution: 'HD',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [step2Inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    const step2Params = step2Inputs?.params as { mannequinJobId?: string };

    const [mannequinInputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, step2Params.mannequinJobId as string));
    expect(mannequinInputs?.upperGarmentKey).toBe(garmentKey);
    expect(mannequinInputs?.thirdGarmentKey).toBe(secondGarmentKey);
    const mannequinParams = mannequinInputs?.params as { workflowTemplateId?: string };
    expect(mannequinParams?.workflowTemplateId).toBe(twoInputWf.id);
  });

  it('rejects secondGarmentKey when the garment type has no two-input workflow configured', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('mannequin-two-input-noconf@x.com');
    const faceId = await seedFace();
    const garmentTypeId = await seedFlatSareeGarmentTypeTwoInput(null, null);
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-noconf-${Date.now()}`,
        label: 'Step1',
        jsonContent: {},
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
      })
      .returning();
    await app.db
      .update(schema.garmentSubcategories)
      .set({ mannequinWorkflowTemplateId: wf.id })
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));

    const garmentKey = `inputs/${userId}/garment.jpg`;
    const secondGarmentKey = `inputs/${userId}/pallu.jpg`;
    await bindUploadKey(userId, garmentKey);
    await bindUploadKey(userId, secondGarmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree-mannequin',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId,
        garmentKey,
        secondGarmentKey,
        faceId,
        step2: {
          inputs: {
            faceId,
            backgroundId: '00000000-0000-0000-0000-000000000000',
            poseIds: ['00000000-0000-0000-0000-000000000000'],
          },
          aspectRatio: '1:1',
          resolution: 'HD',
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- saree-mannequin-job
```

Expected: FAIL — zod strips/rejects `secondGarmentKey` (not yet in the schema before Task 2... it already is from Task 2, so instead this fails because `createSareeMannequinJob` doesn't read `secondGarmentKey`, doesn't check `mannequinTwoInputWorkflowTemplateId`, and doesn't snapshot `params.workflowTemplateId` — the first test's assertion on `mannequinParams?.workflowTemplateId` fails, and the second test gets 201 instead of 400).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/jobs/createSareeMannequin.ts`, change:
```ts
export async function createSareeMannequinJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeMannequinJobRequest>,
): Promise<{ catalogueId: string; jobIds: string[] }> {
  const { garmentTypeId, garmentKey, faceId, step2 } = body;

  await assertOwnsUploadKey(app, userId, garmentKey);

  const [garmentType] = await app.db
    .select({
      isActive: schema.garmentSubcategories.isActive,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, garmentTypeId));
  if (!garmentType?.isActive || !garmentType.requiresMannequinStep) {
    throw new AppError('BAD_CATALOG', 400, 'garment type does not use a mannequin step');
  }
  if (!garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('CONFIG', 400, 'garment type missing step-1 workflow configuration');
  }
```
→
```ts
export async function createSareeMannequinJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeMannequinJobRequest>,
): Promise<{ catalogueId: string; jobIds: string[] }> {
  const { garmentTypeId, garmentKey, secondGarmentKey, faceId, step2 } = body;

  await assertOwnsUploadKey(app, userId, garmentKey);
  if (secondGarmentKey) {
    await assertOwnsUploadKey(app, userId, secondGarmentKey);
  }

  const [garmentType] = await app.db
    .select({
      isActive: schema.garmentSubcategories.isActive,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, garmentTypeId));
  if (!garmentType?.isActive || !garmentType.requiresMannequinStep) {
    throw new AppError('BAD_CATALOG', 400, 'garment type does not use a mannequin step');
  }
  if (secondGarmentKey) {
    if (!garmentType.mannequinTwoInputWorkflowTemplateId) {
      throw new AppError(
        'CONFIG',
        400,
        'garment type missing two-input step-1 workflow configuration',
      );
    }
  } else if (!garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('CONFIG', 400, 'garment type missing step-1 workflow configuration');
  }
```

Then find the mannequin job's `job_inputs` insert:
```ts
    await tx.insert(schema.jobInputs).values({
      jobId: mannequinJob.id,
      upperGarmentKey: garmentKey,
      faceId,
      garmentTypeId,
      params: { kind: 'saree_mannequin' },
    });
```
→
```ts
    await tx.insert(schema.jobInputs).values({
      jobId: mannequinJob.id,
      upperGarmentKey: garmentKey,
      thirdGarmentKey: secondGarmentKey ?? null,
      faceId,
      garmentTypeId,
      params: secondGarmentKey
        ? { kind: 'saree_mannequin', workflowTemplateId: garmentType.mannequinTwoInputWorkflowTemplateId }
        : { kind: 'saree_mannequin' },
    });
```

- [ ] **Step 4: Expose the field on `/v1/models/garment-types`**

In `apps/api/src/modules/models/routes.ts`, lines 26-33:
```ts
          requiresLowerUpload: schema.garmentSubcategories.requiresLowerUpload,
          upperUploadLabel: schema.garmentSubcategories.upperUploadLabel,
          lowerUploadLabel: schema.garmentSubcategories.lowerUploadLabel,
          requiresThirdUpload: schema.garmentSubcategories.requiresThirdUpload,
          thirdUploadLabel: schema.garmentSubcategories.thirdUploadLabel,
          defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
          defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
          requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
```
→
```ts
          requiresLowerUpload: schema.garmentSubcategories.requiresLowerUpload,
          upperUploadLabel: schema.garmentSubcategories.upperUploadLabel,
          lowerUploadLabel: schema.garmentSubcategories.lowerUploadLabel,
          requiresThirdUpload: schema.garmentSubcategories.requiresThirdUpload,
          thirdUploadLabel: schema.garmentSubcategories.thirdUploadLabel,
          defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
          defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
          requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
          mannequinTwoInputWorkflowTemplateId:
            schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @tryme/api test -- saree-mannequin-job
```

Expected: all tests in the file PASS, including the 2 new ones and the pre-existing 4 (regression check).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/jobs/createSareeMannequin.ts apps/api/src/modules/models/routes.ts apps/api/test/integration/saree-mannequin-job.test.ts
git commit -m "feat(api): support two-input (body+pallu) saree mannequin job creation"
```

---

### Task 9: Dispatcher — `processSareeMannequinJob` patches the second garment node

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`
- Test: `apps/dispatcher/test/integration/saree-mannequin.test.ts`

**Interfaces:**
- Consumes: `job_inputs.thirdGarmentKey` (pallu, from Task 8), `workflow_templates.tryonGarmentNodeId2` (Task 1).
- Produces: a two-input mannequin job (`thirdGarmentKey` set + resolved template has `tryonGarmentNodeId2`) patches both garment nodes and completes normally.

- [ ] **Step 1: Write the failing test**

Add to `apps/dispatcher/test/integration/saree-mannequin.test.ts`, a new seed helper + test after the existing tests, before the closing `});` of the `describe`:

```ts
  async function seedTwoInputMannequinJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-two-input-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-two-input-${Date.now()}`,
        label: 'Step1 Two Input',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '3': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1_two_input',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonGarmentNodeId2: '3',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-two-input-${Date.now()}`,
        label: 'Flat Saree Two Input',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'face/ftwoinput.jpg',
        thumbnailKey: 'face/ftwoinput.jpg',
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      thirdGarmentKey: `inputs/${job.id}/pallu.jpg`,
      faceId: face.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin', workflowTemplateId: template.id },
    });

    for (const key of [
      `inputs/${job.id}/garment.jpg`,
      `inputs/${job.id}/pallu.jpg`,
      'face/ftwoinput.jpg',
    ]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job.id, userId: user.id };
  }

  it('patches both body and pallu nodes for a two-input mannequin job', async () => {
    const { jobId, userId } = await seedTwoInputMannequinJob();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-5',
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');

    const prompt = comfy.lastPrompt();
    expect(prompt?.prompt['2']?.inputs?.image).toBeTruthy();
    expect(prompt?.prompt['3']?.inputs?.image).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/dispatcher test -- saree-mannequin
```

Expected: FAIL — node `'3'` (pallu) is never patched (undefined `inputs.image`), because the processor doesn't yet read `tryonGarmentNodeId2`/`thirdGarmentKey`.

- [ ] **Step 3: Implement**

In `apps/dispatcher/src/job/processor.ts`, inside `processSareeMannequinJob`:

Template select (around the block starting `const [template] = await db.select({...`):
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
→
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

Right after the existing node-config guard:
```ts
  const personNodeId = template.tryonPersonNodeId;
  const garmentNodeId = template.tryonGarmentNodeId;
  const outputNodeId = template.tryonOutputNodeId;
  if (!garmentNodeId || !outputNodeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_NODES_NOT_CONFIGURED',
      jobLog,
      startedAt,
    );
    return;
  }
```
→ add a consistency guard for the pallu role immediately after it:
```ts
  const personNodeId = template.tryonPersonNodeId;
  const garmentNodeId = template.tryonGarmentNodeId;
  const palluNodeId = template.tryonGarmentNodeId2;
  const outputNodeId = template.tryonOutputNodeId;
  if (!garmentNodeId || !outputNodeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_NODES_NOT_CONFIGURED',
      jobLog,
      startedAt,
    );
    return;
  }
  if (inputs.thirdGarmentKey && !palluNodeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_NODES_NOT_CONFIGURED',
      jobLog,
      startedAt,
    );
    return;
  }
  if (palluNodeId && !inputs.thirdGarmentKey) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'MANNEQUIN_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }
```

Then the upload + patch block:
```ts
    jobLog.info('uploading mannequin inputs to ComfyUI');
    const [personFile, garmentFile] = await Promise.all([
      personKey ? uploadToComfy(personKey, 'mannequin_person') : Promise.resolve(undefined),
      uploadToComfy(garmentKey, 'mannequin_garment'),
    ]);
    jobLog.info({ personFile, garmentFile }, 'mannequin inputs uploaded');

    const workflow = structuredClone(template.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    if (personNodeId && personFile && workflow[personNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[personNodeId].inputs!.image = personFile;
    }
    if (workflow[garmentNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[garmentNodeId].inputs!.image = garmentFile;
    }
```
→
```ts
    jobLog.info('uploading mannequin inputs to ComfyUI');
    const [personFile, garmentFile, palluFile] = await Promise.all([
      personKey ? uploadToComfy(personKey, 'mannequin_person') : Promise.resolve(undefined),
      uploadToComfy(garmentKey, 'mannequin_garment'),
      inputs.thirdGarmentKey
        ? uploadToComfy(inputs.thirdGarmentKey, 'mannequin_pallu')
        : Promise.resolve(undefined),
    ]);
    jobLog.info({ personFile, garmentFile, palluFile }, 'mannequin inputs uploaded');

    const workflow = structuredClone(template.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    if (personNodeId && personFile && workflow[personNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[personNodeId].inputs!.image = personFile;
    }
    if (workflow[garmentNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[garmentNodeId].inputs!.image = garmentFile;
    }
    if (palluNodeId && palluFile && workflow[palluNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[palluNodeId].inputs!.image = palluFile;
    }
```

And the `COMFY_DISPATCH` event payload's `inputs` field, right below:
```ts
    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: w.id,
        workerUrl: w.url,
        workflowTemplateId,
        inputs: { garmentKey, personKey, personFile, garmentFile },
      },
    });
```
→
```ts
    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: w.id,
        workerUrl: w.url,
        workflowTemplateId,
        inputs: {
          garmentKey,
          personKey,
          personFile,
          garmentFile,
          palluKey: inputs.thirdGarmentKey,
          palluFile,
        },
      },
    });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @tryme/dispatcher test -- saree-mannequin
```

Expected: all tests in the file PASS, including the new one and the 4 pre-existing (regression check for the single-input path — `palluNodeId`/`inputs.thirdGarmentKey` are both undefined there, so neither new guard fires and `palluFile` stays `undefined`, unpatched).

- [ ] **Step 5: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/test/integration/saree-mannequin.test.ts
git commit -m "feat(dispatcher): patch pallu node for two-input saree mannequin jobs"
```

---

### Task 10: Studio wizard — upload-mode dropdown + two upload boxes

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: `mannequinTwoInputWorkflowTemplateId` on `GarmentType` (Task 8), `secondGarmentKey` on the `/v1/jobs/saree-mannequin` request (Task 8).

- [ ] **Step 1: Widen the `GarmentType` interface**

Lines 18-32:
```ts
interface GarmentType {
  id: string;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  instructionImageUrl?: string | null;
  requiresLowerUpload: boolean;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  requiresMannequinStep?: boolean;
  requiresThirdUpload?: boolean;
  thirdUploadLabel?: string | null;
}
```
→
```ts
interface GarmentType {
  id: string;
  slug: string;
  label: string;
  thumbnailUrl?: string | null;
  instructionImageUrl?: string | null;
  requiresLowerUpload: boolean;
  upperUploadLabel?: string | null;
  lowerUploadLabel?: string | null;
  defaultLowerCatalogId?: string | null;
  defaultShoeCatalogId?: string | null;
  requiresMannequinStep?: boolean;
  requiresThirdUpload?: boolean;
  thirdUploadLabel?: string | null;
  mannequinTwoInputWorkflowTemplateId?: string | null;
}
```

- [ ] **Step 2: Add pallu upload state**

The file currently has, at lines 503-506:

```ts
  const [thirdGarmentKey, setThirdGarmentKey] = useState('');
  const [isUploadingThird, setIsUploadingThird] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
```

Insert the pallu state and the upload-mode dropdown state between the `isUploadingThird` line and the `uploadProgress` line, leaving `uploadProgress`/`isUploading` untouched:

```ts
  const [thirdGarmentKey, setThirdGarmentKey] = useState('');
  const [isUploadingThird, setIsUploadingThird] = useState(false);
  const [palluGarmentFile, setPalluGarmentFile] = useState<File | null>(null);
  const palluGarmentPreviewUrl = useMemo(
    () => (palluGarmentFile ? URL.createObjectURL(palluGarmentFile) : ''),
    [palluGarmentFile],
  );
  useEffect(() => {
    return () => {
      if (palluGarmentPreviewUrl) URL.revokeObjectURL(palluGarmentPreviewUrl);
    };
  }, [palluGarmentPreviewUrl]);
  const [palluGarmentKey, setPalluGarmentKey] = useState('');
  const [isUploadingPallu, setIsUploadingPallu] = useState(false);
  const [sareeUploadMode, setSareeUploadMode] = useState<'single' | 'two_input'>('single');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
```

Refs — after `const thirdUploadAbortRef = useRef<AbortController | null>(null);` (line 512), add:
```ts
  const palluFileInputRef = useRef<HTMLInputElement>(null);
  const palluUploadAbortRef = useRef<AbortController | null>(null);
```

And in the unmount-abort effect (lines 515-521):
```ts
  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      lowerUploadAbortRef.current?.abort();
      thirdUploadAbortRef.current?.abort();
```
→
```ts
  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      lowerUploadAbortRef.current?.abort();
      thirdUploadAbortRef.current?.abort();
      palluUploadAbortRef.current?.abort();
```

- [ ] **Step 3: Add `handlePalluGarmentUpload`**

Immediately after the `handleThirdGarmentUpload` function (mirror its body exactly, per the pattern already shared by `handleLowerGarmentUpload`/`handleThirdGarmentUpload`):

```ts
  async function handlePalluGarmentUpload(file: File) {
    if (isUploadingPallu) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setPalluGarmentFile(file);
    setIsUploadingPallu(true);
    const palluAbort = new AbortController();
    palluUploadAbortRef.current = palluAbort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {}, palluAbort.signal);
      setPalluGarmentKey(r2Key);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = (e as Error).message ?? '';
      showToast(
        msg.includes('403')
          ? 'Upload session expired. Please re-select your image and try again.'
          : `Pallu upload failed: ${msg}`,
      );
      setPalluGarmentFile(null);
      setPalluGarmentKey('');
    } finally {
      setIsUploadingPallu(false);
    }
  }
```

- [ ] **Step 4: Compute the two-input gate and extend validation**

Lines 1274-1276:
```ts
  const requiresLowerUpload = selectedGarmentType?.requiresLowerUpload ?? false;
  const requiresThirdUpload = selectedGarmentType?.requiresThirdUpload ?? false;
  const hasMultipleUploadBoxes = requiresLowerUpload || requiresThirdUpload;
```
→
```ts
  const requiresLowerUpload = selectedGarmentType?.requiresLowerUpload ?? false;
  const requiresThirdUpload = selectedGarmentType?.requiresThirdUpload ?? false;
  const sareeTwoInputCapable =
    !!selectedGarmentType?.requiresMannequinStep &&
    !!selectedGarmentType?.mannequinTwoInputWorkflowTemplateId;
  const sareeTwoInputActive = sareeTwoInputCapable && sareeUploadMode === 'two_input';
  const hasMultipleUploadBoxes = requiresLowerUpload || requiresThirdUpload || sareeTwoInputActive;
```

Lines 1279-1310, `canGenerate`/`generateBlocker`:
```ts
  const creditCost = resolution ? RESOLUTION_COSTS[resolution] * selectedCount : 0;
  const canGenerate =
    selectedCount > 0 &&
    !!garmentKey &&
    (!requiresLowerUpload || !!lowerGarmentKey) &&
    (!requiresThirdUpload || !!thirdGarmentKey) &&
    !!faceId &&
    (catalogueTemplateId === 'custom' ? !!backgroundId : true) &&
    customDimsReady &&
    !!resolution &&
    !isUploading &&
    !isUploadingLower &&
    !isUploadingThird &&
    !isSubmitting &&
    !generationInProgress;

  const generateBlocker = generationInProgress
    ? 'Generation in progress…'
    : isUploading || isUploadingLower || isUploadingThird
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Upload a garment image first'
        : requiresLowerUpload && !lowerGarmentKey
          ? 'Upload the lower garment image first'
          : requiresThirdUpload && !thirdGarmentKey
            ? 'Upload the third garment image first'
            : selectedCount === 0
              ? catalogueTemplateId === 'custom'
                ? 'Select at least one pose'
                : 'Select at least one look'
              : !customDimsReady
                ? 'Enter valid width and height for custom size'
                : '';
```
→
```ts
  const creditCost = resolution ? RESOLUTION_COSTS[resolution] * selectedCount : 0;
  const canGenerate =
    selectedCount > 0 &&
    !!garmentKey &&
    (!requiresLowerUpload || !!lowerGarmentKey) &&
    (!requiresThirdUpload || !!thirdGarmentKey) &&
    (!sareeTwoInputActive || !!palluGarmentKey) &&
    !!faceId &&
    (catalogueTemplateId === 'custom' ? !!backgroundId : true) &&
    customDimsReady &&
    !!resolution &&
    !isUploading &&
    !isUploadingLower &&
    !isUploadingThird &&
    !isUploadingPallu &&
    !isSubmitting &&
    !generationInProgress;

  const generateBlocker = generationInProgress
    ? 'Generation in progress…'
    : isUploading || isUploadingLower || isUploadingThird || isUploadingPallu
      ? 'Waiting for upload to finish…'
      : !garmentKey
        ? 'Upload a garment image first'
        : requiresLowerUpload && !lowerGarmentKey
          ? 'Upload the lower garment image first'
          : requiresThirdUpload && !thirdGarmentKey
            ? 'Upload the third garment image first'
            : sareeTwoInputActive && !palluGarmentKey
              ? 'Upload the pallu image first'
              : selectedCount === 0
                ? catalogueTemplateId === 'custom'
                  ? 'Select at least one pose'
                  : 'Select at least one look'
                : !customDimsReady
                  ? 'Enter valid width and height for custom size'
                  : '';
```

- [ ] **Step 5: Extend `handleSubmit`'s early guard and the mannequin-step API call**

Line 1077:
```ts
    if (!garmentKey || !faceId || !resolution) return;
```
→
```ts
    if (!garmentKey || !faceId || !resolution) return;
    if (sareeTwoInputActive && !palluGarmentKey) return;
```

Lines 1134-1138:
```ts
      if (selectedGarmentType?.requiresMannequinStep) {
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/saree-mannequin',
          { garmentTypeId, garmentKey, faceId, step2: step2Body },
        ));
      } else {
```
→
```ts
      if (selectedGarmentType?.requiresMannequinStep) {
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/saree-mannequin',
          {
            garmentTypeId,
            garmentKey,
            ...(sareeTwoInputActive ? { secondGarmentKey: palluGarmentKey } : {}),
            faceId,
            step2: step2Body,
          },
        ));
      } else {
```

- [ ] **Step 6: Reset pallu state on garment-type change**

Lines 1559-1569, the garment-type `VisualCard` `onClick` handler:
```ts
                          onClick={() => {
                            if (s.id !== garmentTypeId) {
                              setGarmentTypeId(s.id);
                              setFaceId('');
                              setCatalogueTemplateId('custom');
                              setBackgroundId('');
                              setPoseIds([]);
                              setLowerCatalogId('');
                              setShoeCatalogId('');
                            }
                          }}
```
→
```ts
                          onClick={() => {
                            if (s.id !== garmentTypeId) {
                              setGarmentTypeId(s.id);
                              setFaceId('');
                              setCatalogueTemplateId('custom');
                              setBackgroundId('');
                              setPoseIds([]);
                              setLowerCatalogId('');
                              setShoeCatalogId('');
                              setSareeUploadMode('single');
                              setPalluGarmentFile(null);
                              setPalluGarmentKey('');
                            }
                          }}
```

- [ ] **Step 7: Add the dropdown and the label override**

Lines 1578-1584:
```ts
            <section className="studio-section-card" style={sectionCardStyle}>
              <SectionHead
                title={hasMultipleUploadBoxes ? 'Upload Garment Images' : 'Upload Garment Image'}
                subtitle="Upload a clean flat lay garment image"
                stepNumber={3}
              />
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
```
→
```ts
            <section className="studio-section-card" style={sectionCardStyle}>
              <SectionHead
                title={hasMultipleUploadBoxes ? 'Upload Garment Images' : 'Upload Garment Image'}
                subtitle="Upload a clean flat lay garment image"
                stepNumber={3}
              />
              {sareeTwoInputCapable && (
                <div style={{ marginBottom: 12 }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: 12,
                      fontWeight: 500,
                      color: C.mid,
                      marginBottom: 6,
                    }}
                  >
                    Upload type
                  </label>
                  <select
                    value={sareeUploadMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'single' | 'two_input';
                      setSareeUploadMode(mode);
                      if (mode === 'single') {
                        setPalluGarmentFile(null);
                        setPalluGarmentKey('');
                      }
                    }}
                    style={{
                      background: C.field,
                      color: C.text,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: '8px 12px',
                      fontSize: 13,
                      minWidth: 220,
                    }}
                  >
                    <option value="single">Full Saree</option>
                    <option value="two_input">Body & Pallu</option>
                  </select>
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
```

Lines 1762-1767, the upper-box label text:
```ts
                              {hasMultipleUploadBoxes
                                ? selectedGarmentType?.upperUploadLabel ||
                                  `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`
                                : `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`}
```
→
```ts
                              {sareeTwoInputActive
                                ? 'Body'
                                : hasMultipleUploadBoxes
                                  ? selectedGarmentType?.upperUploadLabel ||
                                    `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`
                                  : `Upload ${selectedGarmentType?.label ?? 'Top Wear'}`}
```

- [ ] **Step 8: Add the Pallu upload box**

Immediately after the closing `</label>` of the upper (body) garment box (the label block ending at line 1815, right before `{requiresLowerUpload && (`), insert:

```ts
                    {sareeTwoInputActive && (
                      <label
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 12,
                          background: C.card,
                          border: `1px solid ${C.border}`,
                          borderRadius: 8,
                          padding: 12,
                          cursor: 'pointer',
                          boxSizing: 'border-box',
                          overflow: 'hidden',
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer.files?.[0];
                          if (f && ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
                            handlePalluGarmentUpload(f);
                        }}
                      >
                        {palluGarmentFile ? (
                          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {/* biome-ignore lint/performance/noImgElement: static image, Next Image not needed */}
                            <img
                              src={palluGarmentPreviewUrl}
                              alt={palluGarmentFile.name}
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                borderRadius: 6,
                              }}
                            />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                setPalluGarmentFile(null);
                                setPalluGarmentKey('');
                              }}
                              style={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                width: 24,
                                height: 24,
                                borderRadius: '50%',
                                background: 'rgba(0,0,0,0.5)',
                                border: 'none',
                                color: 'white',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <XIcon size={14} />
                            </button>
                            {isUploadingPallu && (
                              <div
                                style={{
                                  position: 'absolute',
                                  bottom: 8,
                                  left: 8,
                                  right: 8,
                                  background: 'rgba(255,255,255,0.95)',
                                  borderRadius: 8,
                                  padding: '6px 10px',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    fontSize: 12,
                                    color: C.text,
                                  }}
                                >
                                  <SpinnerIcon size={14} /> Uploading…
                                </div>
                              </div>
                            )}
                            {palluGarmentKey && (
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 8,
                                  left: 8,
                                  background: C.mint,
                                  color: 'white',
                                  borderRadius: 6,
                                  padding: '3px 8px',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <CheckIcon color="#fff" size={10} /> Uploaded
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: '100%',
                                  color: C.text,
                                  textAlign: 'center',
                                }}
                              >
                                Pallu
                              </span>
                              <span
                                style={{
                                  width: '100%',
                                  fontSize: 10,
                                  fontWeight: 500,
                                  lineHeight: '140%',
                                  color: C.mid,
                                  textAlign: 'center',
                                }}
                              >
                                JPG, PNG · Max 10MB
                              </span>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                              }}
                            >
                              <ImagePlusIcon size={14} />
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 500,
                                  lineHeight: '18px',
                                  color: C.text,
                                }}
                              >
                                Browse
                              </span>
                            </div>
                          </>
                        )}
                        <input
                          ref={palluFileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handlePalluGarmentUpload(f);
                          }}
                        />
                      </label>
                    )}
```

- [ ] **Step 9: Verify it typechecks**

```bash
pnpm --filter @tryme/web typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 10: Manual smoke test**

```bash
pnpm docker:up
pnpm --filter @tryme/api dev &
pnpm --filter @tryme/web dev
```

In the browser (studio wizard):
1. Pick a gender, then a garment type that does **not** have `mannequinTwoInputWorkflowTemplateId` configured yet → confirm no dropdown appears, upload behaves exactly as before (regression check).
2. In the admin panel, on Flat Saree, set both the Step-1 and the new Two-Input Mannequin workflow (any placeholder workflow is fine for a UI-only smoke test — full ComfyUI round-trip is covered by Tasks 8-9's integration tests). Reload the studio wizard.
3. Select Flat Saree → confirm the "Upload type" dropdown appears, defaulted to "Full Saree", and upload behaves exactly as before.
4. Switch to "Body & Pallu" → confirm two upload boxes appear labeled "Body" and "Pallu"; the Continue/Generate button stays disabled until both are uploaded.
5. Switch back to "Full Saree" → confirm it reverts to the single box and clears the pallu selection.

- [ ] **Step 11: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): add Full Saree / Body & Pallu upload mode to studio wizard"
```

---

### Task 11: Update `docs/progress.md`

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top of the log**

Prepend a new entry (following whatever format the existing top entry uses) summarizing: added `mannequinTwoInputWorkflowTemplateId`/`tryonGarmentNodeId2` columns, `saree_step1_two_input` workflow type with auto-detection, two-input `createSareeMannequinJob` support, dispatcher pallu-node patching, admin UI for configuring/uploading the second workflow, and the studio wizard's "Full Saree / Body & Pallu" dropdown for Flat Saree. Note any Failed/Not Done items surfaced during implementation (e.g. if the manual smoke test in Task 10 Step 10 uncovered a layout issue that was deferred) and any Open Questions (e.g. exact wording of the dropdown/box copy, left as implemented per the design doc's "open implementation details" section).

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log saree two-input upload feature in progress.md"
```

---

## Self-Review Notes

- **Spec coverage:** dropdown UI + gating (Task 10) ✓; two admin-configured workflows (Tasks 5-7) ✓; data model (Task 1) ✓; API job creation + snapshot mechanism (Task 8) ✓; dispatcher node patching (Task 9) ✓; auto-detection (Tasks 3-4) ✓; testing per the spec's Testing section — API integration (Task 8), dispatcher integration (Task 9), admin (Task 4), frontend manual (Task 10 Step 10) ✓.
- **Placeholder scan:** none — every step has real, complete code; no TBD/TODO markers or stub logic anywhere in the plan.
- **Type consistency:** `secondGarmentKey` (API request) → `thirdGarmentKey` (job_inputs column, reused) → `inputs.thirdGarmentKey` (dispatcher) is a deliberate rename-across-layers per the design doc, called out at each hop; `tryonGarmentNodeId2` is spelled identically in schema, types, admin routes, admin-web, and dispatcher throughout.
