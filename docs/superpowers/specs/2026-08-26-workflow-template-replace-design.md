# Workflow Template Replace (with drain)

**Status:** Approved design, not yet implemented.
**Date:** 2026-08-26

## 1. Problem Statement

Today, swapping a `workflow_templates` row's underlying ComfyUI graph for a
genuinely different one means creating a brand-new template row and manually
reassigning every foreign key that points at the old one —
`model_poses.workflowTemplateId`, `pose_garment_configs.workflowTemplateId`,
`garment_subcategories`' several mannequin/two-input template columns,
`tryon_categories.workflowTemplateId`, saree config, dev-api config, Shopify
catalog jobs (verified: `packages/db/src/schema/{models,dev-api,saree,shopify,
tryon}.ts` all FK into `workflow_templates.id`, across at least 9 distinct
columns). For a template used by many poses/configs, this reassignment is
tedious and error-prone, and there is no single-action way to say "this
template's content is now this new graph, keep everything that points at it
pointing at it."

This design adds a **Replace** action: the admin uploads a new workflow JSON
for an *existing* template row; the row's `id` never changes, so every FK
relationship above is untouched by construction — there is nothing to
reassign.

## 2. The Complication: In-Flight Jobs

The dispatcher resolves a job's effective `workflowTemplateId` and then loads
`workflow_templates.jsonContent` **fresh, by id, at dispatch time** — verified
in `apps/dispatcher/src/workflow/patcher.ts:17-21` (`loadTemplate` selects by
`eq(schema.workflowTemplates.id, workflowTemplateId)`) and independently in
six call sites in `apps/dispatcher/src/job/processor.ts` (lines ~501, 957,
1240, 1548, 1849, 2177 as of this writing) that each run the identical
`.where(eq(schema.workflowTemplates.id, workflowTemplateId))` lookup. There is
no snapshot of template content taken at job-creation time for the common
"regular" tryon path — only a few paths (mannequin phase, saree step-2,
job-regenerate) already snapshot a *resolved template id* into
`job_inputs.params.workflowTemplateId` (`apps/api/src/modules/jobs/create.ts:
1129` is one such site).

Consequence: if a template's content is overwritten in place, any job that is
currently `QUEUED` or `PROCESSING` against that template id will pick up the
**new** content the moment it (or its next retry) reaches the dispatcher —
even though it was created under the assumption of the old graph's shape.
If the new graph is structurally different, that job's `job_inputs` (built
for the old shape) may not make sense against the new one.

**Decision:** jobs already in flight at replace-time keep resolving against
the **old** content until they finish. Jobs created *after* the admin confirms
the replace get the **new** content immediately — there is no window where
new job creation is blocked or degraded. This requires the system to serve two
versions of one template row's content simultaneously for the (bounded) drain
period, which is the reason this is a full design and not a one-line `UPDATE`.

## 3. Data Model

### 3.1 `workflow_templates.version`

```sql
ALTER TABLE workflow_templates ADD COLUMN version integer NOT NULL DEFAULT 1;
```

Incremented by exactly 1 on every confirmed replace. Not user-facing as a
"version number" concept beyond an admin-visible "last replaced at" — its only
job is to let a job's snapshot be compared against "is this still current."

### 3.2 New table `workflow_template_archives`

```ts
export const workflowTemplateArchives = pgTable('workflow_template_archives', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowTemplateId: uuid('workflow_template_id').notNull()
    .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  // Mirrors every column on workflow_templates that the dispatcher patcher
  // and the admin mapping-review UI read: jsonContent plus every
  // *NodeId/*NodeIds mapping column, workflowType, and the stage1/default-
  // prompt columns. Exact column list finalized against the live
  // workflow_templates schema during implementation, not duplicated here to
  // avoid this spec drifting out of sync with schema changes.
  jsonContent: jsonb('json_content').notNull(),
  // ... mirrored mapping columns ...
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // At most one archived (draining) version per template, enforced at the DB
  // level, not just in application logic — a second concurrent replace on the
  // same template must fail loudly, not silently create two archive rows that
  // the drain-cleanup logic would then have to disambiguate.
  oneActiveArchivePerTemplate: unique('workflow_template_archives_template_unique')
    .on(t.workflowTemplateId),
}));
```

A row here means "this template has a replace in progress; jobs stamped with
`version` should resolve against this row's content, not the live one."
Deleted by drain-cleanup (§5) once no non-terminal job references it.

### 3.3 `job_inputs.params.dispatchTemplateVersion`

No schema migration — `job_inputs.params` is already an unconstrained `jsonb`
column used for exactly this kind of per-job routing metadata (`params.kind`,
`params.needsMannequinStep`, and the existing `params.workflowTemplateId`
snapshot at `jobs/create.ts:1129` are the established precedent). Wherever a
job-creation path already resolves the effective `workflowTemplateId` (the
majority of paths already do this — verified multiple resolution sites in
`apps/api/src/modules/jobs/create.ts` at lines 688, 741, 756, 1090, plus the
saree/mannequin/dev/merchant/shopify/kiosk creation paths each resolving their
own effective template id), that same code also reads the resolved template's
current `version` column and writes `{ ...params, dispatchTemplateVersion:
version }`. This is an additive field alongside existing resolution logic, not
new resolution logic — no path currently missing a resolved template id needs
to gain one just for this feature.

## 4. Dispatcher: Centralized Template Loader

The six duplicated `.where(eq(schema.workflowTemplates.id, workflowTemplateId))`
call sites in `processor.ts`, plus `patcher.ts:loadTemplate`, are consolidated
into one function, `resolveTemplateForDispatch(app, { workflowTemplateId,
snapshotVersion })` in `apps/dispatcher/src/workflow/`. This mirrors the
"one registry, not eight independently-maintained copies" precedent already
established in this codebase's job-taxonomy design
(`docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md`).

Logic:
1. Fetch the live `workflow_templates` row by id.
2. If `snapshotVersion` is absent (job predates this feature, or the path
   never stamped one) or equals the live row's `version` — use the live row.
   This is the common case and is byte-identical to today's behavior.
3. Otherwise, fetch `workflow_template_archives` by
   `(workflowTemplateId, snapshotVersion)`. If found, use its content instead.
   If not found (a job somehow outlived its archive — should not happen under
   the invariants in §5, but is a real possibility if an operator manually
   deletes an archive row), fail the job with a clear `error_code` rather than
   silently falling back to the live (structurally-unrelated) content — a
   loud, attributable failure is preferable to a job that dispatches against
   the wrong graph and produces a nonsensical result.

All six call sites and `patcher.ts` switch to this one function. No call site
keeps its own copy of the lookup.

## 5. Drain Cleanup

An archive row is safe to delete once no `QUEUED`/`PROCESSING` job references
`(workflowTemplateId, version)` via `job_inputs.params.dispatchTemplateVersion`.

Trigger: checked whenever a job that referenced an archived version reaches a
terminal state (`COMPLETED`/`FAILED`/`CANCELLED`) — a cheap, targeted check
(`SELECT count(*) FROM jobs j JOIN job_inputs ji ON ji.job_id = j.id WHERE
ji.params->>'dispatchTemplateVersion' = :version AND j.status NOT IN
('COMPLETED','FAILED','CANCELLED')`, scoped to the one template+version being
watched) rather than a periodic sweep over the whole table.

No new stuck-job handling is introduced. This system's existing stuck-job
sweeper (`apps/dispatcher/src/stream/sweeper.ts`) already forces any job stuck
past its timeout to `FAILED` (a terminal state, confirmed by reading the
sweeper's `markFailed` path), which bounds how long a drain can possibly take
even in the worst case (one hung worker) to that sweeper's existing interval —
no separate override or force-complete action is being added for this
feature.

## 6. Replace Flow

### 6.1 Authorization — two independent gates, not one

1. **Permission**: the existing `workflows.write` permission
   (`apps/api/src/modules/admin/workflows.routes.ts:147`), unchanged — same
   gate that already covers create/edit/delete on templates.
2. **Password re-confirmation** (new): on top of #1, not instead of it. The
   acting admin re-enters their own account password, verified server-side
   against `admin_users.passwordHash` via the existing `verifyPassword`
   helper (`apps/api/src/modules/auth/service.ts`) — the same check used at
   login. This is the first "step-up" pattern in this codebase (no prior admin
   route requires re-authentication beyond the standing JWT), justified by the
   blast radius: unlike today's PATCH-style edits (tweaking a prompt or a
   KSampler value within the same graph), a replace can swap the entire graph
   shape underneath every pose/config that points at this template
   simultaneously, silently, the moment it's confirmed.

### 6.2 UI flow (admin-web)

1. From a template's row/detail (`apps/admin-web/src/pages/WorkflowsPage.tsx`),
   a **Replace workflow** action opens a modal.
2. Admin uploads the new workflow JSON. It runs through the same per-`workflowType`
   auto-detection already used by the create-workflow flow
   (`WorkflowUploadModal.tsx`'s existing parse branches, `two-stage-detect.ts`
   and siblings) — reused as-is, since the new graph may be structurally
   different from the old one, including a different `workflowType` entirely.
3. Review screen: detected mappings (editable, same UX as create), plus an
   **impact summary** — count of poses/configs currently pointing at this
   template id, and, if the new mappings' `lowerNodeId`/`shoeNodeId`
   presence differs from the current row's, an explicit note that dependent
   poses' `hasLower`/`hasShoes` will change as a result. This is a deliberate,
   expected consequence of not reassigning FKs — it must never be a silent
   surprise the admin discovers later.
4. **Password field.** Submitting without a correct password is rejected
   (401/403, not silently ignored).
5. On success: modal closes, row shows a "Replacement in progress — draining
   N old job(s)" badge until drain-cleanup (§5) removes the archive.

### 6.3 API

New route, `POST /admin/workflows/:id/replace`, guarded by
`workflows.write` + password verification, body:
`{ jsonContent, <detected/edited mapping fields>, password }`.

Rejects with a clear error (not a generic 500) if:
- Password is incorrect.
- An archive row already exists for this template (`workflow_template_archives`
  unique constraint, §3.2) — "a replacement is already in progress for this
  template; wait for it to finish before starting another."

On success, in one transaction:
1. Copy the current row's `jsonContent` + mapping columns into a new
   `workflow_template_archives` row tagged with the current `version`.
2. Overwrite the live row's `jsonContent` + mapping columns with the new
   values; increment `version`.
3. `recordAudit(tx, ...)` — before/after snapshot, per this codebase's
   existing fail-closed admin-mutation invariant (if the audit insert throws,
   the whole replace rolls back).

## 7. Non-Goals (v1)

- **Rollback of an already-confirmed replace.** Once confirmed, the only way
  back to the old graph is another explicit replace using the old file. No
  "undo" button.
- **Viewing/inspecting the archived (draining) version's content** in the
  admin UI beyond the "draining N jobs" badge — no side-by-side diff viewer,
  no read endpoint for archive rows.
- **Concurrent replaces on the same template.** Exactly one archive per
  template at a time, enforced at the DB level (§3.2). A second replace
  attempt while one is draining is rejected, not queued.
- **A force-complete/override action** for a stuck drain — the existing
  stuck-job sweeper already bounds this (§5).
- **Timestamp-based version inference** (comparing job `createdAt` against a
  `lastReplacedAt` column instead of an explicit per-job stamped version) was
  considered and rejected: it cannot cleanly disambiguate two replaces close
  together and gives the drain-cleanup query nothing precise to key off of.
  The explicit `dispatchTemplateVersion` stamp is the same implementation
  cost with none of that ambiguity.

## 8. Testing

- Integration test: create a template, queue a job against it (stamped with
  `version=1`), confirm a replace (now `version=2`, archive row for
  `version=1` exists), assert the queued job still resolves `version=1`'s
  content at dispatch, assert a *new* job created after the replace resolves
  `version=2` immediately.
- Drain cleanup: complete the `version=1` job, assert the archive row is
  deleted.
- Concurrency: attempt a second replace while an archive row exists for the
  same template → rejected with the specific "already in progress" error, not
  a generic conflict.
- Auth: replace attempt with correct permission but wrong password → 401/403,
  no state changed (no archive row created, `version` unchanged, no audit
  entry beyond a failed-attempt record if this codebase's audit convention
  calls for logging failed attempts — confirm against existing patterns during
  implementation).
- Missing-archive edge case: manually delete an archive row referenced by a
  still-queued job's stamp, confirm the job fails loudly with a specific error
  code rather than silently dispatching against the live (wrong) content.
- Impact summary: seed multiple poses/configs pointing at one template,
  confirm the review screen's counts match, and confirm a mapping change that
  flips `lowerNodeId` from set to null is reflected in the `hasLower` warning.
