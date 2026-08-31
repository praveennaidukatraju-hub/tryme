import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('POST /v1/auth/catalog-app-device-exchange', () => {
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

  async function deviceTokenFor(userId: string, exp = app.env.JWT_EXPIRY) {
    return signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      userId,
      { kind: 'access' },
      exp,
      'device',
    );
  }

  async function createPlainUser() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `device-exchange-${Date.now()}@example.com`,
        displayName: 'Device User',
        emailVerified: true,
      })
      .returning();
    if (!user) throw new Error('failed to create user');
    return user.id;
  }

  function exchange(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-device-exchange',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('mints a catalog-app session for an active merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const token = await deviceTokenFor(merchant.userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('catalog_app_refresh');
    expect(cookies).not.toContain('refresh');

    const { accessToken } = res.json() as { accessToken: string };
    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('rejects a device user with no merchant profile', async () => {
    const userId = await createPlainUser();
    const token = await deviceTokenFor(userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MERCHANT');
  });

  it('rejects a device user with an inactive merchant profile', async () => {
    const merchant = await createTestMerchant(app, { isActive: false });
    const token = await deviceTokenFor(merchant.userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MERCHANT');
  });

  it('rejects a non-device-audience token', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const webToken = await signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      merchant.userId,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
    );

    const res = await exchange(webToken);

    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired device token', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const token = await deviceTokenFor(merchant.userId, '-1m');

    const res = await exchange(token);

    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-device-exchange',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a banned device user', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    await app.db
      .update(schema.users)
      .set({ isBanned: true })
      .where(eq(schema.users.id, merchant.userId));
    const token = await deviceTokenFor(merchant.userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BANNED');
  });

  it('accepts a token obtained via the real device-login -> device-refresh path (regression: device-refresh must preserve aud "device")', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const email = `real-flow-${randomUUID()}@example.com`;
    await app.db
      .update(schema.users)
      .set({ email, passwordHash: await hashPassword('password123') })
      .where(eq(schema.users.id, merchant.userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login',
      payload: {
        email,
        password: 'password123',
        deviceId: randomUUID(),
        platform: 'mobile',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const { refreshToken } = loginRes.json() as { refreshToken: string };

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-refresh',
      payload: { refreshToken, platform: 'mobile' },
    });
    expect(refreshRes.statusCode).toBe(200);
    const { accessToken } = refreshRes.json() as { accessToken: string };

    const res = await exchange(accessToken);

    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('catalog_app_refresh');
  });
});
