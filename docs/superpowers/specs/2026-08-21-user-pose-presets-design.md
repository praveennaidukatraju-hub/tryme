# User pose presets — design

Date: 2026-08-21
Status: approved, pending implementation plan

## Problem

Studio wizard's pose step (`apps/catalogues-web/src/app/(app)/studio/page.tsx`)
already supports multi-select pose sets (`poseIds: string[]`) per job/batch.
Users who repeatedly pick the same combination of poses have no way to save
that combination and re-apply it in one click. There's also no "last used"
shortcut — every session starts from a blank pose grid.

## Scope

Poses only. A preset is a named list of `model_pose_assets.id` values — no
face, background, garment, or other studio picks are bundled in. Two kinds of
preset per user:

- **Named presets** — explicitly saved by the user, up to 10 per user.
- **Last-used** — exactly one per user, auto-updated every time they submit a
  tryon job/batch with `poseIds`. Not user-creatable or user-deletable
  directly; it just reflects the most recent submission.

Out of scope: editing/renaming an existing named preset (delete + recreate
instead — YAGNI), presets bundling face/background/garment, admin-curated
preset templates (that's the existing separate `catalogueTemplates` /
"looks" concept and is untouched by this work).

## Data model

New table `user_pose_presets` (`packages/db/src/schema/models.ts`, or a new
`presets.ts` schema file — implementer's call, follow existing file-size
conventions in `packages/db/src/schema/`):

```ts
export const userPosePresets = pgTable('user_pose_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name'), // null only for the isLastUsed row
  poseIds: uuid('pose_ids').array().notNull(), // model_pose_assets.id refs — no FK (pg arrays can't FK)
  isLastUsed: boolean('is_last_used').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Constraints (migration, partial unique indexes):

- `user_pose_presets_one_last_used_per_user` — unique on `(user_id) WHERE is_last_used`.
- `user_pose_presets_unique_name_per_user` — unique on `(user_id, lower(name)) WHERE NOT is_last_used`.

No FK from `poseIds` array elements to `model_pose_assets.id` — Postgres can't
FK-constrain array elements. Staleness (pose deleted/deactivated after being
saved into a preset) is handled at read/apply time, not by the schema.

Cap of 10 named presets per user is enforced in the API layer (`COUNT(*)
WHERE user_id = ? AND NOT is_last_used`), not the DB.

## API

New module `apps/api/src/modules/pose-presets/` (routes + service, following
the existing module shape in `apps/api/src/modules/`). All routes require the
existing user-JWT auth plugin — same auth already gating `/v1/jobs/*`, no new
auth pattern.

- `GET /v1/pose-presets` — returns `{ lastUsed: PosePreset | null, named:
  PosePreset[] }`. `named` ordered by `updatedAt desc`, max 10 (DB should
  never exceed this given the create-time cap, but don't rely on it). Each
  preset's `poseIds` is filtered server-side to poses that are still
  `isActive` in `model_pose_assets` before returning — callers never see
  stale ids.
- `POST /v1/pose-presets` — body `{ name: string, poseIds: string[] }`.
  Validation: `poseIds` non-empty array of uuids, every id resolves to an
  active `model_pose_assets` row (400 `INVALID_POSE_IDS` otherwise), `name`
  non-empty and ≤ 40 chars, case-insensitive unique per user (409
  `PRESET_NAME_TAKEN`), named-preset count < 10 (409 `PRESET_LIMIT_REACHED`).
- `DELETE /v1/pose-presets/:id` — ownership check via `userId` from the JWT
  claim (never from the URL or body). 404 if the row doesn't exist or isn't
  owned by the caller. Refuses to delete the `isLastUsed` row (400 — that row
  isn't user-managed, it's overwritten automatically).

New Zod schemas in `packages/types/src/posePresets.ts`: `posePresetSchema`,
`createPosePresetSchema`, exported alongside the other schema modules.

### Last-used auto-upsert

Hooked into job creation, not a client-initiated call — the client never
explicitly "saves" the last-used slot. Applies to every code path that
accepts `poseIds` or `looks`: `apps/api/src/modules/jobs/create.ts`,
`createBatch.ts`, and the saree variants that take pose selections.

After the job-creation Postgres transaction (credit deduct + job insert)
commits successfully, resolve the poseIds actually used — either
`inputs.poseIds` directly, or `looks[].poseId` extracted from looks-mode
requests — then run a single `ON CONFLICT (user_id) WHERE is_last_used`
upsert on `user_pose_presets` **outside** that transaction. This is
best-effort: on failure, log a warning and move on. It must never throw back
to the caller or roll back the job/credit transaction it doesn't belong to —
per the existing invariant that credit-deduct + job-insert is the one
transaction that matters here.

## UI (`apps/catalogues-web`)

New hook `usePosePresets()` (React Query) wrapping `GET /v1/pose-presets`,
used in the studio wizard's pose step (`(app)/studio/page.tsx`, near the
existing pose-picker/pill-row around the `poseIds` state and the "{N}
selected" count).

- A chip row above the pose grid: "Last Used" chip (only if `lastUsed` is
  non-null) + one chip per named preset (name text, no icon). Click → replace
  selection: `setPoseIds(preset.poseIds)` (not merge — matches existing
  "click a preset, see it applied" mental model elsewhere in this file, e.g.
  the catalogues page date-range presets).
  - If the preset's returned `poseIds` (already filtered by the API to
    active poses) is shorter than what was originally saved, or if any
    remaining ids aren't valid for the current gender/garment context (the
    pose picker is already gender-scoped, same filter applies here), show a
    toast: "N poses no longer available, removed from preset." If filtering
    leaves zero poses, the click is a no-op with a toast: "All poses in this
    preset are no longer available."
- "Save as preset" — small button next to the "{N} selected" count, enabled
  only when `poseIds.length > 0`. Opens a lightweight inline name input
  (matches this file's existing inline-panel style, not a modal) → `POST
  /v1/pose-presets`. Surfaces `PRESET_LIMIT_REACHED` as "Max 10 presets —
  delete one first" and `PRESET_NAME_TAKEN` as "Name already used" inline,
  not as a generic toast.
- Each named chip gets a small delete (×) → `DELETE /v1/pose-presets/:id`,
  optimistic removal from the local list, rollback on failure.
- No dispatcher or `job_inputs` changes — presets are a pre-submission
  convenience only; resolved `poseIds` still flow through the existing job
  creation path unchanged.

## Error handling summary

| Case | Behavior |
|---|---|
| Preset poses became inactive since saved | Filtered out server-side on GET; client toasts if any were dropped |
| All poses in a preset now inactive | Click is a no-op + toast, preset not auto-deleted |
| Duplicate name (case-insensitive) | 409 `PRESET_NAME_TAKEN`, inline error |
| 11th named preset | 409 `PRESET_LIMIT_REACHED`, inline error |
| Delete another user's preset by guessing id | 404 (ownership check via JWT `userId`, not request params) |
| Attempt to delete the last-used row | 400 — not user-managed |
| Concurrent job submissions racing the last-used upsert | `ON CONFLICT` makes it atomic; last write wins, no user-visible error |
| Last-used upsert fails for any reason | Logged, swallowed — never blocks or fails job creation |

## Testing

- `apps/api/test/integration/pose-presets.test.ts`: create, list, delete;
  cap-at-10; duplicate-name conflict; cross-user ownership isolation on
  delete; inactive-pose filtering on GET; attempt to delete the last-used row
  (rejected).
- Integration test on job creation (extend existing `jobs` integration
  tests): submitting a tryon job with `poseIds` creates/updates the
  last-used row; a second submission overwrites rather than duplicating.
- No admin-web or dispatcher test changes needed — out of scope for both.
