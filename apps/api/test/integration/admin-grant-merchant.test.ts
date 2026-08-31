import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('grant merchant access to an existing user', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('grants merchant access via userId to a username-only account with no email', async () => {
    const username = `granttarget${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Walk-in Customer' },
    });
    expect(createRes.statusCode).toBe(201);
    const { userId } = createRes.json() as { userId: string };

    const grantRes = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { userId, companyName: 'Walk-in Shop' },
    });
    expect(grantRes.statusCode).toBe(201);
    const { id: merchantId } = grantRes.json() as { id: string };

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    expect(merchant?.userId).toBe(userId);
    expect(merchant?.companyName).toBe('Walk-in Shop');

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.email).toBeNull();
  });

  it('still supports the email-based find-or-create path (no userId given)', async () => {
    const email = `newmerchant${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { email, companyName: 'Email Onboarded Co' },
    });
    expect(res.statusCode).toBe(201);

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(user).toBeTruthy();
  });

  it('rejects when neither userId nor email is given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { companyName: 'No Target Co' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects granting merchant access to a userId that is already a merchant', async () => {
    const username = `already${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Already Merchant' },
    });
    const { userId } = createRes.json() as { userId: string };

    await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { userId, companyName: 'First Grant' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { userId, companyName: 'Second Grant' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('404s when userId does not resolve to a user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: authHeader,
      payload: { userId: '00000000-0000-0000-0000-000000000000', companyName: 'Ghost Co' },
    });
    expect(res.statusCode).toBe(404);
  });
});
