import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('credits', () => {
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

  async function registerUser(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Credits User', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return {
      token: login.json().accessToken,
      userId: JSON.parse(atob(login.json().accessToken.split('.')[1])).sub,
    };
  }

  it('GET /v1/credits returns balance + ledger', async () => {
    const { token, userId } = await registerUser('credits@x.com');
    await app.db
      .update(schema.userCredits)
      .set({ balance: 7 })
      .where(eq(schema.userCredits.userId, userId));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe(7);
  });

  it('GET /v1/credits reports firstPurchaseBonusPercent: null for a non-attributed user', async () => {
    const { token } = await registerUser('no-campaign-credits@x.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPurchaseBonusPercent).toBeNull();
  });

  it('GET /v1/credits reports the campaign bonusPercent for an attributed user with no purchase yet', async () => {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: 'credits-badge-test',
        name: 'Credits Badge Test',
        bonusPercent: 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
      })
      .returning();

    const { token, userId } = await registerUser('campaign-credits@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPurchaseBonusPercent).toBe(25);
  });

  it('GET /v1/credits reports firstPurchaseBonusPercent: null once the user has a paid purchase', async () => {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: 'credits-badge-purchased-test',
        name: 'Credits Badge Purchased Test',
        bonusPercent: 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
      })
      .returning();

    const { token, userId } = await registerUser('campaign-credits-purchased@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));
    await app.db.insert(schema.payments).values({
      userId,
      planId: 'some-plan',
      razorpayOrderId: 'order_credits_badge_purchased',
      basePaise: 100000,
      gstPaise: 18000,
      totalPaise: 118000,
      credits: 500,
      status: 'paid',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPurchaseBonusPercent).toBeNull();
  });
});
