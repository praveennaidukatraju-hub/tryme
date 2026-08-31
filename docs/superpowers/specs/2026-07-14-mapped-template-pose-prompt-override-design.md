# Mapped-Template Pose Prompt Override — Design

## Problem

The recently-added `catalogue_template_pose_workflows` table lets an admin assign a specific ComfyUI workflow to a specific pose within a specific (catalogue template × garment type) mapping. When a job is created against a mapping, `jobs/create.ts` snapshots the resolved `workflowTemplateId` into `job_inputs.params`, and the dispatcher (`processor.ts:208-217`) honors that snapshot by overriding the pose's own default workflow — but it also unconditionally nulls out `effectivePromptFacePhase`/`effectivePromptGarmentPhase`, discarding any custom prompt the pose has (via `model_pose_assets.promptGarmentPhase` or a `pose_garment_configs` override) whenever that pose is used through a template mapping. The assigned workflow's own hardcoded default prompt always wins instead.

This was flagged during review of the mapping feature as a real, if defensible, behavior gap: there's no way to give a mapped-template pose its own custom prompt, the same way `pose_garment_configs` already lets a pose have a custom prompt per garment type outside the mapping flow. This spec adds that capability, mirroring the existing `pose_garment_configs` mechanism.

## Confirmed decisions

- Only `promptGarmentPhase` gets a column, admin API surface, and UI. `pose_garment_configs` already carries a parallel `promptFacePhase` column that its own admin UI never exposes (`PoseConfigsPanel` always saves `promptFacePhase: null`) — replicating that unused column on the new table would be dead weight. Face-phase prompt stays `null` for mapped-template jobs, unchanged from today.
- The override is scoped to `(mappingId, poseAssetId)` — same granularity as the workflow assignment itself, since a `catalogue_template_pose_workflows` row cannot exist without a `workflowTemplateId` (`NOT NULL`), the prompt override can only ever be set on a row that already has a workflow assigned.
- Precedence and snapshot mechanics mirror the existing `workflowTemplateId` handling exactly: resolved and validated at job-creation time, snapshotted into `job_inputs.params`, and read by the dispatcher from the snapshot rather than re-queried at dispatch time (avoids a job's behavior changing if an admin edits the mapping after the job was queued).

## Design

### 1. Data model

Add to `catalogueTemplatePoseWorkflows` (`packages/db/src/schema/models.ts`):

```ts
promptGarmentPhase: text('prompt_garment_phase'),
```

Nullable, no default. New Drizzle migration. Backward-compatible — every existing row gets `NULL` (falls back to current "always use workflow's own default" behavior — no observable change until an admin sets an override).

### 2. Admin API (`apps/api/src/modules/admin/subcategories.routes.ts`)

**`GET /admin/assets/catalogue-template-mappings/:mappingId/poses`** — add `promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase` to the existing select, and return it on each item. No new "default" field is needed from this endpoint — the modal already has the full `workflows` list loaded client-side and can read the assigned workflow's own `defaultGarmentPhasePrompt` for pre-fill purposes (see UI section).

**`PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId`** — body schema becomes:

```ts
body: z.object({
  workflowTemplateId: z.string().uuid().nullable(),
  promptGarmentPhase: z.string().nullable().optional(),
}),
```

`promptGarmentPhase` absent from the body (`undefined`) means "don't touch it" — this is what the workflow-`<select>`'s own PATCH calls send today, and they must not clobber a previously-saved prompt override. An explicit `null` clears it.

Behavior:
- `workflowTemplateId === null` → existing delete-row branch, unchanged (a deleted row has no prompt to preserve).
- `workflowTemplateId` present → existing insert/`onConflictDoUpdate` branch. The `set` clause conditionally includes `promptGarmentPhase` only when the request body actually contains that key:

```ts
const patch: { workflowTemplateId: string; promptGarmentPhase?: string | null; updatedAt: Date } = {
  workflowTemplateId,
  updatedAt: new Date(),
};
if ('promptGarmentPhase' in (req.body as object)) {
  patch.promptGarmentPhase = promptGarmentPhase ?? null;
}
await app.db
  .insert(schema.catalogueTemplatePoseWorkflows)
  .values({ mappingId, poseAssetId, workflowTemplateId, promptGarmentPhase: promptGarmentPhase ?? null })
  .onConflictDoUpdate({
    target: [schema.catalogueTemplatePoseWorkflows.mappingId, schema.catalogueTemplatePoseWorkflows.poseAssetId],
    set: patch,
  });
```

(The `insert` branch always includes whatever `promptGarmentPhase` was sent — or `null` if omitted — since a brand-new row has nothing to preserve; only the `onConflictDoUpdate.set` needs the conditional to avoid clobbering an existing value on a workflow-only PATCH.)

### 3. Job creation (`apps/api/src/modules/jobs/create.ts`)

The `mappingPoseWorkflows` resolution query (lines 258-266) adds `promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase` to its select. The mapped row objects returned by that block (lines 323-329) carry it through:

```ts
return {
  poseId,
  workflowTemplateId: row.workflowTemplateId,
  lowerNodeId: row.lowerNodeId,
  shoeNodeId: row.shoeNodeId,
  sizeNodeIds: row.sizeNodeIds,
  promptGarmentPhase: row.promptGarmentPhase,
};
```

The existing `params` snapshot block (around line 471-476, inside the `catalogueTemplateMappingId ? {...} : {}` spread) adds the prompt alongside the already-snapshotted `workflowTemplateId`:

```ts
...(catalogueTemplateMappingId
  ? {
      catalogueTemplateMappingId,
      workflowTemplateId: pw?.workflowTemplateId,
      promptGarmentPhase: pw?.promptGarmentPhase ?? undefined,
    }
  : {}),
```

`?? undefined` (not `?? null`) matches the existing sibling field's convention — omits the key from the JSONB entirely rather than writing an explicit `null`, keeping `job_inputs.params` payloads minimal.

### 4. Dispatcher (`apps/dispatcher/src/job/processor.ts:208-217`)

Replace the unconditional null-out with reading the snapshotted value, falling back to `null` (today's behavior — "use the assigned workflow's own default prompt") when no override was set:

```ts
const snapshottedWorkflowTemplateId =
  typeof rawParams.workflowTemplateId === 'string' ? rawParams.workflowTemplateId : null;
if (snapshottedWorkflowTemplateId) {
  effectiveWorkflowTemplateId = snapshottedWorkflowTemplateId;
  effectivePromptFacePhase = null;
  effectivePromptGarmentPhase =
    typeof rawParams.promptGarmentPhase === 'string' ? rawParams.promptGarmentPhase : null;
} else if (inputs.garmentTypeId) {
  // unchanged
}
```

`effectivePromptFacePhase` stays hardcoded `null` for the mapped-template path — consistent with the "no face-phase override" scope decision above, and it was already `null` here before this change.

### 5. Admin UI (`apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`, `MappedTemplateWorkflowModal`)

`MappedTemplatePoseWorkflow` (`apps/admin-web/src/types.ts:104-110`) gains `promptGarmentPhase: string | null`.

Each pose row currently renders a 3-column grid (thumbnail / name+badge / workflow `<select>`). Add a small "Prompt" toggle button after the `<select>`, disabled/hidden when `item.workflowTemplateId` is null (no row can exist to attach a prompt to without a workflow already assigned — matches the table's `NOT NULL` constraint). Toggling expands an inline textarea beneath the row:

- Pre-filled value: `item.promptGarmentPhase ?? workflows.find(w => w.id === item.workflowTemplateId)?.defaultGarmentPhasePrompt ?? ''` — shows the override if set, otherwise previews what the assigned workflow would use by default, mirroring the pre-fill convention `PoseConfigsPanel.openEdit` already uses for the non-mapped flow.
- An explicit "Save" button (not autosave-on-keystroke, matching `PoseConfigsPanel`'s existing UX for text fields) that calls:

```ts
await apiFetch(`/admin/assets/catalogue-template-mappings/${mapping.mappingId}/poses/${poseAssetId}`, {
  method: 'PATCH',
  body: JSON.stringify({ workflowTemplateId: item.workflowTemplateId, promptGarmentPhase: text || null }),
});
```

(Always includes the row's current `workflowTemplateId` — the PATCH body requires it regardless of what's being changed.)

The existing "Ready" / "Workflow required" badge gains a secondary small badge/dot when `item.promptGarmentPhase` is set, mirroring the `hasPromptOverride` visual treatment in `PoseConfigsPanel`.

### 6. Testing

- `apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`: extend the PATCH-endpoint tests — setting `promptGarmentPhase` alone (workflow already assigned) doesn't touch `workflowTemplateId`; setting `workflowTemplateId` alone (omitting `promptGarmentPhase`) doesn't clobber a previously-saved prompt; explicit `promptGarmentPhase: null` clears it; deleting the row (`workflowTemplateId: null`) removes any prompt with it.
- `apps/api/test/integration/jobs-create-looks.test.ts`: assert that when a mapping-pose row has `promptGarmentPhase` set, the created job's `job_inputs.params.promptGarmentPhase` matches it; assert it's absent from `params` when unset.

## Out of scope

- `promptFacePhase` on the new table (see Confirmed decisions).
- Any change to the existing `pose_garment_configs` / non-mapped-template prompt-override flow — untouched.
- Bulk-apply prompt across multiple poses in one mapping (the existing `PoseConfigsPanel` has bulk actions for workflow but not prompt; this feature doesn't need to match that either — single-row editing only, matching the granularity of the "Configure workflows" modal today).
