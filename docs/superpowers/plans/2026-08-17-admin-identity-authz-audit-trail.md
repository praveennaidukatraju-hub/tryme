# Admin Identity, Authorization & Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple people currently share one `SUPER_ADMIN` login, so no admin mutation
(workflow edits, worker assignment, asset changes, support replies) can be attributed to
a specific person. Fix: individual identity + a real audit trail + explicit
capability-based permissions — not a resource-ownership/scope engine, which the domain
doesn't currently model and shouldn't be invented speculatively (see Phase 5).

**Spec:** No separate spec file — the design was agreed in conversation, including a
review pass that found and corrected a load-bearing flaw in the original Phase 2 design
(see "Design corrections from review" below). This plan is the full agreed design.

**Tech stack:** Fastify 5, Drizzle ORM (Postgres 16), Vite/React admin SPA
(`apps/admin-web`), Vitest (container-backed integration tests, no testcontainers),
`@tryme/observability` (Prometheus registry).

---

## Context

- `admin_users` (`packages/db/src/schema/admin.ts`) has one row per `user_id`, a
  free-text `role` column (`SUPER_ADMIN | MODERATOR | SUPPORT | ADMIN`, default
  `SUPPORT`, **no DB-level constraint**), and `status` (`pending | active | rejected`).
- Authorization is `requireAdmin(roles)` (`apps/api/src/modules/admin/guard.ts`) — a
  single Fastify preHandler called with a hand-picked role allow-list. Verified: **64
  call sites across 27 files** under `apps/api/src/modules/admin/`.
- `apps/admin-web` only hides sidebar nav by role (`Sidebar.tsx`); `App.tsx` renders
  every route unconditionally — the backend 403 is the only real enforcement today.
  `RecycleBinPage.tsx`'s `canHardDelete = role === 'SUPER_ADMIN' || role === 'MODERATOR'`
  is the one place with any client-side gating, and it's a one-off pattern, not
  generalized.
- `/results` (`apps/api/src/modules/results/routes.ts`) is a separate server-rendered
  console. Verified at line 54: it gates only on `admin?.status !== 'active'` — **role is
  embedded into the minted token at line 56 but never checked before minting it.** Today,
  any active admin of *any* role gets a `/results` session. It mints its own
  `kind: 'results'` JWT (8h expiry, `results_access_token` cookie), entirely bypassing
  `requireAdmin`.
- No audit log exists anywhere. `credit_ledger.adminId` (`packages/db/src/schema/credits.ts`)
  is the closest precedent — a bare `uuid` with **no FK constraint**, unlike the new
  `audit_logs.actorUserId` this plan adds (which does have a real FK to `users.id`).
- Admin invite/approval flow already exists: `apps/api/src/modules/admin/users.routes.ts`,
  `GET /admin/admin-requests` (status=pending), `POST /admin/admin-requests/:userId/approve`,
  `.../reject`.

---

## Global Constraints

- Do all of this locally / on a dev branch. Never run `db:generate`, `drizzle-kit`, or
  ad-hoc `psql` against production or `tryon_prod` — ship schema changes through
  push → CI/CD → `db:migrate:prod`.
- **`pnpm db:generate` is currently broken in this repo** — confirmed repeatedly in
  `docs/progress.md` (snapshot-chain forks, missing `meta/` snapshots). Migration `0156`
  (`drop_kiosk_devices`) and, earlier, `0083` (`kiosk_auth_foundation`) both had to be
  hand-written and hand-appended to `meta/_journal.json` for exactly this reason. **Every
  migration step in this plan (Phase 2, Phase 3) should assume the same** — don't spend
  time attempting `db:generate` first; hand-write the SQL and journal entry following
  those two migrations as the pattern.
- `packages/db/src/index.ts` exports `* as schema` — never add a duplicate `schema`
  re-export; import `@tryme/db` as `workspace:*`.
- Match existing comment density/idiom in every file touched — comment the *why*.
- Integration tests: `apps/api/test/integration/**`, run via
  `pnpm --filter @tryme/api test:integration` against the docker-compose
  Postgres/Redis/MinIO (`pnpm docker:up` first, no testcontainers). Each test file gets
  its own DB via `test/helpers/containers.ts`.
- Use RFC 5737 test IPs for anything touching the rate limiter, per existing convention.

---

## Design corrections from review

The original Phase 2 design specified DB-level append-only enforcement via
`REVOKE UPDATE, DELETE ON audit_logs FROM <app_db_role>`. **This does not work in this
repo and must not ship as written.**

Verified: `POSTGRES_USER=tryon` is the *only* Postgres role defined anywhere —
`infra/docker-compose.yml`, `infra/docker-compose.prod.yml`,
`infra/docker-compose.staging.yml`, `.env.production.example` all use it, in every
environment including production. The official Postgres Docker image makes its
`POSTGRES_USER` the cluster's bootstrap **superuser** by construction. Superusers bypass
all privilege/ACL checks unconditionally — `REVOKE` on a superuser-owned connection is
inert by definition, not a misconfiguration to tune. This isn't a "find the exact role
name" gap; the role itself is the wrong kind of role for this mechanism, regardless of
name. It would have shipped as decorative in every environment, including prod.

**Revised Phase 2 requirement** (see Task 2.2 below):

1. Ship a `BEFORE UPDATE OR DELETE` trigger on `audit_logs` that raises an exception,
   as the *interim* append-only mechanism. Triggers fire regardless of role privilege
   (not part of the ACL system), so this genuinely stops an accidental `UPDATE`/`DELETE`
   from the app or a careless direct `psql` session. **It must be labeled — in code
   comments and in this doc — as privilege-bypassable**: a superuser can
   `ALTER TABLE ... DISABLE TRIGGER` first. Given this whole plan exists because of a
   shared, over-privileged credential problem, "someone with prod DB credentials acts
   deliberately" is exactly the failure mode in scope, not a remote edge case — don't
   let the trigger's real value (stops accidents) get oversold as equivalent to genuine
   ACL enforcement.
2. Open **a separate, tracked infra task**: a genuinely non-superuser Postgres role for
   the app's runtime connection, with `REVOKE UPDATE, DELETE` actually enforced against
   it. This is not a one-line change — if `tryon` is also what runs `db:migrate:prod`
   (schema changes need elevated rights, especially given the fragile `db:generate`
   state above), downgrading the runtime connection to non-superuser breaks migrations
   unless the deploy step gets **its own separate, more-privileged credential** distinct
   from what the running containers use day-to-day. That means: two Postgres roles, new
   secret(s), and the corresponding `docker-compose`/CI wiring — real infra work, not a
   Phase 2 line item. **Do not block Phase 2 on this task.**

---

## Phase 0 — Kill the shared login (no schema change, do this first)

Purely operational. No code changes required — it unblocks attribution immediately,
before any of the engineering below lands.

- [ ] Confirm every person currently using the shared `SUPER_ADMIN` credential has their
      own `admin_users` row (via the existing invite/approval flow —
      `apps/api/src/modules/admin/users.routes.ts`, `status: pending|active|rejected`).
- [ ] Assign each person the least-privileged existing role (`ADMIN`/`MODERATOR`/`SUPPORT`)
      that covers their current work — not `SUPER_ADMIN` by default.
- [ ] Rotate the shared `SUPER_ADMIN` account's password once individuals are confirmed
      working under their own logins. Keep it only as a break-glass account.

---

## Phase 1 — Unify `/results` authorization

**Files:**
- Modify: `apps/api/src/modules/admin/guard.ts` — extract `resolveAdminAccess(userId)`
- Modify: `apps/api/src/modules/results/routes.ts:54-58`

- [x] **Extract the shared check.** In `guard.ts`, factor the
      `admin_users` lookup + `status !== 'active'` + role check currently inline in
      `requireAdmin` into `resolveAdminAccess(userId): Promise<{ role: string; status: string } | null>`.
      `requireAdmin(roles)` becomes a thin wrapper: call `resolveAdminAccess`, 403 if
      null/inactive/role not in `roles`.
- [x] **Wire `/results` through it.** Replace the inline
      `admin?.status !== 'active'` check at `results/routes.ts:54` with a call to
      `resolveAdminAccess`. Keep the token-minting mechanism (`kind: 'results'` JWT,
      8h expiry, `results_access_token` cookie) — it's legitimately needed for a
      server-rendered page, don't rip it out.
- [x] **Decide explicitly, don't leave ambiguous:** today `/results` grants access to
      *any* active admin regardless of role. Pick one and document it in the code
      comment at the call site:
      - (a) preserve that behavior — `resolveAdminAccess` returning non-null + active is
        sufficient, role is informational only for `/results`, or
      - (b) require a specific capability (e.g. `results.read`, once Phase 3 exists) or
        role allow-list, same as any other admin route.
- [x] **Acceptance test:** an integration test that flips `admin_users.status` mid-test
      (active → rejected) and asserts the `/results/login` endpoint now rejects with 403,
      proving both paths share the same live check rather than each caching/re-deriving
      independently.

---

## Phase 2 — `audit_logs` infrastructure

### Task 2.1: Schema

**Files:**
- Create: `packages/db/src/schema/audit.ts`
- Create: migration (hand-written — see Global Constraints)

```ts
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  actorRole: text('actor_role').notNull(), // snapshot at time of action, role can change later
  action: text('action').notNull(),        // e.g. 'workflow.update', 'worker.assign'
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [x] Add indexes: `(resourceType, resourceId)` and `(actorUserId, createdAt)` for the
      Activity page queries (Task 2.4).
- [x] Hand-write the migration following `0156_drop_kiosk_devices.sql`'s pattern (name,
      journal append). **Do not attempt `pnpm db:generate` first** — see Global
      Constraints.

### Task 2.2: Append-only enforcement (revised — see "Design corrections" above)

**Files:**
- Same migration as Task 2.1, or a follow-up one in the same PR.

- [x] Add a `BEFORE UPDATE OR DELETE` trigger on `audit_logs` that raises an exception
      unconditionally. Comment on the trigger definition itself must state: *"Stops
      accidental/app-level UPDATE|DELETE. Does NOT stop a superuser who explicitly
      disables this trigger first — see docs/superpowers/plans/2026-08-17-admin-identity-authz-audit-trail.md
      for the tracked follow-up (non-superuser DB role)."*
- [x] **Do not** attempt the `REVOKE`-based approach from the original design — it is a
      no-op against `tryon` (superuser) in every environment. If a genuinely restricted
      role exists by the time this task runs (see the separate infra task below), revisit
      and add the `REVOKE` as defense-in-depth on top of the trigger, not instead of it.
- [x] Test: connect as the app's DB role and assert `UPDATE`/`DELETE` on `audit_logs`
      raises — this proves the trigger fires, **not** privilege enforcement (the test
      name/comment should say so explicitly, so a future reader doesn't mistake trigger
      coverage for ACL coverage).

**Separate, not-Phase-2 task — do not implement inline here:**
- [ ] Non-superuser Postgres role for the app's runtime connection, with a second,
      more-privileged credential for `db:migrate:prod` (since `tryon` currently does
      both and can't be downgraded without splitting them). Needs new
      `docker-compose`/CI secret wiring in all three environments (dev, staging, prod).
      Once this lands, add `REVOKE UPDATE, DELETE ON audit_logs FROM <new_runtime_role>`
      as genuine ACL enforcement alongside the existing trigger.

### Task 2.3: `recordAudit` service + wiring into highest-value mutations

**Files:**
- Create: `apps/api/src/modules/admin/audit.ts`

```ts
export async function recordAudit(
  tx: DbTransaction,
  params: {
    actor: { userId: string; role: string };
    action: string;
    resourceType: string;
    resourceId?: string;
    before?: unknown;
    after?: unknown;
    request: FastifyRequest; // for ip/userAgent/requestId
  }
): Promise<void>
```

- [x] Called inside the same `tx` the mutation uses, **after** the mutation, **before**
      commit — never fire-and-forget post-commit. If the insert fails, let it throw so
      the transaction rolls back (fail-closed — see the tradeoff note below).
- [x] `ipAddress` from `request.ip` (already resolved via `TRUST_PROXY_HOPS` +
      `CF-Connecting-IP`, per the existing rate-limiter `keyGenerator` in
      `apps/api/src/server.ts` — reuse it, don't reimplement per-handler).
      `userAgent` from headers. `requestId` from Fastify's built-in `request.id`.
- [x] Actor is passed explicitly by the caller (`req.userId`/`req.adminRole`, set by
      `requireAdmin`), never re-derived from ambient context inside the service — keeps
      it usable later from non-HTTP callers without faking a request.
- [x] **Alerting on audit-insert failure — concrete mechanism, not just "must be
      alerted":** increment a Prometheus counter `audit_log_write_failures_total` (via
      `@tryme/observability`'s shared registry) in the error path, *before*
      re-throwing. This is an in-process metric write, unaffected by the DB transaction
      rolling back. Add a Grafana Alloy/Alertmanager rule firing on any nonzero rate —
      an audit_logs outage should page someone within minutes, not surface only as
      generic 500s on the admin panel.
- [x] **State the tradeoff explicitly (sign-off line item, not implicit):** fail-closed
      audit means `audit_logs` health becomes a hard dependency for *all* admin writes —
      an audit_logs outage is now a full admin-panel outage. This mirrors the existing
      `credit_ledger` transactional pattern (`packages/db/src/schema/credits.ts`) and is
      the right call for an audit trail (never silently lose attribution), but whoever
      signs off on this plan should see it named here, not discover it during an
      incident.
- [x] `SELECT ... FOR UPDATE` on the row being changed, inside the same transaction,
      before computing `before`/`after` — avoids races between concurrent edits.

**Wire into these, in priority order (don't boil the ocean — routes not listed get no
audit coverage yet, a known accepted gap, expand opportunistically later):**
1. Worker create/update/assign/delete (`apps/api/src/modules/admin/workers.routes.ts`
   or equivalent)
2. Workflow template update/publish
3. Asset upload/update/delete/approve
4. `users.routes.ts` — user disable/delete, admin-user role changes
5. Support ticket assign/reply/close
6. Credit/payment-related admin actions — `credit_ledger.adminId` already covers part
   of this for credits specifically; **recommend mirroring into `audit_logs` too**, since
   a unified Activity page is the whole point of this plan.

### Task 2.4: Admin Activity page

- [x] `GET /admin/audit-logs` — filters (actor, action, resourceType, resourceId, date
      range), paginated, `requireAdmin(['SUPER_ADMIN'])` only initially.
- [x] `apps/admin-web` page: table (time / admin / action / resource / before→after
      summary).

---

## Phase 3 — Permission model + compatibility shim

### Task 3.1: Schema

**Files:**
- Modify: `packages/db/src/schema/admin.ts` — `admin_users.role`
- Create: `packages/db/src/schema/permissions.ts`
- Create: migration (hand-written)

```ts
// admin.ts — replace the unconstrained text column with a CHECK constraint via migration:
// ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
//   CHECK (role IN ('SUPER_ADMIN','ADMIN','MODERATOR','SUPPORT'));
```

CHECK over a roles table or `pgEnum`: exactly 4 fixed roles, not dynamically
admin-managed anywhere in current requirements. A roles table with surrogate keys is
machinery this domain doesn't need yet (same reasoning that rules out the scope engine
in Phase 5). A CHECK constraint is simpler to alter later (`DROP`/`ADD CONSTRAINT` in one
migration) than a Postgres enum's `ALTER TYPE ... ADD VALUE` lifecycle.

```ts
// permissions.ts
export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(), // 'jobs.retry', 'workflows.publish', ...
  description: text('description'),
});

export const rolePermissions = pgTable('role_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: text('role').notNull(), // matches admin_users.role's CHECK-constrained values
  permissionId: uuid('permission_id').notNull().references(() => permissions.id),
}, (t) => ({
  uniq: unique().on(t.role, t.permissionId),
}));

// Deferred, add only when a real exception is needed:
// user_permissions (userId, permissionId, granted: boolean) as an override table.
```

- [x] Seed initial permission set (business capabilities, never routes):
      `jobs.read/update/retry/cancel/reassign`,
      `workers.read/create/update/delete/assign`,
      `workflows.read/create/update/publish/delete`,
      `assets.read/upload/update/delete/approve`,
      `support.read/reply/assign/close`,
      `users.read/create/update/disable`,
      `audit.read`.
- [x] Seed `role_permissions` so each role's grants exactly reproduce today's
      `requireAdmin([...])` allow-lists. **Grep every call site in
      `apps/api/src/modules/admin/*.routes.ts` first** and build the mapping from what's
      actually there — 64 sites across 27 files (verified count) — not from assumption.

### Task 3.2 — PR 1: infrastructure only, zero behavior change

- [x] Add `requirePermission(key: string)` in `guard.ts`: resolves the caller's
      `admin_users.role` → `role_permissions` → checks `key` is present, same 403
      semantics as today.
- [x] Replace every `requireAdmin([...])` call site with `requirePermission(...)` (or a
      small `requireAnyPermission([...])` where a route currently allows a role-set with
      no single unifying capability — flag those for a follow-up capability split
      rather than forcing a bad abstraction).
- [x] **Parity test suite** — snapshot pre-migration behavior first, then hit every
      migrated route with each of the 4 roles and assert identical 200/403 results after
      the migration. This is the safety net for the big call-site rewrite; ship PR 1
      alone and verify this is green before touching policy.

### Task 3.3 — PR 2: actual policy changes (separate PR, after 3.2 is stable)

- [ ] Only after PR 1 is verified stable, change individual `role_permissions` rows to
      loosen/restrict specific capabilities per role, per whatever the team decides.
      Keep this its own PR so a regression is attributable to a policy decision, not a
      refactor bug.

---

## Phase 4 — Frontend gating

**Files:** `apps/admin-web/src/AuthContext.tsx`, `App.tsx`, `Sidebar.tsx`,
`RecycleBinPage.tsx` (generalize its existing pattern, don't leave it a one-off).

- [x] Extend `GET /admin/me` to also return the resolved permission-key list for the
      current user; expose `hasPermission(key)` from `AuthContext`.
- [x] Add real route guards in `App.tsx` — wrap protected routes in a component that
      checks the relevant permission before rendering, redirecting/showing a 403 page
      otherwise. Today every route mounts unconditionally (verified) and relies solely
      on the backend 403 — close that gap.
- [x] Update `Sidebar.tsx` to filter on permission keys instead of hardcoded role arrays.
- [x] Gate action buttons (Retry, Cancel, Reassign, Delete, etc.) per-permission, same
      pattern as `RecycleBinPage.tsx`'s `canHardDelete` — generalize it into a shared
      helper rather than leaving it a one-off.
- [x] This phase is UX only — `requirePermission` from Phase 3 remains the actual
      security boundary.

---

## Phase 5 — explicitly deferred

**Do not build:** `feature_ownership`, resource-level `OWN`/`ASSIGNED`/`TEAM` scopes,
per-user permission overrides beyond the `user_permissions` schema placeholder in Task
3.1. Revisit only when a concrete need appears — the most likely first candidate is
support tickets (`support.reply` scoped to `assigned_to_user_id`, since that column is a
natural fit once tickets have an assignee), not jobs/workers/workflows, which have no
natural ownership partition in the current schema.

---

## Testing summary

- Integration tests in `apps/api/test/integration/`, run via
  `pnpm --filter @tryme/api test:integration` against the docker-compose Postgres
  (no testcontainers). Each test file gets its own DB per `containers.ts`.
- Phase 2: test that a mutation + audit insert commit together, and that a forced
  audit-insert failure (e.g. inject a bad `resourceType` value) rolls back the mutation
  *and* increments `audit_log_write_failures_total`.
- Phase 2 append-only: test the trigger fires (see Task 2.2) — explicitly documented as
  proving trigger behavior, not privilege enforcement, until the separate non-superuser
  role task lands.
- Phase 3 PR 1: the parity suite (Task 3.2) diffing every migrated route × all 4 roles
  against the pre-migration baseline.
- RFC 5737 test IPs for anything touching the rate limiter.

## Deployment

- Hand-write and review migrations locally (see Global Constraints — `db:generate` is
  broken), commit them, let CI/CD apply via `db:migrate:prod` — never run `drizzle-kit`
  or ad-hoc SQL against the production VPS or `tryon_prod`.
- Record any new dashboard/env discoveries made while doing this work in
  `docs/progress.md`.
- Once Phases 1–3 land, add the resulting invariants (same-transaction audit,
  trigger-based append-only + its documented limitation, shared `/results` permission
  resolution) to `CLAUDE.md`'s own "Invariants (do not break)" section, alongside the
  existing credit-transaction and admin-role invariants.
