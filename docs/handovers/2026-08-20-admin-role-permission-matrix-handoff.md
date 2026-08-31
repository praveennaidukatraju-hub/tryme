# Handover: Admin Role-Permission Matrix

**For:** antigravity CLI (implementer)
**From:** Claude — architect/reviewer only on this initiative. Nothing in this plan is
implemented yet; this handoff covers all 4 tasks from scratch.
**Branch:** `feat/admin-identity-authz-audit` — already checked out locally at
`D:\tryme\webtool`, tracking `origin/feat/admin-identity-authz-audit`. **Implement here,
do not create a new branch or branch off `dev`.** This matters: the permission system this
plan builds on (`permissions`/`role_permissions` tables, `requirePermission` in `guard.ts`,
`AuthContext.hasPermission`) only exists on this branch — verified `dev` does **not** have
it yet (`git merge-base --is-ancestor feat/admin-identity-authz-audit dev` → not an
ancestor). A branch cut from `dev` would be missing the tables and helpers every task here
calls. Current HEAD: `723e987f`. `dev` is already merged into this branch (see commit
`714faa0f`), so it's current.

**Before Task 1 — commit the pending uncommitted diff first, as its own commit:**
`apps/admin-web/src/pages/UsersPage.tsx` has an uncommitted change sitting in the working
tree (replaces the old separate "Grant admin"/"Revoke admin" buttons with a single role
`<select>` — Not admin/Admin/Moderator/Support — that grants, changes, or revokes on
change). It's already been through `biome check` and `tsc -b` clean. Commit it as:
```
git add apps/admin-web/src/pages/UsersPage.tsx
git commit -m "refactor(admin): unify grant/change/revoke admin role into one select"
```
Then start Task 1 on a clean tree.

**Plan file:** `docs/superpowers/plans/2026-08-20-admin-role-permission-matrix.md` — read
Tasks 1-4 directly from this file. Each has a literal TDD script (test code, implementation
code, exact commands) with `- [ ] **Step N**` checkboxes — check each one off (`- [x]`) as
it lands.

## Scope (all 4 tasks pending)

| Task | What | Depends on |
|---|---|---|
| 1 | `GET`/`PATCH /admin/role-permissions` API — reads/writes the existing `role_permissions` table, gated by `admin_users.manage`, `SUPER_ADMIN` excluded from edits by the zod enum (not a runtime check) | Nothing new — table already exists |
| 2 | "Roles & Permissions" tab in the admin Settings page — a checkbox matrix, wired to Task 1's API | Task 1 |
| 3 | Fix `Sidebar.tsx` — replace hard-coded `roles: string[]` per nav item with real permission keys (verified against seed data; 3 items are corrected drifts, not preserved as-is — see the plan's mapping table). `payments` is the one deliberate exception, left on `role` identity because no permission key exists for it yet | Independent of 1/2, but verify against Task 1's `GET` response while testing |
| 4 | Fix `RecycleBinPage.tsx`'s `canHardDelete` — same hard-coded-role problem, one line | Independent |

**Explicitly out of scope — do not implement, even if it looks like a natural extension:**
- Renaming the `ADMIN`/`MODERATOR`/`SUPPORT` role values themselves (DB, JWTs, ~50 call
  sites). The user asked about this separately; the recommendation on record is a
  **display-label-only** change (`adminRoleLabel()` in `UsersPage.tsx` + the role `<select>`
  option text) if and when they confirm exact wording — not a schema/enum rename. Not part
  of this handoff either way.
- Migrating `payments.routes.ts` off `requireAdmin([...])` to a real permission key.
- `App.tsx` route-level guards (there are none today; out of scope, sizing is materially
  larger than this plan).
- Adding `contact.write` to `SUPPORT`'s default grants — flagged as a likely-oversight in
  the plan's Context, but it's a policy call for whoever owns team access, not a code task.
  (Task 2's new tab is what makes this a one-click fix later, without a migration.)

## Gotchas worth knowing before you start

1. **`SUPER_ADMIN` is not a runtime special-case anywhere on the backend.** `guard.ts`'s
   `getRolePermissions()` does a real `role_permissions` lookup for every role including
   `SUPER_ADMIN` — its access is 52 real rows seeded by migration `0160_permissions.sql`,
   not a hard-coded bypass. Task 1's zod `z.enum(['ADMIN','MODERATOR','SUPPORT'])` on the
   `PATCH` body is the *only* thing stopping someone from editing `SUPER_ADMIN`'s own rows
   into a lockout — don't relax it, don't add a redundant separate check either (the plan
   deliberately keeps this to one enforcement point, not two that could drift).
2. **The frontend does *not* match that.** `AuthContext.tsx:38` — `hasPermission()`
   hard-codes `if (role === 'SUPER_ADMIN') return true`, bypassing `permissions` state
   entirely for that role. This plan does not touch that line. Don't "fix" it as a drive-by
   — it's called out in the plan's Context as a known asymmetry, intentionally left alone
   because changing it is a separate concern (keeping `permissions` state always current)
   not scoped here.
3. **Task 3's Sidebar mapping table is the source of truth, not a suggestion.** It was built
   by reading `0160_permissions.sql`'s actual `INSERT` statements per role, not guessed. If
   you find a mismatch between the table and current seed data while implementing, that
   means the seed data changed since this plan was written (2026-08-20) — re-verify against
   the live `role_permissions` table via Task 1's own `GET` endpoint (build Task 1 first)
   rather than trusting either the table or your memory of the migration file.
4. **Plan line-number references drift** (recurring issue on this repo's other handoffs
   too) — always grep/read the actual current file before editing against a snippet's line
   reference; the plan's line numbers were accurate as of `723e987f` but may have moved.
5. **Docker infra must be running** (`pnpm docker:up` — postgres/redis/minio) before any
   integration test in Task 1.
6. **No admin-web unit test harness exists for pages** (confirmed while researching this
   plan) — Task 2 and Task 3/4's verification steps are manual browser walks, not automated
   tests. Don't invent a testing harness to cover this; match the existing convention (every
   other admin-web page has no test file either).

## Definition of done

- Every `- [ ]` checkbox for Tasks 1-4 in
  `docs/superpowers/plans/2026-08-20-admin-role-permission-matrix.md` checked to `- [x]`.
- `pnpm --filter @tryme/api test:integration` green (new `role-permissions.test.ts`
  plus no regressions in existing suites).
- `pnpm typecheck` and `pnpm lint` clean repo-wide.
- `pnpm --filter @tryme/admin build` succeeds (or the equivalent `tsc -b` — check
  `apps/admin-web/package.json`'s `build` script if the filter name doesn't resolve).
- Manual verification steps in Tasks 2-4 actually walked in a running admin-web instance,
  not just assumed from the code — screenshots or a short description of what was clicked
  and observed in your final report.
- `docs/progress.md` updated with a new dated entry at the top (`## YYYY-MM-DD — <title>`,
  `**Done**` bullets), matching the existing entries' style (see the top entry as of this
  handoff, `2026-08-19`).
- Final commit(s) per task, matching the plan's own commit-message suggestions unless the
  live code disagrees enough to warrant a different message.
- Report back: which commits landed for each task, and call out any place where the live
  codebase disagreed with the plan's literal snippets and what you did instead — the plan
  is a strong default, not gospel; when it's wrong, say so and explain the deviation rather
  than silently following or silently ignoring it.
