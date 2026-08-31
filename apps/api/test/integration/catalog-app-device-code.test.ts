import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('POST /v1/auth/catalog-app-device-code + /v1/auth/catalog-app-code-exchange', () => {
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
        email: `device-code-${Date.now()}@example.com`,
        displayName: 'Device Code User',
        emailVerified: true,
      })
      .returning();
    if (!user) throw new Error('failed to create user');
    return user.id;
  }

  function requestCode(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-device-code',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function exchangeCode(code: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-code-exchange',
      payload: { code },
    });
  }

  describe('catalog-app-device-code (issuance)', () => {
    it('issues a single-use code for an active merchant', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      const token = await deviceTokenFor(merchant.userId);

      const res = await requestCode(token);

      expect(res.statusCode).toBe(200);
      const body = res.json() as { code: string; expiresInSeconds: number };
      expect(body.code.length).toBeGreaterThanOrEqual(20);
      expect(body.expiresInSeconds).toBe(60);
    });

    it('rejects a device user with no merchant profile', async () => {
      const userId = await createPlainUser();
      const token = await deviceTokenFor(userId);

      const res = await requestCode(token);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_A_MERCHANT');
    });

    it('rejects a device user with an inactive merchant profile', async () => {
      const merchant = await createTestMerchant(app, { isActive: false });
      const token = await deviceTokenFor(merchant.userId);

      const res = await requestCode(token);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_A_MERCHANT');
    });

    it('rejects a banned device user', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      await app.db
        .update(schema.users)
        .set({ isBanned: true })
        .where(eq(schema.users.id, merchant.userId));
      const token = await deviceTokenFor(merchant.userId);

      const res = await requestCode(token);

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('BANNED');
    });

    it('rejects a non-device-audience token', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      const webToken = await signAccess(
        new TextEncoder().encode(app.env.JWT_SECRET),
        merchant.userId,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
      );

      const res = await requestCode(webToken);

      expect(res.statusCode).toBe(401);
    });

    it('rejects an expired device token', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      const token = await deviceTokenFor(merchant.userId, '-1m');

      const res = await requestCode(token);

      expect(res.statusCode).toBe(401);
    });

    it('rejects a request with no bearer token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/catalog-app-device-code',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('catalog-app-code-exchange (redemption)', () => {
    it('mints a catalog-app session for a valid code, scoped to the code-issuing user', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      const token = await deviceTokenFor(merchant.userId);
      const { code } = (await requestCode(token)).json() as { code: string };

      const res = await exchangeCode(code);

      expect(res.statusCode).toBe(200);
      const cookies = res.cookies.map((ck) => ck.name);
      expect(cookies).toContain('catalog_app_refresh');

      const { accessToken } = res.json() as { accessToken: string };
      const merchantRes = await app.inject({
        method: 'GET',
        url: '/v1/merchant/catalog/subcategories',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(merchantRes.statusCode).toBe(200);
    });

    it('rejects reusing an already-consumed code', async () => {
      const merchant = await createTestMerchant(app, { isActive: true });
      const token = await deviceTokenFor(merchant.userId);
      const { code } = (await requestCode(token)).json() as { code: string };

      const first = await exchangeCode(code);
      expect(first.statusCode).toBe(200);

      const second = await exchangeCode(code);
      expect(second.statusCode).toBe(401);
      expect(second.json().error.code).toBe('INVALID_CODE');
    });

    it('rejects an unknown code', async () => {
      const res = await exchangeCode('a'.repeat(32));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CODE');
    });

    it('rejects an expired code', async () => {
      // Bypass the 60s issuance TTL to test expiry deterministically and fast:
      // write the same Redis key shape directly with a 1s TTL.
      const merchant = await createTestMerchant(app, { isActive: true });
      const code = 'expired-code-test-000000000000';
      await app.redis.set(`catalog-app-handoff:${code}`, merchant.userId, 'EX', 1);
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const res = await exchangeCode(code);

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CODE');
    });

    it('rejects a malformed (too short) code', async () => {
      const res = await exchangeCode('short');
      expect(res.statusCode).toBe(400);
    });
  });
});
