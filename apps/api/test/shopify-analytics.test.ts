import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyticsCards,
  analyticsDaily,
  analyticsFunnel,
  analyticsProducts,
} from '../src/modules/shopify/analytics.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { localDayStart } from '../src/modules/shopify/store-day.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const TZ = 'Asia/Kolkata'; // UTC+5:30 — a half-hour offset catches naive UTC math
let c: Containers;
let app: TestApp;
let storeId: string;
let otherStoreId: string;
let userId: string;
let token: string;

const range = {
  from: localDayStart(TZ, '2026-07-01'),
  to: localDayStart(TZ, '2026-07-08'),
  timezone: TZ,
};

async function seedShopper(store: string, clientId: string, email: string | null = null) {
  const [row] = await app.db
    .insert(schema.shopifyShoppers)
    .values({
      storeId: store,
      clientId,
      email,
      emailCapturedAt: email ? new Date('2026-07-02T10:00:00Z') : null,
    })
    .returning();
  return row.id;
}

async function seedJob(store: string, shopperId: string | null, at: string, productId?: number) {
  const jobId = randomUUID();
  await app.db.insert(schema.jobs).values({
    id: jobId,
    userId,
    shopifyStoreId: store,
    shopifyShopperId: shopperId,
    status: 'COMPLETED',
    source: 'shopify',
    createdAt: new Date(at),
  });
  if (productId != null) {
    await app.db.insert(schema.jobInputs).values({
      jobId,
      params: { kind: 'shopify', shopifyProductId: productId },
    });
  }
  return jobId;
}

async function seedEvent(
  store: string,
  type: string,
  clientId: string | null,
  at: string,
  productId?: number,
) {
  await app.db.insert(schema.shopifyWidgetEvents).values({
    storeId: store,
    type,
    clientId,
    shopifyProductId: productId ?? null,
    createdAt: new Date(at),
  });
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: 'test-secret',
    SHOPIFY_API_KEY: 'test-key',
  });

  const [user] = await app.db
    .insert(schema.users)
    .values({ email: `an-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
    .returning();
  userId = user.id;

  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 93,
      shopDomain: 'an.myshopify.com',
      myshopifyDomain: 'an.myshopify.com',
      name: 'AN',
      email: 'a@a.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  await app.db
    .update(schema.shopifyStores)
    .set({ ianaTimezone: TZ })
    .where(eq(schema.shopifyStores.id, storeId));
  token = signSessionToken('an.myshopify.com', 'test-secret', 'test-key');

  const other = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 94,
      shopDomain: 'ot.myshopify.com',
      myshopifyDomain: 'ot.myshopify.com',
      name: 'OT',
      email: 'o@o.com',
    },
    'tok',
    'read_products',
  );
  otherStoreId = other.id;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('analyticsCards', () => {
  it('counts try-ons, shoppers, add-to-carts and emails in range', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    const s1 = await seedShopper(storeId, c1, 'a@b.com');
    const s2 = await seedShopper(storeId, c2);

    await seedJob(storeId, s1, '2026-07-02T06:00:00Z');
    await seedJob(storeId, s1, '2026-07-03T06:00:00Z');
    await seedJob(storeId, s2, '2026-07-04T06:00:00Z');
    await seedJob(storeId, null, '2026-07-04T07:00:00Z'); // no shopper identity

    // Three clicks from one shopper is one converted shopper, not three.
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:00:00Z');
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:01:00Z');
    await seedEvent(storeId, 'add_to_cart', c1, '2026-07-02T07:02:00Z');

    await seedEvent(storeId, 'refused_store_cap', c2, '2026-07-05T06:00:00Z');
    await seedEvent(storeId, 'refused_email_gate', c2, '2026-07-05T06:01:00Z');

    const cards = await analyticsCards(app.db, storeId, range);

    expect(cards.tryOns).toBe(4);
    expect(cards.uniqueShoppers).toBe(2);
    expect(cards.addedToCart).toBe(1);
    expect(cards.emailsCaptured).toBe(1);
    // total = storeCap + shopperCap only; emailGate is a soft gate (shopper
    // typically submits their email and gets the try-on anyway) so it is
    // reported separately and excluded from the "turned away" total.
    expect(cards.turnedAway).toMatchObject({ total: 1, storeCap: 1, emailGate: 1, shopperCap: 0 });
    // Denominator is shoppers with an identity (2), not the try-on count (4).
    expect(cards.addToCartRate).toBeCloseTo(0.5, 5);
  });

  it('never counts another store', async () => {
    const c3 = randomUUID();
    const s3 = await seedShopper(otherStoreId, c3);
    await seedJob(otherStoreId, s3, '2026-07-02T06:00:00Z');
    await seedEvent(otherStoreId, 'add_to_cart', c3, '2026-07-02T07:00:00Z');

    const cards = await analyticsCards(app.db, storeId, range);
    expect(cards.tryOns).toBe(4);
    expect(cards.addedToCart).toBe(1);
  });

  it('excludes activity outside the range', async () => {
    const c4 = randomUUID();
    const s4 = await seedShopper(storeId, c4);
    await seedJob(storeId, s4, '2026-06-30T06:00:00Z');
    await seedJob(storeId, s4, '2026-07-20T06:00:00Z');

    const cards = await analyticsCards(app.db, storeId, range);
    expect(cards.tryOns).toBe(4);
  });
});

describe('analyticsDaily', () => {
  it('buckets by store-local day and zero-fills quiet days', async () => {
    const daily = await analyticsDaily(app.db, storeId, range);

    // 2026-07-01 .. 2026-07-07 inclusive — the range is half-open on `to`.
    expect(daily.map((d) => d.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
    ]);
    expect(daily.find((d) => d.day === '2026-07-01')?.tryOns).toBe(0);
    expect(daily.find((d) => d.day === '2026-07-04')?.tryOns).toBe(2);
  });

  it('assigns a job to the store-local day, not the UTC day', async () => {
    const c5 = randomUUID();
    const s5 = await seedShopper(storeId, c5);
    // 20:00 UTC on the 5th is 01:30 on the 6th in Asia/Kolkata.
    await seedJob(storeId, s5, '2026-07-05T20:00:00Z');

    const daily = await analyticsDaily(app.db, storeId, range);
    expect(daily.find((d) => d.day === '2026-07-06')?.tryOns).toBe(1);
    expect(daily.find((d) => d.day === '2026-07-05')?.tryOns).toBe(0);
  });
});

describe('analyticsFunnel', () => {
  it('counts distinct shoppers per step, not raw events', async () => {
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-03T06:00:00Z');

    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:00:00Z');
    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:01:00Z');
    await seedEvent(storeId, 'button_click', c, '2026-07-03T05:02:00Z');
    await seedEvent(storeId, 'upload', c, '2026-07-03T05:03:00Z');
    await seedEvent(storeId, 'result_view', c, '2026-07-03T06:05:00Z');

    const funnel = await analyticsFunnel(app.db, storeId, range);

    // One enthusiastic shopper clicking three times is one shopper.
    expect(funnel.buttonClick).toBe(1);
    expect(funnel.upload).toBe(1);
    expect(funnel.resultView).toBe(1);
  });

  it('reports try-ons with no client_id as unattributed rather than dropping them', async () => {
    const funnel = await analyticsFunnel(app.db, storeId, range);
    // Seeded in the cards suite: one job with a null shopper.
    expect(funnel.unattributed).toBeGreaterThanOrEqual(1);
  });

  it('does not clamp a step to the one above it', async () => {
    // A shopper whose event calls were blocked still generated a real try-on,
    // so tryOn can legitimately exceed buttonClick. Clamping would hide that
    // the client-side steps are lossy.
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-07T06:00:00Z');

    const funnel = await analyticsFunnel(app.db, storeId, range);
    expect(funnel.tryOn).toBeGreaterThan(funnel.buttonClick);
  });
});

describe('analyticsProducts', () => {
  it('aggregates try-ons and add-to-carts per product', async () => {
    const c = randomUUID();
    const s = await seedShopper(storeId, c);
    await seedJob(storeId, s, '2026-07-02T08:00:00Z', 777);
    await seedJob(storeId, s, '2026-07-02T09:00:00Z', 777);
    await seedJob(storeId, s, '2026-07-02T10:00:00Z', 888);
    await seedEvent(storeId, 'add_to_cart', c, '2026-07-02T11:00:00Z', 777);

    await app.db.insert(schema.shopifyProductGarments).values({
      storeId,
      shopifyProductId: 777,
      shopifyVariantId: null,
      r2Key: 'x/777.jpg',
      title: 'Blue Shirt',
      status: 'active',
      enabled: true,
    });

    const products = await analyticsProducts(app.db, storeId, range);

    const p777 = products.find((p) => p.shopifyProductId === 777);
    expect(p777).toMatchObject({
      title: 'Blue Shirt',
      tryOns: 2,
      uniqueShoppers: 1,
      addedToCart: 1,
    });
    expect(p777?.addToCartRate).toBeCloseTo(1, 5);

    // A product with no garment row still appears — it just has no title.
    const p888 = products.find((p) => p.shopifyProductId === 888);
    expect(p888).toMatchObject({ title: null, tryOns: 1, addedToCart: 0 });
  });

  it('orders by try-ons descending', async () => {
    const products = await analyticsProducts(app.db, storeId, range);
    for (let i = 1; i < products.length; i++) {
      expect(products[i - 1].tryOns).toBeGreaterThanOrEqual(products[i].tryOns);
    }
  });
});

describe('GET /v1/shopify/analytics', () => {
  function get(qs: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/shopify/analytics?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('returns every section for a valid range', async () => {
    const res = await get('from=2026-07-01&to=2026-07-07');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.range.timezone).toBe(TZ);
    expect(body.cards.tryOns).toBeGreaterThan(0);
    expect(body.daily).toHaveLength(7);
    expect(body.funnel).toHaveProperty('unattributed');
    expect(Array.isArray(body.products)).toBe(true);
  });

  it('includes the last day of the range', async () => {
    // `to` is inclusive to the merchant; the resolved instant is exclusive.
    const res = await get('from=2026-07-07&to=2026-07-07');
    expect(res.json().daily).toEqual([{ day: '2026-07-07', tryOns: expect.any(Number) }]);
  });

  it('rejects a reversed range', async () => {
    const res = await get('from=2026-07-08&to=2026-07-01');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a range longer than 400 days', async () => {
    // Beyond the events retention horizon the window is partly swept, which
    // would read as a traffic collapse rather than as missing data.
    const res = await get('from=2024-01-01&to=2026-07-07');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed date', async () => {
    const res = await get('from=July&to=2026-07-07');
    expect(res.statusCode).toBe(400);
  });
});
