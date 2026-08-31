import { randomUUID } from 'node:crypto';
import { eq, schema } from '@tryme/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendVerificationEmail, sendWelcomeEmail } from '../../src/lib/mailer.js';
import { setGoogleKeyGetterForTests } from '../../src/modules/auth/google-id-token.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Both are mocked (real module otherwise) — the whole point of these tests is
// to pin down exactly when each fires relative to the other.
vi.mock('../../src/lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/mailer.js')>();
  return {
    ...actual,
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
  };
});

const GOOGLE_AUD = 'web-client.apps.googleusercontent.com';
let ctx: Containers;
let app: TestApp;
let googlePrivateKey: CryptoKey;

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx, { GOOGLE_CLIENT_ID: GOOGLE_AUD });

  const pair = await generateKeyPair('RS256');
  googlePrivateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  setGoogleKeyGetterForTests(createLocalJWKSet({ keys: [jwk] }));
});

afterAll(async () => {
  setGoogleKeyGetterForTests(undefined);
  await app.close();
  await ctx.stop();
});

async function googleIdToken(over: Partial<{ sub: string; email: string; name: string }> = {}) {
  return new SignJWT({
    sub: over.sub ?? randomUUID(),
    email: over.email ?? `g-${randomUUID()}@example.com`,
    email_verified: true,
    name: over.name ?? 'Google Person',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer('https://accounts.google.com')
    .setAudience(GOOGLE_AUD)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(googlePrivateKey);
}

describe('welcome email timing', () => {
  it('POST /v1/auth/register sends only the verification email, not the welcome email', async () => {
    vi.mocked(sendVerificationEmail).mockClear();
    vi.mocked(sendWelcomeEmail).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'New User', email: 'newcomer@example.com', password: 'password123' },
    });

    expect(res.statusCode).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();

    const [user] = await app.db
      .select({ emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.email, 'newcomer@example.com'));
    expect(user?.emailVerified).toBe(false);
  });

  it('GET /v1/auth/verify-email sends the welcome email only after verification succeeds', async () => {
    vi.mocked(sendVerificationEmail).mockClear();
    vi.mocked(sendWelcomeEmail).mockClear();

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Verify Me', email: 'verifyme@example.com', password: 'password123' },
    });
    expect(sendWelcomeEmail).not.toHaveBeenCalled();

    const token = vi.mocked(sendVerificationEmail).mock.calls[0]?.[4];
    expect(token).toBeTruthy();

    const res = await app.inject({ method: 'GET', url: `/v1/auth/verify-email?token=${token}` });

    expect(res.statusCode).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmail).toHaveBeenCalledWith(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      'verifyme@example.com',
    );

    const [user] = await app.db
      .select({ emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.email, 'verifyme@example.com'));
    expect(user?.emailVerified).toBe(true);
  });

  it('an invalid or expired verification token never triggers the welcome email', async () => {
    vi.mocked(sendWelcomeEmail).mockClear();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/verify-email?token=not-a-real-token',
    });

    expect(res.statusCode).toBe(400);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('a brand-new Google device-login signup sends the welcome email immediately (no separate verification step)', async () => {
    vi.mocked(sendWelcomeEmail).mockClear();
    const email = `newgoogleuser-${randomUUID()}@example.com`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/google',
      payload: {
        idToken: await googleIdToken({ email }),
        deviceId: randomUUID(),
        deviceName: 'Test Device',
        platform: 'mobile',
      },
      remoteAddress: '198.51.100.1',
    });

    expect(res.statusCode).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmail).toHaveBeenCalledWith(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      email,
    );

    const [user] = await app.db
      .select({ emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    expect(user?.emailVerified).toBe(true);
  });

  it('a repeat Google device-login for the same account does not resend the welcome email', async () => {
    const email = `repeatgoogleuser-${randomUUID()}@example.com`;
    const sub = randomUUID();

    await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/google',
      payload: {
        idToken: await googleIdToken({ email, sub }),
        deviceId: randomUUID(),
        deviceName: 'Test Device',
        platform: 'mobile',
      },
      remoteAddress: '198.51.100.2',
    });
    vi.mocked(sendWelcomeEmail).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/google',
      payload: {
        idToken: await googleIdToken({ email, sub }),
        deviceId: randomUUID(),
        deviceName: 'Test Device 2',
        platform: 'mobile',
      },
      remoteAddress: '198.51.100.3',
    });

    expect(res.statusCode).toBe(200);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });
});
