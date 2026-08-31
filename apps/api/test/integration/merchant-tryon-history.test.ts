import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedJob(
  app: TestApp,
  opts: {
    merchantId: string;
    userId: string;
    customerPhotoKey: string;
    status: string;
    createdAt: string;
  },
) {
  await app.db.insert(schema.jobs).values({
    merchantId: opts.merchantId,
    userId: opts.userId,
    customerPhotoKey: opts.customerPhotoKey,
    status: opts.status,
    createdAt: new Date(opts.createdAt),
  });
}

describe('merchant try-on history', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('counts distinct input photos separately from completed (generated) jobs, and omits empty days', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-a@example.com');
    const auth = await authHeader(merchantUser.id);

    // 2026-08-19: three completed jobs reuse the same photo (P1); one job uses
    // a different photo (P2) and fails. inputCount=2 (P1,P2), generatedCount=3
    // (three P1 completions), failedCount=1 — generatedCount exceeds inputCount,
    // the divergence this endpoint exists to expose.
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p1.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-19T09:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p1.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-19T10:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p2.jpg',
      status: 'FAILED',
      createdAt: '2026-08-19T11:00:00.000Z',
    });
    // A third completion reusing photo P1 — generatedCount (3) now exceeds
    // inputCount (2, distinct photos P1+P2), demonstrating the divergence
    // this endpoint exists to expose (one photo, multiple garment try-ons).
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p1.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-19T12:00:00.000Z',
    });

    // 2026-08-20: one queued job, not yet completed or failed.
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p3.jpg',
      status: 'QUEUED',
      createdAt: '2026-08-20T08:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: Array<{
        date: string;
        inputCount: number;
        generatedCount: number;
        failedCount: number;
      }>;
      nextCursor: string | null;
    };

    expect(body.days).toEqual([
      { date: '2026-08-20', inputCount: 1, generatedCount: 0, failedCount: 0 },
      { date: '2026-08-19', inputCount: 2, generatedCount: 3, failedCount: 1 },
    ]);
    expect(body.nextCursor).toBeNull();
    // The headline behavior this endpoint exists to expose: one reused photo
    // can produce more completed (generated) jobs than distinct input photos.
    expect(body.days[1].generatedCount).toBeGreaterThan(body.days[1].inputCount);
  });

  it("never leaks another merchant's jobs into the response", async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-b@example.com');
    const { merchant: otherMerchant, merchantUser: otherUser } = await createMerchant(
      app,
      'history-c@example.com',
    );
    const auth = await authHeader(merchantUser.id);

    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/mine.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-18T09:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: otherMerchant.id,
      userId: otherUser.id,
      customerPhotoKey: 'merchant-inputs/theirs.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-18T09:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    const body = res.json() as {
      days: Array<{
        date: string;
        inputCount: number;
        generatedCount: number;
        failedCount: number;
      }>;
    };
    // Only this merchant's one distinct photo — the other merchant's job must not add to the count.
    expect(body.days).toEqual([
      { date: '2026-08-18', inputCount: 1, generatedCount: 1, failedCount: 0 },
    ]);
  });

  it('paginates with the before cursor, oldest page has nextCursor null', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-d@example.com');
    const auth = await authHeader(merchantUser.id);

    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      await seedJob(app, {
        merchantId: merchant.id,
        userId: merchantUser.id,
        customerPhotoKey: `merchant-inputs/${date}.jpg`,
        status: 'COMPLETED',
        createdAt: `${date}T09:00:00.000Z`,
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?limit=2',
      headers: auth,
    });
    const body1 = page1.json() as { days: Array<{ date: string }>; nextCursor: string | null };
    expect(body1.days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-02']);
    expect(body1.nextCursor).toBe('2026-08-02');

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/history?limit=2&before=${body1.nextCursor}`,
      headers: auth,
    });
    const body2 = page2.json() as { days: Array<{ date: string }>; nextCursor: string | null };
    expect(body2.days.map((d) => d.date)).toEqual(['2026-08-01']);
    expect(body2.nextCursor).toBeNull();
  });

  it('returns an empty history for a merchant with no jobs, and rejects an out-of-range limit and a malformed before cursor with 400', async () => {
    const { merchantUser } = await createMerchant(app, 'history-e@example.com');
    const auth = await authHeader(merchantUser.id);

    const empty = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ days: [], nextCursor: null });

    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?limit=200',
      headers: auth,
    });
    expect(badLimit.statusCode).toBe(400);

    const badBefore = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?before=not-a-date',
      headers: auth,
    });
    expect(badBefore.statusCode).toBe(400);
  });
});
