import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGoogleKeyGetterForTests } from '../src/modules/auth/google-id-token.js';
import { signAccess } from '../src/modules/auth/service.js';
import { adminAuthHeader } from './helpers/admin.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

const GOOGLE_AUD = 'web-client.apps.googleusercontent.com';
let googlePrivateKey: CryptoKey;

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { GOOGLE_CLIENT_ID: GOOGLE_AUD });

  const pair = await generateKeyPair('RS256');
  googlePrivateKey = pair.privateKey;
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

// Represents a real device-app session (Android app: password device-login,
// force-login, or Google device-login all mint this audience uniformly).
async function tokenFor(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'device',
  );
}

// Represents a plain web-browser session (password login or web Google OAuth) —
// no audience claim, exactly as createSessionTokens(..., 'web') mints it.
async function webTokenFor(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function createGoogleUser(displayName: string | null = 'Google Person') {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `onb-${randomUUID()}@example.com`,
      displayName,
      passwordHash: null,
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { userId: user.id, token: await tokenFor(user.id) };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /v1/merchant/onboarding', () => {
  it('reports ONBOARDING_REQUIRED with a prefill before onboarding', async () => {
    const { token } = await createGoogleUser('Prefill Person');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merchantStatus: 'ONBOARDING_REQUIRED',
      prefill: { contactName: 'Prefill Person', companyName: 'Prefill Person', phone: '' },
    });
  });

  it('reports ACTIVE once a merchant exists', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(await tokenFor(merchant.userId)),
    });
    expect(res.json().merchantStatus).toBe('ACTIVE');
  });

  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/merchant/onboarding' });
    expect(res.statusCode).toBe(401);
  });

  it('401s for a plain web session (no device audience)', async () => {
    const { userId } = await createGoogleUser('Web Session Person');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(await webTokenFor(userId)),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/merchant/onboarding', () => {
  it('creates an active merchant from the phone number alone', async () => {
    const { userId, token } = await createGoogleUser('Only Name');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9876543210' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().merchantStatus).toBe('ACTIVE');

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    expect(merchant).toMatchObject({
      contactName: 'Only Name',
      companyName: 'Only Name',
      businessAddress: 'Not Provided',
      phone: '9876543210',
      isActive: true,
      demoData: false,
      signupSource: 'android_google',
    });

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.phone).toBe('9876543210');
  });

  it('grants no credits on merchant onboarding — the user already has their signup free trial', async () => {
    const { userId, token } = await createGoogleUser('No Credits Person');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9876500001' },
    });
    expect(res.statusCode).toBe(201);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));

    // Whatever the user had before onboarding is what they have after.
    expect(credits?.balance ?? 0).toBe(0);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.filter((r) => r.reason === 'FREE_TRIAL')).toHaveLength(0);
  });

  it('uses all four supplied fields when given', async () => {
    const { userId, token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: {
        phone: '9000000001',
        contactName: 'Real Contact',
        companyName: 'Real Shop',
        businessAddress: '1 Real Street',
      },
    });

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    expect(merchant).toMatchObject({
      contactName: 'Real Contact',
      companyName: 'Real Shop',
      businessAddress: '1 Real Street',
    });
  });

  it('unblocks requireMerchant immediately', async () => {
    const { token } = await createGoogleUser();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: auth(token),
    });
    expect(before.statusCode).toBe(403);

    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000002' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: auth(token),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().items).toEqual([]);
  });

  it('409s on a second submit', async () => {
    const { token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000003' },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000003' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('409s for an admin-created merchant and leaves signupSource as admin', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(await tokenFor(merchant.userId)),
      payload: { phone: '9000000004' },
    });
    expect(res.statusCode).toBe(409);

    const [row] = await app.db
      .select({ signupSource: schema.merchants.signupSource })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchant.merchantId));
    expect(row?.signupSource).toBe('admin');
  });

  it('rejects an arbitrary signup source at the database boundary', async () => {
    const { userId } = await createGoogleUser();

    await expect(
      app.db.insert(schema.merchants).values({
        companyName: 'Invalid Source Shop',
        contactName: 'Invalid Source Person',
        phone: '9000000005',
        businessAddress: '1 Constraint Street',
        signupSource: 'unapproved' as never,
        userId,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('400s on a missing or malformed phone number', async () => {
    const { token } = await createGoogleUser();
    for (const payload of [{}, { phone: '123' }, { phone: 'not-a-number' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/merchant/onboarding',
        headers: auth(token),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('401s for a plain web session (no device audience)', async () => {
    const { userId } = await createGoogleUser('Web Session Person');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(await webTokenFor(userId)),
      payload: { phone: '9000000007' },
    });
    expect(res.statusCode).toBe(401);

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    expect(merchant).toBeUndefined();
  });
});

describe('device-session boundary (end-to-end)', () => {
  it('a real device-login/google session can reach onboarding', async () => {
    const email = `real-google-${randomUUID()}@example.com`;
    const idToken = await new SignJWT({
      sub: randomUUID(),
      email,
      email_verified: true,
      name: 'Real Google Person',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer('https://accounts.google.com')
      .setAudience(GOOGLE_AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(googlePrivateKey);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/google',
      payload: { idToken, deviceId: randomUUID(), platform: 'mobile' },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = loginRes.json();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('ONBOARDING_REQUIRED');
  });

  it('a real plain web login cannot reach onboarding', async () => {
    const email = `real-web-${randomUUID()}@example.com`;
    const password = 'correct-horse-battery-1';
    const registerRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password, displayName: 'Real Web Person' },
    });
    expect(registerRes.statusCode).toBe(201);
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, email));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { accessToken } = loginRes.json();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/merchants signupSource', () => {
  it('reports android_google for a self-serve signup and admin for the rest', async () => {
    const adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const seeded = await createTestMerchant(app, { isActive: true });
    const { token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000005' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/merchants',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);

    const rows = res.json().clients as Array<{ id: string; signupSource: string }>;
    expect(rows.find((row) => row.id === seeded.merchantId)?.signupSource).toBe('admin');
    expect(rows.some((row) => row.signupSource === 'android_google')).toBe(true);
  });
});

describe('GET /admin/users signupSource', () => {
  it('reports a merchant user signup source', async () => {
    const adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const seeded = await createTestMerchant(app, { isActive: true });
    const selfServe = await createGoogleUser();
    const nonMerchant = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(selfServe.token),
      payload: { phone: '9000000006' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);

    const rows = res.json().items as Array<{ id: string; signupSource: string | null }>;
    expect(rows.find((row) => row.id === seeded.userId)?.signupSource).toBe('admin');
    expect(rows.find((row) => row.id === selfServe.userId)?.signupSource).toBe('android_google');
    expect(rows.find((row) => row.id === nonMerchant.userId)?.signupSource).toBeNull();
  });
});

describe('merchant demoData defaults and admin toggle', () => {
  it('defaults admin-created merchants to demoData=false and lets admins enable it', async () => {
    const adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const email = `merchant-demo-data-${randomUUID()}@example.com`;

    const created = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: adminHeaders,
      payload: {
        email,
        companyName: 'Demo Data Merchant',
        contactName: 'Demo Owner',
        phone: '9000000007',
        businessAddress: '7 Demo Street',
      },
    });
    expect(created.statusCode).toBe(201);
    const merchantId = created.json().id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/merchants/${merchantId}`,
      headers: adminHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().demoData).toBe(false);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchantId}`,
      headers: adminHeaders,
      payload: { demoData: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().demoData).toBe(true);
  });
});

describe('demo catalog auto-assignment on demoData', () => {
  async function seedActiveDemoSet() {
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `demo-assign-gt-${randomUUID()}`,
        label: 'Demo Assign Garment Type',
        isActive: true,
      })
      .returning();
    if (!gt) throw new Error('failed to seed garment type');
    const [set] = await app.db
      .insert(schema.demoCatalogSets)
      .values({ name: `Auto Assign Set ${randomUUID()}`, isActive: true })
      .returning();
    if (!set) throw new Error('failed to seed demo set');
    const [sub] = await app.db
      .insert(schema.demoCatalogSubcategories)
      .values({
        setId: set.id,
        category: 'women',
        name: 'Auto Assign Sub',
        garmentSubcategoryId: gt.id,
      })
      .returning();
    if (!sub) throw new Error('failed to seed demo subcategory');
    return { subcategoryId: sub.id };
  }

  // Nothing writes to demoCatalogAssignments except this auto-assign path (the
  // per-set assignment UI was removed — apps/admin-web's Kiosk Demo Data page
  // only ever has one universal set). Without it, no merchant could ever see
  // demo data regardless of the demoData toggle.
  it('PATCHing demoData to true auto-assigns the merchant to the active demo set', async () => {
    const adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const merchant = await createTestMerchant(app, { demoData: false });
    const demo = await seedActiveDemoSet();
    const token = await webTokenFor(merchant.userId);

    const before = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth(token),
    });
    expect(
      before.json().items.find((s: { id: string }) => s.id === demo.subcategoryId),
    ).toBeUndefined();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/merchants/${merchant.merchantId}`,
      headers: adminHeaders,
      payload: { demoData: true },
    });
    expect(patched.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth(token),
    });
    expect(
      after.json().items.find((s: { id: string }) => s.id === demo.subcategoryId),
    ).toBeDefined();
  });

  it('a merchant created via POST /admin/merchants (demoData defaults false) is not auto-visible until enabled', async () => {
    const adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const demo = await seedActiveDemoSet();

    const created = await app.inject({
      method: 'POST',
      url: '/admin/merchants',
      headers: adminHeaders,
      payload: {
        email: `merchant-auto-assign-${randomUUID()}@example.com`,
        companyName: 'Auto Assign Co',
        contactName: 'Auto Owner',
        phone: '9000000008',
        businessAddress: '8 Auto Street',
      },
    });
    expect(created.statusCode).toBe(201);
    const merchantId = created.json().id as string;

    const [merchantRow] = await app.db
      .select({ userId: schema.merchants.userId })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));
    if (!merchantRow) throw new Error('merchant row not found');
    const token = await webTokenFor(merchantRow.userId);

    const subs = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth(token),
    });
    expect(
      subs.json().items.find((s: { id: string }) => s.id === demo.subcategoryId),
    ).toBeUndefined();
  });
});
