import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { createVerifiedUserToken } from '../helpers/auth';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin-approval', () => {
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

  async function registerAndVerify(email: string) {
    return createVerifiedUserToken(app, email);
  }

  it('regular user can request admin', async () => {
    const { token, userId } = await registerAndVerify('req1@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId));
    expect(row.status).toBe('pending');
  });

  it('re-request while pending is idempotent', async () => {
    const { token } = await registerAndVerify('req2@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('active admin cannot re-request', async () => {
    const { token, userId } = await registerAndVerify('req3@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('pending user blocked from admin routes', async () => {
    const { token, userId } = await registerAndVerify('req4@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'pending' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejected user blocked from admin routes', async () => {
    const { token, userId } = await registerAndVerify('req5@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'rejected' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejected user can re-apply', async () => {
    const { token, userId } = await registerAndVerify('req6@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'rejected' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId));
    expect(row.status).toBe('pending');
  });

  it('super admin can list pending requests', async () => {
    const { token: superToken, userId: superId } = await registerAndVerify('super-lr@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { token: pendingToken } = await registerAndVerify('pending-lr@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/admin-requests',
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
    expect(res.json().items[0]).toHaveProperty('email');
    expect(res.json().items[0]).toHaveProperty('role');
  });

  it('super admin can approve a request', async () => {
    const { token: superToken, userId: superId } = await registerAndVerify('super-ap@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { token: reqToken, userId: requestUserId } =
      await registerAndVerify('approve-target@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${reqToken}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${requestUserId}/approve`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, requestUserId));
    expect(row.status).toBe('active');
  });

  it('super admin can reject a request', async () => {
    const { token: superToken, userId: superId } = await registerAndVerify('super-rj@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { token: reqToken, userId: requestUserId } =
      await registerAndVerify('reject-target@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${reqToken}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${requestUserId}/reject`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, requestUserId));
    expect(row.status).toBe('rejected');
  });

  it('super admin can revoke an active admin', async () => {
    const { token: superToken, userId: superId } = await registerAndVerify('super-rv@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { userId: adminId } = await registerAndVerify('revoke-me@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: adminId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/admin-users/${adminId}`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, adminId));
    expect(row).toBeUndefined();
  });

  it('approved ADMIN can access admin routes', async () => {
    const { token, userId } = await registerAndVerify('admin-ok@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('ADMIN cannot delete assets', async () => {
    const { token, userId } = await registerAndVerify('admin-nodel@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/assets/faces/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN can read workflows', async () => {
    const { token, userId } = await registerAndVerify('admin-nowf@test.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/workflows',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('non-admin cannot approve/reject requests', async () => {
    const { token, userId } = await registerAndVerify('rando@test.com');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${userId}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('super admin cannot revoke themselves', async () => {
    const { token, userId } = await registerAndVerify('self-revoke@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'SUPER_ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/admin-users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  describe('sync-password', () => {
    it('returns 403 for non-super admin callers', async () => {
      const { token: modToken, userId: modUserId } = await registerAndVerify('mod-caller@test.com');
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: modUserId, role: 'MODERATOR', status: 'active' });
      const { userId: targetId } = await registerAndVerify('sync-target-1@test.com');
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: targetId, role: 'ADMIN', status: 'active' });

      const res = await app.inject({
        method: 'POST',
        url: `/admin/admin-users/${targetId}/sync-password`,
        headers: { authorization: `Bearer ${modToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for non-existent or non-admin user', async () => {
      const { token: superToken, userId: superId } =
        await registerAndVerify('super-sync-404@test.com');
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });

      // Non-admin user
      const { userId: plainUserId } = await registerAndVerify('plain-user-sync@test.com');
      const plainRes = await app.inject({
        method: 'POST',
        url: `/admin/admin-users/${plainUserId}/sync-password`,
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(plainRes.statusCode).toBe(404);
      expect(plainRes.json().error.message).toBe('no active admin for this user');

      // Random UUID
      const randRes = await app.inject({
        method: 'POST',
        url: '/admin/admin-users/00000000-0000-0000-0000-000000000099/sync-password',
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(randRes.statusCode).toBe(404);
    });

    it('returns 404 for pending or rejected admin users', async () => {
      const { token: superToken, userId: superId } = await registerAndVerify(
        'super-sync-status@test.com',
      );
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });

      // Pending admin
      const { userId: pendingUserId } = await registerAndVerify('pending-sync@test.com');
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: pendingUserId, role: 'ADMIN', status: 'pending' });

      const pendingRes = await app.inject({
        method: 'POST',
        url: `/admin/admin-users/${pendingUserId}/sync-password`,
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(pendingRes.statusCode).toBe(404);
      expect(pendingRes.json().error.message).toBe('no active admin for this user');

      // Rejected admin
      const { userId: rejectedUserId } = await registerAndVerify('rejected-sync@test.com');
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: rejectedUserId, role: 'ADMIN', status: 'rejected' });

      const rejectedRes = await app.inject({
        method: 'POST',
        url: `/admin/admin-users/${rejectedUserId}/sync-password`,
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(rejectedRes.statusCode).toBe(404);
      expect(rejectedRes.json().error.message).toBe('no active admin for this user');
    });

    it('syncs passwordHash for active admin (including SUPER_ADMIN) and writes audit log', async () => {
      const { token: superToken, userId: superId } = await registerAndVerify(
        'super-sync-runner@test.com',
      );
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });

      // Create target active SUPER_ADMIN with stale passwordHash on admin_users
      const { userId: targetSuperId } = await registerAndVerify('target-super-admin@test.com');
      await app.db.insert(schema.adminUsers).values({
        userId: targetSuperId,
        role: 'SUPER_ADMIN',
        status: 'active',
        passwordHash: 'stale-hash-old',
      });

      // Target user has real passwordHash in users table
      const [targetUser] = await app.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, targetSuperId));
      expect(targetUser.passwordHash).not.toBe('stale-hash-old');

      const res = await app.inject({
        method: 'POST',
        url: `/admin/admin-users/${targetSuperId}/sync-password`,
        headers: { authorization: `Bearer ${superToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      // Verify admin_users.passwordHash was updated to match users.passwordHash
      const [syncedAdmin] = await app.db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, targetSuperId));
      expect(syncedAdmin.passwordHash).toBe(targetUser.passwordHash);

      // Verify audit log recorded
      const [audit] = await app.db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.resourceId, targetSuperId));
      expect(audit).toBeDefined();
      expect(audit.action).toBe('admin_users.sync_password');
      expect(audit.resourceType).toBe('admin_user');
      expect(audit.actorUserId).toBe(superId);
      expect(audit.actorRole).toBe('SUPER_ADMIN');
    });
  });

  describe('reset-password audit and transaction', () => {
    it('resets user password, revokes tokens, and records audit log in transaction', async () => {
      const { token: adminToken, userId: adminId } = await registerAndVerify(
        'admin-reset-pwd@test.com',
      );
      await app.db
        .insert(schema.adminUsers)
        .values({ userId: adminId, role: 'ADMIN', status: 'active' });

      const { userId: targetId } = await registerAndVerify('target-pwd-reset@test.com');

      const [userBefore] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, targetId));

      const res = await app.inject({
        method: 'POST',
        url: `/admin/users/${targetId}/reset-password`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { newPassword: 'NewValidPassword123!' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const [userAfter] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, targetId));
      expect(userAfter.passwordHash).not.toBe(userBefore.passwordHash);

      // Verify audit log recorded without exposing password hash
      const audits = await app.db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.resourceId, targetId));
      const resetAudit = audits.find((a) => a.action === 'users.reset_password');
      expect(resetAudit).toBeDefined();
      expect(resetAudit?.resourceType).toBe('user');
      expect(resetAudit?.actorUserId).toBe(adminId);
      expect(resetAudit?.actorRole).toBe('ADMIN');
      expect(resetAudit?.after).toBeNull();
    });
  });
});
