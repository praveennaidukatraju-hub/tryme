import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('results auth unification', () => {
  let c: Containers;
  let app: TestApp;
  // /results/login is rate-limited to 5/min; each call below needs its own
  // remoteAddress so tests don't collide on the same limiter bucket.
  let nextTestClient = 1;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('allows active admin of any role to log into /results', async () => {
    const password = 'password123';
    const passwordHash = await hashPassword(password);

    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: 'support-admin@x.com',
        passwordHash,
        displayName: 'Support Admin',
        emailVerified: true,
      })
      .returning();

    await app.db.insert(schema.adminUsers).values({
      userId: user.id,
      role: 'SUPPORT',
      status: 'active',
      passwordHash,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'support-admin@x.com', password },
    });

    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((cookie) => cookie.name === 'results_access_token')).toBe(true);
  });

  it('rejects non-admin user from /results with 403', async () => {
    const password = 'password123';
    const passwordHash = await hashPassword(password);

    await app.db.insert(schema.users).values({
      email: 'regular-user@x.com',
      passwordHash,
      displayName: 'Regular User',
      emailVerified: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'regular-user@x.com', password },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('admin access required');
  });

  it('rejects previously active admin if status changes to rejected (live check verification)', async () => {
    const password = 'password123';
    const passwordHash = await hashPassword(password);

    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: 'flip-status-admin@x.com',
        passwordHash,
        displayName: 'Flip Admin',
        emailVerified: true,
      })
      .returning();

    await app.db.insert(schema.adminUsers).values({
      userId: user.id,
      role: 'ADMIN',
      status: 'active',
      passwordHash,
    });

    // First login succeeds while active
    const res1 = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'flip-status-admin@x.com', password },
    });
    expect(res1.statusCode).toBe(200);

    // Flip status to rejected in DB
    await app.db
      .update(schema.adminUsers)
      .set({ status: 'rejected' })
      .where(eq(schema.adminUsers.userId, user.id));

    // Next login immediately fails with 403
    const res2 = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'flip-status-admin@x.com', password },
    });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error.message).toBe('admin access required');
  });

  it('authenticates against admin_users.passwordHash, not the customer password, when the two diverge', async () => {
    const adminPassword = 'admin-password-1';
    const customerPassword = 'customer-password-2';

    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: 'diverged-admin@x.com',
        passwordHash: await hashPassword(customerPassword),
        displayName: 'Diverged Admin',
        emailVerified: true,
      })
      .returning();

    await app.db.insert(schema.adminUsers).values({
      userId: user.id,
      role: 'ADMIN',
      status: 'active',
      passwordHash: await hashPassword(adminPassword),
    });

    const withAdminPassword = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'diverged-admin@x.com', password: adminPassword },
    });
    expect(withAdminPassword.statusCode).toBe(200);

    const withCustomerPassword = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'diverged-admin@x.com', password: customerPassword },
    });
    expect(withCustomerPassword.statusCode).toBe(401);
  });

  it('does not leak admin status via response code when the password is wrong for a non-active account', async () => {
    // No admin_users row at all — under the vulnerable ordering, the status check
    // (`!admin`) fires unconditionally and returns 403 without ever inspecting the
    // password. The fix must verify the password first, so a wrong password here
    // returns 401 — indistinguishable from a wrong password against a nonexistent email.
    await app.db.insert(schema.users).values({
      email: 'non-admin-wrong-pw@x.com',
      passwordHash: await hashPassword('correct-password'),
      displayName: 'Non Admin',
      emailVerified: true,
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'non-admin-wrong-pw@x.com', password: 'wrong-password' },
    });
    expect(res1.statusCode).toBe(401);
    expect(res1.json().error.message).toBe('invalid credentials');

    // A non-active admin row — same failure mode: `admin.status !== 'active'` must not
    // fire before the password is checked.
    const [user2] = await app.db
      .insert(schema.users)
      .values({
        email: 'rejected-admin-wrong-pw@x.com',
        passwordHash: await hashPassword('correct-password'),
        displayName: 'Rejected Admin',
        emailVerified: true,
      })
      .returning();

    await app.db.insert(schema.adminUsers).values({
      userId: user2.id,
      role: 'ADMIN',
      status: 'rejected',
      passwordHash: await hashPassword('correct-password'),
    });

    const res2 = await app.inject({
      method: 'POST',
      url: '/results/login',
      remoteAddress: `127.0.0.${nextTestClient++}`,
      payload: { email: 'rejected-admin-wrong-pw@x.com', password: 'wrong-password' },
    });
    expect(res2.statusCode).toBe(401);
    expect(res2.json().error.message).toBe('invalid credentials');
  });
});
