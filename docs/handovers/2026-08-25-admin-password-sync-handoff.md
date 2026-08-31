# Handover: Admin panel password desync fix

**For:** antigravity CLI (implementer)
**From:** Claude — architect/reviewer only on this initiative. Nothing is implemented yet.
This handoff is the product of a two-round review (initial proposal → verified line-by-line
against live code, two corrections found → both corrections independently re-verified).
Every claim below about schema, existing routes, and line numbers has been checked against
the current code, not assumed.

**Branch:** create a new branch off `dev` — e.g. `fix/admin-password-sync`. `dev` is at
`d321e94b` (matches `origin/dev`) as of this handoff. The current working tree (branch
`fix/merchant-demo-data-default`) is clean and unrelated to this task — don't branch off it.

## Background

`admin_users.passwordHash` is a **separate credential from `users.passwordHash`**, by
design, since `feat(auth): isolate admin/web sessions with separate credentials and JWT
audience` (commit `12868615`, 2026-06-12). `/admin/auth/login` checks `admin_users.passwordHash`
only. The intent was always that this field gets seeded/resynced from `users.passwordHash`
at admin-grant time — `POST /admin/admin-users` (`apps/api/src/modules/admin/users.routes.ts:634-648`)
does exactly that via `onConflictDoUpdate`.

Two gaps in that design, both confirmed against live code:

1. **No resync path for SUPER_ADMIN.** `POST /admin/admin-users`'s body schema is
   `role: z.enum(['ADMIN','MODERATOR','SUPPORT'])` (`users.routes.ts:630`) — it cannot
   target a SUPER_ADMIN row at all. The admin UI's own role dropdown
   (`apps/admin-web/src/pages/UsersPage.tsx:734`) already excludes SUPER_ADMIN rows for
   this exact reason.
2. **Silent staleness on customer-support password reset.** `POST /admin/users/:id/reset-password`
   (`users.routes.ts:409-431`) updates only `users.passwordHash`. If that user is also an
   active admin, their admin-panel login silently goes stale — no error, no signal. This
   already happened once: `docs/progress.md:1244` (dated 2026-08-05, "admin bootstrap
   login") documents the bootstrap-admin account hitting this exact bug, two months after
   the isolation design shipped. This fix closes the *general* case, not just that instance.

Both gaps are closed with one new endpoint + two small UI changes. No schema/migration
needed — `role`/`status` on `admin_users` are plain `text` columns
(`packages/db/src/schema/admin.ts:10-11`), not a Postgres enum.

---

## 1. New endpoint: explicit admin-password resync

Add to `apps/api/src/modules/admin/users.routes.ts`, immediately after the
`DELETE /admin/admin-users/:userId` route's closing `);` (currently ends at line 696-697,
right before the function's final closing `}` at line 698). Reuse the existing `SUPER`
const already defined at `users.routes.ts:543` (`requirePermission('admin_users.manage')`).
`recordAudit`, `AppError`, `eq`, and `schema` are already imported in this file — no new
imports needed.

```ts
app.post(
  '/admin/admin-users/:userId/sync-password',
  {
    preHandler: SUPER,
    schema: { params: z.object({ userId: z.string().uuid() }) },
  },
  async (req) => {
    const { userId } = req.params as { userId: string };
    await app.db.transaction(async (tx) => {
      const [admin] = await tx
        .select({ status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, userId))
        .for('update');
      if (!admin || admin.status !== 'active') {
        throw new AppError('NOT_FOUND', 404, 'no active admin for this user');
      }
      const [user] = await tx
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');

      await tx
        .update(schema.adminUsers)
        .set({ passwordHash: user.passwordHash })
        .where(eq(schema.adminUsers.userId, userId));

      // Never persist passwordHash itself into audit_logs (see admin_users schema comment).
      await recordAudit(tx, {
        actor: { userId: req.userId, role: req.adminRole! },
        action: 'admin_users.sync_password',
        resourceType: 'admin_user',
        resourceId: userId,
        request: req,
      });
    });
    return { ok: true };
  },
);
```

Deliberately doesn't touch `role` — unlike `POST /admin/admin-users` it works for
SUPER_ADMIN rows too, and can't be used to escalate anyone's role. It's strictly "make
this admin's panel password match their account password." The `.for('update')` row lock
matches the existing pattern in the DELETE route just above it (`users.routes.ts:679`).

## 2. Surface it in the UI

`apps/admin-web/src/pages/UsersPage.tsx` — add a button next to the existing "Reset
Password" button (currently at lines 725-732). **Gate it on `isSuperAdmin`**, matching the
existing convention for every other SUPER-only control on this page (role dropdown at
`:734`, Delete button at `:758`) — without this gate, non-super admins would see the
button and get a 403 toast on click:

```tsx
{isSuperAdmin && u.isAdmin && (
  <button
    className="btn ghost"
    disabled={adminActioning}
    onClick={() => void syncAdminPassword(u)}
  >
    <Icon.Refresh /> Sync Admin Password
  </button>
)}
```

Handler, alongside `assignAdminRole`/`revokeAdminRole` (currently lines 646-687):

```ts
async function syncAdminPassword(u: User) {
  setAdminActioning(true);
  try {
    await apiFetch(`/admin/admin-users/${u.id}/sync-password`, { method: 'POST' });
    toast({ title: `${userLabel(u)}'s admin panel password now matches their account password` });
  } catch (e) {
    toast({
      kind: 'error',
      title: 'Failed to sync admin password',
      body: apiErrorMessage(e, 'Please try again.'),
    });
  } finally {
    setAdminActioning(false);
  }
}
```

## 3. Close the silent-trap gap in `handleResetPassword`

`UsersPage.tsx:637-644`. `detail.isAdmin` is already known client-side — no backend
change needed, just warn right there:

```ts
async function handleResetPassword(newPassword: string) {
  if (!detail) return;
  await apiFetch(`/admin/users/${detail.id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
  if (detail.isAdmin) {
    toast({
      kind: 'warning',
      title: 'Password reset — admin panel access not yet updated',
      body: `${userLabel(detail)} is also an active admin. Use "Sync Admin Password" to update their admin.tryme.com login too.`,
    });
  } else {
    toast({ title: 'Password reset — share the new password with the customer' });
  }
}
```

## 4. Also fix while in this file: reset-password transaction/audit gap

`POST /admin/users/:id/reset-password` (`users.routes.ts:409-431`) is currently the only
mutating admin route in this file **not** wrapped in a transaction and **not** calling
`recordAudit` — every sibling mutation does, and CLAUDE.md's invariants require it. Wrap
the two `update()` calls (`users.passwordHash` set, `refreshTokens` revoke) in
`app.db.transaction(...)` and add a `recordAudit` call:

```ts
action: 'users.reset_password',
resourceType: 'user',
resourceId: id,
// no `after` payload — the hash itself must never reach audit_logs
```

## 5. Log it in `docs/progress.md`

**Not** `docs/audits/open-findings.md` — that file doesn't exist in this repo (`docs/audits/`
only contains `architecture_report.md`, `repository_inventory.md`,
`2026-07-16-admin-error-surfacing.md`, `2026-08-10-shopify-app-store-review.md`; confirmed
via directory listing). CLAUDE.md's file map references it as if live, but it isn't — flag
that discrepancy to the user separately if you notice it again elsewhere.

Add a dated entry to `docs/progress.md` (today's date, new section at the top) following
the style of the existing entry at `docs/progress.md:1244`. That entry documented this bug
for the bootstrap-admin instance specifically (2026-08-05); the new entry should note the
**general case** is now closed via the explicit resync endpoint + UI warning — not just
that one instance. Keep the two dates distinct in the writeup:

- **2026-06-12** (`12868615`) — the admin/web credential isolation design shipped
  (`admin_users.passwordHash` becomes a separate field from `users.passwordHash`).
- **2026-08-05** (`docs/progress.md:1244`) — first known casualty of the resulting desync
  (bootstrap-admin), fixed for that one case only.
- **Today** — the general case closed: explicit resync endpoint for SUPER_ADMIN rows,
  admin-role-grant path already resynced non-SUPER_ADMIN rows, and the reset-password flow
  now warns instead of failing silently.

---

## Verification before calling this done

- `pnpm --filter @tryme/api typecheck` and `pnpm --filter @tryme/admin typecheck`
  clean.
- Manually exercise in the admin panel: grant an ADMIN role to a test user (confirms
  existing resync path still works), then as SUPER_ADMIN use "Sync Admin Password" on a
  SUPER_ADMIN row (confirms the new path), then reset a non-admin user's password (confirms
  no warning toast) and an admin user's password (confirms the warning toast appears and
  points at the right action).
- Confirm the new endpoint 404s for a `pending`/`rejected` admin row and for a non-admin
  userId, and 403s for a non-SUPER caller.
