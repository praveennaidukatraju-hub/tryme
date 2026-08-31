# Workflow Prompt Editing — Design Spec

## Problem

`apps/admin-web`'s Workflows page lets an admin edit a workflow template's `label`/`slug`, and separately lets them *view* (read-only) everything parsed out of the uploaded ComfyUI workflow JSON — including two prompt slots baked into that JSON:

- **`garmentPhasePromptNode`** — the positive prompt. Already overridable *per job* via `model_pose_assets.promptGarmentPhase` or a per-(pose, garment-type) row in `pose_garment_configs`, falling back to whatever text is baked into the template's `jsonContent` when no override exists (`apps/dispatcher/src/workflow/patcher.ts:148-153`).
- **`facePhasePromptNode`** — the negative prompt. Per `apps/dispatcher/src/workflow/patcher.ts:155`, this is **"never overridden — hardcoded per workflow"** — there is no override mechanism for it anywhere in the system today.

Today, changing either prompt's *text* requires re-uploading an entirely new workflow JSON. The `defaultFacePhasePrompt`/`defaultGarmentPhasePrompt` columns visible in the admin UI are a read-only cache extracted from `jsonContent` at upload time (or when an admin re-points *which node* holds the prompt, via the existing `PATCH /admin/workflows/:id`'s `facePhasePromptNode`/`garmentPhasePromptNode` node-ID fields) — editing those columns directly today would have **no effect on real generations**, since the dispatcher reads the prompt straight out of `jsonContent`, never from those columns.

## Goal

Let an admin directly edit the text of both prompts from the Workflows page, and have that edit actually take effect on the next generation dispatched against that template — without requiring a re-upload.

## Why no dispatcher changes are needed

`apps/dispatcher/src/job/processor.ts:594` calls `patchWorkflow(...)`, which (per this project's existing invariant) always `structuredClone`s the template's `jsonContent` fresh before patching per-job inputs on top. If the admin-entered prompt text is written directly into `jsonContent`, every future dispatch's clone starts from that updated baseline automatically:

- **Garment-phase**: the clone carries the new default; a per-pose/per-garment-type override (if one exists) still applies on top, unchanged behavior.
- **Face-phase**: since it's never overridden at any per-job layer, whatever is in `jsonContent` is unconditionally what ComfyUI receives — editing `jsonContent` is the *only* way this value can ever change, by design.

So this is purely an `apps/api` (one endpoint) + `apps/admin-web` (one modal) change. No dispatcher file is touched.

## API changes

### `packages/types/src/admin.ts` — `UpdateWorkflowBody`

Add two new optional fields, distinct from the existing `facePhasePromptNode`/`garmentPhasePromptNode` (which identify *which node* holds the prompt — unchanged, still supported):

```ts
garmentPhasePrompt: z.string().optional(),
facePhasePrompt: z.string().optional(),
```

No `.min(1)` at the schema layer — emptiness is validated in the route handler (see below), where the exact rule depends on *which* prompt, not just "is it a non-empty string."

### `apps/api/src/modules/admin/workflows.routes.ts` — `PATCH /admin/workflows/:id`

**New helper**, symmetric counterpart to the existing `extractPromptText()` (lines 58-61), which reads `inputs.prompt ?? inputs.text`:

```ts
// Writes into whichever key the node already uses (standard CLIPTextEncode = "text",
// custom nodes like TextEncodeQwenImageEditPlusPro = "prompt") — mirrors extractPromptText's
// read priority so a write always lands in the field ComfyUI actually reads for that node.
// Defaults to "text" (the standard CLIPTextEncode key) only if the node has neither key yet.
function writePromptText(json: Record<string, unknown>, nodeId: string, text: string): void {
  const node = json[nodeId] as WorkflowNode | undefined;
  if (!node) return;
  node.inputs ??= {};
  const key = 'prompt' in node.inputs ? 'prompt' : 'text';
  node.inputs[key] = text;
}
```

**Handler changes**, inserted alongside the existing node-ID validation block (after line 575, before the `mergedUpperNodeIds` block):

- If `body.garmentPhasePrompt !== undefined`:
  - Reject with `400 VALIDATION` if `body.garmentPhasePrompt.trim() === ''`. This mirrors a documented production bug (`apps/dispatcher/src/workflow/patcher.test.ts:303`, *"empty string caused ComfyUI 400"*) — an empty garment-phase default would break every job dispatched against this template that doesn't happen to have a pose-level override.
  - Call `writePromptText(json, newPosNode, body.garmentPhasePrompt)`, where `newPosNode` is the (possibly just-updated) `garmentPhasePromptNode` — reuse the existing `newPosNode` variable already computed at line 607.
- If `body.facePhasePrompt !== undefined`:
  - If the template has no `facePhasePromptNode` (`newNegNode` is null, using the existing variable at line 606), reject with `400 VALIDATION` — `"cannot set facePhasePrompt: this workflow has no face-phase prompt node"`. Don't silently no-op; an admin editing a field that then does nothing is worse than an explicit error.
  - Otherwise call `writePromptText(json, newNegNode, body.facePhasePrompt)`. No non-empty requirement — an empty negative prompt is a legitimate, already-supported state (the column's own DB default is `''`).
- After either write, `json` (the in-memory `jsonContent` object, already loaded at line 536) has been mutated. Add `updateValues.jsonContent = json;` to the existing `updateValues` object (built at lines 617-660) so the mutation persists.
- Re-run `extractDefaultPrompts(json, newNegNode, newPosNode)` (existing function, lines 63-76) whenever `garmentPhasePrompt`, `facePhasePrompt`, `facePhasePromptNode`, or `garmentPhasePromptNode` changed, and use its result for `defaultFacePhasePrompt`/`defaultGarmentPhasePrompt` in `updateValues` — this keeps the two derived-cache columns honest by re-deriving from the just-mutated JSON rather than trusting the raw input strings verbatim (defends against the write going to a different key than expected, or the node type changing shape).

**Note:** this reuses the *existing* `newNegNode`/`newPosNode` variables (lines 606-607) and the *existing* `extractDefaultPrompts` re-derivation block (lines 609-615) — the new logic slots into that same conditional rather than duplicating it. The condition at line 611 (`if (body.facePhasePromptNode || body.garmentPhasePromptNode)`) needs widening to also trigger on `body.facePhasePrompt !== undefined || body.garmentPhasePrompt !== undefined`.

### `GET /admin/workflows` (list) — expose `facePhasePromptNode`

The admin-web Edit modal needs to know whether a template *has* a face-phase prompt node at all, to decide whether to show that textarea — but the list endpoint's mapped response (lines 101-124) currently omits `facePhasePromptNode` (it only returns the extracted *text*, `defaultFacePhasePrompt`, not the node-ID field itself, and an empty string there is not a reliable signal — a node can exist with genuinely empty baked-in text). Add one field to the returned object:

```ts
facePhasePromptNode: r.facePhasePromptNode,
```

`r` already carries this column (the query is `select()` with no column list, i.e. every column), so this is a one-line addition to the mapped shape, no query change.

### `GET /admin/workflows/:id` (detail)

No change needed — it already does `select()` (all columns), so `facePhasePromptNode`/`garmentPhasePromptNode` and the patched `jsonContent` are already present in the "View" modal's data, unchanged by this feature.

## Frontend changes (`apps/admin-web`)

### `src/types.ts` — `WorkflowOption`

Add:
```ts
facePhasePromptNode: string | null;
```

### `src/pages/WorkflowsPage.tsx`

- `editForm` state (line 50) gains two fields: `garmentPhasePrompt: string` and `facePhasePrompt: string`.
- Both `onClick` handlers that call `setEditingWf`/`setEditForm` (lines 376-382 and the desktop-table equivalent) pre-fill from the row's existing `wf.defaultGarmentPhasePrompt` / `wf.defaultFacePhasePrompt`.
- Edit modal JSX (lines 972-1036): add two `<textarea>` fields after the existing Slug field —
  - **"Garment-phase prompt"** — always rendered.
  - **"Face-phase (negative) prompt"** — rendered only when `editingWf?.facePhasePromptNode` is non-null; omitted entirely otherwise (not disabled/greyed — just not present, so there's nothing implying it's editable when it isn't applicable).
  - Widen the modal's inline `style` from `{ width: 'min(420px, calc(100vw - 40px))' }` (line 978) to `{ width: 'min(640px, calc(100vw - 40px))' }` to give multi-line prompt text room; textareas sized `rows={4}`, monospace not required (these are natural-language prompts, not code).
- `handleEditSave` (lines 171-205): include `garmentPhasePrompt: editForm.garmentPhasePrompt.trim()` in the PATCH body always; include `facePhasePrompt: editForm.facePhasePrompt.trim()` only when the face-phase field was shown (i.e., `editingWf?.facePhasePromptNode` was non-null) — mirrors the "omit = leave unchanged" convention the PATCH endpoint already uses elsewhere.
- Save-button disabled condition (line 1030) gains `|| !editForm.garmentPhasePrompt.trim()`, matching the backend's non-empty rule so the error is caught client-side too (backend validation remains the source of truth; this is just faster feedback).
- On the 400 `VALIDATION` response (empty garment-phase prompt, or face-phase-prompt-on-a-template-with-no-face-node), the existing `catch` block in `handleEditSave` already surfaces `ApiError` messages via toast — no new error-handling path needed, the existing one already extracts `e.body.error.message`.

## Error handling

| Case | Behavior |
|---|---|
| `garmentPhasePrompt` empty/whitespace after trim | `400 VALIDATION`, save button also disabled client-side |
| `facePhasePrompt` provided but template has no `facePhasePromptNode` | `400 VALIDATION`; frontend won't normally hit this since the field is hidden when inapplicable, but the backend still guards it (defense in depth — e.g. a stale client) |
| `facePhasePrompt` empty/whitespace | Allowed — matches the column's existing `''` default, a negative prompt is legitimately optional |
| Node id (`newPosNode`/`newNegNode`) not found in `jsonContent` | Can't happen via normal use (both are validated at upload/repoint time), but `writePromptText` no-ops safely (`if (!node) return;`) rather than throwing, consistent with defensive style elsewhere in this file |

## Testing

New `it()` blocks in `apps/api/test/integration/admin-workflows.test.ts` (existing file, same `describe('admin workflows - floor validation', ...)` block or a new sibling `describe`):

1. `PATCH` with a new `garmentPhasePrompt` updates both `jsonContent[garmentPhasePromptNode].inputs.<key>` and `defaultGarmentPhasePrompt`, verified via a follow-up `GET /admin/workflows/:id`.
2. `PATCH` with `garmentPhasePrompt: '   '` (whitespace only) → `400`.
3. `PATCH` with a new `facePhasePrompt` on a template that has `facePhasePromptNode` set → succeeds, both `jsonContent` and `defaultFacePhasePrompt` updated.
4. `PATCH` with `facePhasePrompt` on a template where `facePhasePromptNode` is null → `400`.
5. `PATCH` with `facePhasePrompt: ''` on a template that has `facePhasePromptNode` set → succeeds (empty is allowed for this one).
6. Write-key fidelity: one fixture workflow whose prompt node's `inputs` already has a `text` key (standard CLIPTextEncode shape) and one whose `inputs` already has a `prompt` key (custom node shape) — confirm `writePromptText` writes to the same key it found, not always defaulting to one or the other.
7. `GET /admin/workflows` (list) response includes `facePhasePromptNode` per row.

Frontend: no automated test infrastructure in `admin-web` (consistent with prior work in this repo) — manual build (`pnpm --filter @tryme/admin build`) plus a manual browser pass: open Edit on a workflow with a face-phase node (textarea shown) and one without (textarea absent), edit and save both prompt fields, confirm the "View" (read-only) modal reflects the new text immediately after.

## Non-goals

- No versioning/history of prompt edits — this matches the existing behavior of every other field on this endpoint (label, slug, node IDs) which also apply immediately with no undo.
- No change to how `garmentPhasePrompt` per-job/per-pose overrides work — that mechanism (`model_pose_assets.promptGarmentPhase`, `pose_garment_configs.promptGarmentPhase`) is untouched; this feature only changes the *fallback* used when no such override exists.
- No editing of arbitrary JSON nodes — only the two already-designated prompt nodes (`facePhasePromptNode`/`garmentPhasePromptNode`) are editable text; re-pointing *which* node holds the prompt remains the existing, separate `facePhasePromptNode`/`garmentPhasePromptNode` (node-ID) fields on the same endpoint.
