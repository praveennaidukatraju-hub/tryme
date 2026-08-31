import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { createVerifiedUserToken } from '../helpers/auth';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin-users', () => {
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

  it('returns 403 for non-admin accessing admin routes', async () => {
    const { token } = await createVerifiedUserToken(app, 'user@x.com');
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows admin to list users', async () => {
    const { token, userId } = await createVerifiedUserToken(app, 'admin2@x.com');
    await app.db
      .update(schema.users)
      .set({ phone: '9876543210' })
      .where(eq(schema.users.id, userId));
    await app.db.insert(schema.adminUsers).values({ userId, role: 'SUPER_ADMIN' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
    const adminUser = res.json().items.find((item: { id: string }) => item.id === userId);
    expect(adminUser?.phone).toBe('9876543210');
  });

  it('hides suspended users from the default list, shows them with showBanned=true', async () => {
    const { token: adminToken, userId: adminId } = await createVerifiedUserToken(
      app,
      'admin_banned_filter@x.com',
    );
    await app.db.insert(schema.adminUsers).values({ userId: adminId, role: 'SUPER_ADMIN' });

    const { userId: bannedId } = await createVerifiedUserToken(app, 'banned_filter_target@x.com');
    await app.db
      .update(schema.users)
      .set({ isBanned: true, banReason: 'test suspension' })
      .where(eq(schema.users.id, bannedId));

    const defaultRes = await app.inject({
      method: 'GET',
      url: '/admin/users?pageSize=100',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(defaultRes.statusCode).toBe(200);
    expect(defaultRes.json().items.some((item: { id: string }) => item.id === bannedId)).toBe(
      false,
    );

    const showBannedRes = await app.inject({
      method: 'GET',
      url: '/admin/users?pageSize=100&showBanned=true',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(showBannedRes.statusCode).toBe(200);
    expect(showBannedRes.json().items.some((item: { id: string }) => item.id === bannedId)).toBe(
      true,
    );
  });

  it('performs full PII erasure on single delete for regular user', async () => {
    const { token: superAdminToken, userId: superAdminUserId } = await createVerifiedUserToken(
      app,
      'superadmin_erasure_user@x.com',
    );
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superAdminUserId, role: 'SUPER_ADMIN' });

    // Target user to erase
    const { userId: targetId } = await createVerifiedUserToken(app, 'target_pii@x.com');
    await app.db
      .update(schema.users)
      .set({
        displayName: 'Target Person',
        phone: '9876543211',
        companyName: 'Acme Corp',
        username: 'target_person',
      })
      .where(eq(schema.users.id, targetId));

    // OAuth account
    await app.db.insert(schema.oauthAccounts).values({
      userId: targetId,
      provider: 'google',
      providerId: 'google-sub-12345',
    });

    // Refresh token
    await app.db.insert(schema.refreshTokens).values({
      userId: targetId,
      familyId: '11111111-1111-4111-8111-111111111111',
      tokenHash: 'test-refresh-token-hash-1',
      expiresAt: new Date(Date.now() + 86400000),
    });

    // Associated financial & job records
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId: targetId,
        status: 'completed',
        jobType: 'regular',
        creditsCharged: 5,
      })
      .returning();

    const [plan] = await app.db
      .insert(schema.creditPlans)
      .values({
        slug: 'test_plan_erasure',
        name: 'Test Plan',
        credits: 1000,
        basePaise: 1000,
        queueStream: 'normal',
      })
      .returning();

    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: targetId,
        planId: plan.id,
        credits: 100,
        razorpayOrderId: 'order_test_123',
        razorpayPaymentId: 'pay_test_123',
        amount: 500,
        basePaise: 50000,
        gstPaise: 9000,
        totalPaise: 59000,
        currency: 'INR',
        status: 'captured',
      })
      .returning();

    const [ledger] = await app.db
      .insert(schema.creditLedger)
      .values({
        userId: targetId,
        delta: 10,
        action: 'grant',
        reason: 'test grant',
      })
      .returning();

    // Perform erasure via DELETE /admin/users/:id
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${targetId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Assert user fields in DB anonymized
    const [dbUser] = await app.db.select().from(schema.users).where(eq(schema.users.id, targetId));
    expect(dbUser.email).toBe(`deleted+${targetId}@example.invalid`);
    expect(dbUser.displayName).toBe('Deleted User');
    expect(dbUser.phone).toBeNull();
    expect(dbUser.companyName).toBeNull();
    expect(dbUser.username).toBeNull();
    expect(dbUser.isBanned).toBe(true);
    expect(dbUser.banReason).toBe('admin erasure (GDPR)');

    // Assert oauth_accounts deleted
    const oauthRows = await app.db
      .select()
      .from(schema.oauthAccounts)
      .where(eq(schema.oauthAccounts.userId, targetId));
    expect(oauthRows).toHaveLength(0);

    // Assert refreshTokens revoked
    const refreshRows = await app.db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, targetId));
    expect(refreshRows.length).toBeGreaterThan(0);
    expect(refreshRows[0].revokedAt).not.toBeNull();

    // Assert financial & job records intact with original userId FK
    const [checkJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(checkJob.userId).toBe(targetId);

    const [checkPayment] = await app.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, payment.id));
    expect(checkPayment.userId).toBe(targetId);

    const [checkLedger] = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.id, ledger.id));
    expect(checkLedger.userId).toBe(targetId);
  });

  it('rejects deletion of admin user with 403', async () => {
    const { token: superAdminToken, userId: superAdminId } = await createVerifiedUserToken(
      app,
      'sa_guard@x.com',
    );
    await app.db.insert(schema.adminUsers).values({ userId: superAdminId, role: 'SUPER_ADMIN' });

    const { userId: targetAdminId } = await createVerifiedUserToken(app, 'target_admin@x.com');
    await app.db.insert(schema.adminUsers).values({ userId: targetAdminId, role: 'MODERATOR' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${targetAdminId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('cannot delete an admin user');
  });

  it('rejects deletion of merchant account owner with 403', async () => {
    const { token: superAdminToken, userId: superAdminId } = await createVerifiedUserToken(
      app,
      'sa_merchant_guard@x.com',
    );
    await app.db.insert(schema.adminUsers).values({ userId: superAdminId, role: 'SUPER_ADMIN' });

    const { userId: merchantOwnerId } = await createVerifiedUserToken(app, 'merchant_owner@x.com');
    await app.db.insert(schema.merchants).values({
      userId: merchantOwnerId,
      companyName: 'Test Merchant',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: '123 Main St',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${merchantOwnerId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('cannot erase a merchant account owner');
  });

  it('returns 403 for non-SUPER_ADMIN on single and bulk delete routes', async () => {
    const { token: modToken, userId: modUserId } = await createVerifiedUserToken(
      app,
      'mod_user@x.com',
    );
    await app.db.insert(schema.adminUsers).values({ userId: modUserId, role: 'MODERATOR' });

    const { userId: plainUserId } = await createVerifiedUserToken(app, 'plain_target@x.com');

    const singleRes = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${plainUserId}`,
      headers: { authorization: `Bearer ${modToken}` },
    });
    expect(singleRes.statusCode).toBe(403);

    const bulkRes = await app.inject({
      method: 'POST',
      url: '/admin/users/bulk-delete',
      headers: { authorization: `Bearer ${modToken}` },
      payload: { ids: [plainUserId] },
    });
    expect(bulkRes.statusCode).toBe(403);
  });

  it('processes bulk-delete independently, reporting succeeded and skipped splits', async () => {
    const { token: superAdminToken, userId: superAdminId } = await createVerifiedUserToken(
      app,
      'sa_bulk@x.com',
    );
    await app.db.insert(schema.adminUsers).values({ userId: superAdminId, role: 'SUPER_ADMIN' });

    // 1. Clean plain user
    const { userId: cleanId } = await createVerifiedUserToken(app, 'bulk_clean@x.com');
    // 2. Admin user
    const { userId: adminId } = await createVerifiedUserToken(app, 'bulk_admin@x.com');
    await app.db.insert(schema.adminUsers).values({ userId: adminId, role: 'SUPPORT' });
    // 3. Merchant owner
    const { userId: merchantId } = await createVerifiedUserToken(app, 'bulk_merchant@x.com');
    await app.db.insert(schema.merchants).values({
      userId: merchantId,
      companyName: 'Bulk Merchant',
      contactName: 'Bulk Owner',
      phone: '8888888888',
      businessAddress: '456 Market St',
    });
    // 4. Already erased user
    const { userId: erasedId } = await createVerifiedUserToken(app, 'bulk_erased@x.com');
    await app.db
      .update(schema.users)
      .set({
        email: `deleted+${erasedId}@example.invalid`,
        displayName: 'Deleted User',
        isBanned: true,
        banReason: 'admin erasure (GDPR)',
      })
      .where(eq(schema.users.id, erasedId));

    const res = await app.inject({
      method: 'POST',
      url: '/admin/users/bulk-delete',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { ids: [cleanId, adminId, merchantId, erasedId] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toEqual([cleanId, erasedId]);
    expect(body.skipped).toEqual([
      { id: adminId, reason: 'cannot delete an admin user' },
      { id: merchantId, reason: 'cannot erase a merchant account owner' },
    ]);

    // Assert clean user PII was indeed erased
    const [dbClean] = await app.db.select().from(schema.users).where(eq(schema.users.id, cleanId));
    expect(dbClean.displayName).toBe('Deleted User');
  });
});
