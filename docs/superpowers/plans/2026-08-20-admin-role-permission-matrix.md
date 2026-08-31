# Admin Role-Permission Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today only a Super Admin editing raw SQL can change what `ADMIN`/`MODERATOR`/`SUPPORT`
are allowed to do — the `permissions`/`role_permissions` tables from the prior
admin-identity-authz-audit plan are fully data-driven on the backend, but nothing in
`apps/admin-web` lets a Super Admin see or edit that data. Fix: a Settings tab that reads
and writes `role_permissions` through the API, then use its output as the verified ground
truth to fix two admin-web surfaces (`Sidebar.tsx`, `RecycleBinPage.tsx`) that were
supposed to become permission-driven in the prior plan's Phase 4 but still hard-code role
identity — so an edit made in the new tab actually changes what a role can *see*, not just
what it's rejected for after clicking.

**Architecture:** No schema changes — `permissions` and `role_permissions`
(`packages/db/src/schema/permissions.ts`, migration `0160_permissions.sql`) already model
this as a many-to-many table. Add a small CRUD route pair gated by the existing
`admin_users.manage` permission, and a matrix-editor tab under the existing Settings page.
`SUPER_ADMIN` is excluded from editing by construction (not a runtime check) — see Task 1.

**Tech stack:** Fastify 5, Drizzle ORM (Postgres 16), Vite/React admin SPA
(`apps/admin-web`), Vitest (container-backed integration tests, no testcontainers).

---

## Context (verified)

- `permissions` (id, key, description) and `role_permissions` (id, role, permission_id,
  unique on `(role, permission_id)`) already exist and are seeded with 52 permission keys
  across all 4 roles — `packages/db/src/schema/permissions.ts`,
  `packages/db/src/migrations/0160_permissions.sql`.
- `apps/api/src/modules/admin/guard.ts`'s `getRolePermissions(app, role)` does a live
  `role_permissions` ⨝ `permissions` lookup — **there is no `SUPER_ADMIN` bypass on the
  backend.** `SUPER_ADMIN`'s access is 52 real rows in `role_permissions`, seeded by
  `INSERT INTO role_permissions SELECT 'SUPER_ADMIN', id FROM permissions` in the same
  migration. This matters for Task 1's safety rule below.
- **Contradicts it:** `apps/admin-web/src/context/AuthContext.tsx:38` —
  `hasPermission()` hard-codes `if (role === 'SUPER_ADMIN') return true`, bypassing
  `permissions` entirely on the frontend. This plan does not touch that line (changing it
  needs `permissions` state to always be current, and it's out of scope here), but it means
  the SUPER_ADMIN row must **never be user-editable** through the new UI/API — see Task 1.
  If someone strips `SUPER_ADMIN`'s backend rows some other way, the frontend would still
  render everything for them while the backend 403s every call — an actual regression this
  plan must not introduce.
- Two admin routes still gate on hardcoded `requireAdmin([...])` role arrays instead of
  `requirePermission(key)`, left over from the original plan's still-open Task 3.3:
  `apps/api/src/modules/admin/payments.routes.ts:19` (all payment routes) and
  `apps/api/src/modules/admin/shopify-stores.routes.ts:17` (the write route only — its
  read route already uses `requirePermission('shopify_stores.read')`). **No permission key
  exists for payments at all.** Task 3 below explicitly does not touch the `payments` nav
  item for this reason — migrating `payments.routes.ts` to `requirePermission` is
  prerequisite follow-up work, not part of this plan.
- `apps/admin-web/src/components/Sidebar.tsx` gates all 21 nav items on a hard-coded
  `roles: string[]` array per item (`interface NavItem`, lines 17-24), filtered at
  line 209/211 via `item.roles.includes(role)` — **despite the original plan's Phase 4
  checklist marking "Update Sidebar.tsx to filter on permission keys" done, it was not.**
  Cross-referencing all 21 arrays against the real `role_permissions` seed data (Task 3's
  table) found **3 confirmed drifts**: `shopify-funnels`, `users`, and `credit-analysis`
  nav items hide themselves from a role that already has API access to that data today.
- `apps/admin-web/src/pages/RecycleBinPage.tsx:50-51` —
  `canHardDelete = role === 'SUPER_ADMIN' || role === 'MODERATOR'` — the one place the
  original plan's own Context section flagged as "a one-off pattern, not generalized," and
  Phase 4 also claimed to have generalized it. It was not.
- `apps/admin-web/src/App.tsx` has **no route-level permission guards at all** — every
  route mounts unconditionally, same as the original plan's Context section described
  before Phase 4. This is a real, separate gap but a much larger one (needs a
  route→permission map for every page). **Explicitly out of scope for this plan** — noted
  here so it isn't mistaken for closed; the backend 403 remains the actual security
  boundary for it, same as today.
- `admin_users.manage` (`apps/api/src/modules/admin/users.routes.ts:474`) is the permission
  already gating admin-identity management (approve/reject/grant/revoke admin access) — the
  new role-permission-matrix routes reuse it rather than minting a new permission key, since
  "who can reshape what a role can do" is the same authority as "who can grant admin access"
  in this system's current model.
- Settings page (`apps/admin-web/src/pages/SettingsPage.tsx`) is a tabbed page —
  `SETTING_SECTIONS` array + `settings/*Tab.tsx` components
  (`JobCostsTab.tsx`, `PurchasablePlansTab.tsx`, `ShopifyCreditsTab.tsx` are the existing
  pattern to follow). It's already nav-gated to `SUPER_ADMIN` only via
  `Sidebar.tsx:214` (`showSettings`), which Task 3 changes to `hasPermission('admin_users.manage')`.

---

## Global Constraints

(Carried over from the original admin-identity-authz-audit plan — still true.)

- Never run `db:generate`/`drizzle-kit`/ad-hoc `psql` against production. This plan needs
  **no migration** — it only reads/writes existing tables.
- Match existing comment density/idiom in every file touched — comment the *why*.
- Integration tests: `apps/api/test/integration/**`, run via
  `pnpm --filter @tryme/api test:integration` against the docker-compose
  Postgres/Redis/MinIO (`pnpm docker:up` first, no testcontainers).
- Every admin mutation must call `recordAudit(tx, ...)` inside the same transaction as the
  write, per `CLAUDE.md`'s audit invariant.

---

## Task 1: `role_permissions` API

**Files:**
- Create: `apps/api/src/modules/admin/role-permissions.routes.ts`
- Modify: `apps/api/src/server.ts` — register the module
- Test: `apps/api/test/integration/role-permissions.test.ts`

- [x] **Step 1: Write the route file**

```ts
// apps/api/src/modules/admin/role-permissions.routes.ts
import { schema } from '@tryme/db';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';

// SUPER_ADMIN is deliberately excluded from every route here. Its access is 52 real
// role_permissions rows (see migration 0160_permissions.sql), not a code bypass —
// guard.ts's getRolePermissions() looks SUPER_ADMIN up like any other role — so
// letting this endpoint edit it risks a Super Admin locking every admin (including
// themselves) out of the whole admin panel with one accidental unchecked box. The
// zod enum below is the actual enforcement; there is no separate runtime check to
// forget.
const EDITABLE_ROLES = ['ADMIN', 'MODERATOR', 'SUPPORT'] as const;
const ALL_ROLES = ['SUPER_ADMIN', ...EDITABLE_ROLES] as const;

const PatchBody = z.object({
  role: z.enum(EDITABLE_ROLES),
  permissionKey: z.string().min(1),
  granted: z.boolean(),
});

export async function adminRolePermissionsRoutes(app: FastifyInstance) {
  const GUARD = requirePermission('admin_users.manage');

  app.get('/admin/role-permissions', { preHandler: GUARD }, async () => {
    const allPermissions = await app.db
      .select({
        id: schema.permissions.id,
        key: schema.permissions.key,
        description: schema.permissions.description,
      })
      .from(schema.permissions)
      .orderBy(asc(schema.permissions.key));

    const grants = await app.db
      .select({
        role: schema.rolePermissions.role,
        permissionId: schema.rolePermissions.permissionId,
      })
      .from(schema.rolePermissions);

    const keyById = new Map(allPermissions.map((p) => [p.id, p.key]));
    const matrix: Record<string, string[]> = { SUPER_ADMIN: [], ADMIN: [], MODERATOR: [], SUPPORT: [] };
    for (const g of grants) {
      const key = keyById.get(g.permissionId);
      if (key && g.role in matrix) matrix[g.role].push(key);
    }

    return {
      roles: ALL_ROLES,
      editableRoles: EDITABLE_ROLES,
      permissions: allPermissions,
      matrix,
    };
  });

  app.patch(
    '/admin/role-permissions',
    { preHandler: GUARD, schema: { body: PatchBody } },
    async (req) => {
      const { role, permissionKey, granted } = req.body as z.infer<typeof PatchBody>;

      const [permission] = await app.db
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, permissionKey));
      if (!permission) throw new AppError('NOT_FOUND', 404, 'unknown permission key');

      await app.db.transaction(async (tx) => {
        if (granted) {
          await tx
            .insert(schema.rolePermissions)
            .values({ role, permissionId: permission.id })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(schema.rolePermissions)
            .where(
              and(
                eq(schema.rolePermissions.role, role),
                eq(schema.rolePermissions.permissionId, permission.id),
              ),
            );
        }

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: granted ? 'role_permissions.grant' : 'role_permissions.revoke',
          resourceType: 'role_permissions',
          resourceId: role,
          after: { role, permissionKey, granted },
          request: req,
        });
      });

      return { ok: true, role, permissionKey, granted };
    },
  );
}
```

- [x] **Step 2: Register it**

In `apps/api/src/server.ts`, add the import next to the other admin route imports
(around line 27):

```ts
import { adminRolePermissionsRoutes } from './modules/admin/role-permissions.routes.js';
```

And register it next to `adminUsersRoutes` (around line 375):

```ts
await app.register(adminRolePermissionsRoutes);
```

- [x] **Step 3: Write the integration test**

```ts
// apps/api/test/integration/role-permissions.test.ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin role-permissions matrix', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('GET returns all 4 roles, editableRoles excludes SUPER_ADMIN, matrix reflects seeded grants', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const res = await app.inject({ method: 'GET', url: '/admin/role-permissions', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles).toEqual(['SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'SUPPORT']);
    expect(body.editableRoles).toEqual(['ADMIN', 'MODERATOR', 'SUPPORT']);
    expect(body.matrix.SUPPORT).toContain('jobs.read');
    expect(body.matrix.SUPPORT).not.toContain('jobs.write');
  });

  it('PATCH grants a permission to a role, is idempotent, and audit-logs it', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const [before] = await app.db
      .select()
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(and(eq(schema.rolePermissions.role, 'SUPPORT'), eq(schema.permissions.key, 'jobs.write')));
    expect(before).toBeUndefined();

    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/role-permissions',
      headers,
      payload: { role: 'SUPPORT', permissionKey: 'jobs.write', granted: true },
    });
    expect(res.statusCode).toBe(200);

    const [after] = await app.db
      .select()
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(and(eq(schema.rolePermissions.role, 'SUPPORT'), eq(schema.permissions.key, 'jobs.write')));
    expect(after).toBeDefined();

    const [auditRow] = await app.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'role_permissions.grant'))
      .orderBy(schema.auditLogs.createdAt);
    expect(auditRow.resourceId).toBe('SUPPORT');

    // Re-granting is a no-op, not an error (onConflictDoNothing).
    const res2 = await app.inject({
      method: 'PATCH',
      url: '/admin/role-permissions',
      headers,
      payload: { role: 'SUPPORT', permissionKey: 'jobs.write', granted: true },
    });
    expect(res2.statusCode).toBe(200);

    // Revoke it back to the seeded state so this test doesn't leak into others.
    await app.inject({
      method: 'PATCH',
      url: '/admin/role-permissions',
      headers,
      payload: { role: 'SUPPORT', permissionKey: 'jobs.write', granted: false },
    });
  });

  it('rejects SUPER_ADMIN as an editable role', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/role-permissions',
      headers,
      payload: { role: 'SUPER_ADMIN', permissionKey: 'jobs.write', granted: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403s a non-SUPER_ADMIN caller (admin_users.manage is SUPER_ADMIN-only today)', async () => {
    const headers = await adminAuthHeader(app, 'ADMIN');
    const res = await app.inject({ method: 'GET', url: '/admin/role-permissions', headers });
    expect(res.statusCode).toBe(403);
  });
});
```

- [x] **Step 4: Run it**

Run: `pnpm docker:up` (if not already running), then from `apps/api`:
`npx vitest run --config vitest.integration.config.ts test/integration/role-permissions.test.ts`
Expected: 4 passed.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/role-permissions.routes.ts apps/api/src/server.ts apps/api/test/integration/role-permissions.test.ts
git commit -m "feat(admin): add role-permissions matrix API"
```

---

## Task 2: Roles & Permissions settings tab

**Files:**
- Create: `apps/admin-web/src/pages/settings/RolesPermissionsTab.tsx`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx` — add the tab

- [x] **Step 1: Write the tab component**

```tsx
// apps/admin-web/src/pages/settings/RolesPermissionsTab.tsx
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch } from '../../lib/data';

interface Permission {
  id: string;
  key: string;
  description: string | null;
}
interface MatrixResponse {
  roles: string[];
  editableRoles: string[];
  permissions: Permission[];
  matrix: Record<string, string[]>;
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function RolesPermissionsTab({ toast }: Props) {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null); // `${role}:${key}` in flight

  useEffect(() => {
    apiFetch<MatrixResponse>('/admin/role-permissions')
      .then(setData)
      .catch((e) =>
        toast({ kind: 'error', title: 'Failed to load roles & permissions', body: apiErrorMessage(e) }),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  async function toggle(role: string, key: string, nextGranted: boolean) {
    if (!data) return;
    const cellId = `${role}:${key}`;
    setPending(cellId);
    // Optimistic update — the matrix is small enough that a wrong flash from a
    // rejected PATCH is cheaper than a full reload per click.
    const rolled = data.matrix[role]?.includes(key) ?? false;
    setData({
      ...data,
      matrix: {
        ...data.matrix,
        [role]: nextGranted
          ? [...data.matrix[role], key]
          : data.matrix[role].filter((k) => k !== key),
      },
    });
    try {
      await apiFetch('/admin/role-permissions', {
        method: 'PATCH',
        body: JSON.stringify({ role, permissionKey: key, granted: nextGranted }),
      });
    } catch (e) {
      setData((prev) =>
        prev && {
          ...prev,
          matrix: {
            ...prev.matrix,
            [role]: rolled ? [...prev.matrix[role], key] : prev.matrix[role].filter((k) => k !== key),
          },
        },
      );
      toast({ kind: 'error', title: 'Failed to update permission', body: apiErrorMessage(e) });
    } finally {
      setPending(null);
    }
  }

  if (loading) return <p className="sub">Loading&hellip;</p>;
  if (!data) return null;

  return (
    <div style={{ overflowX: 'auto' }}>
      <p className="lede" style={{ marginBottom: 16 }}>
        Super Admin always has every permission and can't be edited here — it's the
        account that recovers access if a role gets misconfigured.
      </p>
      <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ textAlign: 'left', padding: '0.5rem' }}>Permission</th>
            {data.roles.map((role) => (
              <th key={role} style={{ padding: '0.5rem', textAlign: 'center', fontSize: '0.75rem' }}>
                {role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.permissions.map((perm) => (
            <tr key={perm.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '0.5rem' }}>
                <div style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>{perm.key}</div>
                {perm.description && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{perm.description}</div>
                )}
              </td>
              {data.roles.map((role) => {
                const editable = data.editableRoles.includes(role);
                const checked = data.matrix[role]?.includes(perm.key) ?? false;
                return (
                  <td key={role} style={{ padding: '0.5rem', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!editable || pending === `${role}:${perm.key}`}
                      onChange={(e) => toggle(role, perm.key, e.target.checked)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [x] **Step 2: Wire it into `SettingsPage.tsx`**

Add the import near the other tab imports:

```ts
import RolesPermissionsTab from './settings/RolesPermissionsTab';
```

Add `'roles-permissions'` to the `SettingsSection` union and `SETTING_SECTIONS` array:

```ts
type SettingsSection =
  | 'appearance'
  | 'notifications'
  | 'credit-plans'
  | 'signup-campaigns'
  | 'roles-permissions'
  | 'system'
  | 'session';

const SETTING_SECTIONS: { k: SettingsSection; label: string }[] = [
  { k: 'appearance', label: 'Appearance' },
  { k: 'notifications', label: 'Notifications' },
  { k: 'credit-plans', label: 'Credit Plans' },
  { k: 'signup-campaigns', label: 'Signup Campaigns' },
  { k: 'roles-permissions', label: 'Roles & Permissions' },
  { k: 'system', label: 'System' },
  { k: 'session', label: 'Session' },
];
```

Find where the active section switches to a tab component's JSX (look for
`section === 'credit-plans' && <PurchasablePlansTab ... />` or equivalent) and add:

```tsx
{section === 'roles-permissions' && <RolesPermissionsTab toast={toast} />}
```

- [x] **Step 3: Manual verification (no admin-web unit test harness exists for pages —
      match existing convention)**

Run: `pnpm --filter @tryme/admin dev`, log in as a `SUPER_ADMIN` test admin, open
Settings → Roles & Permissions, toggle `jobs.write` off for `SUPPORT` and back on. Confirm
the checkbox reflects the change immediately and `GET /admin/role-permissions` (Network
tab) shows the row round-tripping.

- [x] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/settings/RolesPermissionsTab.tsx apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add Roles & Permissions settings tab"
```

---

## Task 3: Fix `Sidebar.tsx` to gate on permissions, not hard-coded roles

Uses Task 1's `GET /admin/role-permissions` output as the verified source for this
mapping — every row below was cross-checked against `role_permissions` seed data in
`0160_permissions.sql`, not guessed.

**Files:**
- Modify: `apps/admin-web/src/components/Sidebar.tsx` (`App.tsx` needs no change —
  `role` stays a valid prop, just no longer primary)

**Mapping (nav key → permission key). Three rows are marked `[drift fix]`: the nav item
currently hides itself from a role that already has API access to that data today — this
plan corrects that rather than preserving it.**

| Nav key | Permission key | |
|---|---|---|
| dashboard | `admin.me` | |
| assets | `assets.read` | |
| workflows | `workflows.write` | |
| tryon | `tryon.write` | |
| demo-catalog | `demo_catalog.read` | |
| dev-api | `dev_api.write` | |
| saree | `saree.write` | |
| shopify-funnels | `shopify_funnels.write` | **[drift fix]** newly visible to `ADMIN` |
| users | `users.read` | **[drift fix]** newly visible to `MODERATOR` |
| jobs | `jobs.write` | |
| held-batches | `held_jobs.manage` | |
| workers | `workers.write` | |
| recycle-bin | `assets.read` | (the hard-delete *button* stays gated separately — Task 4) |
| credit-analysis | `credit_analysis.read` | **[drift fix]** newly visible to `MODERATOR` |
| payments | *(unchanged — keep hard-coded roles)* | no permission key exists yet; `payments.routes.ts` hasn't migrated off `requireAdmin` (see Context) |
| telemetry | `telemetry.read` | |
| shopify-stores | `shopify_stores.read` | |
| audit-logs | `audit.read` | |
| chat-inbox | `chatbot.read` | |
| contacts | `contact.read` | |
| chatbot-qna | `chatbot.manage` | |

- [x] **Step 1: Change `NavItem` to carry a permission key instead of a role array**

```ts
interface NavItem {
  k: string;
  label: string;
  icon: () => ReactElement;
  perm: string | null; // null = always visible to any active admin (dashboard-style items use 'admin.me' instead)
  roles?: string[]; // present only on the one item still gated by hard-coded roles — see `payments` below
  count?: number;
  alert?: boolean;
}
```

- [x] **Step 2: Replace every `roles: [...]` with `perm: '...'` per the table above**, e.g.:

```ts
{
  k: 'dashboard',
  label: 'Dashboard',
  icon: Icon.Dashboard,
  perm: 'admin.me',
},
```

...through all 20 permission-backed items. Leave `payments` as the one exception,
unchanged:

```ts
{
  k: 'payments',
  label: 'Payments',
  icon: Icon.Credit,
  // Not migrated to a permission key yet — payments.routes.ts still uses
  // requireAdmin([...]) directly (see docs/superpowers/plans/2026-08-20-admin-role-permission-matrix.md,
  // Context). Revisit once that route is migrated to requirePermission.
  roles: ['SUPER_ADMIN', 'SUPPORT', 'ADMIN'],
},
```

- [x] **Step 3: Update the filter logic to check `hasPermission` for every item except
      the one `payments` holdout, which still needs the raw `role`**

`payments` is the only item without a `perm` (see the table — no permission key exists
for it yet), so `role` stays on `SidebarProps` for that one case rather than being
removed; everything else now goes through `hasPermission`, preserving `payments`'s exact
current gating instead of silently widening or narrowing who sees it:

```ts
export function Sidebar({
  page,
  onNav,
  role,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const { token, hasPermission } = useAuth();
  const [contactBadge, setContactBadge] = useState(0);

  // ...unchanged contactBadge effect...

  const isVisible = (item: NavItem) =>
    item.perm ? hasPermission(item.perm) : (item.roles ?? []).includes(role);

  const allItems = groups.flatMap((g) => g.items);
  const visible = allItems.filter(isVisible);
  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
    .filter((g) => g.items.length > 0);

  const showSettings = hasPermission('admin_users.manage');
```

- [x] **Step 4: No change needed in `App.tsx`** — `<Sidebar role={role ?? ''} ... />`
      (line 215) keeps working as-is; `role` is still a real prop, just no longer the
      primary gating mechanism for anything except `payments`.

- [x] **Step 5: Manual verification**

Run: `pnpm --filter @tryme/admin dev`. Using the new Roles & Permissions tab from Task
2, revoke `jobs.write` from `SUPPORT`, log in as a `SUPPORT` test admin, confirm the Jobs
nav item disappears; re-grant it, confirm it reappears without a page reload (permissions
are fetched once at login via `/admin/me` — a logout/login is expected to pick up a change,
document that as the known refresh model rather than building live permission push, which
nothing in this codebase does for any other admin state today).

- [x] **Step 6: Commit**

```bash
git add apps/admin-web/src/components/Sidebar.tsx
git commit -m "fix(admin): gate sidebar nav on permissions instead of hard-coded roles"
```

---

## Task 4: Fix `RecycleBinPage.tsx`'s hard-coded `canHardDelete`

**Files:**
- Modify: `apps/admin-web/src/pages/RecycleBinPage.tsx:50-51`

- [x] **Step 1: Replace the role check with a permission check**

```ts
// Before:
const { role } = useAuth();
const canHardDelete = role === 'SUPER_ADMIN' || role === 'MODERATOR';

// After:
const { hasPermission } = useAuth();
const canHardDelete = hasPermission('assets.delete');
```

This is a **behavior change for `ADMIN`**: today `ADMIN` is excluded from
`canHardDelete` by role identity, and `ADMIN` does not hold `assets.delete` in the current
seed data (verified against `0160_permissions.sql` — `ADMIN`'s grants include
`assets.read`/`assets.write` but not `assets.delete`), so this is behavior-preserving, not
a widening. Confirmed by inspection, not assumption — no seed data change needed for this
task.

- [x] **Step 2: Manual verification**

Log in as `MODERATOR`, confirm the hard-delete button still appears in Recycle Bin (has
`assets.delete` by default). Using Task 2's tab, revoke `assets.delete` from `MODERATOR`,
reload, confirm the button disappears.

- [x] **Step 3: Commit**

```bash
git add apps/admin-web/src/pages/RecycleBinPage.tsx
git commit -m "fix(admin): gate recycle-bin hard-delete on assets.delete permission"
```

---

## Explicitly out of scope

- **Role renaming.** Discussed separately — the recommendation is a display-label-only
  change (`adminRoleLabel()` and the role `<select>` option text in `UsersPage.tsx`), not
  a rename of the underlying `admin_users.role` / `role_permissions.role` string values.
  Renaming the values themselves would need: a migration updating the `CHECK` constraint
  and every existing `admin_users` row, updates to every hard-coded role-string call site
  found across ~50 files (`grep -rln "'SUPER_ADMIN'\|'MODERATOR'\|'SUPPORT'\|'ADMIN'"`, most
  of them tests), and a plan for admins with an already-issued access token carrying the
  old role name mid-rename. None of that changes what any role can *do* — only what it's
  *called* — so it doesn't belong in the same plan as the functional matrix editor above.
  If the label-only change is wanted, it's small enough to do directly rather than plan.
- **`payments.routes.ts` → `requirePermission` migration.** Needed before `payments` can
  join Task 3's mapping table. Small, mechanical, but a distinct unit of work with its own
  parity-test concern (mirrors the original plan's Task 3.2), not folded in here.
- **`App.tsx` route-level guards.** Real gap (noted in Context), but sizing a
  route→permission map for every page in the admin SPA is materially larger than this
  plan's scope. The backend 403 remains the actual security boundary until it's done.
- **`SUPPORT` role's missing `contact.write`.** Noticed while reading the seed data —
  `SUPPORT` can read contact messages but not reply to them, which seems like an oversight
  given "Support" is the role name. This is exactly the kind of thing Task 2's matrix tab
  now makes trivial to fix live, without a migration or a deploy — a policy call for
  whoever owns the team's access, not a code task.
