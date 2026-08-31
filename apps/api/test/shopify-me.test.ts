import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 66,
      shopDomain: 'm.myshopify.com',
      myshopifyDomain: 'm.myshopify.com',
      name: 'M',
      email: 'm@m.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('m.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    {
      storeId,
      shopifyProductId: 1,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/1/garment.jpg`,
      status: 'active',
      enabled: true,
    },
    {
      storeId,
      shopifyProductId: 2,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/2/garment.jpg`,
      status: 'processing',
      enabled: false,
    },
    {
      storeId,
      shopifyProductId: 3,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/3/garment.jpg`,
      status: 'deleted',
      enabled: true,
    },
  ]);

  for (let i = 0; i < 3; i++) {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers userId as non-null; widget jobs legitimately have null userId
    await (app.db.insert(schema.jobs).values as any)({
      id: randomUUID(),
      userId: null,
      shopifyStoreId: storeId,
      status: 'COMPLETED',
      creditsCharged: 10,
    });
  }
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/me stats', () => {
  it('includes totalTryOns, syncedProductCount, enabledProductCount, statusCounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toEqual({
      totalTryOns: 3,
      syncedProductCount: 3,
      enabledProductCount: 1,
      statusCounts: { active: 1, processing: 0, failed: 0, disabled: 2 },
      todayTryOns: 3,
      storeDailyCap: null,
      capturedEmailCount: 0,
    });
  });

  it('no longer reports funnel state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).not.toHaveProperty('funnelConfigured');
    expect(res.json().stats).not.toHaveProperty('funnelCounts');
  });
});

describe('GET /v1/shopify/me creditBalance', () => {
  it('is 0 for a store with no shopify_store_credits row yet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().store).not.toHaveProperty('ownerUserId');
    expect(res.json().creditBalance).toBe(0);
  });

  it("reflects the store's own shopify_store_credits balance", async () => {
    await app.db.insert(schema.shopifyStoreCredits).values({ storeId, balance: 42 });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().creditBalance).toBe(42);
  });
});

describe('GET /v1/shopify/me store.connectedSince', () => {
  it("reflects the store's installedAt timestamp", async () => {
    const [store] = await app.db
      .select({ installedAt: schema.shopifyStores.installedAt })
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().store.connectedSince).toBe(store.installedAt.toISOString());
  });
});

describe('GET /v1/shopify/me stats — daily cap & captured emails', () => {
  it('reports today usage against the store cap and the captured email count', async () => {
    // Isolated store: the shared `storeId` already has 3 same-day jobs from this file's beforeAll,
    // which would make the brief's literal todayTryOns===1 assertion false.
    const testStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 999,
        shopDomain: 'test.myshopify.com',
        myshopifyDomain: 'test.myshopify.com',
        name: 'Test Store',
        email: 'test@test.com',
      },
      'tok',
      'read_products',
    );
    const testToken = signSessionToken('test.myshopify.com', API_SECRET, API_KEY);
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { limits: { storeDailyCap: 100 } } })
      .where(eq(schema.shopifyStores.id, testStore.id));
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId: testStore.id, clientId: 'c1', email: 'a@b.com' });
    await app.db.insert(schema.jobs).values({
      status: 'COMPLETED',
      shopifyStoreId: testStore.id,
      creditsCharged: 1,
      source: 'shopify',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${testToken}` },
    });
    const body = res.json();
    expect(body.stats.storeDailyCap).toBe(100);
    expect(body.stats.todayTryOns).toBe(1);
    expect(body.stats.capturedEmailCount).toBe(1);
  });
});

describe('GET /v1/shopify/me stats — enabledProductCount is activation-aware', () => {
  it('under global mode counts every non-deleted, non-excluded product regardless of individual `enabled`', async () => {
    const modeStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 1001,
        shopDomain: 'global-mode.myshopify.com',
        myshopifyDomain: 'global-mode.myshopify.com',
        name: 'Global Mode Store',
        email: 'gm@test.com',
      },
      'tok',
      'read_products',
    );
    const modeToken = signSessionToken('global-mode.myshopify.com', API_SECRET, API_KEY);

    await app.db.insert(schema.shopifyProductGarments).values([
      {
        storeId: modeStore.id,
        shopifyProductId: 10,
        shopifyVariantId: null,
        r2Key: `shopify-garments/${modeStore.id}/10/garment.jpg`,
        status: 'active',
        enabled: true,
      },
      {
        // Not individually enabled — under selective mode this should NOT
        // count; under global mode it SHOULD (global mode enables everything
        // except exclusions).
        storeId: modeStore.id,
        shopifyProductId: 11,
        shopifyVariantId: null,
        r2Key: `shopify-garments/${modeStore.id}/11/garment.jpg`,
        status: 'processing',
        enabled: false,
      },
      {
        // Individually excluded — exclusion always wins, even under global
        // mode, so this must never count in either mode.
        storeId: modeStore.id,
        shopifyProductId: 12,
        shopifyVariantId: null,
        r2Key: `shopify-garments/${modeStore.id}/12/garment.jpg`,
        status: 'active',
        enabled: true,
        excluded: true,
      },
      {
        // Deleted — never counts, regardless of mode.
        storeId: modeStore.id,
        shopifyProductId: 13,
        shopifyVariantId: null,
        r2Key: `shopify-garments/${modeStore.id}/13/garment.jpg`,
        status: 'deleted',
        enabled: true,
      },
    ]);

    const selectiveRes = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${modeToken}` },
    });
    expect(selectiveRes.json().stats.enabledProductCount).toBe(1);

    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { activation: { mode: 'global' } } })
      .where(eq(schema.shopifyStores.id, modeStore.id));

    const globalRes = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${modeToken}` },
    });
    expect(globalRes.json().stats.enabledProductCount).toBe(2);
  });
});
