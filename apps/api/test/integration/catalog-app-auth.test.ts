import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('catalog-app portal login', () => {
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

  async function setPassword(userId: string, password: string) {
    const passwordHash = await hashPassword(password);
    await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  it('issues a catalog_app_refresh cookie (not refresh) for a merchant account', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain('catalog_app_refresh');
    expect(cookies).not.toContain('refresh');
  });

  it('rejects a non-merchant account with portal: catalog-app', async () => {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `notmerchant${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a catalog-app token is rejected by requireUser but accepted by requireMerchant', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    const { accessToken } = loginRes.json() as { accessToken: string };

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(401);

    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('plain /v1/auth/login (no portal) is unaffected — sets refresh, not catalog_app_refresh', async () => {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `plainlogin${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain('refresh');
    expect(cookies).not.toContain('catalog_app_refresh');
  });

  it('catalog-app-refresh rotates the catalog_app_refresh cookie and reissues a catalog-app-audience token', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'catalog_app_refresh');
    expect(refreshCookie).toBeTruthy();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-refresh',
      cookies: { catalog_app_refresh: refreshCookie?.value ?? '' },
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().accessToken).toBeTruthy();

    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${refreshRes.json().accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('rejects a plain web refresh token presented at catalog-app-refresh', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123' },
    });
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'refresh');

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-refresh',
      cookies: { catalog_app_refresh: refreshCookie?.value ?? '' },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
});
