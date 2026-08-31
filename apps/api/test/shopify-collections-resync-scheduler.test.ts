import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { startCollectionResyncScheduler } from '../src/modules/shopify/collections-resync-scheduler.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: 'test-secret',
    SHOPIFY_API_KEY: 'test-key',
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('startCollectionResyncScheduler', () => {
  it('enqueues one collection task per selected collection, across enabled and excluded, and skips stores with none selected', async () => {
    const storeWithSelections = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 901,
        shopDomain: 's1.myshopify.com',
        myshopifyDomain: 's1.myshopify.com',
        name: 'S1',
        email: 's1@s1.com',
      },
      'tok',
      'read_products',
    );
    const storeWithNone = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 902,
        shopDomain: 's2.myshopify.com',
        myshopifyDomain: 's2.myshopify.com',
        name: 'S2',
        email: 's2@s2.com',
      },
      'tok',
      'read_products',
    );
    await app.db.insert(schema.shopifyEnabledCollections).values({
      storeId: storeWithSelections.id,
      shopifyCollectionId: 10,
    });
    await app.db.insert(schema.shopifyExcludedCollections).values({
      storeId: storeWithSelections.id,
      shopifyCollectionId: 20,
    });

    const xaddSpy = vi.spyOn(app.redis, 'xadd');
    const stop = startCollectionResyncScheduler(app, 1_000_000); // large interval — we call the tick directly, not via timer
    stop(); // stop the timer immediately; we only want to test the tick logic itself

    // Re-import the tick function directly instead of waiting on setInterval:
    const mod = await import('../src/modules/shopify/collections-resync-scheduler.js');
    await mod.runResyncTick(app);

    const enqueuedTasks = xaddSpy.mock.calls
      .filter((call) => call[0] === 'shopify:sync')
      .map((call) => JSON.parse(call[3] as string));

    expect(
      enqueuedTasks.some(
        (t) =>
          t.storeId === storeWithSelections.id &&
          t.mode === 'collection' &&
          t.shopifyCollectionId === 10,
      ),
    ).toBe(true);
    expect(
      enqueuedTasks.some(
        (t) =>
          t.storeId === storeWithSelections.id &&
          t.mode === 'collection' &&
          t.shopifyCollectionId === 20,
      ),
    ).toBe(true);
    expect(enqueuedTasks.some((t) => t.storeId === storeWithNone.id)).toBe(false);

    xaddSpy.mockRestore();
  });
});

describe('syncOneTask — collection mode, deleted collection', () => {
  it('cleans up the selection and cached membership when Shopify confirms the collection is gone', async () => {
    const { syncOneTask } = await import('../src/modules/shopify/products.sync.js');
    const store = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 903,
        shopDomain: 's3.myshopify.com',
        myshopifyDomain: 's3.myshopify.com',
        name: 'S3',
        email: 's3@s3.com',
      },
      'tok',
      'read_products',
    );
    await app.db
      .insert(schema.shopifyEnabledCollections)
      .values({ storeId: store.id, shopifyCollectionId: 700 });
    await app.db
      .insert(schema.shopifyCollectionProducts)
      .values({ storeId: store.id, shopifyCollectionId: 700, shopifyProductId: 1 });
    await app.db
      .insert(schema.shopifyCollections)
      .values({ storeId: store.id, shopifyCollectionId: 700, title: 'Gone' });

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { collection: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      await syncOneTask(app, { storeId: store.id, mode: 'collection', shopifyCollectionId: 700 });

      const enabledRows = await app.db
        .select()
        .from(schema.shopifyEnabledCollections)
        .where(eq(schema.shopifyEnabledCollections.storeId, store.id));
      expect(enabledRows).toHaveLength(0);

      const membershipRows = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(eq(schema.shopifyCollectionProducts.storeId, store.id));
      expect(membershipRows).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
