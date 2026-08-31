# Tryon Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained "tryon" subsystem: a new `workflowType:'tryon'` with an auto-detecting parser, plus a dedicated admin "Tryon" sidebar section to manage tryon garment-type categories (each assigned one tryon workflow + reference sample images).

**Architecture:** Tryon is isolated from the existing `models`/`catalog` modules. Tryon workflows reuse the `workflow_templates` table (new `tryon_*` node columns + reused prompt columns) and get their own detector file `tryon-detect.ts`. Categories live in two new tables (`tryon_categories`, `tryon_category_samples`) with their own admin routes + page. Runtime execution (dispatcher/job/web) is explicitly out of scope.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM (Postgres), Vitest, React 19 + Vite (admin SPA), pnpm workspaces, R2/MinIO presigned uploads.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-26-tryon-feature-design.md`. Reference sample JSON: `templates/tryonupper25062026 (2).json`.
- ESM only, TypeScript 5.6, Node 20+. pnpm only — never npm/yarn.
- Migration flow (mandatory order): edit schema TS → `pnpm --filter @tryme/db build` → `pnpm db:generate` → `pnpm db:migrate`. The `local-db-sync` pre-push hook BLOCKS push if local `.sql` count > applied count, so always migrate before pushing.
- `@tryme/db` exports `* as schema` from `packages/db/src/index.ts` — do not add a duplicate schema re-export. New tables go in their own schema file, re-exported from `packages/db/src/schema/index.js`.
- All `/admin/*` routes use `requireAdmin([...])`. Tryon admin routes use `requireAdmin(['SUPER_ADMIN','MODERATOR'])` for writes, add `'ADMIN'` for reads (mirror workflows.routes.ts `W`/`R`).
- Admin UI: use `C`/CSS-var design tokens, no raw hex. Logger: pino via `@tryme/logger`, no `console.log` in committed API code (admin SPA `console.error` is fine).
- DB column naming: snake_case in SQL, camelCase in Drizzle. Prompt mapping convention (existing): positive prompt → `garmentPhasePromptNode` / `defaultGarmentPhasePrompt`; negative prompt → `facePhasePromptNode` / `defaultFacePhasePrompt`.
- Commit after each task. Run `pnpm --filter @tryme/api typecheck` and the relevant package build/typecheck before each commit.

---

# INCREMENT 1 — Parser

### Task 1: DB columns for tryon workflow nodes

**Files:**
- Modify: `packages/db/src/schema/models.ts:102-106` (workflow_templates widget block)
- Generated: `packages/db/src/migrations/0063_*.sql` + `meta/_journal.json` + a new snapshot (via drizzle-kit)

**Interfaces:**
- Produces: `schema.workflowTemplates.tryonPersonNodeId`, `.tryonGarmentNodeId`, `.tryonOutputNodeId` (all `text`, nullable).

- [ ] **Step 1: Add the three columns to the schema**

In `packages/db/src/schema/models.ts`, immediately after the existing `widgetOutputNodeId` line (currently line 106), add:

```ts
  // Tryon workflow node IDs — only set when workflowType = 'tryon'
  tryonPersonNodeId: text('tryon_person_node_id'),
  tryonGarmentNodeId: text('tryon_garment_node_id'),
  tryonOutputNodeId: text('tryon_output_node_id'),
```

Also update the comment on line 103 from `// 'regular' | 'widget'` to `// 'regular' | 'widget' | 'tryon'`.

- [ ] **Step 2: Build the db package (drizzle-kit reads dist/)**

Run: `pnpm --filter @tryme/db build`
Expected: `tsc` completes, no errors.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0063_<name>.sql` containing three `ALTER TABLE "workflow_templates" ADD COLUMN ...` statements, plus a new snapshot in `meta/` and a `_journal.json` entry with `idx: 63`.

- [ ] **Step 4: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: `migrations applied` (the NOTICE lines about existing schema/relation are normal).

- [ ] **Step 5: Verify columns exist**

Run: `psql "$DATABASE_URL" -c "\d workflow_templates" | grep tryon`
Expected: three rows — `tryon_person_node_id`, `tryon_garment_node_id`, `tryon_output_node_id`, all `text`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add tryon node columns to workflow_templates"
```

---

### Task 2: Tryon workflow detector + tests

**Files:**
- Create: `apps/api/src/modules/admin/tryon-detect.ts`
- Create: `apps/api/src/modules/admin/tryon-detect.test.ts`

**Interfaces:**
- Consumes: `normaliseTitle`, `classifyNode` from `./workflow-detect.js`.
- Produces: `detectTryonMappings(json: Record<string, unknown>): { detected: DetectedTryonMappings; allImageNodes: ParsedNode[]; allPromptNodes: ParsedNode[] }` where
  `DetectedTryonMappings = { personNodeId?: string; garmentNodeId?: string; outputNodeId?: string; positivePromptNode?: string; negativePromptNode?: string; defaultPositivePrompt: string; defaultNegativePrompt: string }`
  and `ParsedNode = { id: string; class_type: string; title: string; category: NodeCategory }` (re-export the existing `ParsedNode` type from `workflow-detect.ts`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/admin/tryon-detect.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTryonMappings } from './tryon-detect.js';

const sample = JSON.parse(
  readFileSync(join(process.cwd(), '../../templates/tryonupper25062026 (2).json'), 'utf8'),
) as Record<string, unknown>;

describe('detectTryonMappings', () => {
  it('detects person, garment and output nodes from the sample JSON', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.personNodeId).toBe('1000');
    expect(detected.garmentNodeId).toBe('1006');
    expect(detected.outputNodeId).toBe('994');
  });

  it('detects positive and negative prompt nodes via the positive/negative input links', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.positivePromptNode).toBe('1001:111');
    expect(detected.negativePromptNode).toBe('1117');
  });

  it('extracts default prompt text from the detected prompt nodes', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('tryon image2 upperwear');
    expect(detected.defaultNegativePrompt).toContain('plastics hands');
  });

  it('returns the full image and prompt node lists for manual override', () => {
    const { allImageNodes, allPromptNodes } = detectTryonMappings(sample);
    expect(allImageNodes.map((n) => n.id).sort()).toEqual(['1000', '1006']);
    expect(allPromptNodes.map((n) => n.id).sort()).toEqual(['1001:111', '1117']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run src/modules/admin/tryon-detect.test.ts`
Expected: FAIL — `Cannot find module './tryon-detect.js'`.

- [ ] **Step 3: Write the detector**

Create `apps/api/src/modules/admin/tryon-detect.ts`:

```ts
// Tryon workflow node auto-detection. Independent of the regular detectMappings
// because the tryon JSON breaks all of its assumptions:
//   - output node class_type is "Save Image With Callback", not "SaveImage"
//   - prompt nodes feed ControlNetInpaintingAliMamaApply.positive/.negative,
//     not KSampler.positive/.negative directly
//   - input titles are "person"/"garment", not "face"/"upper_garment"
import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

export interface DetectedTryonMappings {
  personNodeId?: string;
  garmentNodeId?: string;
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

// nodeId → list of {consumerId, inputName} that link FROM this node.
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

export function detectTryonMappings(json: Record<string, unknown>): {
  detected: DetectedTryonMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedTryonMappings = {
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

  // ── Pass 1: title / class_type detection ─────────────────────────────────
  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'person') detected.personNodeId = nodeId;
      else if (norm === 'garment') detected.garmentNodeId = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    // Output: class_type contains "Save Image" (matches "Save Image With Callback").
    if (!detected.outputNodeId && classType.includes('Save Image')) {
      detected.outputNodeId = nodeId;
    }
  }

  // Fallback: a single SaveImage node when no "Save Image*" custom node matched.
  if (!detected.outputNodeId) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNodeId = nodeId;
        break;
      }
    }
  }

  // Fallback: if exactly one garment isn't titled, the non-garment image is person.
  if (!detected.personNodeId) {
    const candidate = allImageNodes.find((n) => n.id !== detected.garmentNodeId);
    if (candidate) detected.personNodeId = candidate.id;
  }

  // ── Pass 2: connection-based prompt detection ────────────────────────────
  // A prompt node feeding any consumer input named "positive"/"negative" — works
  // for ControlNet AND KSampler (regular detector requires a Sampler; tryon does not).
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

Run: `pnpm --filter @tryme/api exec vitest run src/modules/admin/tryon-detect.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/tryon-detect.ts apps/api/src/modules/admin/tryon-detect.test.ts
git commit -m "feat(api): tryon workflow node detector"
```

---

### Task 3: Zod schema — tryon workflow fields

**Files:**
- Modify: `packages/types/src/admin.ts:126-196` (`CreateWorkflowBody`)

**Interfaces:**
- Produces: `CreateWorkflowBody` accepts `workflowType: 'regular' | 'widget' | 'tryon'` and optional `tryonPersonNodeId`, `tryonGarmentNodeId`, `tryonOutputNodeId`, `facePhasePromptNode`, `garmentPhasePromptNode` (the prompt fields already exist).

- [ ] **Step 1: Update the enum and add tryon fields**

In `packages/types/src/admin.ts`, change line 136:

```ts
    workflowType: z.enum(['regular', 'widget', 'tryon']).default('regular'),
```

After the widget fields block (after line 157, the `widgetOutputNodeId` line), add:

```ts
    // Tryon workflow fields (required when workflowType = 'tryon')
    tryonPersonNodeId: z.string().min(1).optional(),
    tryonGarmentNodeId: z.string().min(1).optional(),
    tryonOutputNodeId: z.string().min(1).optional(),
```

- [ ] **Step 2: Update the superRefine validation**

Replace the `.superRefine` body (lines 159-191) so the three branches are explicit. Replace the existing `if (val.workflowType === 'regular') { ... } else { ... }` with:

```ts
  .superRefine((val, ctx) => {
    const required =
      val.workflowType === 'regular'
        ? (['faceNodeId', 'poseNodeId', 'bgNodeId', 'upperNodeIds', 'facePhasePromptNode', 'garmentPhasePromptNode'] as const)
        : val.workflowType === 'widget'
          ? (['widgetGarmentNodeId', 'widgetCustomerPhotoNodeId', 'widgetOutputNodeId'] as const)
          : (['tryonPersonNodeId', 'tryonGarmentNodeId', 'tryonOutputNodeId', 'facePhasePromptNode', 'garmentPhasePromptNode'] as const);
    for (const field of required) {
      if (!val[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required for ${val.workflowType} workflows`,
        });
      }
    }
  });
```

- [ ] **Step 3: Typecheck types package**

Run: `pnpm --filter @tryme/types typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/admin.ts
git commit -m "feat(types): tryon workflow fields in CreateWorkflowBody"
```

---

### Task 4: API — parse + create tryon branch

**Files:**
- Modify: `apps/api/src/modules/admin/workflows.routes.ts` (parse route ~124-142, create route body type ~152-174, insert branch after widget block ~222)

**Interfaces:**
- Consumes: `detectTryonMappings` from `./tryon-detect.js`; `CreateWorkflowBody` (Task 3).
- Produces: `POST /admin/workflows/parse` with `{ jsonContent, workflowType:'tryon' }` returns `{ detected, allImageNodes, allPromptNodes }`; `POST /admin/workflows` with `workflowType:'tryon'` inserts a tryon row.

- [ ] **Step 1: Import the tryon detector**

In `apps/api/src/modules/admin/workflows.routes.ts` line 13, change the import to also pull the tryon detector:

```ts
import { classifyNode, detectMappings, type NodeCategory } from './workflow-detect.js';
import { detectTryonMappings } from './tryon-detect.js';
```

- [ ] **Step 2: Branch the parse route on workflowType**

`ParseWorkflowBody` currently only has `jsonContent`. Add an optional `workflowType` to it in `packages/types/src/admin.ts` (line ~194):

```ts
export const ParseWorkflowBody = z.object({
  jsonContent: z.record(z.any()),
  workflowType: z.enum(['regular', 'widget', 'tryon']).optional(),
});
```

Then in the parse handler (workflows.routes.ts ~130-141), after the object-type guard, branch:

```ts
      if ((req.body as { workflowType?: string }).workflowType === 'tryon') {
        const { detected, allImageNodes, allPromptNodes } = detectTryonMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }

      const { detected, allImageNodes, allPromptNodes, allLatentNodes } =
        detectMappings(jsonContent);
      return { detected, allImageNodes, allPromptNodes, allLatentNodes };
```

- [ ] **Step 3: Add tryon fields to the create-route body type**

In the `body` type cast (workflows.routes.ts ~152-174), add after `widgetOutputNodeId?: string;`:

```ts
        tryonPersonNodeId?: string;
        tryonGarmentNodeId?: string;
        tryonOutputNodeId?: string;
```

- [ ] **Step 4: Add the tryon insert branch**

Immediately after the closing `}` of the `if (workflowType === 'widget') { ... }` block (after line 222) and before the `// Regular workflow` comment, insert:

```ts
      if (workflowType === 'tryon') {
        const personNodeId = body.tryonPersonNodeId!;
        const garmentNodeId = body.tryonGarmentNodeId!;
        const outputNodeId = body.tryonOutputNodeId!;
        const negNode = body.facePhasePromptNode!;
        const posNode = body.garmentPhasePromptNode!;

        validateNodeExists(body.jsonContent, personNodeId, 'person');
        validateNodeExists(body.jsonContent, garmentNodeId, 'garment');
        validateNodeExists(body.jsonContent, outputNodeId, 'output');
        validateNodeExists(body.jsonContent, negNode, 'negative prompt');
        validateNodeExists(body.jsonContent, posNode, 'positive prompt');
        validateNodeType(body.jsonContent, personNodeId, 'image', 'person');
        validateNodeType(body.jsonContent, garmentNodeId, 'image', 'garment');
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
            workflowType: 'tryon',
            faceNodeId: '',
            poseNodeId: '',
            bgNodeId: '',
            upperNodeIds: [],
            facePhasePromptNode: negNode,
            garmentPhasePromptNode: posNode,
            defaultFacePhasePrompt,
            defaultGarmentPhasePrompt,
            tryonPersonNodeId: personNodeId,
            tryonGarmentNodeId: garmentNodeId,
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
          tryonOutputNodeId: row?.tryonOutputNodeId,
          createdAt: row?.createdAt,
        };
      }
```

- [ ] **Step 5: Surface tryon fields in the list route**

In `GET /admin/workflows` (the `rows.map`, ~97-118), add after `widgetOutputNodeId: r.widgetOutputNodeId,`:

```ts
      tryonPersonNodeId: r.tryonPersonNodeId,
      tryonGarmentNodeId: r.tryonGarmentNodeId,
      tryonOutputNodeId: r.tryonOutputNodeId,
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/types build && pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/workflows.routes.ts packages/types/src/admin.ts
git commit -m "feat(api): tryon branch in workflow parse + create routes"
```

---

### Task 5: Admin UI — tryon option in WorkflowUploadModal

**Files:**
- Modify: `apps/admin/src/components/WorkflowUploadModal.tsx`

**Interfaces:**
- Consumes: `POST /admin/workflows/parse` with `workflowType:'tryon'`; `POST /admin/workflows`.

- [ ] **Step 1: Widen the workflowType state**

Line 125 — change:

```ts
  const [workflowType, setWorkflowType] = useState<'regular' | 'widget' | 'tryon'>('regular');
```

- [ ] **Step 2: Add tryon node + prompt state**

After the widget state block (after line 148, `setWidgetOutputNodeId`), add:

```ts
  // Tryon workflow node IDs + prompts (auto-detected, overridable)
  const [tryonPersonNodeId, setTryonPersonNodeId] = useState('');
  const [tryonGarmentNodeId, setTryonGarmentNodeId] = useState('');
  const [tryonOutputNodeId, setTryonOutputNodeId] = useState('');
  const [tryonPositivePrompt, setTryonPositivePrompt] = useState('');
  const [tryonNegativePrompt, setTryonNegativePrompt] = useState('');
```

- [ ] **Step 3: Make the Parse handler send workflowType and apply tryon detection**

In `handleParse` (line ~182), change the apiFetch body to include the type, and apply tryon detection when in tryon mode. Replace the `apiFetch<ParseResult>(...)` call and the block that applies detected mappings with:

```ts
      const result = await apiFetch<ParseResult & { detected: Record<string, unknown> }>(
        '/admin/workflows/parse',
        { method: 'POST', body: JSON.stringify({ jsonContent, workflowType }) },
      );
      setParsed(result);

      if (workflowType === 'tryon') {
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

      const d = result.detected as DetectedMappings;
      setFaceNodeId(d.faceNodeId ?? '');
      setPoseNodeId(d.poseNodeId ?? '');
      setBgNodeId(d.bgNodeId ?? '');
      setUpperNodeIds(d.upperNodeIds.length > 0 ? d.upperNodeIds : ['']);
      setLowerNodeId(d.lowerNodeId ?? '');
      setShoeNodeId(d.shoeNodeId ?? '');
      setSizeNodeIds(d.sizeNodeIds ?? []);
      setPositivePromptNode(d.positivePromptNode ?? '');
      setNegativePromptNode(d.negativePromptNode ?? '');
      setLatentSizeNodeIds(d.latentSizeNodeIds ?? []);
      setOutputSizeNodeIds(d.outputSizeNodeIds ?? []);
      setResultNodeId(d.resultNodeId ?? '');
```

- [ ] **Step 4: Add tryon validation + payload in handleSubmit**

In `handleSubmit` (line ~216), add a tryon branch to the validation block. After the `if (workflowType === 'widget') { ... }` validation block, add `else if (workflowType === 'tryon')`:

```ts
    } else if (workflowType === 'tryon') {
      if (!tryonPersonNodeId.trim() || !tryonGarmentNodeId.trim() || !tryonOutputNodeId.trim()) {
        setError('Person, garment, and output node IDs are required');
        return;
      }
      if (!positivePromptNode || !negativePromptNode) {
        setError('Positive and negative prompt nodes are required');
        return;
      }
    } else {
```

(i.e. the existing `else` that handles regular becomes `} else {` after this new branch.)

Then in the payload construction (line ~247), add a tryon payload branch. After the widget `if`, add:

```ts
      } else if (workflowType === 'tryon') {
        payload = {
          slug: slug.trim(),
          label: label.trim(),
          jsonContent,
          workflowType: 'tryon',
          tryonPersonNodeId: tryonPersonNodeId.trim(),
          tryonGarmentNodeId: tryonGarmentNodeId.trim(),
          tryonOutputNodeId: tryonOutputNodeId.trim(),
          facePhasePromptNode: negativePromptNode,
          garmentPhasePromptNode: positivePromptNode,
        };
```

- [ ] **Step 5: Add 'tryon' to the type toggle**

Line ~357 — change the toggle array and label:

```tsx
            {(['regular', 'widget', 'tryon'] as const).map((t) => (
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
                {t === 'widget' ? 'Widget try-on' : t === 'tryon' ? 'Tryon (person + garment)' : 'Regular (pose-based)'}
              </button>
            ))}
```

- [ ] **Step 6: Show the Parse button for tryon too**

Line ~479 — change the Parse-button guard from `workflowType === 'regular'` to:

```tsx
              {(workflowType === 'regular' || workflowType === 'tryon') && (
```

- [ ] **Step 7: Render the tryon form**

After the widget form block (after its closing `)}` at ~586), add a tryon form block:

```tsx
          {workflowType === 'tryon' && parsed && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>Slug <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={slug} disabled={saving}
                    onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
                </div>
                <div className="field">
                  <label>Label <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={label} disabled={saving}
                    onChange={(e) => setLabel(e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>Person node <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={tryonPersonNodeId} disabled={saving}
                    onChange={(e) => setTryonPersonNodeId(e.target.value.trim())} />
                </div>
                <div className="field">
                  <label>Garment node <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={tryonGarmentNodeId} disabled={saving}
                    onChange={(e) => setTryonGarmentNodeId(e.target.value.trim())} />
                </div>
                <div className="field">
                  <label>Output node <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={tryonOutputNodeId} disabled={saving}
                    onChange={(e) => setTryonOutputNodeId(e.target.value.trim())} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field">
                  <label>Positive prompt node <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={positivePromptNode} disabled={saving}
                    onChange={(e) => setPositivePromptNode(e.target.value.trim())} />
                </div>
                <div className="field">
                  <label>Negative prompt node <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="input" value={negativePromptNode} disabled={saving}
                    onChange={(e) => setNegativePromptNode(e.target.value.trim())} />
                </div>
              </div>
              <div className="field">
                <label>Positive prompt (default, editable)</label>
                <textarea className="input" rows={3} value={tryonPositivePrompt} disabled={saving}
                  onChange={(e) => setTryonPositivePrompt(e.target.value)}
                  style={{ fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }} />
              </div>
              <div className="field">
                <label>Negative prompt (default, editable)</label>
                <textarea className="input" rows={3} value={tryonNegativePrompt} disabled={saving}
                  onChange={(e) => setTryonNegativePrompt(e.target.value)}
                  style={{ fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }} />
              </div>
            </>
          )}
```

Note: editable prompt text is captured in state for future use, but the create route currently re-extracts defaults from the JSON node. Storing edited prompt text is deferred (it would require sending `defaultGarmentPhasePrompt`/`defaultFacePhasePrompt` in the payload and accepting them server-side); not in scope for this task. The node-ID fields are what the server consumes.

- [ ] **Step 8: Update canSubmit**

Line ~311 — extend `canSubmit` to handle tryon. Change the ternary to:

```tsx
    (workflowType === 'widget'
      ? widgetGarmentNodeId.trim() && widgetCustomerPhotoNodeId.trim() && widgetOutputNodeId.trim()
      : workflowType === 'tryon'
        ? parsed && tryonPersonNodeId && tryonGarmentNodeId && tryonOutputNodeId && positivePromptNode && negativePromptNode
        : parsed &&
          faceNodeId &&
          poseNodeId &&
          bgNodeId &&
          positivePromptNode &&
          negativePromptNode &&
          upperNodeIds.filter(Boolean).length > 0);
```

- [ ] **Step 9: Typecheck admin**

Run: `cd apps/admin && npx tsc -b && cd ../..`
Expected: no errors.

- [ ] **Step 10: Manual verification**

Run admin dev (`pnpm --filter @tryme/admin dev`) + api dev. Open Workflows → Upload → pick "Tryon", choose `templates/tryonupper25062026 (2).json`, click Parse. Expected: person=1000, garment=1006, output=994, positive=1001:111, negative=1117 pre-filled; Create succeeds; new row appears with `workflowType: tryon`.

- [ ] **Step 11: Commit**

```bash
git add apps/admin/src/components/WorkflowUploadModal.tsx
git commit -m "feat(admin): tryon option in workflow upload modal"
```

---

# INCREMENT 2 — Tryon admin tab

### Task 6: Tryon category tables

**Files:**
- Create: `packages/db/src/schema/tryon.ts`
- Modify: `packages/db/src/schema/index.ts` (add `export * from './tryon.js';`)
- Generated: `packages/db/src/migrations/0064_*.sql` + meta

**Interfaces:**
- Produces: `schema.tryonCategories` (id, name, slug, workflowTemplateId, sortOrder, isActive, createdAt, updatedAt), `schema.tryonCategorySamples` (id, categoryId, r2Key, thumbnailKey, sortOrder, createdAt).

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/tryon.ts`:

```ts
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workflowTemplates } from './models.js';

export const tryonCategories = pgTable('tryon_categories', {
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

export const tryonCategorySamples = pgTable('tryon_category_samples', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id')
    .notNull()
    .references(() => tryonCategories.id, { onDelete: 'cascade' }),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Re-export from schema index**

In `packages/db/src/schema/index.ts`, add after the models line:

```ts
export * from './tryon.js';
```

- [ ] **Step 3: Build, generate, migrate**

Run:
```bash
pnpm --filter @tryme/db build
pnpm db:generate
pnpm db:migrate
```
Expected: `0064_*.sql` created with two `CREATE TABLE` statements + FK constraints; migration applied.

- [ ] **Step 4: Verify**

Run: `psql "$DATABASE_URL" -c "\dt tryon_*"`
Expected: `tryon_categories` and `tryon_category_samples` listed.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/tryon.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(db): tryon_categories + tryon_category_samples tables"
```

---

### Task 7: R2 key builders for tryon samples

**Files:**
- Modify: `packages/storage/src/keys.ts`

**Interfaces:**
- Produces: `keys.tryonSample(categoryId, sampleId)` → `tryon/categories/<categoryId>/<sampleId>.jpg`; `keys.tryonSampleThumb(categoryId, sampleId)` → `...thumb.jpg`.

- [ ] **Step 1: Add the key builders**

In `packages/storage/src/keys.ts`, before the closing `};`, add:

```ts
  tryonSample: (categoryId: string, sampleId: string) =>
    `tryon/categories/${categoryId}/${sampleId}.jpg`,
  tryonSampleThumb: (categoryId: string, sampleId: string) =>
    `tryon/categories/${categoryId}/${sampleId}.thumb.jpg`,
```

- [ ] **Step 2: Build + typecheck**

Run: `pnpm --filter @tryme/storage build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): tryon sample R2 key builders"
```

---

### Task 8: Zod schemas for tryon categories

**Files:**
- Create: `packages/types/src/tryon.ts`
- Modify: `packages/types/src/index.ts` (add `export * from './tryon.js';`)

**Interfaces:**
- Produces: `CreateTryonCategoryBody`, `UpdateTryonCategoryBody`, `TryonSamplePresignBody`, `CreateTryonSampleBody`.

- [ ] **Step 1: Create the schema file**

Create `packages/types/src/tryon.ts`:

```ts
import { z } from 'zod';

export const CreateTryonCategoryBody = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'Slug must be snake_case (lowercase letters, digits, underscores only)'),
  workflowTemplateId: z.string().uuid().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const UpdateTryonCategoryBody = z.object({
  name: z.string().min(1).max(80).optional(),
  workflowTemplateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const TryonSamplePresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

export const CreateTryonSampleBody = z.object({
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
});
```

- [ ] **Step 2: Re-export**

In `packages/types/src/index.ts`, add:

```ts
export * from './tryon.js';
```

- [ ] **Step 3: Build + typecheck**

Run: `pnpm --filter @tryme/types build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/tryon.ts packages/types/src/index.ts
git commit -m "feat(types): tryon category zod schemas"
```

---

### Task 9: API — tryon category routes

**Files:**
- Create: `apps/api/src/modules/admin/tryon.routes.ts`
- Modify: `apps/api/src/server.ts` (import + register)

**Interfaces:**
- Consumes: zod from Task 8, `keys.tryonSample*` from Task 7, `schema.tryonCategories`/`tryonCategorySamples` from Task 6.
- Produces: `GET/POST /admin/tryon-categories`, `PATCH/DELETE /admin/tryon-categories/:id`, `POST /admin/tryon-categories/:id/samples/presign`, `POST /admin/tryon-categories/:id/samples`, `DELETE /admin/tryon-categories/:id/samples/:sampleId`.

- [ ] **Step 1: Create the routes file**

Create `apps/api/src/modules/admin/tryon.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateTryonCategoryBody,
  CreateTryonSampleBody,
  TryonSamplePresignBody,
  UpdateTryonCategoryBody,
} from '@tryme/types';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

export async function adminTryonRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const R = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const uuidParam = z.object({ id: z.string().uuid() });

  // GET /admin/tryon-categories — list with workflow label + samples
  app.get('/admin/tryon-categories', { preHandler: R }, async () => {
    const cats = await app.db
      .select()
      .from(schema.tryonCategories)
      .orderBy(asc(schema.tryonCategories.sortOrder));
    const samples = await app.db
      .select()
      .from(schema.tryonCategorySamples)
      .orderBy(asc(schema.tryonCategorySamples.sortOrder));
    const byCat = new Map<string, typeof samples>();
    for (const s of samples) {
      if (!byCat.has(s.categoryId)) byCat.set(s.categoryId, []);
      byCat.get(s.categoryId)?.push(s);
    }
    return cats.map((c) => ({ ...c, samples: byCat.get(c.id) ?? [] }));
  });

  // POST /admin/tryon-categories
  app.post(
    '/admin/tryon-categories',
    { preHandler: W, schema: { body: CreateTryonCategoryBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateTryonCategoryBody>;
      const [existing] = await app.db
        .select({ id: schema.tryonCategories.id })
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.slug, body.slug));
      if (existing) throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
      const [row] = await app.db
        .insert(schema.tryonCategories)
        .values({
          name: body.name,
          slug: body.slug,
          workflowTemplateId: body.workflowTemplateId ?? null,
          sortOrder: body.sortOrder ?? 0,
          isActive: body.isActive ?? true,
        })
        .returning();
      return { ...row, samples: [] };
    },
  );

  // PATCH /admin/tryon-categories/:id
  app.patch(
    '/admin/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam, body: UpdateTryonCategoryBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateTryonCategoryBody>;
      const [row] = await app.db
        .update(schema.tryonCategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.workflowTemplateId !== undefined
            ? { workflowTemplateId: body.workflowTemplateId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.tryonCategories.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'category not found');
      return row;
    },
  );

  // DELETE /admin/tryon-categories/:id  (cascades samples)
  app.delete(
    '/admin/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await app.db.delete(schema.tryonCategories).where(eq(schema.tryonCategories.id, id));
      return { ok: true };
    },
  );

  // POST /admin/tryon-categories/:id/samples/presign
  app.post(
    '/admin/tryon-categories/:id/samples/presign',
    { preHandler: W, schema: { params: uuidParam, body: TryonSamplePresignBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { contentType } = req.body as z.infer<typeof TryonSamplePresignBody>;
      const sampleId = randomUUID();
      const r2Key = keys.tryonSample(id, sampleId);
      const thumbKey = keys.tryonSampleThumb(id, sampleId);
      const [main, thumb] = await Promise.all([
        app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
        app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300),
      ]);
      return { r2Key, uploadUrl: main.url, thumbnailKey: thumbKey, thumbnailUploadUrl: thumb.url };
    },
  );

  // POST /admin/tryon-categories/:id/samples — record uploaded sample
  app.post(
    '/admin/tryon-categories/:id/samples',
    { preHandler: W, schema: { params: uuidParam, body: CreateTryonSampleBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof CreateTryonSampleBody>;
      const [cat] = await app.db
        .select({ id: schema.tryonCategories.id })
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.id, id));
      if (!cat) throw new AppError('NOT_FOUND', 404, 'category not found');
      const [row] = await app.db
        .insert(schema.tryonCategorySamples)
        .values({
          categoryId: id,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey ?? null,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      return row;
    },
  );

  // DELETE /admin/tryon-categories/:id/samples/:sampleId
  app.delete(
    '/admin/tryon-categories/:id/samples/:sampleId',
    {
      preHandler: W,
      schema: { params: z.object({ id: z.string().uuid(), sampleId: z.string().uuid() }) },
    },
    async (req) => {
      const { sampleId } = req.params as { id: string; sampleId: string };
      await app.db
        .delete(schema.tryonCategorySamples)
        .where(eq(schema.tryonCategorySamples.id, sampleId));
      return { ok: true };
    },
  );
}
```

- [ ] **Step 2: Register the routes**

In `apps/api/src/server.ts`, add the import near the other admin imports (after `adminWorkflowsRoutes` import, ~line 29):

```ts
import { adminTryonRoutes } from './modules/admin/tryon.routes.js';
```

And register it after `await app.register(adminWorkflowsRoutes);` (~line 125):

```ts
  await app.register(adminTryonRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types build && pnpm --filter @tryme/storage build && pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke test the list route**

With api dev running and an admin token, run:
`curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" http://localhost:4000/admin/tryon-categories`
Expected: `[]` (empty array, HTTP 200).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/tryon.routes.ts apps/api/src/server.ts
git commit -m "feat(api): tryon category CRUD + sample presign routes"
```

---

### Task 10: Admin data layer — types + API helpers

**Files:**
- Modify: `apps/admin/src/types.ts` (add `TryonCategory`, `TryonSample`)

**Interfaces:**
- Produces: TS types `TryonCategory`, `TryonSample` consumed by the page in Task 12.

- [ ] **Step 1: Add the types**

In `apps/admin/src/types.ts`, add:

```ts
export interface TryonSample {
  id: string;
  categoryId: string;
  r2Key: string;
  thumbnailKey: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface TryonCategory {
  id: string;
  name: string;
  slug: string;
  workflowTemplateId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  samples: TryonSample[];
}
```

- [ ] **Step 2: Typecheck admin**

Run: `cd apps/admin && npx tsc -b && cd ../..`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/types.ts
git commit -m "feat(admin): tryon category TS types"
```

---

### Task 11: Sidebar nav + route

**Files:**
- Modify: `apps/admin/src/components/Sidebar.tsx:22` (items array)
- Modify: `apps/admin/src/App.tsx:189` (routes)

**Interfaces:**
- Consumes: `TryonPage` (created in Task 12 — create a minimal stub first so the route compiles, then flesh out in Task 12).

- [ ] **Step 1: Create a stub page so the route compiles**

Create `apps/admin/src/pages/TryonPage.tsx`:

```tsx
export default function TryonPage() {
  return <div style={{ padding: 24 }}>Tryon</div>;
}
```

- [ ] **Step 2: Add the nav item**

In `apps/admin/src/components/Sidebar.tsx`, in the `items` array (after the `workflows` entry, line ~36), add:

```ts
  { k: 'tryon', label: 'Tryon', icon: Icon.Workflow, roles: ['SUPER_ADMIN', 'MODERATOR'] },
```

- [ ] **Step 3: Add the route**

In `apps/admin/src/App.tsx`, add the import near the other page imports and a route after the workflows route (line ~189):

```tsx
            <Route path="/tryon" element={<TryonPage {...pageProps} />} />
```

Add at the top with the other imports: `import TryonPage from './pages/TryonPage';`

- [ ] **Step 4: Typecheck + manual nav check**

Run: `cd apps/admin && npx tsc -b && cd ../..`
Then run admin dev and confirm a "Tryon" item appears in the sidebar and routes to the stub page.
Expected: no errors; nav item visible for SUPER_ADMIN/MODERATOR.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/Sidebar.tsx apps/admin/src/App.tsx apps/admin/src/pages/TryonPage.tsx
git commit -m "feat(admin): tryon sidebar nav + route + stub page"
```

---

### Task 12: Tryon page — categories CRUD + sample uploads

**Files:**
- Modify: `apps/admin/src/pages/TryonPage.tsx` (full implementation)

**Interfaces:**
- Consumes: `TryonCategory`/`TryonSample` (Task 10), `WorkflowOption` (existing), `apiFetch` (`../lib/data`), `useAuth().storagePublicUrl`, the API routes from Task 9.

- [ ] **Step 1: Implement the page**

Replace `apps/admin/src/pages/TryonPage.tsx` with a full implementation. It must:
- On mount, load categories (`GET /admin/tryon-categories`) and tryon workflows (`GET /admin/workflows`, filter `workflowType === 'tryon'`).
- Render a grid of category cards (name, assigned workflow label, sample thumbnails via `${storagePublicUrl}/${sample.thumbnailKey ?? sample.r2Key}`, active toggle, sort order).
- "Add category" button → modal with: name input, slug (auto-derived from name, snake_case, editable), workflow `<select>` (tryon workflows only), sortOrder, active checkbox. Submits `POST /admin/tryon-categories`.
- Per-card "Edit" → same modal pre-filled, submits `PATCH`.
- Per-card "Delete" → confirm → `DELETE`.
- In the edit modal, a sample-image multi-uploader: for each chosen file, `POST .../samples/presign` → PUT file to `uploadUrl` + thumbnail to `thumbnailUploadUrl` (reuse the `putFile` + `makeThumbnail` pattern from `EditPoseAssetModal.tsx`) → `POST .../samples` to record. Per-sample delete → `DELETE .../samples/:sampleId`.
- Use `C`/CSS-var tokens, no raw hex. Use `toast` prop for success/error.

Reference implementations to mirror exactly:
- Upload+thumbnail flow: `apps/admin/src/components/EditPoseAssetModal.tsx` (`putFile`, `makeThumbnail`, presign→PUT→record).
- Card grid + modal styling: `apps/admin/src/pages/assets/PoseAssetsTab.tsx`.

Page props type: match the other pages — `{ toast }` from `pageProps`. Inspect `apps/admin/src/pages/WorkflowsPage.tsx` for the exact `Props` shape and `apiFetch` usage, and copy that pattern.

- [ ] **Step 2: Typecheck**

Run: `cd apps/admin && npx tsc -b && cd ../..`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end verification**

With api + admin dev running:
1. Tryon tab → Add category "Upper" (slug auto `upper`), assign a tryon workflow, save → card appears.
2. Edit "Upper" → upload 2 sample images → thumbnails appear on the card.
3. Delete one sample → it disappears.
4. Toggle active off/on → persists after reload.
5. Delete category → removed; its samples cascade-deleted (verify `psql "$DATABASE_URL" -c "select count(*) from tryon_category_samples"`).

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/pages/TryonPage.tsx
git commit -m "feat(admin): tryon categories management page"
```

---

## Deferred (NOT in this plan)

Per the spec: dispatcher `processTryonJob`, tryon job-creation API + enqueue + credit handling, end-user web upload/run flow + SSE, and worker-pool routing. Each is its own future spec → plan cycle.

## Self-Review Notes

- Spec coverage: Increment 1 (parser) = Tasks 1-5; Increment 2 (tab + categories) = Tasks 6-12. Deferred section matches spec.
- Type consistency: `detectTryonMappings` return shape defined in Task 2 and consumed in Tasks 4-5; prompt mapping (positive→garment*, negative→face*) consistent with existing convention and used identically in Task 4. `tryonPersonNodeId`/`tryonGarmentNodeId`/`tryonOutputNodeId` named identically across schema (T1), zod (T3), route (T4), UI (T5). `tryonCategories`/`tryonCategorySamples` consistent across T6/T8/T9/T10.
- Migration order constraint (build→generate→migrate) embedded in T1 and T6.
