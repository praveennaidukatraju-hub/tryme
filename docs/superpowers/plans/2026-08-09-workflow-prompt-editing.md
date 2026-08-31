# Workflow Prompt Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin edit a workflow template's garment-phase (positive) and face-phase (negative) prompt text from the admin panel, persisting the edit into the template's `jsonContent` so it takes effect on the next dispatched job.

**Architecture:** One new write path on the existing `PATCH /admin/workflows/:id` endpoint writes admin-supplied prompt text directly into the corresponding ComfyUI node inside `jsonContent`, then re-derives the two display-cache columns (`defaultFacePhasePrompt`/`defaultGarmentPhasePrompt`) from the freshly-patched JSON. The existing "Edit workflow" modal in `apps/admin-web` gains two textareas. No dispatcher changes: the dispatcher already clones `jsonContent` fresh per job, so a jsonContent edit is picked up automatically on the very next dispatch.

**Tech Stack:** Fastify 5 + Drizzle ORM + Zod (backend), React 18 (admin-web frontend), Vitest integration tests against a real Postgres via `apps/api/test/helpers`.

## Global Constraints

- No dispatcher file may be touched — the feature works entirely by writing into `jsonContent` before it's ever read by `apps/dispatcher`.
- `garmentPhasePrompt` must be rejected (400) if empty or whitespace-only after trimming — an empty positive prompt causes ComfyUI to reject the job (documented regression: `apps/dispatcher/src/workflow/patcher.test.ts:303`), and there's no per-job override guaranteed to save every workflow from hitting this.
- `facePhasePrompt` may be saved as an empty string — a negative prompt is legitimately optional. It must be rejected (400) only when the target workflow has no `facePhasePromptNode` at all.
- The write must land in whichever input key (`prompt` or `text`) the target node already uses — never assume one. Default to `text` only when the node has neither key yet.
- After any prompt write, `defaultFacePhasePrompt`/`defaultGarmentPhasePrompt` must be re-derived by reading the just-mutated `jsonContent` (via the existing `extractDefaultPrompts()`), never set directly from the raw request string — this keeps the display-cache columns honest even if the write landed somewhere unexpected.
- Frontend: the face-phase textarea is shown only when the workflow has a `facePhasePromptNode`; the garment-phase textarea is always shown. Save behavior stays consistent with every other field on this endpoint — immediate, no draft/staging step, no versioning/undo.
- Frontend automated tests are out of scope (`apps/admin-web` has no test infrastructure and this project doesn't introduce one). The frontend task ends with a manual build check instead of a test run.
- Full spec: `docs/superpowers/specs/2026-08-09-workflow-prompt-editing-design.md`.

---

## Task 1: Backend — prompt write path on `PATCH /admin/workflows/:id`

**Files:**
- Modify: `packages/types/src/admin.ts:371-405` (`UpdateWorkflowBody`)
- Modify: `apps/api/src/modules/admin/workflows.routes.ts` (new helper + PATCH handler + GET list handler)
- Test: `apps/api/test/integration/admin-workflows.test.ts`

**Interfaces:**
- Consumes: existing `extractDefaultPrompts()`, `extractPromptText()`, `validateNodeExists()`, `WorkflowNode` type, `AppError` — all already defined in `apps/api/src/modules/admin/workflows.routes.ts`.
- Produces: `writePromptText(json: Record<string, unknown>, nodeId: string, text: string): void` — a new exported-from-module (not exported from the package, just a module-local function like its siblings) helper; used only within this file. `UpdateWorkflowBody` gains `garmentPhasePrompt?: string` and `facePhasePrompt?: string` — consumed by Task 2's frontend PATCH payload.

- [ ] **Step 1: Add the two new fields to `UpdateWorkflowBody`**

Open `packages/types/src/admin.ts`. Find the `UpdateWorkflowBody` object (starts at line 371). Add these two lines immediately after the existing `garmentPhasePromptNode: z.string().min(1).optional(),` line (currently line 399):

```ts
  // Prompt TEXT (not which node holds it — see facePhasePromptNode/garmentPhasePromptNode
  // above for that). No .min(1) here on purpose: emptiness rules differ per field and are
  // enforced in the route handler (garmentPhasePrompt must be non-empty, facePhasePrompt may
  // be empty).
  garmentPhasePrompt: z.string().optional(),
  facePhasePrompt: z.string().optional(),
```

- [ ] **Step 2: Verify the types package builds**

Run: `pnpm --filter @tryme/types build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Write the failing tests**

Open `apps/api/test/integration/admin-workflows.test.ts`. Add these six `it()` blocks inside the existing `describe('admin workflows - floor validation', ...)` block, after the last existing test (`'PATCH persists thirdNodeId'`, currently ending at line 220), before the closing `});` of the `describe` block:

```ts
  it('PATCH updates garmentPhasePrompt text in both jsonContent and defaultGarmentPhasePrompt', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_garment_${Date.now()}`,
        label: 'Prompt edit garment',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: 'a brand new positive prompt' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({
        jsonContent: schema.workflowTemplates.jsonContent,
        defaultGarmentPhasePrompt: schema.workflowTemplates.defaultGarmentPhasePrompt,
      })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultGarmentPhasePrompt).toBe('a brand new positive prompt');
    const stored = row?.jsonContent as Record<string, { inputs: { prompt?: string } }>;
    expect(stored.positive_node.inputs.prompt).toBe('a brand new positive prompt');
  });

  it('PATCH rejects an empty or whitespace-only garmentPhasePrompt', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_empty_${Date.now()}`,
        label: 'Prompt edit empty',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: '   ' },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH updates facePhasePrompt when the workflow has a facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_face_${Date.now()}`,
        label: 'Prompt edit face',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: 'a brand new negative prompt' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({
        jsonContent: schema.workflowTemplates.jsonContent,
        defaultFacePhasePrompt: schema.workflowTemplates.defaultFacePhasePrompt,
      })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultFacePhasePrompt).toBe('a brand new negative prompt');
    const stored = row?.jsonContent as Record<string, { inputs: { prompt?: string } }>;
    expect(stored.negative_node.inputs.prompt).toBe('a brand new negative prompt');
  });

  it('PATCH rejects facePhasePrompt when the workflow has no facePhasePromptNode', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_no_face_${Date.now()}`,
        label: 'Prompt edit no face',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: 'should be rejected' },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH allows an empty facePhasePrompt when a facePhasePromptNode exists', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_face_empty_${Date.now()}`,
        label: 'Prompt edit face empty',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: '' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ defaultFacePhasePrompt: schema.workflowTemplates.defaultFacePhasePrompt })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultFacePhasePrompt).toBe('');
  });

  it('PATCH writes to the "text" key for a node that already uses "text" instead of "prompt"', async () => {
    const textKeyed = {
      ...jsonContent,
      positive_node: {
        inputs: { text: 'default via text key' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'positive_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_textkey_${Date.now()}`,
        label: 'Prompt edit text key',
        jsonContent: textKeyed,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: 'updated via text key' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ jsonContent: schema.workflowTemplates.jsonContent })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    const stored = row?.jsonContent as Record<
      string,
      { inputs: { text?: string; prompt?: string } }
    >;
    expect(stored.positive_node.inputs.text).toBe('updated via text key');
    expect(stored.positive_node.inputs.prompt).toBeUndefined();
  });
```

Also add one more `it()` for the `GET /admin/workflows` list-response change (same file, same `describe` block):

```ts
  it('GET /admin/workflows list response includes facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `list_face_node_${Date.now()}`,
        label: 'List face node',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const listRes = await app.inject({ method: 'GET', url: '/admin/workflows', headers });
    expect(listRes.statusCode).toBe(200);
    const row = (listRes.json() as { id: string; facePhasePromptNode: string | null }[]).find(
      (w) => w.id === id,
    );
    expect(row?.facePhasePromptNode).toBe('negative_node');
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run (from `apps/api`): `npx vitest run --config vitest.integration.config.ts admin-workflows`

(The plan's literal `pnpm --filter @tryme/api test -- admin-workflows` command does NOT reach `test/integration/**` — `apps/api/vitest.config.ts` excludes that directory by default and there is no `test:integration` script. Use the `npx vitest run --config vitest.integration.config.ts` form for every integration-test step in this plan. Docker Postgres/Redis/MinIO must be running — `pnpm docker:up` from the repo root.)

Expected: the 7 new tests FAIL — `garmentPhasePrompt`/`facePhasePrompt` aren't in the Zod schema yet, so Fastify's schema validation will either 400 on an unrecognized field (if strict) or the field will simply be ignored by the handler with no effect on `jsonContent`, causing the assertions on `jsonContent`/`defaultGarmentPhasePrompt`/`defaultFacePhasePrompt` to fail. The empty/no-face-node rejection tests will fail because nothing 400s yet (no validation exists for these new fields). Confirm each of the 7 new tests fails; the pre-existing tests in this file must still pass.

- [ ] **Step 5: Add the `writePromptText` helper**

Open `apps/api/src/modules/admin/workflows.routes.ts`. Add this function immediately after `extractDefaultPrompts` (which ends at line 76) and before the `// ── Routes ──` comment (line 78):

```ts
// Writes into whichever key the node already uses (standard CLIPTextEncode = "text",
// custom nodes like TextEncodeQwenImageEditPlusPro = "prompt") — mirrors extractPromptText's
// read priority so a write always lands in the field ComfyUI actually reads for that node.
// Defaults to "text" (the standard CLIPTextEncode key) when the node has neither key yet.
function writePromptText(json: Record<string, unknown>, nodeId: string, text: string): void {
  const node = json[nodeId] as WorkflowNode | undefined;
  if (!node) return;
  node.inputs ??= {};
  const key = 'prompt' in node.inputs ? 'prompt' : 'text';
  node.inputs[key] = text;
}
```

- [ ] **Step 6: Wire the write path into the PATCH handler**

In the same file, find the `PATCH /admin/workflows/:id` handler. Two edits:

**6a.** In the destructured `body` type (currently lines 505-528), add the two new fields after `garmentPhasePromptNode?: string;` (line 523):

```ts
        garmentPhasePrompt?: string;
        facePhasePrompt?: string;
```

**6b.** Find this existing block (currently lines 606-615):

```ts
      const newNegNode = body.facePhasePromptNode ?? existing.facePhasePromptNode;
      const newPosNode = body.garmentPhasePromptNode ?? existing.garmentPhasePromptNode;

      let defaultFacePhasePrompt = existing.defaultFacePhasePrompt;
      let defaultGarmentPhasePrompt = existing.defaultGarmentPhasePrompt;
      if (body.facePhasePromptNode || body.garmentPhasePromptNode) {
        const extracted = extractDefaultPrompts(json, newNegNode, newPosNode);
        defaultFacePhasePrompt = extracted.defaultFacePhasePrompt;
        defaultGarmentPhasePrompt = extracted.defaultGarmentPhasePrompt;
      }
```

Replace it with:

```ts
      const newNegNode = body.facePhasePromptNode ?? existing.facePhasePromptNode;
      const newPosNode = body.garmentPhasePromptNode ?? existing.garmentPhasePromptNode;

      if (body.garmentPhasePrompt !== undefined) {
        if (!body.garmentPhasePrompt.trim()) {
          throw new AppError(
            'VALIDATION',
            400,
            'garmentPhasePrompt cannot be empty — an empty positive prompt causes ComfyUI to reject the job',
          );
        }
        writePromptText(json, newPosNode, body.garmentPhasePrompt);
      }
      if (body.facePhasePrompt !== undefined) {
        if (!newNegNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot set facePhasePrompt: this workflow has no face-phase prompt node',
          );
        }
        writePromptText(json, newNegNode, body.facePhasePrompt);
      }

      let defaultFacePhasePrompt = existing.defaultFacePhasePrompt;
      let defaultGarmentPhasePrompt = existing.defaultGarmentPhasePrompt;
      if (
        body.facePhasePromptNode ||
        body.garmentPhasePromptNode ||
        body.facePhasePrompt !== undefined ||
        body.garmentPhasePrompt !== undefined
      ) {
        const extracted = extractDefaultPrompts(json, newNegNode, newPosNode);
        defaultFacePhasePrompt = extracted.defaultFacePhasePrompt;
        defaultGarmentPhasePrompt = extracted.defaultGarmentPhasePrompt;
      }
```

**6c.** Find the `updateValues` object initialization (currently lines 617-621):

```ts
      const updateValues: Record<string, unknown> = {
        updatedAt: new Date(),
        defaultFacePhasePrompt,
        defaultGarmentPhasePrompt,
      };
```

Replace it with:

```ts
      const updateValues: Record<string, unknown> = {
        updatedAt: new Date(),
        defaultFacePhasePrompt,
        defaultGarmentPhasePrompt,
      };
      if (body.garmentPhasePrompt !== undefined || body.facePhasePrompt !== undefined) {
        updateValues.jsonContent = json;
      }
```

- [ ] **Step 7: Expose `facePhasePromptNode` on the list endpoint**

In the same file, find the `GET /admin/workflows` handler's returned mapping (currently lines 101-124). Add one line immediately after `defaultGarmentPhasePrompt: r.defaultGarmentPhasePrompt,` (line 109):

```ts
      facePhasePromptNode: r.facePhasePromptNode,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.integration.config.ts admin-workflows` (from `apps/api`)
Expected: PASS, all tests in the file green (the 7 new tests plus every pre-existing test in `admin-workflows.test.ts`).

- [ ] **Step 9: Run typecheck and lint for the API package**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api lint`
Expected: both succeed with no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/admin.ts apps/api/src/modules/admin/workflows.routes.ts apps/api/test/integration/admin-workflows.test.ts
git commit -m "feat(api,types): let admins edit workflow prompt text, persisted into jsonContent"
```

---

## Task 2: Frontend — prompt textareas in the Edit workflow modal

**Files:**
- Modify: `apps/admin-web/src/types.ts` (`WorkflowOption`)
- Modify: `apps/admin-web/src/pages/WorkflowsPage.tsx`

**Interfaces:**
- Consumes: `garmentPhasePrompt`/`facePhasePrompt` PATCH body fields (Task 1); `facePhasePromptNode` on the `GET /admin/workflows` list response and on `WorkflowOption` (Task 1, Step 7).
- Produces: nothing consumed by another task — this is the last task in the plan.

- [ ] **Step 1: Add `facePhasePromptNode` to `WorkflowOption`**

Open `apps/admin-web/src/types.ts`. Find the `WorkflowOption` interface (starts at line 69). Add this line immediately after `defaultGarmentPhasePrompt: string;` (line 77):

```ts
  facePhasePromptNode: string | null;
```

- [ ] **Step 2: Extend `editForm` state**

Open `apps/admin-web/src/pages/WorkflowsPage.tsx`. Find the `editForm` state declaration (currently lines 49-53):

```ts
  const [editForm, setEditForm] = useState({
    label: '',
    slug: '',
  });
```

Replace it with:

```ts
  const [editForm, setEditForm] = useState({
    label: '',
    slug: '',
    garmentPhasePrompt: '',
    facePhasePrompt: '',
  });
```

- [ ] **Step 3: Pre-fill the new fields when opening Edit**

This file has two places that open the Edit modal — one in the mobile/card view and one in the desktop table view — both calling `setEditingWf(wf); setEditForm({ label: wf.label, slug: wf.slug });` (currently around lines 377-381 and again around lines 629-635; search for `setEditingWf(wf);` to find both occurrences). In **both** places, replace:

```ts
                              setEditingWf(wf);
                              setEditForm({
                                label: wf.label,
                                slug: wf.slug,
                              });
```

with:

```ts
                              setEditingWf(wf);
                              setEditForm({
                                label: wf.label,
                                slug: wf.slug,
                                garmentPhasePrompt: wf.defaultGarmentPhasePrompt,
                                facePhasePrompt: wf.defaultFacePhasePrompt,
                              });
```

(Match each occurrence's existing indentation exactly — the two call sites are indented differently since one is inside the mobile card list and one inside the desktop table row; keep whatever indentation each already has, only add the two new lines to the object literal.)

- [ ] **Step 4: Add the two textareas to the Edit modal**

Find the Edit modal's `modal-body` div (currently lines 991-1019), which currently contains the Label and Slug fields ending with:

```tsx
              <div className="field">
                <label>Slug</label>
                <input
                  className="input"
                  value={editForm.slug}
                  disabled={editSaving}
                  placeholder="snake_case"
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    }))
                  }
                />
              </div>
            </div>
```

Replace it with (adds two new fields inside the same `modal-body`, before its closing `</div>`):

```tsx
              <div className="field">
                <label>Slug</label>
                <input
                  className="input"
                  value={editForm.slug}
                  disabled={editSaving}
                  placeholder="snake_case"
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    }))
                  }
                />
              </div>
              <div className="field">
                <label>Garment-phase prompt</label>
                <textarea
                  className="input"
                  rows={4}
                  value={editForm.garmentPhasePrompt}
                  disabled={editSaving}
                  onChange={(e) =>
                    setEditForm((f) => ({ ...f, garmentPhasePrompt: e.target.value }))
                  }
                />
              </div>
              {editingWf?.facePhasePromptNode && (
                <div className="field">
                  <label>Face-phase (negative) prompt</label>
                  <textarea
                    className="input"
                    rows={4}
                    value={editForm.facePhasePrompt}
                    disabled={editSaving}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, facePhasePrompt: e.target.value }))
                    }
                  />
                </div>
              )}
            </div>
```

- [ ] **Step 5: Widen the modal**

In the same modal, find its `style` prop (currently line 978):

```ts
            style={{ width: 'min(420px, calc(100vw - 40px))' }}
```

Replace it with:

```ts
            style={{ width: 'min(640px, calc(100vw - 40px))' }}
```

- [ ] **Step 6: Include the new fields in the save payload and disabled condition**

Find `handleEditSave` (currently lines 171-205). Find this block inside it:

```ts
      const patch: Record<string, unknown> = {
        label: editForm.label.trim(),
        slug: editForm.slug.trim(),
      };
```

Replace it with:

```ts
      const patch: Record<string, unknown> = {
        label: editForm.label.trim(),
        slug: editForm.slug.trim(),
        garmentPhasePrompt: editForm.garmentPhasePrompt.trim(),
      };
      if (editingWf.facePhasePromptNode) {
        patch.facePhasePrompt = editForm.facePhasePrompt.trim();
      }
```

Find the Save button's `disabled` condition (currently line 1030):

```ts
                disabled={editSaving || !editForm.label.trim() || !editForm.slug.trim()}
```

Replace it with:

```ts
                disabled={
                  editSaving ||
                  !editForm.label.trim() ||
                  !editForm.slug.trim() ||
                  !editForm.garmentPhasePrompt.trim()
                }
```

- [ ] **Step 7: Verify the frontend builds**

Run: `pnpm --filter @tryme/admin build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 8: Manual verification**

Run:
```bash
pnpm docker:up
pnpm --filter @tryme/api dev
pnpm --filter @tryme/admin dev
```

In a browser, sign in to the admin panel, open **Workflows**, and verify:
1. Click "Edit" on a workflow that has a face-phase prompt node — both textareas appear, pre-filled with the current garment-phase and face-phase prompt text.
2. Click "Edit" on a workflow with no face-phase prompt node — only the garment-phase textarea appears.
3. Edit the garment-phase prompt text, click Save — the modal closes, no error toast.
4. Click "View" on the same workflow — the "Node mappings" section's displayed prompt-related data reflects the new text (via `defaultGarmentPhasePrompt`, returned by `GET /admin/workflows/:id`).
5. Re-open "Edit" on the same workflow — the garment-phase textarea now pre-fills with the text you just saved (confirms the round-trip through `defaultGarmentPhasePrompt`, not just the JSON write).
6. Try clearing the garment-phase textarea to blank and clicking Save — the Save button is disabled (client-side), matching the backend's rejection rule.

If any check fails, fix it before considering this task complete — do not defer UI bugs found here, since frontend has no automated test net per this project's scope.

- [ ] **Step 9: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/WorkflowsPage.tsx
git commit -m "feat(admin-web): add prompt-editing textareas to the Edit workflow modal"
```
