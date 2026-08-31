import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('credit-plans admin guards', () => {
  let c: Containers;
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);

    // /v1/auth/register only sends a verification email now (no token in the
    // response), and /v1/auth/login rejects SUPER_ADMIN accounts outright — so
    // admin test users must go through /admin/auth/login, which requires
    // emailVerified=true and admin_users.passwordHash to be set (normally copied
    // over at admin-approval time; we do it directly here).
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Credit Plans Admin',
        email: 'plans-admin@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'plans-admin@x.com'));
    const userId = user?.id;
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userId));
    await app.db.insert(schema.adminUsers).values({
      userId,
      role: 'SUPER_ADMIN',
      passwordHash: user?.passwordHash,
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'plans-admin@x.com', password: 'password123' },
    });
    adminToken = loginRes.json().accessToken;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  function authed(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  }

  async function registerAndGetUserId(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Credit Plans User', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    return user?.id;
  }

  it('seeds the free plan via migration 0077 with slug "free"', async () => {
    const [plan] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    expect(plan).toBeDefined();
    expect(plan?.isActive).toBe(true);
  });

  it('allows changing the free plan credits to 0 (basePaise/credits now accept nonnegative, not just positive)', async () => {
    const [freePlan] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    const res = await authed('PATCH', `/admin/credit-plans/${freePlan?.id}`, {
      slug: 'free',
      name: 'Free',
      subtext: 'Default plan for new users',
      credits: 0,
      basePaise: 0,
      isActive: true,
      isHighlighted: false,
      badge: null,
      sortOrder: 0,
      queueStream: 'normal',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().credits).toBe(0);

    // restore for subsequent tests
    await authed('PATCH', `/admin/credit-plans/${freePlan?.id}`, { credits: 100 });
  });

  it('blocks renaming the free plan slug (400)', async () => {
    const [freePlan] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    const res = await authed('PATCH', `/admin/credit-plans/${freePlan?.id}`, {
      slug: 'not-free',
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks deactivating the free plan (403)', async () => {
    const [freePlan] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    const res = await authed('PATCH', `/admin/credit-plans/${freePlan?.id}`, {
      isActive: false,
    });
    expect(res.statusCode).toBe(403);

    const [stillActive] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    expect(stillActive?.isActive).toBe(true);
  });

  it('blocks deleting the free plan (403)', async () => {
    const [freePlan] = await app.db
      .select()
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    const res = await authed('DELETE', `/admin/credit-plans/${freePlan?.id}`);
    expect(res.statusCode).toBe(403);
  });

  it('blocks deleting a paid plan that a user currently has as their tier (409)', async () => {
    const created = await authed('POST', '/admin/credit-plans', {
      slug: 'guard-test-plan',
      name: 'Guard Test Plan',
      credits: 500,
      basePaise: 200000,
      queueStream: 'normal',
    });
    expect(created.statusCode).toBe(200);
    const plan = created.json();

    const userId = await registerAndGetUserId('on-guard-plan@x.com');
    await app.db.update(schema.users).set({ tier: plan.slug }).where(eq(schema.users.id, userId));

    const delRes = await authed('DELETE', `/admin/credit-plans/${plan.id}`);
    expect(delRes.statusCode).toBe(409);

    // move the user off the plan, deletion should now succeed
    await app.db.update(schema.users).set({ tier: 'free' }).where(eq(schema.users.id, userId));
    const delRes2 = await authed('DELETE', `/admin/credit-plans/${plan.id}`);
    expect(delRes2.statusCode).toBe(204);
  });

  it('DB-level FK backstop: a raw delete of a plan with a user on it fails even bypassing the API guard', async () => {
    const created = await authed('POST', '/admin/credit-plans', {
      slug: 'fk-backstop-plan',
      name: 'FK Backstop Plan',
      credits: 100,
      basePaise: 100000,
      queueStream: 'normal',
    });
    const plan = created.json();

    const userId = await registerAndGetUserId('fk-backstop@x.com');
    await app.db.update(schema.users).set({ tier: plan.slug }).where(eq(schema.users.id, userId));

    await expect(
      app.db.delete(schema.creditPlans).where(eq(schema.creditPlans.id, plan.id)),
    ).rejects.toThrow();
  });
});
