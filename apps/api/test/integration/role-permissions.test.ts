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
      .where(
        and(eq(schema.rolePermissions.role, 'SUPPORT'), eq(schema.permissions.key, 'jobs.write')),
      );
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
      .where(
        and(eq(schema.rolePermissions.role, 'SUPPORT'), eq(schema.permissions.key, 'jobs.write')),
      );
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
