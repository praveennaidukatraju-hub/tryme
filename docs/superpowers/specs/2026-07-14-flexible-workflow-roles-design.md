# Flexible Workflow Roles — Design (Sub-project A of Wear-Type Support)

> **Revision 3.** Revision 2 fixed 8 gaps found in a review of Revision 1. A second review of Revision 2 found 10 more confirmed issues — some new bugs introduced by Revision 2's own fixes (a TypeScript error, an incomplete admin-UI fix, a worker-leak risk, an internal wording contradiction), and some genuine gaps in scope (a crash in `/v1/assets`, a `lowerCatalogId`-as-hero inconsistency, per-pose garment-key stripping) plus two **pre-existing bugs** in `regenerate.ts` that predate this feature entirely but block Decision 2's commitment that regeneration must actually work for lower-only jobs (a 24h upload-ownership TTL, and loss of catalogue-template-mapping context on regenerate). This revision incorporates all 10 fixes. Every claim was independently re-verified against the current codebase.

## Problem

Every "regular" `workflow_templates` row today hard-requires `faceNodeId`, `poseNodeId`, `bgNodeId`, and a non-empty `upperNodeIds` (enforced by `CreateWorkflowBody`'s `superRefine`, `packages/types/src/admin.ts:191-212`). This makes it impossible to upload a workflow for a garment type that isn't "upper garment on a full-body model shot" — specifically, lower-wear-only or inner-wear-only generation, where the hero garment is the lower/inner slot and there may be no face node at all.

This is Sub-project A of a two-part feature. **Sub-project B** (not this spec) is the studio wizard's gender → wear-type → garment-type selection UX, which depends on A existing first. A's job: make flexible workflows genuinely uploadable via admin and runnable end-to-end via the job-creation API — including regeneration and every surface that displays a job's source garment — fully testable without touching the studio page.

## Confirmed decisions from brainstorming

- Inner wear reuses the **upper** node role — no new node field. The upper/inner distinction is a catalog/UX classification (Sub-project B's concern), not a different ComfyUI node structure. **A lower-primary workflow has empty `upperNodeIds`; an inner-primary workflow has non-empty `upperNodeIds`** (Revision 3 correction — Revision 2 said "lower/inner-primary... empty `upperNodeIds`" for both, which directly contradicted this same bullet's first sentence).
- Lower/inner-primary generation shows **only** that garment as the hero (not paired with a separate upper item) — confirmed by the user.
- **Pose stays mandatory** for every regular workflow.
- **`faceId` and `backgroundId` stay mandatory at the job-creation API** — every look always carries a `backgroundId`; `faceId` is always a single top-level field. Neither becomes optional at any layer.
- **`upperGarmentKey` is the only job-creation field that becomes optional**, gated by what the *actually resolved* workflow for each look requires, not a request-level flag.
- **A workflow may declare both an upper role and a lower role simultaneously** (Decision 1) — matches every existing production workflow, no new schema capability.
- **Missing runtime garment/face/background input for a node the resolved workflow actually maps is a hard job failure with refund** (Decision 3 from Rev 2) — applies uniformly to upper/lower/shoe, superseding the pre-existing lower/shoe "fall back to upper garment" behavior.
- **Sub-project A's scope includes regeneration, catalogue history, `/v1/assets`, and results/admin display of lower-only jobs** (Decision 2, expanded in Revision 3 to explicitly include `/v1/assets` — Revision 2 missed this file, and it's the same commitment).
- **The admin create-workflow UI must change; the admin edit-workflow UI stays out of scope** (unchanged from Revision 2).
- **`lowerCatalogId` may NOT serve as the sole hero for a lower-primary workflow** (Revision 3, Decision 1) — when `upperNodeIds` is empty for the resolved workflow, the lower garment must be a real upload (`lowerGarmentKey`), not a catalog pick. Catalog-picked lower items remain valid as a *paired* accessory when an upper role is also present (unchanged existing behavior for full-outfit workflows) — this is genuinely a hero-vs-accessory distinction, not a blanket ban on `lowerCatalogId`.
- **Regeneration authorizes via ownership of the original completed job, not by re-checking the 24h upload-ownership Redis TTL** (Revision 3, Decision 2) — `regenerate.ts` already verifies `original.job.userId === userId` before reading any of its inputs; re-running the same time-limited ownership check `createJob` uses for fresh uploads is both redundant and actively wrong for anything regenerated after the TTL expires.
- **Mixed-role pose selections within one request are allowed** (Revision 3, Decision 3) — the architecture already lets different poses in one `looks[]` submission resolve to different workflows (that's the purpose of `pose_garment_configs`/`catalogue_template_pose_workflows`); rejecting mixed upper/lower-primary selections would be a new, unrequested restriction. Each resulting job row must store only the garment key(s) its own resolved workflow actually uses (Revision 3, Finding 7).
- **A dispatcher-side fail-closed failure releases its claimed worker back to IDLE before returning** (Revision 3, Decision 4) — matches the existing pattern used by every other failure path in `processor.ts`; validating garment-input completeness before claiming a worker is not pursued, since job-creation's Finding-1/6/7 fixes should already make this path a rare defense-in-depth case, not a normal-operation one.
- **Rollout order matters** — see the "Rollout" section below.

## Design

### 1. Data model

`workflow_templates`: relax to nullable — `faceNodeId`, `bgNodeId`, `facePhasePromptNode`. Stay `NOT NULL`: `poseNodeId`, `garmentPhasePromptNode`, `upperNodeIds` (the column; only its non-empty *validation* relaxes).

`job_inputs`: relax `upperGarmentKey` to nullable.

Both migrations are backward-compatible.

### 2. Admin workflow create — backend (`POST /admin/workflows`)

**Zod floor** (`CreateWorkflowBody`'s `superRefine`): for `workflowType: 'regular'`, require `poseNodeId` + `garmentPhasePromptNode`, plus at least one garment slot (`upperNodeIds` non-empty OR `lowerNodeId` set). If `faceNodeId` is provided, `facePhasePromptNode` must be too. Also drop `upperNodeIds`' `.min(1)` constraint (empty array is now valid).

**Route handler** (`apps/api/src/modules/admin/workflows.routes.ts:277-309`): the non-null-asserted `faceNodeId`/`bgNodeId`/`upperNodeIds` reads and their unconditional `validateNodeExists`/`validateNodeType` calls become conditional, mirroring the PATCH handler's existing per-field pattern. The DB insert writes `faceNodeId: body.faceNodeId ?? null` etc.

**`extractDefaultPrompts` (Revision 3 addition — Finding 6):** this helper (`workflows.routes.ts:62-73`) takes `negativePromptNode: string` (non-optional) and does `json[negativePromptNode]`. It cannot be called with an absent/undefined node ID. When `body.facePhasePromptNode` is not set, skip the negative-prompt half entirely: compute `defaultGarmentPhasePrompt` from the (always-required) positive node as today, and set `defaultFacePhasePrompt: ''` directly rather than calling `extractDefaultPrompts` for it. Concretely, replace the single combined call with two independent computations — one for garment phase (always runs), one for face phase (only when `facePhasePromptNode` is present, else `''`).

### 3. Admin workflow PATCH — merge-then-validate

`PATCH /admin/workflows/:id` currently validates each field in isolation with no check on the resulting final row. Compute the merged shape and re-run the create-time floor check before persisting: at least one garment slot, `facePhasePromptNode` present if `faceNodeId` present.

**`UpdateWorkflowBody.upperNodeIds` schema fix (Revision 3 addition — Finding 10):** this schema currently has `.min(1)` copied from the pre-Revision-2 `CreateWorkflowBody`, never relaxed. As written, the merge-validation logic above can *never* actually observe `upperNodeIds: []` in a PATCH request — Zod rejects the body before the handler runs. Drop `.min(1)` here too: `upperNodeIds: z.array(z.string().min(1)).max(8).optional()`.

### 4. Admin workflow create — UI (`apps/admin-web/src/components/WorkflowUploadModal.tsx`)

`handleSubmit`'s validation relaxes to mirror the new backend floor: `poseNodeId` + positive prompt always required; negative prompt required only if `faceNodeId` is set; at least one garment slot (upper or lower).

**Payload construction fix (Revision 3 addition — Finding 6):** the payload currently sends `faceNodeId`/`bgNodeId` conditionally (`|| undefined`, per Revision 2) but still sends `facePhasePromptNode: negativePromptNode` **unconditionally**. When no face node is set, `negativePromptNode` is `''`, and the Zod schema's `facePhasePromptNode: z.string().min(1).optional()` rejects an explicitly-provided empty string (`.optional()` only permits the key's *absence*, not a present-but-invalid value) — so Revision 2's UI fix does not actually work end-to-end without this. Fix: `facePhasePromptNode: negativePromptNode || undefined,` — same conditional pattern already used for `lowerNodeId`/`shoeNodeId` two lines below it.

Add a short inline hint near the node-mapping section documenting the relaxed requirement.

### 5. Job creation — garment-slot cross-validation (Finding 1, the most severe gap in this feature)

Extend the per-pose validation loop in `apps/api/src/modules/jobs/create.ts:395-402` with a symmetric upper-role check, **and** correct the lower-role check's hero-vs-accessory distinction (Revision 3 addition — Finding 1):

```ts
for (const pw of poseWorkflows) {
  if (pw.upperNodeIds.length > 0 && !upperGarmentKey) {
    throw new AppError('VALIDATION', 400, 'upper garment required for this pose');
  }
  if (pw.lowerNodeId) {
    if (pw.upperNodeIds.length === 0) {
      // Lower is the sole hero for this pose's workflow — must be the customer's
      // own upload, not a generic catalog stock photo (Decision 1, Revision 3).
      if (!lowerGarmentKey) {
        throw new AppError('VALIDATION', 400, 'lower garment upload required for this pose');
      }
    } else if (!lowerCatalogId && !lowerGarmentKey) {
      // Lower is a paired accessory alongside an upper hero — catalog pick remains valid,
      // matching the pre-existing behavior for full-outfit workflows.
      throw new AppError('VALIDATION', 400, 'lower garment required for this pose');
    }
  }
  if (pw.shoeNodeId && !shoeCatalogId) {
    throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
  }
}
```

`upperNodeIds` must be threaded through both the `mappingPoseWorkflows` branch and the `poseWorkflowRows.map(...)` fallback branch in `create.ts`, mirroring how `lowerNodeId`/`shoeNodeId`/`sizeNodeIds` already are. Runs before credit deduction.

**Per-pose garment-key stripping (Revision 3 addition — Finding 7):** the insert loop (`create.ts:~430`) already computes `effectiveLowerCatalogId`/`effectiveLowerGarmentKey`/`effectiveShoeCatalogId`, each gated by whether the resolved workflow for that specific look actually maps the corresponding node — "only store inputs the workflow actually supports." `upperGarmentKey` is stored unconditionally with no matching gate. Add the same pattern:

```ts
const effectiveUpperGarmentKey = pw?.upperNodeIds && pw.upperNodeIds.length > 0 ? upperGarmentKey : null;
```

and store `effectiveUpperGarmentKey` in the `job_inputs` insert instead of the raw `upperGarmentKey`. Without this, a mixed request (Decision 3 — one submission with both upper and lower-primary poses) would leave an irrelevant upper key attached to a lower-only job's row, corrupting `/v1/assets`, catalogue-history hero resolution, and results display for that job.

### 6. Dispatcher patcher — fail closed, not stale-image (unchanged from Revision 2)

Every garment/face/background role, if mapped but unfulfilled at patch time, causes `applyWorkflowPatch` to throw rather than submit a stale/placeholder image or silently skip. `WorkflowInputs.upperGarmentFile`/`faceSideFile`/`backgroundFile` all become optional; `poseFile` stays required. The pre-existing lower/shoe "fall back to upper garment" behavior is replaced by the same throw.

### 7. Dispatcher processor — conditional uploads + worker release on fail-closed failure

Upload `upperGarmentKey` to ComfyUI only when the resolved workflow's `upperNodeIds` is non-empty; skip uploading face/background images when the resolved workflow has no `faceNodeId`/`bgNodeId`.

**Worker release fix (Revision 3 addition — Finding 8):** every existing failure path in `processor.ts` calls `setWorkerStatus(redis, w.id, 'IDLE')` before or alongside `markFailed(...)` — 8 call sites, all following this pattern. The new catch branch for the fail-closed "missing garment input" error (Section 6) is added *after* the worker is already claimed (the whole upload→patch→submit sequence runs inside a `try` block that starts after `selectWorker`), so it must call `setWorkerStatus(redis, w.id, 'IDLE')` too, or a worker hitting this path stays claimed forever — a silent, permanent reduction in GPU capacity per occurrence. Per Decision 4, this is fixed by adding the release call to the new catch branch, not by restructuring validation to run before worker claim.

### 8. Regeneration (`apps/api/src/modules/jobs/regenerate.ts`)

Drop the `|| !inputs.upperGarmentKey` clause from the studio/catalogue-job precondition check (line 67) — require only `poseId`/`faceId`/`backgroundId` at this layer; the downstream `createJob` call performs the real per-workflow slot validation from Section 5.

**Type fix (Revision 3 addition — Finding 5):** `inputs.upperGarmentKey` is Drizzle-typed `string | null`. Once the precondition check above no longer narrows it to non-null, assigning it directly into the reconstructed request's `upperGarmentKey` field (typed `string | undefined` after Section 2's Zod relaxation) is a type error. Use `upperGarmentKey: inputs.upperGarmentKey ?? undefined,`.

**Upload-ownership authorization fix (Revision 3 addition — Finding 3, pre-existing bug, in scope per Decision 2):** `createJob` calls `assertOwnsUploadKey`, which checks a Redis key (`upload:owner:{key}`) with a 24-hour TTL. `regenerate.ts` passes the original job's `upperGarmentKey`/`lowerGarmentKey` straight through to `createJob`, which re-runs that same time-limited check — but `regenerate.ts` has *already* independently verified the caller owns the original job (`original.job.userId !== userId` → 404, line 30) before ever reading those keys. Regenerating any job (of any garment-role shape) older than 24 hours already fails today because of this. Fix: `createJob` gains an internal (non-request-facing) way to accept a set of garment keys that are pre-authorized by the caller — e.g. an optional `trustedGarmentKeys?: Set<string>` parameter — for which it skips the Redis ownership lookup but still performs the existing `headObject`-based existence/size check (the other half of what `assertOwnsUploadKey` does today, which must still run — an object could have been deleted since). `regenerate.ts` populates this set with `inputs.upperGarmentKey`/`inputs.lowerGarmentKey` when reconstructing the request.

**Mapped-template context fix (Revision 3 addition — Finding 4, pre-existing bug, in scope per Decision 2):** `regenerate.ts` always reconstructs the legacy `backgroundId + poseIds` form, never `catalogueTemplateMappingId`/`looks[]`. For a job originally created against a catalogue-template mapping, regeneration silently falls through to `pose_garment_configs`/pose-default resolution instead — which can resolve to an entirely different workflow (wrong garment role, wrong prompt). Fix: read `catalogueTemplateMappingId` from `inputs.params` (already snapshotted there by the mapped-template-workflow feature) — if present, reconstruct the request using `looks: [{ poseId: inputs.poseId, backgroundId: inputs.backgroundId }]` plus `catalogueTemplateMappingId` and `garmentTypeId` instead of the legacy `backgroundId`/`poseIds` fields, so the same mapping-specific workflow resolution Section 5 validates against is used again on regenerate.

### 9. Every surface that displays a job's source garment (Finding 6/2 in Revision 2, expanded in Revision 3)

**`GET /v1/catalogues/:id`** (`jobs/routes.ts:367-403`): resolve `garmentUrl` from whichever hero source is present — `upperGarmentKey` if set, else `lowerGarmentKey` if set, else a catalog-item thumbnail via `lowerCatalogId`.

**`/results/data`** (`results/routes.ts:145`): select `lowerGarmentKey` alongside `upperGarmentKey`; present whichever is set wherever `monitorHtml()` renders the thumbnail.

**`GET /v1/assets` (Revision 3 addition — Finding 2, a confirmed crash, not merely a display gap):** `jobs/routes.ts:407-428` groups solely by `upperGarmentKey`, which is now nullable — any user with a lower-only job produces a row with `r2Key: null`. The consuming frontend, `apps/catalogues-web/src/app/(app)/assets/page.tsx:71`, does `a.r2Key.toLowerCase()` with no null guard: an uncaught `TypeError` on render, crashing the entire "My Products" page for that user. This is not "technically null-safe but incomplete" like the other two surfaces were — it is an unguarded crash, and per this endpoint's own purpose ("list user's unique uploaded garments") a user who has only ever uploaded lower garments should see them here too, not just avoid a crash. Fix: extend the query to surface distinct uploaded garments from *both* `upperGarmentKey` and `lowerGarmentKey` — run two grouped selects (one per column, each still excluding `sourceJobId`-reuse rows per the existing comment), merge and de-duplicate the results by `r2Key` in application code, keeping the most recent `uploadedAt`/highest `jobCount` when a key appears in both (possible if a garment was uploaded once and used as upper in one job, lower in another — unlikely but not impossible). Additionally add a defensive null/empty-string filter in `assets/page.tsx`'s `filtered` computation regardless of the backend fix, since a frontend that trusts an API response to never contain a null in a "non-nullable-looking" field is exactly the kind of assumption this whole review has been finding broken.

### 10. Rollout order

`api` and `dispatcher` deploy independently; no feature-flag system exists in this codebase. Required order: **(1) migration** → **(2) dispatcher** (Sections 6–7, backward compatible on its own) → **(3) api + admin-web** (Sections 2–5, 8–9 — the only layer that can start producing `NULL upper_garment_key` rows). Step 3 must not ship before step 2 is confirmed live.

## Out of scope for A (explicitly deferred to Sub-project B)

- `garment_subcategories` gaining a wear-type classification.
- Any studio wizard / frontend changes beyond the crash fix and hero-resolution fixes in Section 9 (those are correctness fixes to existing surfaces, not new UX).
- `backgroundId`/`faceId` becoming optional at any layer.
- `lowerCatalogId` as a *newly submittable* upload alternative for an upper-primary/mixed workflow — unchanged, still just the pre-existing paired-accessory behavior. (Its use as a sole hero for a lower-primary workflow is explicitly *disallowed*, not newly allowed — see Decision 1, Revision 3.)
- The `(backgroundId+poseIds)` vs `looks` XOR requirement — unchanged at the schema level (Section 8's regeneration fix reconstructs one or the other internally, it doesn't change the public request contract).
- Admin edit-workflow UI for node mappings.
- A feature-flag mechanism.
