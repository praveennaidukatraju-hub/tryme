# Workflow KSampler Settings Editing — Design Spec

## Problem

Real ComfyUI workflow templates (confirmed against `logopic.json`/`blazerpic.json`, two actual production workflow exports) each contain exactly one `KSampler` node with tunable generation parameters:

```json
"inputs": { "seed": ..., "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, ... }
```

Today, changing `steps`/`cfg`/`denoise` requires re-uploading an entirely new workflow JSON — there's no way to tune these from the admin panel, the same gap the recently-shipped prompt-editing feature closed for the two prompt nodes.

## Goal

Let an admin edit `steps`, `cfg`, and `denoise` on a workflow's `KSampler` node directly from the Workflows page's existing Edit modal, persisting into `jsonContent` so it takes effect on the next dispatched job — same mechanism, same reasoning, as the prompt-editing feature (`docs/superpowers/specs/2026-08-09-workflow-prompt-editing-design.md`).

## Scope decisions (from brainstorming)

- **KSampler count:** every real workflow has exactly one `KSampler` node (confirmed against both reference files). The backend finds it by scanning `jsonContent` for `class_type === 'KSampler'` — no new stored node-id column, no migration.
- **Editable fields:** `steps`, `cfg`, `denoise` only. `sampler_name`/`scheduler` (algorithm choice) and `seed` (per-run randomization, not a workflow default) are explicitly out of scope.
- **No stored cache column** (deliberate divergence from the prompt fields' `defaultFacePhasePrompt`/`defaultGarmentPhasePrompt` pattern): those columns exist because several *other* admin pages already read them (`GarmentTypesTab.tsx`, `EditPoseAssetModal.tsx`, `EditPoseModal.tsx`, `PoseUploadModal.tsx`, `models.routes.ts`, `saree.routes.ts` — confirmed by grep). Nothing outside the Workflows page needs KSampler values today, so computing them on the fly from `jsonContent` avoids a migration, avoids a second source of truth, and is simpler. If another page needs this later, add the read then — YAGNI now.

## Refinement flagged for review

During brainstorming the UI was described as "always shown, since every real workflow has one KSampler." On closer thought, that's not the safest choice: the face-phase prompt field already establishes the pattern of *hiding* a field when its underlying node isn't present, rather than showing a field that would silently no-op or error. This spec instead gates visibility on whether a `KSampler` node was actually found (`ksamplerSteps !== null`) — consistent with the existing pattern, and defensive against a workflow that turns out not to have one. Flagging this explicitly since it changes what was verbally agreed.

## API changes

### `packages/types/src/admin.ts` — `UpdateWorkflowBody`

Add three new optional fields, after the `facePhasePrompt`/`garmentPhasePrompt` fields added by the prompt-editing feature:

```ts
ksamplerSteps: z.number().int().min(1).optional(),
ksamplerCfg: z.number().min(0).optional(),
ksamplerDenoise: z.number().min(0).max(1).optional(),
```

Rationale for the bounds: `steps` below 1 means no generation happens (reject, same class of guard as the empty-prompt rule). `cfg` has no fixed upper bound in ComfyUI — it varies by model/LoRA — so only a floor of 0 is enforced. `denoise` is bounded 0–1 because that's its defined semantic range (1.0 = full generation from noise, 0.0 = no change) — a value outside that range is nonsensical, not just unusual.

### `apps/api/src/modules/admin/workflows.routes.ts`

**New helpers**, added alongside the existing `extractPromptText`/`extractDefaultPrompts`/`writePromptText` (after `writePromptText`, currently ending at line 91, before `export async function adminWorkflowsRoutes` at line 92):

```ts
// Every real workflow has exactly one KSampler node (verified against production
// workflow exports) — found by class_type, not a stored node-id column, since
// nothing else needs to identify it and a scan is O(nodes) on an already-small JSON.
function findKSamplerNode(json: Record<string, unknown>): { nodeId: string; node: WorkflowNode } | null {
  for (const [nodeId, value] of Object.entries(json)) {
    const node = value as WorkflowNode;
    if (node?.class_type === 'KSampler') return { nodeId, node };
  }
  return null;
}

function extractKSamplerValues(json: Record<string, unknown>): {
  ksamplerSteps: number | null;
  ksamplerCfg: number | null;
  ksamplerDenoise: number | null;
} {
  const inputs = findKSamplerNode(json)?.node.inputs;
  return {
    ksamplerSteps: typeof inputs?.steps === 'number' ? inputs.steps : null,
    ksamplerCfg: typeof inputs?.cfg === 'number' ? inputs.cfg : null,
    ksamplerDenoise: typeof inputs?.denoise === 'number' ? inputs.denoise : null,
  };
}

// Returns false (no write performed) when the workflow has no KSampler node —
// caller turns that into a 400, mirroring the facePhasePrompt-with-no-node case.
function writeKSamplerValues(
  json: Record<string, unknown>,
  values: { steps?: number; cfg?: number; denoise?: number },
): boolean {
  const found = findKSamplerNode(json);
  if (!found) return false;
  found.node.inputs ??= {};
  if (values.steps !== undefined) found.node.inputs.steps = values.steps;
  if (values.cfg !== undefined) found.node.inputs.cfg = values.cfg;
  if (values.denoise !== undefined) found.node.inputs.denoise = values.denoise;
  return true;
}
```

**`GET /admin/workflows` (list, currently lines 98-138):** spread `extractKSamplerValues(r.jsonContent as Record<string, unknown>)` into each returned row, alongside the existing `facePhasePromptNode: r.facePhasePromptNode,` line (122).

**`GET /admin/workflows/:id` (detail, currently lines 486-507):** the handler already does `return { ...row, poseCount: ... }` (line 505), which spreads every raw column including `jsonContent` — add `...extractKSamplerValues(row.jsonContent as Record<string, unknown>)` to that same returned object so list and detail use the identical derivation function (structural guarantee against drift, same discipline as the Generation Operations Console work).

**`PATCH /admin/workflows/:id` (currently lines 510-...):**
- Body type (lines 518-543): add `ksamplerSteps?: number; ksamplerCfg?: number; ksamplerDenoise?: number;` alongside the existing `garmentPhasePrompt?: string; facePhasePrompt?: string;` lines (537-538).
- After the existing face-phase-prompt write block (currently ending at line 642, right before the blank line at 644), insert:

```ts
      if (
        body.ksamplerSteps !== undefined ||
        body.ksamplerCfg !== undefined ||
        body.ksamplerDenoise !== undefined
      ) {
        const wrote = writeKSamplerValues(json, {
          steps: body.ksamplerSteps,
          cfg: body.ksamplerCfg,
          denoise: body.ksamplerDenoise,
        });
        if (!wrote) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot set ksampler values: this workflow has no KSampler node',
          );
        }
      }
```

- Widen the existing `jsonContent` persistence guard (currently lines 663-665):

```ts
      if (body.garmentPhasePrompt !== undefined || body.facePhasePrompt !== undefined) {
        updateValues.jsonContent = json;
      }
```

to:

```ts
      if (
        body.garmentPhasePrompt !== undefined ||
        body.facePhasePrompt !== undefined ||
        body.ksamplerSteps !== undefined ||
        body.ksamplerCfg !== undefined ||
        body.ksamplerDenoise !== undefined
      ) {
        updateValues.jsonContent = json;
      }
```

No dispatcher changes — same reasoning as the prompt-editing feature: `apps/dispatcher/src/job/processor.ts` clones `jsonContent` fresh per job, so a `jsonContent` edit is picked up automatically on the next dispatch.

## Frontend changes (`apps/admin-web`)

### `src/types.ts` — `WorkflowOption`

Add, alongside the existing `facePhasePromptNode: string | null;`:

```ts
ksamplerSteps: number | null;
ksamplerCfg: number | null;
ksamplerDenoise: number | null;
```

### `src/pages/WorkflowsPage.tsx`

- `editForm` state: add `ksamplerSteps: string`, `ksamplerCfg: string`, `ksamplerDenoise: string` — kept as strings (not numbers) so the number `<input>`s are fully controlled without fighting `NaN` on an empty field, matching common React numeric-input practice; parsed to numbers only at save time.
- Both `setEditingWf`/`setEditForm` call sites (the same two occurrences the prompt-editing feature updated) pre-fill with `String(wf.ksamplerSteps ?? '')`, `String(wf.ksamplerCfg ?? '')`, `String(wf.ksamplerDenoise ?? '')`.
- Edit modal JSX: three `<input type="number">` fields after the two prompt textareas, wrapped in the **same conditional-visibility pattern** as the face-phase prompt field — rendered only when `editingWf?.ksamplerSteps !== null` (see "Refinement flagged for review" above). All three render together or not at all (they come from the same node).
- `handleEditSave`: parse each field with `Number(editForm.ksamplerSteps)` etc.; include in the PATCH payload only when the field was shown (mirrors the `facePhasePrompt` conditional-inclusion pattern) and the parsed value is a valid, non-NaN number.
- Save-button disabled condition: extend with `Number.isNaN(Number(editForm.ksamplerSteps)) || Number(editForm.ksamplerSteps) < 1`, and equivalent non-negative/range checks for `ksamplerCfg`/`ksamplerDenoise`, gated on the same "was this field shown" condition — mirrors the server-side validation for fast client feedback, server remains the source of truth.
- Optimistic local-state update after save (the pattern the prompt fields already established at the `setWorkflows((prev) => prev.map(...))` call) extends to include the three new fields the same way.

## Error handling

| Case | Behavior |
|---|---|
| `ksamplerSteps < 1` | `400 VALIDATION` (Zod-level, via `.min(1)`) |
| `ksamplerCfg < 0` | `400 VALIDATION` (Zod-level) |
| `ksamplerDenoise` outside `[0, 1]` | `400 VALIDATION` (Zod-level) |
| Any of the three provided but workflow has no `KSampler` node | `400 VALIDATION` (handler-level, via `writeKSamplerValues`'s `false` return) — shouldn't happen in practice given every real workflow has one, but handled the same defensive way as the analogous face-phase-prompt case |

## Testing

New `it()` blocks in `apps/api/test/integration/admin-workflows.test.ts` (existing file, same `describe` block):

1. `PATCH` with `ksamplerSteps`/`ksamplerCfg`/`ksamplerDenoise` updates all three in `jsonContent`, verified via a follow-up `GET /admin/workflows/:id`.
2. `PATCH` with `ksamplerSteps: 0` → `400`.
3. `PATCH` with `ksamplerCfg: -1` → `400`.
4. `PATCH` with `ksamplerDenoise: 1.5` → `400`.
5. `PATCH` on a workflow with no `KSampler` node (the shared `jsonContent` fixture used throughout this test file has none) with any of the three fields → `400`.
6. `GET /admin/workflows` (list) and `GET /admin/workflows/:id` (detail) return identical `ksamplerSteps`/`ksamplerCfg`/`ksamplerDenoise` values for the same workflow — the same list/detail-agreement discipline used elsewhere in this codebase.
7. Partial update: `PATCH` with only `ksamplerSteps` provided leaves `cfg`/`denoise` unchanged in `jsonContent`.

Frontend: no automated test infrastructure in `admin-web` (consistent with prior work) — manual build (`pnpm --filter @tryme/admin build`) plus a manual browser pass: open Edit on a workflow with a `KSampler` node (three fields shown, pre-filled with real values), edit and save, confirm the values round-trip through re-opening Edit.

## Non-goals

- No editing of `seed`, `sampler_name`, or `scheduler` — explicitly excluded per the brainstorming decision.
- No versioning/undo — matches every other field on this endpoint.
- No support for workflows with multiple `KSampler` nodes — not a real case per the confirmed reference workflows; if one ever exists, `findKSamplerNode` picks the first one found by object key iteration order, which is not a meaningful guarantee. If multi-KSampler workflows become real, this needs a stored node-id column (the same escape hatch the prompt fields already use), not a fix to this feature.
