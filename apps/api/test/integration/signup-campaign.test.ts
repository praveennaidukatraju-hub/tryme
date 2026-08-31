import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('signup campaign attribution — register', () => {
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

  async function seedCampaign(overrides: Partial<typeof schema.signupCampaigns.$inferInsert> = {}) {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: 'gartex2026',
        name: 'Gartex Expo Delhi 2026',
        bonusPercent: 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
        ...overrides,
      })
      .returning();
    return campaign;
  }

  it('attributes a new user to the campaign when signupSource matches an active, in-window code', async () => {
    const campaign = await seedCampaign({ code: 'attr-test-1' });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'QR User',
        email: 'qr-user-1@x.com',
        password: 'password123',
        signupSource: 'attr-test-1',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'qr-user-1@x.com'));
    expect(user?.signupCampaignId).toBe(campaign?.id);
  });

  it('leaves signupCampaignId null for an unknown code (no error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'No Campaign User',
        email: 'no-campaign@x.com',
        password: 'password123',
        signupSource: 'not-a-real-code',
      },
    });
    expect(res.statusCode).toBe(201);

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'no-campaign@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null for a code outside its date window', async () => {
    const now = new Date();
    await seedCampaign({
      code: 'expired-test',
      startAt: new Date(now.getTime() - 2 * 86_400_000),
      endAt: new Date(now.getTime() - 86_400_000), // ended yesterday
    });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Late User',
        email: 'late-user@x.com',
        password: 'password123',
        signupSource: 'expired-test',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'late-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null for an inactive campaign', async () => {
    await seedCampaign({ code: 'inactive-test', isActive: false });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Inactive User',
        email: 'inactive-user@x.com',
        password: 'password123',
        signupSource: 'inactive-test',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'inactive-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null when no signupSource is sent at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Plain User',
        email: 'plain-user@x.com',
        password: 'password123',
      },
    });
    expect(res.statusCode).toBe(201);

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'plain-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('boosts the FREE_TRIAL grant by bonusPercent when the user completed profile is campaign-attributed', async () => {
    // Free plan must actually grant something for the boost to be observable.
    await app.db
      .update(schema.creditPlans)
      .set({ credits: 100 })
      .where(eq(schema.creditPlans.slug, 'free'));

    const campaign = await seedCampaign({ code: 'boost-test', bonusPercent: 25 });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Boosted User',
        email: 'boosted-user@x.com',
        password: 'password123',
        signupSource: 'boost-test',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'boosted-user@x.com'));
    expect(user?.signupCampaignId).toBe(campaign?.id);

    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user?.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'boosted-user@x.com', password: 'password123' },
    });
    const { accessToken } = login.json() as { accessToken: string };

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543210' }, // email already set at register â€” this completes the profile
    });
    expect(res.statusCode).toBe(200);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user?.id));
    expect(credits?.balance).toBe(125); // 100 base * 1.25

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, user?.id));
    expect(ledger.some((l) => l.delta === 125 && l.reason === 'FREE_TRIAL')).toBe(true);
  });

  it('grants the plain (non-boosted) FREE_TRIAL amount for a non-attributed user', async () => {
    await app.db
      .update(schema.creditPlans)
      .set({ credits: 100 })
      .where(eq(schema.creditPlans.slug, 'free'));

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Plain Trial User',
        email: 'plain-trial@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'plain-trial@x.com'));

    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user?.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'plain-trial@x.com', password: 'password123' },
    });
    const { accessToken } = login.json() as { accessToken: string };

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543211' },
    });

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user?.id));
    expect(credits?.balance).toBe(100); // unboosted
  });
});
