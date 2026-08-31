import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 88,
      shopDomain: 'a.myshopify.com',
      myshopifyDomain: 'a.myshopify.com',
      name: 'A',
      email: 'a@a.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('a.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    {
      storeId,
      shopifyProductId: 1,
      shopifyVariantId: null,
      r2Key: 'x',
      title: 'One',
      status: 'active',
      enabled: true,
    },
    {
      storeId,
      shopifyProductId: 2,
      shopifyVariantId: null,
      r2Key: 'y',
      title: 'Two',
      status: 'failed',
      enabled: false,
      failedReason: 'bad image',
    },
    {
      storeId,
      shopifyProductId: 3,
      shopifyVariantId: null,
      r2Key: 'z',
      title: 'Three',
      status: 'active',
      enabled: false,
      excluded: true,
    },
  ]);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/activation', () => {
  it('returns mode and summary counts, including failed-to-sync independent of enabled state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/activation',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('selective');
    expect(body.counts.individuallyEnabledProducts).toBe(1);
    expect(body.counts.excludedProducts).toBe(1);
    expect(body.counts.failedToSync).toBe(1);
  });
});

describe('PATCH /v1/shopify/activation/mode', () => {
  it('sets global mode', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/activation/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { mode: 'global' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('global');

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.activation?.mode).toBe('global');

    // reset for later tests in this file
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/activation/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { mode: 'selective' },
    });
  });
});

describe('collections enable/exclude CRUD', () => {
  it('adds an enabled collection, syncing its membership, then removes it', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/graphql.json')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.variables?.id === 'gid://shopify/Collection/50') {
          return new Response(
            JSON.stringify({
              data: {
                collection: {
                  title: 'Hats',
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: 'gid://shopify/Product/1' }],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected graphql variables: ${JSON.stringify(body.variables)}`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const addRes = await app.inject({
        method: 'POST',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { shopifyCollectionIds: [50] },
      });
      expect(addRes.statusCode).toBe(200);

      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}` },
      });
      const list = listRes.json().items;
      expect(
        list.some(
          (c: { shopifyCollectionId: number; title: string }) =>
            c.shopifyCollectionId === 50 && c.title === 'Hats',
        ),
      ).toBe(true);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/collections/50',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delRes.statusCode).toBe(200);

      const listAfter = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(
        listAfter
          .json()
          .items.some((c: { shopifyCollectionId: number }) => c.shopifyCollectionId === 50),
      ).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('exclusions/collections CRUD', () => {
  it('adds and removes an excluded collection', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/graphql.json')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.variables?.id === 'gid://shopify/Collection/60') {
          return new Response(
            JSON.stringify({
              data: {
                collection: {
                  title: 'Clearance',
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected graphql variables: ${JSON.stringify(body.variables)}`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const addRes = await app.inject({
        method: 'POST',
        url: '/v1/shopify/activation/exclusions/collections',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { shopifyCollectionIds: [60] },
      });
      expect(addRes.statusCode).toBe(200);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/exclusions/collections/60',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delRes.statusCode).toBe(200);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('DELETE collection membership sharing', () => {
  it('keeps cached membership when the collection is still selected in the sibling table', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/graphql.json')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.variables?.id === 'gid://shopify/Collection/70') {
          return new Response(
            JSON.stringify({
              data: {
                collection: {
                  title: 'Shared',
                  products: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: 'gid://shopify/Product/100' }],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected graphql variables: ${JSON.stringify(body.variables)}`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      // Add the collection to the enabled set (this syncs membership rows).
      const addEnabledRes = await app.inject({
        method: 'POST',
        url: '/v1/shopify/activation/collections',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { shopifyCollectionIds: [70] },
      });
      expect(addEnabledRes.statusCode).toBe(200);

      // Also select the same collection ID in the excluded set directly,
      // bypassing the sync (nothing stops a collection from being in both).
      await app.db
        .insert(schema.shopifyExcludedCollections)
        .values({ storeId, shopifyCollectionId: 70 })
        .onConflictDoNothing();

      // Sanity check membership rows exist before removal.
      const membershipBefore = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(eq(schema.shopifyCollectionProducts.shopifyCollectionId, 70));
      expect(membershipBefore.length).toBeGreaterThan(0);

      // Remove the collection from the enabled set only.
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/collections/70',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delRes.statusCode).toBe(200);

      // Membership rows must still exist — the collection is still selected
      // (as an exclusion), so wiping them would silently stop the exclusion
      // from applying until the next hourly resync.
      const membershipAfter = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(eq(schema.shopifyCollectionProducts.shopifyCollectionId, 70));
      expect(membershipAfter.length).toBe(membershipBefore.length);

      // Clean up: remove from excluded too, which should now be safe to wipe
      // membership since neither table selects it anymore.
      const delExcludedRes = await app.inject({
        method: 'DELETE',
        url: '/v1/shopify/activation/exclusions/collections/70',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(delExcludedRes.statusCode).toBe(200);

      const membershipFinal = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(eq(schema.shopifyCollectionProducts.shopifyCollectionId, 70));
      expect(membershipFinal.length).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('GET /v1/shopify/activation/collections/search', () => {
  it('proxies a live title search', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              collections: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Collection/1', title: 'Summer' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/activation/collections/search?q=summer',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([{ shopifyCollectionId: 1, title: 'Summer' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
