import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGoogleKeyGetterForTests } from '../src/modules/auth/google-id-token.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

const AUD = 'web-client.apps.googleusercontent.com';
let c: Containers;
let app: TestApp;
let privateKey: CryptoKey;
let requestIp = 1;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { GOOGLE_CLIENT_ID: AUD });

  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  setGoogleKeyGetterForTests(createLocalJWKSet({ keys: [jwk] }));
});

afterAll(async () => {
  setGoogleKeyGetterForTests(undefined);
  await app?.close();
  await c?.stop();
});

async function idToken(
  over: Partial<{ sub: string; email: string; name: string }> = {},
  aud = AUD,
) {
  return new SignJWT({
    sub: over.sub ?? randomUUID(),
    email: over.email ?? `g-${randomUUID()}@example.com`,
    email_verified: true,
    name: over.name ?? 'Google Person',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer('https://accounts.google.com')
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function post(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/device-login/google',
    payload,
    remoteAddress: `198.51.100.${requestIp++}`,
  });
}

describe('POST /v1/auth/device-login/google', () => {
  it('creates the account and asks for onboarding', async () => {
    const email = `new-${randomUUID()}@example.com`;
    const res = await post({
      idToken: await idToken({ email, name: 'New Person' }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.email).toBe(email);
    expect(body.merchantStatus).toBe('ONBOARDING_REQUIRED');
    expect(body.onboarding.suggestedContactName).toBe('New Person');

    const merchants = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, body.user.id));
    expect(merchants).toHaveLength(0);
  });

  it('links onto an existing merchant account by email and reports ACTIVE', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const email = `linked-${randomUUID()}@example.com`;
    await app.db.update(schema.users).set({ email }).where(eq(schema.users.id, merchant.userId));

    const res = await post({
      idToken: await idToken({ email }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(merchant.userId);
    expect(res.json().merchantStatus).toBe('ACTIVE');
    expect(res.json().onboarding).toBeUndefined();
  });

  it('returns the same user on a repeat login with the same google sub', async () => {
    const sub = randomUUID();
    const email = `repeat-${randomUUID()}@example.com`;
    const first = await post({
      idToken: await idToken({ sub, email }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });
    const second = await post({
      idToken: await idToken({ sub, email }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });
    expect(second.json().user.id).toBe(first.json().user.id);
  });

  it('rejects a banned account', async () => {
    const email = `banned-${randomUUID()}@example.com`;
    await app.db
      .insert(schema.users)
      .values({ email, displayName: 'B', emailVerified: true, isBanned: true });

    const res = await post({
      idToken: await idToken({ email }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BANNED');
  });

  it('rejects a token minted for another audience', async () => {
    const res = await post({
      idToken: await idToken({}, 'someone-else'),
      deviceId: randomUUID(),
      platform: 'mobile',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_GOOGLE_TOKEN');
  });

  it('enforces the device cap on kiosk and hands back a usable forceLogoutToken', async () => {
    const email = `kiosk-${randomUUID()}@example.com`;
    const sub = randomUUID();
    const first = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'device-a',
      platform: 'kiosk',
    });
    expect(first.statusCode).toBe(200);

    const second = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'device-b',
      platform: 'kiosk',
    });
    expect(second.statusCode).toBe(409);
    const { code, forceLogoutToken } = second.json().error;
    expect(code).toBe('DEVICE_LIMIT_REACHED');

    const forced = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/force',
      payload: { forceLogoutToken, deviceId: 'device-b', platform: 'kiosk' },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().accessToken).toBeTruthy();
  });

  it('does not enforce the cap on mobile', async () => {
    const email = `mob-${randomUUID()}@example.com`;
    const sub = randomUUID();
    await post({ idToken: await idToken({ sub, email }), deviceId: 'm-a', platform: 'mobile' });
    const second = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'm-b',
      platform: 'mobile',
    });
    expect(second.statusCode).toBe(200);
  });

  it('issues a refresh token that works against device-refresh with the same platform', async () => {
    const res = await post({ idToken: await idToken(), deviceId: randomUUID(), platform: 'kiosk' });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-refresh',
      payload: { refreshToken: res.json().refreshToken, platform: 'kiosk' },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().accessToken).toBeTruthy();
  });
});

describe('POST /v1/auth/device-login/google without GOOGLE_CLIENT_ID', () => {
  it('returns 503', async () => {
    const bare = await buildTestApp(c, { GOOGLE_CLIENT_ID: undefined });
    try {
      const res = await bare.inject({
        method: 'POST',
        url: '/v1/auth/device-login/google',
        payload: { idToken: 'x', deviceId: randomUUID(), platform: 'mobile' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('GOOGLE_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
