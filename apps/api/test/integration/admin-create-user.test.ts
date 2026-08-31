import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('admin create user', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('creates a username-only account (no email) that can log in with the username', async () => {
    const username = `walkin${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Walk-in Customer' },
    });
    expect(createRes.statusCode).toBe(201);
    const { userId } = createRes.json() as { userId: string };
    expect(userId).toBeTruthy();

    const [row] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row?.email).toBeNull();
    expect(row?.username).toBe(username.toLowerCase());
    expect(row?.emailVerified).toBe(true);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: username, password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().accessToken).toBeTruthy();
  });

  it('logging in with the username is case-insensitive', async () => {
    const username = `caseinsensitive${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Case Test' },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: username.toUpperCase(), password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('rejects a duplicate username', async () => {
    const username = `dupe${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'First' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Second' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects a username shaped like an email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username: 'not@allowed', password: 'password123', displayName: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an optional email/phone and rejects a duplicate email', async () => {
    const existingEmail = `existing${Date.now()}@example.com`;
    await app.db.insert(schema.users).values({ email: existingEmail, tier: 'free' });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: {
        username: `withemail${Date.now()}`,
        password: 'password123',
        displayName: 'Has Email',
        email: existingEmail,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });
});
