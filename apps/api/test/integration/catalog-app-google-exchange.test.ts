import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('catalog-app portal — Google OAuth exchange', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    // googleAuthRoutes early-returns (no /v1/auth/google/* routes registered) unless
    // all three GOOGLE_* vars are present — see apps/api/src/modules/auth/google.routes.ts.
    app = await buildTestApp(c, {
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:4000/v1/auth/google/callback',
      WEB_URL: 'http://localhost:3000',
    });
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('rejects a non-merchant account exchanging an OTP with portal: catalog-app', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `notmerchant-google-${Date.now()}@example.com`,
        passwordHash: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    const otp = 'test-otp-non-merchant';
    await app.redis.set(`oauth:otp:${otp}`, user?.id ?? '', 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp, portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an inactive merchant account exchanging an OTP with portal: catalog-app', async () => {
    const { userId } = await createTestMerchant(app, { isActive: false });
    const otp = 'test-otp-inactive-merchant';
    await app.redis.set(`oauth:otp:${otp}`, userId, 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp, portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a merchant account exchanging an OTP with portal: catalog-app, issuing a catalog-app-audience session', async () => {
    const { userId } = await createTestMerchant(app);
    const otp = 'test-otp-merchant';
    await app.redis.set(`oauth:otp:${otp}`, userId, 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp, portal: 'catalog-app' },
    });
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

  it('plain portal: web exchange is unaffected by the merchant check', async () => {
    const passwordHash = null;
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `plain-google-${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    const otp = 'test-otp-plain-web';
    await app.redis.set(`oauth:otp:${otp}`, user?.id ?? '', 'EX', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('refresh');
  });
});
