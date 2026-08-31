# Pose Shot-Type Default Workflows — Design

## Problem

Workflow assignment for catalogue-template poses is fully manual today, via
`MappedTemplateWorkflowModal` in `apps/admin-web/src/pages/assets/GarmentTypesTab.tsx`
— one dropdown per pose, one pose row at a time, no bulk selection. Every
`(catalogue template × garment type × pose)` combination needs its own click
to populate `catalogue_template_pose_workflows`. At the project's target scale
(hundreds to thousands of templates, ~4 poses each, per garment type) this is
not viable — configuring one garment type end-to-end could mean thousands of
individual dropdown picks.

The "Custom look poses" panel (`PoseConfigsPanel`, same file) already solved
an analogous problem for `pose_garment_configs` with bulk multi-select +
"Apply workflow". That table's cardinality is bounded by
`(general poses × garment types)`, which stays small. The template-mapping
table's cardinality is `(templates × poses-per-template × garment types)`,
which does not.

## Goal

Let an admin configure workflow assignment for an entire garment type — no
matter how many templates are mapped to it, now or in the future — with a
constant, small number of actions (three: one per shot-type category),
instead of one action per pose-per-template.

## Non-goals

- Not touching `pose_garment_configs` / `PoseConfigsPanel` (the "Custom look
  poses" bulk-apply already solves that flow's scale problem).
- Not changing how the dispatcher or `/v1/catalog/:type` /
  `/v1/models/catalogue-templates` *read* `catalogue_template_pose_workflows`
  — this feature only changes how rows in that table get **populated**. Read
  paths are untouched and carry zero regression risk from this work.
- Not building a bulk-backfill script to retroactively tag every existing
  template-scoped pose with a shot type. Existing poses get `shot_type = NULL`
  after migration and are simply not eligible for auto-resolve until someone
  tags them (by re-uploading that look's pose image through the updated
  builder). This is an operational/data-entry follow-up, not a code task.

## Core concept: shot-type category as the assignment key

Every template-scoped pose gets tagged, at creation time, with one of three
shot-type categories: **full pose**, **half pose**, **closeup**. Each garment
type gets a 3-slot default: "poses tagged **full** use Workflow A", "**half**
use Workflow B", "**closeup** use Workflow C". Setting or changing one of
these three defaults immediately re-resolves every matching pose across every
template currently mapped to that garment type, and the same defaults are
applied automatically the moment a new template gets mapped or a new look
gets added to an already-mapped template. Three actions per garment type
covers the entire template surface, present and future.

The existing per-pose dropdown in `MappedTemplateWorkflowModal` is kept for
exceptions — a pose that needs a workflow different from its category's
default.

## Data model

**`model_pose_assets.shot_type`** (new, nullable `text`): `'full' | 'half' |
'closeup'`, validated at the Zod layer (not a DB enum/CHECK) — matches the
existing convention for this table's `scope` column. A 4th category later is
a one-line Zod change, no migration. Set once, at pose-upload time, in the
catalogue-template look-row builder (`EditCatalogueTemplateModal`). General
(`scope='general'`) poses may also carry a shot type but nothing in this
feature reads it for them — the auto-resolve system only concerns itself
with `catalogue_template_pose_workflows`.

**`garment_shot_type_workflows`** (new table) — the 3-slot default per
garment type:
```
id                    uuid PK
garment_type_id       uuid NOT NULL FK -> garment_subcategories(id) ON DELETE CASCADE
shot_type             text NOT NULL   -- 'full' | 'half' | 'closeup'
workflow_template_id  uuid NOT NULL FK -> workflow_templates(id) ON DELETE CASCADE
created_at, updated_at
UNIQUE (garment_type_id, shot_type)
```
A join table, not three fixed columns on `garment_subcategories` — a 4th shot
type later is new rows, not a migration. No `prompt_garment_phase` column —
this feature doesn't add UI to set a category-level prompt override, so
auto-resolved rows always write `NULL` for
`catalogue_template_pose_workflows.prompt_garment_phase`, which already means
"inherit the assigned workflow's own default prompt" everywhere else in this
UI (see `openPromptEditor` in `GarmentTypesTab.tsx`). Add the column when a
real need for per-category prompt defaults shows up.

**`catalogue_template_pose_workflows.source`** (new, `text NOT NULL DEFAULT
'manual'`): `'auto' | 'manual'`. Existing rows backfill to `'manual'` for
free via the `NOT NULL DEFAULT` clause on `ALTER TABLE ADD COLUMN` — every
row an admin already configured today is permanently protected from being
touched by auto-resolve, with no extra migration step. Rows the auto-resolver
writes are tagged `'auto'`. Rows an admin sets explicitly via the per-pose
dropdown are tagged `'manual'`.

## Resolution semantics: live rule, not one-time stamp

A category default is not a stamp applied once — it stays live. Re-running
resolve (which happens automatically on every trigger below) will:
- **Insert** a row for any `(mapping, pose)` combination that has none yet.
- **Update** a row that is currently `source = 'auto'` to the (possibly new)
  default.
- **Never touch** a row that is `source = 'manual'`.

This is enforced by a single atomic SQL statement per trigger — an
`INSERT ... SELECT ... ON CONFLICT (mapping_id, pose_asset_id) DO UPDATE ...
WHERE catalogue_template_pose_workflows.source = 'auto'`. The `WHERE` on the
conflict branch is what makes "never clobber a manual pick" a database-level
guarantee rather than an application-level race-prone read-then-write. This
is why the design is "live": fixing a wrong category default next month
immediately corrects every pose still on `'auto'`, instead of leaving them
silently stuck on the old value forever.

The resolve statement additionally: only considers poses with
`is_active = true AND deleted_at IS NULL`, and only considers templates with
`deleted_at IS NULL` — a soft-deleted template or a deactivated pose should
never get rows written or refreshed. The conflict branch's `WHERE` also
requires `workflow_template_id IS DISTINCT FROM excluded.workflow_template_id`
alongside `source = 'auto'`, so a row already at the correct value is left
completely untouched (no wasted `UPDATE`, no bumped `updated_at`) — at
thousands-of-rows scale, most re-runs of a trigger touch nothing.

An admin can hand a pose back to live-default behavior via "Reset to category
default" (clears the row; the same trigger that runs on every clear
re-resolves it against the current default, so it immediately gets the live
default's current value if one exists for its shot type).

**Clearing a garment type's category default** (setting a slot back to
"none") does not retroactively erase already-resolved `'auto'` rows — they
stay exactly as they are. Removing a default should not silently break
templates that are already generating correctly; it only stops applying to
new/future poses and mappings going forward.

## Atomicity: mutation and resolve are one transaction

Every trigger pairs a mutation (upsert a default, insert a mapping, delete an
override) with a resolve call. Both run inside the **same Postgres
transaction** — never mutation-then-separately-call-resolve as two round
trips. This matters most on the "new mapping" trigger: the mapping insert
uses `ON CONFLICT DO NOTHING`, so if resolve threw *after* a non-transactional
insert had already committed, the mapping would exist but never get resolved
— and retrying `PATCH .../templates/:templateId { mapped: true }` would hit
the "already exists" branch, which does not call resolve, permanently
stranding that mapping unresolved with no automatic recovery. Wrapping insert
and resolve in one transaction fixes this as a direct consequence of
atomicity: if resolve fails, the insert rolls back too, so a retry re-enters
the same insert-and-resolve path rather than silently skipping it. The three
resolve functions in `shot-type-resolve.ts` accept anything with an
`.execute()` method (a plain `DB` or a transaction handle `tx`), so callers
can pass `tx` when running inside `db.transaction(...)`.

## Keeping the admin UI in sync with server-side resolution

Because clearing a per-pose override can immediately cause the resolver to
write a *new* `'auto'` row (if the garment type has a live default for that
pose's shot type), and because a manual pick flips `source` to `'manual'`
server-side, every mutating response (`PATCH .../poses/:poseAssetId`,
`PATCH .../shot-type-workflows/:shotType`) returns the row's actual resulting
state — `workflowTemplateId` and `source` as they stand after any resolve
that just ran — not just an echo of what the client asked for. The admin UI
must use that returned state to update its local view (not a blind optimistic
guess), so "Clear override" that instantly falls back to a live default shows
the resolved workflow immediately, and a manual pick's "auto" badge clears
immediately instead of waiting for a reload.

## Auto-resolve triggers

All four triggers below call into one of three functions in a new module,
`apps/api/src/modules/admin/shot-type-resolve.ts`. Each function is a single
SQL statement — no per-row loop, no N+1 — so resolving thousands of rows at
once is one round trip.

1. **A garment type's category default is set or changed**
   (`PATCH /admin/assets/garment-types/:id/shot-type-workflows/:shotType`) →
   `resolveForGarmentTypeShotType(db, garmentTypeId, shotType)`. Scoped to one
   shot type, across every template currently mapped to that garment type.
   This is also how the ~4000-row existing backlog gets adopted: the first
   time an admin sets a default for a garment type that already has mapped
   templates (with tagged poses), this same call resolves all of them.

2. **A template is newly mapped to a garment type**
   (`PATCH /admin/assets/garment-types/:id/templates/:templateId` with
   `mapped: true`, on the branch that inserts a new mapping row) →
   `resolveForMapping(db, mappingId)`. Scoped to the one new mapping, joined
   against whatever category defaults that garment type currently has.

3. **A template's looks are replaced**
   (`PUT /admin/assets/catalogue-templates/:id/looks`) →
   `resolveForTemplate(tx, templateId)`, inside the same transaction that
   replaces the looks. A template can be mapped to more than one garment
   type; this resolves the template's current look set against every garment
   type it's mapped to in one statement (scoped by `template_id`, not
   `mapping_id`). The same transaction also deletes any
   `catalogue_template_pose_workflows` rows whose `pose_asset_id` is no
   longer among the template's current looks — otherwise every "correct a
   mis-tagged pose by re-uploading it" cycle (the pose upload builder always
   creates a *new* pose asset per upload) leaves the old pose's now-orphaned
   workflow row behind forever.

4. **An admin clears a manual per-pose override**
   (`PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId`
   with `workflowTemplateId: null`) → delete the row, then
   `resolveForMapping(db, mappingId)`, so the pose falls back to the live
   category default if one exists for its shot type (this is "Reset to
   category default" and "Clear override" unified into one action — no
   separate endpoint needed).

Setting `workflowTemplateId` to a real value through that same per-pose PATCH
route is the explicit-override path: it now also sets `source: 'manual'` on
the written row, which is what makes it immune to future auto-resolve.

## API surface

New:
- `GET /admin/assets/garment-types/:id/shot-type-workflows` — 404 if the
  garment type doesn't exist; otherwise always returns exactly 3 entries
  (`full`, `half`, `closeup`), `workflowTemplateId: null` for any unset slot.
- `PATCH /admin/assets/garment-types/:id/shot-type-workflows/:shotType` —
  404 if the garment type doesn't exist. Body
  `{ workflowTemplateId: string | null }`. Upserts (or deletes, if
  `workflowTemplateId` is null) the default and runs trigger (1) in one
  transaction, returning `{ ok: true, resolvedCount: number }`.

Modified:
- `PATCH /admin/assets/garment-types/:id/templates/:templateId` — runs
  trigger (2) in the same transaction as the mapping insert.
- `PUT /admin/assets/catalogue-templates/:id/looks` — runs trigger (3), plus
  the stale-workflow-row cleanup described above, inside the existing
  looks-replace transaction.
- `PATCH /admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId`
  — sets `source: 'manual'` on explicit set; runs trigger (4), in the same
  transaction as the delete, on clear. Response now always includes the
  row's actual resulting `workflowTemplateId` and `source` (`null` for both
  if the pose ends up unresolved) — see "Keeping the admin UI in sync" above.
- `GET /admin/assets/catalogue-template-mappings/:mappingId/poses` — response
  items gain `source: 'auto' | 'manual' | null` (`null` = unresolved), so the
  admin UI can show provenance.
- `GET /admin/assets/pose-assets` — response items gain `shotType`, so the
  template-looks builder can show a pose's already-persisted tag when
  reopening an existing template (without this, every pose looks untagged on
  reopen regardless of its real database value).
- `POST /admin/assets/pose-assets` — body gains optional `shotType`, stored
  on the created pose.

## Admin UI

- New panel in `GarmentTypesTab.tsx`'s configs subview, "0. Shot-type default
  workflows" (rendered above the existing "1. Catalogue templates" panel,
  since it's the thing an admin sets up first): three rows (Full pose / Half
  pose / Closeup), each a workflow `<select>` wired to the new PATCH route,
  showing a toast with the resolved count on save.
- `MappedTemplateWorkflowModal`: poses whose current workflow came from
  `source: 'auto'` get a subtle "auto" badge instead of nothing; poses that
  are `'manual'` are unchanged from today.
- `EditCatalogueTemplateModal.tsx`: each look row gets a Full/Half/Closeup
  selector next to the pose upload tile, sent as `shotType` in the pose-asset
  creation call whenever that row's image is (re-)uploaded. The selector is
  **always editable**, regardless of whether the row already has a pose —
  correcting a mis-tagged pose means picking the right value here *then*
  re-uploading that row's image (this modal already treats every pose upload
  as fresh, so re-uploading always creates a new pose asset with the
  currently-selected tag; no separate edit-shot-type endpoint needed, but the
  control must not be disabled or there's no way to pick a different value
  before re-uploading). A brand-new row defaults to "Full". A row loaded from
  an existing template shows whatever the pose's `shotType` actually is in
  the database, including a distinct "not tagged" state for legacy poses
  that predate this feature (`shot_type IS NULL`) — it must never silently
  display an untagged pose as "Full", since that would look already-correct
  when it's actually unresolved.

## Testing strategy

One new integration test file,
`apps/api/test/integration/shot-type-workflow-resolve.test.ts`, following
this repo's existing `startContainers()` / `buildTestApp()` /
`adminAuthHeader()` harness pattern (see
`apps/api/test/integration/catalogue-template-subcategories-admin.test.ts`
for the exact seeding conventions this reuses). Covers: setting a category
default resolves existing mapped-template poses; a manual override survives
a category-default change; a newly mapped template auto-resolves from
existing defaults; replacing a template's looks auto-resolves the new look
across every garment type it's mapped to; clearing a manual override falls
back to the live category default; pose-asset creation persists `shotType`.
