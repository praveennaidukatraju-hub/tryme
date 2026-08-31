import { schema as dbSchema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildServer } from '../../src/server';
import { type Containers, startContainers } from '../helpers/containers';

function decodeJwtPayload(token: string): { sub: string; [key: string]: unknown } {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('malformed JWT: missing payload segment');
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

function extractOtpFromLocation(location: string): string {
  const otp = new URL(location).searchParams.get('code');
  if (!otp) throw new Error('redirect location missing ?code= OTP');
  return otp;
}

async function buildGoogleApp(c: Containers) {
  const app = await buildServer({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: 0,
    DATABASE_URL: c.pgUrl,
    REDIS_URL: c.redisUrl,
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef-32min',
    JWT_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY: '7d',
    R2_ENDPOINT: c.r2Endpoint,
    R2_ACCESS_KEY_ID: c.r2Key,
    R2_SECRET_ACCESS_KEY: c.r2Secret,
    R2_BUCKET: c.r2Bucket,
    R2_PUBLIC_URL: `${c.r2Endpoint}/${c.r2Bucket}`,
    R2_FORCE_PATH_STYLE: true,
    CORS_ORIGIN: ['http://localhost:3000'],
    COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef-32min',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:4000/v1/auth/google/callback',
    WEB_URL: 'http://localhost:3000',
  });
  await app.listen({ port: 0 });
  return app;
}

describe('google oauth', () => {
  let c: Containers;
  let app: Awaited<ReturnType<typeof buildGoogleApp>>;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildGoogleApp(c);
    const passwordHash = await hashPassword('password123');
    const [adminUser] = await app.db
      .insert(dbSchema.users)
      .values({
        email: 'google-race-admin@example.com',
        displayName: 'Google Race Admin',
        passwordHash,
        emailVerified: true,
      })
      .returning({ id: dbSchema.users.id });
    if (!adminUser) throw new Error('failed to seed Google race admin');
    await app.db.insert(dbSchema.adminUsers).values({
      userId: adminUser.id,
      role: 'SUPER_ADMIN',
      passwordHash,
    });
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'google-race-admin@example.com', password: 'password123' },
    });
    adminToken = adminLogin.json<{ accessToken: string }>().accessToken;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  afterEach(() => vi.restoreAllMocks());

  it('GET /v1/auth/google/init redirects to Google with state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/google/init' });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('client_id=test-google-client-id');
    expect(location).toContain('scope=openid+email+profile');
    const cookieHeader = res.headers['set-cookie'];
    expect(cookieHeader).toBeTruthy();
    const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
    expect(cookies.some((c: string) => c.startsWith('google_state='))).toBe(true);
  });

  it('GET /v1/auth/google/init without src clears a stale campaign source cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/init',
      headers: { cookie: 'google_src=gartex2026' },
    });

    expect(res.statusCode).toBe(302);
    const cookieHeader = res.headers['set-cookie'];
    const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
    const clearedSrc = cookies.find((cookie) => cookie.startsWith('google_src=;'));
    expect(clearedSrc).toBeTruthy();
    expect(clearedSrc).toContain('Max-Age=0');
    expect(clearedSrc).toContain('Path=/v1/auth/google');
  });

  it('POST /v1/auth/google/exchange with valid OTP returns accessToken', async () => {
    // Create a user to get a real userId
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'OTP Test',
        email: 'otp-test@example.com',
        password: 'password123',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const [user] = await app.db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.email, 'otp-test@example.com'));
    if (!user) throw new Error('user not found');
    await app.db
      .update(dbSchema.users)
      .set({ emailVerified: true })
      .where(eq(dbSchema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'otp-test@example.com', password: 'password123' },
    });
    const { accessToken: regToken } = login.json() as { accessToken: string };

    // Decode userId from JWT sub claim
    const userId = decodeJwtPayload(regToken).sub;

    // Seed OTP in Redis
    const otp = 'test-otp-1234';
    await app.redis.set(`oauth:otp:${otp}`, userId, 'EX', 60);

    // Exchange OTP
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessToken: expect.any(String) });

    // OTP must be consumed (cannot reuse)
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: otp },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toMatchObject({ error: { code: 'INVALID_OTP' } });
  });

  it('POST /v1/auth/google/exchange with expired/missing OTP returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/google/exchange',
      payload: { code: 'nonexistent-otp' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_OTP' } });
  });

  it('GET /v1/auth/google/callback upserts new user and redirects with OTP code', async () => {
    const state = 'test-csrf-state-abc123';
    const mockFetch = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-google-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-001',
            email: 'newgoogleuser@example.com',
            name: 'New Google User',
            picture: 'https://example.com/pic.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    };
    vi.spyOn(global, 'fetch').mockImplementation(mockFetch as typeof fetch);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=auth_code_123&state=${state}`,
      headers: { cookie: `google_state=${state}` },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('http://localhost:3000/api/auth/google/callback?code=');

    // Extract OTP and verify it exists in Redis
    const otp = extractOtpFromLocation(location);
    expect(otp).toBeTruthy();
    const storedUserId = await app.redis.get(`oauth:otp:${otp}`);
    expect(storedUserId).toBeTruthy();
  });

  it('GET /v1/auth/google/callback with mismatched state redirects to login with error reason', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=auth_code&state=wrong-state',
      headers: { cookie: 'google_state=correct-state' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('error=google_invalid_state');
  });

  it('GET /v1/auth/google/callback redirects to login with error reason when state cookie is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/callback?code=auth_code&state=some-state',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location as string).toContain('error=google_invalid_state');
  });

  it('GET /v1/auth/google/callback links Google to existing email/password account', async () => {
    // Register a user with email/password first
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Existing User',
        email: 'existing@example.com',
        password: 'password123',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const [user] = await app.db
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.email, 'existing@example.com'));
    if (!user) throw new Error('user not found');
    await app.db
      .update(dbSchema.users)
      .set({ emailVerified: true })
      .where(eq(dbSchema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'existing@example.com', password: 'password123' },
    });

    const state = 'link-test-state-xyz';
    const mockFetchLink = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-google-token-link' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-link-002',
            email: 'existing@example.com', // same email as registered user
            name: 'Existing User',
            picture: 'https://example.com/pic2.jpg',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    };
    vi.spyOn(global, 'fetch').mockImplementation(mockFetchLink as typeof fetch);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=link_code_456&state=${state}`,
      headers: { cookie: `google_state=${state}` },
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('http://localhost:3000/api/auth/google/callback?code=');

    // Only one user should exist for this email
    const otp = extractOtpFromLocation(location);

    // Exchange the OTP to get the real userId
    const linkedUserId = await app.redis.get(`oauth:otp:${otp}`);
    expect(linkedUserId).toBeTruthy();

    // Verify the oauth_accounts row links to the ORIGINAL registered user (not a new user)
    const regToken = login.json<{ accessToken: string }>().accessToken;
    const originalUserId = decodeJwtPayload(regToken).sub;

    const links = await app.db
      .select({ userId: dbSchema.oauthAccounts.userId })
      .from(dbSchema.oauthAccounts)
      .where(
        and(
          eq(dbSchema.oauthAccounts.provider, 'google'),
          eq(dbSchema.oauthAccounts.providerId, 'google-sub-link-002'),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0]?.userId).toBe(originalUserId);
  });

  it('attributes a brand-new Google signup to the campaign when ?src= is threaded through init -> callback', async () => {
    const now = new Date();
    await app.db.insert(dbSchema.signupCampaigns).values({
      code: 'gartex2026',
      name: 'Gartex Expo Delhi 2026',
      bonusPercent: 25,
      startAt: new Date(now.getTime() - 86_400_000),
      endAt: new Date(now.getTime() + 86_400_000),
      isActive: true,
    });

    const initRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/init?src=gartex2026',
    });
    expect(initRes.statusCode).toBe(302);
    const initCookies = Array.isArray(initRes.headers['set-cookie'])
      ? initRes.headers['set-cookie']
      : [initRes.headers['set-cookie'] as string];
    const stateCookie = initCookies.find((c) => c.startsWith('google_state='));
    const srcCookie = initCookies.find((c) => c.startsWith('google_src='));
    expect(srcCookie).toBeTruthy();
    const state = stateCookie?.split(';')[0]?.split('=')[1];
    const encodedSrc = srcCookie?.split(';')[0]?.split('=')[1];

    const mockFetch = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-campaign-001',
            email: 'gartex-google-user@example.com',
            name: 'Gartex Google User',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    };
    vi.spyOn(global, 'fetch').mockImplementation(mockFetch as typeof fetch);

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=auth_code_campaign&state=${state}`,
      headers: { cookie: `google_state=${state}; google_src=${encodedSrc}` },
    });
    expect(callbackRes.statusCode).toBe(302);

    const [user] = await app.db
      .select({ id: dbSchema.users.id, signupCampaignId: dbSchema.users.signupCampaignId })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.email, 'gartex-google-user@example.com'));
    expect(user).toBeTruthy();
    expect(user?.signupCampaignId).toBeTruthy();

    const [campaign] = await app.db
      .select()
      .from(dbSchema.signupCampaigns)
      .where(eq(dbSchema.signupCampaigns.code, 'gartex2026'));
    expect(user?.signupCampaignId).toBe(campaign?.id);
  });

  it('serializes new Google campaign attribution with admin deletion', async () => {
    const now = new Date();
    const [campaign] = await app.db
      .insert(dbSchema.signupCampaigns)
      .values({
        code: 'google-signup-delete-race',
        name: 'Google Signup Delete Race',
        bonusPercent: 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
      })
      .returning();
    if (!campaign) throw new Error('failed to seed Google race campaign');

    await app.db
      .update(dbSchema.creditPlans)
      .set({ credits: 100, isActive: true })
      .where(eq(dbSchema.creditPlans.slug, 'free'));

    const initRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/init?src=google-signup-delete-race',
    });
    const initCookies = Array.isArray(initRes.headers['set-cookie'])
      ? initRes.headers['set-cookie']
      : [initRes.headers['set-cookie'] as string];
    const state = initCookies
      .find((cookie) => cookie.startsWith('google_state='))
      ?.split(';')[0]
      ?.split('=')[1];
    const encodedSrc = initCookies
      .find((cookie) => cookie.startsWith('google_src='))
      ?.split(';')[0]
      ?.split('=')[1];
    if (!state || !encodedSrc)
      throw new Error('Google init did not return state and source cookies');

    vi.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'google-race-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlString.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-delete-race',
            email: 'google-delete-race-user@example.com',
            name: 'Google Delete Race User',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch to: ${urlString}`);
    });

    const blocker = postgres(c.pgUrl, { max: 1 });
    const observer = postgres(c.pgUrl, { max: 1 });
    let callback!: ReturnType<typeof app.inject>;
    let deleting!: ReturnType<typeof app.inject>;
    let deleteCompleted = false;
    let deleteCompletedBeforeSignupCouldCommit = false;

    try {
      await blocker.begin(async (tx) => {
        await tx`lock table users in share mode`;
        callback = app.inject({
          method: 'GET',
          url: `/v1/auth/google/callback?code=google_race_code&state=${state}`,
          headers: { cookie: `google_state=${state}; google_src=${encodedSrc}` },
        });

        const insertDeadline = Date.now() + 5_000;
        while (true) {
          const [waitingInsert] = await observer`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like 'insert into "users"%'
            limit 1
          `;
          if (waitingInsert) break;
          if (Date.now() >= insertDeadline) {
            throw new Error('Google signup did not reach the user insert');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        deleting = app.inject({
          method: 'DELETE',
          url: `/admin/signup-campaigns/${campaign.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        void deleting.then(() => {
          deleteCompleted = true;
        });

        const deleteDeadline = Date.now() + 5_000;
        while (!deleteCompleted) {
          const [waitingDelete] = await observer`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%signup_campaigns%'
            limit 1
          `;
          if (waitingDelete) break;
          if (Date.now() >= deleteDeadline) {
            throw new Error('delete neither completed nor waited for the campaign lock');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        deleteCompletedBeforeSignupCouldCommit = deleteCompleted;
      });

      const [callbackResponse, deleteResponse] = await Promise.all([callback, deleting]);
      expect(deleteCompletedBeforeSignupCouldCommit).toBe(false);
      expect(callbackResponse.statusCode).toBe(302);
      expect(deleteResponse.statusCode).toBe(409);

      const [user] = await app.db
        .select({
          id: dbSchema.users.id,
          signupCampaignId: dbSchema.users.signupCampaignId,
        })
        .from(dbSchema.users)
        .where(eq(dbSchema.users.email, 'google-delete-race-user@example.com'));
      expect(user?.signupCampaignId).toBe(campaign.id);

      const [credits] = await app.db
        .select({ balance: dbSchema.userCredits.balance })
        .from(dbSchema.userCredits)
        .where(eq(dbSchema.userCredits.userId, user?.id));
      expect(credits?.balance).toBe(125);
    } finally {
      await blocker.end();
      await observer.end();
    }
  }, 15_000);
});
