import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/auth/service.js';
import { createSessionTokens } from '../../src/modules/auth/tokens.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

function parseCookie(header: string | string[] | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const cookies = Array.isArray(header) ? header : [header];
  for (const c of cookies) {
    const m = c.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

describe('auth', () => {
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

  async function registerAndLogin(email: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash, emailVerified: true })
      .returning({ id: schema.users.id });
    let refreshPlain = '';
    const reply = {
      setCookie(name: string, value: string) {
        if (name === 'refresh') refreshPlain = value;
      },
      code() {
        return reply;
      },
    } as const;
    const { accessToken } = await createSessionTokens(app, user.id, reply as never, 200);
    return { accessToken, refreshPlain };
  }

  async function createVerifiedUser(email: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash, emailVerified: true })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not found');
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    let refreshPlain = '';
    const reply = {
      setCookie(name: string, value: string) {
        if (name === 'refresh') refreshPlain = value;
      },
      code() {
        return reply;
      },
    } as const;
    const { accessToken } = await createSessionTokens(app, user.id, reply as never, 200);
    expect(refreshPlain).toBeTruthy();
    return { accessToken, userId: user.id };
  }

  it('registers a user and returns tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Alice A', email: 'a@b.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ requiresEmailVerification: true });

    const [user] = await app.db
      .select({ emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.email, 'a@b.com'));
    expect(user?.emailVerified).toBe(false);
  });

  it('PATCH /v1/me accepts phone-only profile completion and grants free credits once', async () => {
    const { accessToken, userId } = await createVerifiedUser('profile@x.com');
    const trialCredits = 100;

    await app.db
      .update(schema.creditPlans)
      .set({ credits: trialCredits })
      .where(eq(schema.creditPlans.slug, 'free'));

    const first = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543210', companyName: null },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      phone: '9876543210',
      companyName: null,
    });

    const [creditRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(creditRow?.balance).toBe(trialCredits);

    const ledgerRows = await app.db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledgerRows.length).toBeGreaterThan(0);

    const second = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { companyName: 'Acme' },
    });
    expect(second.statusCode).toBe(200);

    const freeTrialRows = await app.db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(freeTrialRows.length).toBe(1);
  });

  it('PATCH /v1/me blocks duplicate phone numbers with a clear error', async () => {
    const owner = await createVerifiedUser('owner@x.com');
    const blocked = await createVerifiedUser('blocked@x.com');

    const ownerSave = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { phone: '9123456780', companyName: null },
    });
    expect(ownerSave.statusCode).toBe(200);

    const conflict = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${blocked.accessToken}` },
      payload: { phone: '9123456780', companyName: null },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: {
        code: 'PHONE_TAKEN',
        message:
          'This mobile number is already assigned to another email address. Use a different number.',
      },
    });
  });

  it('rejects duplicate email with 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Dup One', email: 'dup@x.com', password: 'password123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Dup Two', email: 'dup@x.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects signup without full name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'anon@x.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('issues a session token for verified users and rejects wrong passwords at the verifier level', async () => {
    const { accessToken } = await createVerifiedUser('login@x.com');
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    const passwordHash = await hashPassword('password123');
    expect(await verifyPassword(passwordHash, 'wrong')).toBe(false);
  });

  it('concurrent refresh: one rotation, others reissue, all 200', async () => {
    const { refreshPlain } = await registerAndLogin('concurrent@x.com');
    expect(refreshPlain).toBeTruthy();

    const reqs = Array.from({ length: 5 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { Cookie: `refresh=${refreshPlain}` },
      }),
    );
    const responses = await Promise.all(reqs);

    const rotated = responses.filter((r) => r.statusCode === 200 && r.headers['set-cookie']);
    const reissued = responses.filter((r) => r.statusCode === 200 && !r.headers['set-cookie']);
    const failed = responses.filter((r) => r.statusCode !== 200);

    expect(rotated.length).toBe(1);
    expect(reissued.length).toBe(4);
    expect(failed.length).toBe(0);
  });

  it('replay after delay still reissues while successor exists', async () => {
    const { refreshPlain } = await registerAndLogin('replay@x.com');
    expect(refreshPlain).toBeTruthy();

    // First refresh rotates G1 -> G2
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain}` },
    });
    expect(first.statusCode).toBe(200);

    // Wait longer than the original test's grace window. Current refresh logic
    // still reissues while a live successor exists.
    await new Promise((r) => setTimeout(r, 3_500));

    // Reuse G1
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain}` },
    });
    expect(replay.statusCode).toBe(200);

    // G2 should still be valid (family NOT revoked)
    const refreshPlain2 = parseCookie(first.headers['set-cookie'], 'refresh');
    expect(refreshPlain2).toBeTruthy();
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain2}` },
    });
    expect(second.statusCode).toBe(200);
  });

  it('logout revokes entire family', async () => {
    const { accessToken, refreshPlain } = await registerAndLogin('logout@x.com');
    expect(refreshPlain).toBeTruthy();

    // Rotate to G2
    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain}` },
    });
    expect(rotated.statusCode).toBe(200);
    const refreshPlain2 = parseCookie(rotated.headers['set-cookie'], 'refresh');

    // Logout with G2
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        Cookie: `refresh=${refreshPlain2}`,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(logout.statusCode).toBe(200);

    // G2 refresh should now fail
    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain2}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('grace window reissue: immediate reuse of just-used token succeeds', async () => {
    const { refreshPlain } = await registerAndLogin('grace@x.com');
    expect(refreshPlain).toBeTruthy();

    // First refresh rotates G1 -> G2.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain}` },
    });
    expect(first.statusCode).toBe(200);

    // Immediate reuse of G1 within grace window should succeed via successor lookup.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { Cookie: `refresh=${refreshPlain}` },
    });
    expect(second.statusCode).toBe(200);
  });
});
