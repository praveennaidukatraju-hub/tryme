import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import {
  searchCollections,
  syncCollectionMembership,
} from '../src/modules/shopify/collections.sync.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let storeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
    SHOPIFY_API_SECRET: 'test-secret',
    SHOPIFY_API_KEY: 'test-key',
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'c.myshopify.com',
      myshopifyDomain: 'c.myshopify.com',
      name: 'C',
      email: 'c@c.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('syncCollectionMembership', () => {
  it("replaces a collection's membership with a fresh pull, and fetches its title", async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    await app.db.insert(schema.shopifyCollectionProducts).values({
      storeId,
      shopifyCollectionId: 500,
      shopifyProductId: 999, // stale — must be gone after resync
    });

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            collection: {
              title: 'Summer',
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Product/1' }, { id: 'gid://shopify/Product/2' }],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const result = await syncCollectionMembership(app, store, 500);
      expect(result).toEqual({ title: 'Summer', productCount: 2 });

      const rows = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(
          and(
            eq(schema.shopifyCollectionProducts.storeId, storeId),
            eq(schema.shopifyCollectionProducts.shopifyCollectionId, 500),
          ),
        );
      expect(rows.map((r) => r.shopifyProductId).sort()).toEqual([1, 2]);
      expect(rows.some((r) => r.shopifyProductId === 999)).toBe(false);

      const [collectionRow] = await app.db
        .select()
        .from(schema.shopifyCollections)
        .where(
          and(
            eq(schema.shopifyCollections.storeId, storeId),
            eq(schema.shopifyCollections.shopifyCollectionId, 500),
          ),
        );
      expect(collectionRow.title).toBe('Summer');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('syncCollectionMembership — pagination', () => {
  it('accumulates members across pages and threads the cursor into the next request', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    let callCount = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body)) as { variables?: { cursor?: string | null } };
      if (callCount === 1) {
        expect(body.variables?.cursor ?? null).toBeNull();
        return new Response(
          JSON.stringify({
            data: {
              collection: {
                title: 'Multi Page',
                products: {
                  pageInfo: { hasNextPage: true, endCursor: 'c1' },
                  nodes: [{ id: 'gid://shopify/Product/701' }],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      expect(body.variables?.cursor).toBe('c1');
      return new Response(
        JSON.stringify({
          data: {
            collection: {
              title: 'Multi Page',
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Product/702' }],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const result = await syncCollectionMembership(app, store, 900);
      expect(callCount).toBe(2);
      expect(result).toEqual({ title: 'Multi Page', productCount: 2 });

      const rows = await app.db
        .select()
        .from(schema.shopifyCollectionProducts)
        .where(
          and(
            eq(schema.shopifyCollectionProducts.storeId, storeId),
            eq(schema.shopifyCollectionProducts.shopifyCollectionId, 900),
          ),
        );
      expect(rows.map((r) => r.shopifyProductId).sort()).toEqual([701, 702]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('syncCollectionMembership — deleted collection', () => {
  it('throws CollectionNotFoundError when Shopify reports no such collection', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { collection: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const { CollectionNotFoundError } = await import(
        '../src/modules/shopify/collections.sync.js'
      );
      await expect(syncCollectionMembership(app, store, 12345)).rejects.toBeInstanceOf(
        CollectionNotFoundError,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not classify a rate-limit response as not-found', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Too many requests' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const { CollectionNotFoundError } = await import(
        '../src/modules/shopify/collections.sync.js'
      );
      await expect(syncCollectionMembership(app, store, 12345)).rejects.not.toBeInstanceOf(
        CollectionNotFoundError,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('searchCollections', () => {
  it('filters the full collection list by a case-insensitive title substring', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            collections: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: 'gid://shopify/Collection/1', title: 'Summer Dresses' },
                { id: 'gid://shopify/Collection/2', title: 'Winter Coats' },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const results = await searchCollections(app, store, 'summer');
      expect(results).toEqual([{ shopifyCollectionId: 1, title: 'Summer Dresses' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('searchCollections — pagination (fetchCollectionTitleMap)', () => {
  it('finds a collection whose title only appears on the second page, threading the cursor', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    let callCount = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body)) as { variables?: { cursor?: string | null } };
      if (callCount === 1) {
        expect(body.variables?.cursor ?? null).toBeNull();
        return new Response(
          JSON.stringify({
            data: {
              collections: {
                pageInfo: { hasNextPage: true, endCursor: 'cc1' },
                nodes: [{ id: 'gid://shopify/Collection/801', title: 'Spring Sale' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      expect(body.variables?.cursor).toBe('cc1');
      return new Response(
        JSON.stringify({
          data: {
            collections: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: 'gid://shopify/Collection/802', title: 'Autumn Picks' }],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const results = await searchCollections(app, store, 'autumn');
      expect(callCount).toBe(2);
      expect(results).toEqual([{ shopifyCollectionId: 802, title: 'Autumn Picks' }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
