import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { syncOneTask, syncProduct } from '../src/modules/shopify/products.sync.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 5).toString('base64');
let c: Containers;
let app: TestApp;
let storeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 7,
      shopDomain: 's.myshopify.com',
      myshopifyDomain: 's.myshopify.com',
      name: 'S',
      email: 's@s.com',
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

const mockFetch = (async () =>
  ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: new Map([['content-type', 'image/jpeg']]),
  }) as unknown as Response) as typeof fetch;

describe('syncProduct', () => {
  it('uploads first image to R2 and upserts an active garment row', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: new Map([['content-type', 'image/jpeg']]),
      }) as unknown as Response) as typeof fetch;
    await syncProduct(
      app,
      storeId,
      { id: 42, title: 'Test Product', imageUrl: 'https://cdn.shopify.com/x.jpg' },
      fakeFetch,
    );
    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 42),
        ),
      );
    expect(row.status).toBe('active');
    expect(row.title).toBe('Test Product');
    expect(row.r2Key).toBe(`shopify-garments/${storeId}/42/garment.jpg`);
    const head = await app.storage.headObject(row.r2Key);
    expect(head.contentLength).toBe(3);
  });

  it('marks failed when a product has no image', async () => {
    const fakeFetch = (async () => {
      throw new Error('should not be called');
    }) as typeof fetch;
    await syncProduct(
      app,
      storeId,
      { id: 43, title: 'No Image Product', imageUrl: null },
      fakeFetch,
    );
    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 43),
        ),
      );
    expect(row.status).toBe('failed');
    expect(row.failedReason).toBeTruthy();
  });

  it('requests redirect: "error" and a live AbortSignal, so a CDN redirect to an off-allowlist host is never followed', async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: new Map([['content-type', 'image/jpeg']]),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await syncProduct(
      app,
      storeId,
      {
        id: 44,
        title: 'Redirect Check Product',
        imageUrl: 'https://cdn.shopify.com/redirect-check.jpg',
      },
      fakeFetch,
    );
    expect(capturedInit?.redirect).toBe('error');
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);

    // Simulate what real fetch does when redirect: 'error' hits a 3xx: it throws instead
    // of following it, which must land in the existing failed-status path.
    const redirectingFetch = (async () => {
      throw new TypeError('unexpected redirect');
    }) as unknown as typeof fetch;
    await syncProduct(
      app,
      storeId,
      {
        id: 45,
        title: 'Redirects Elsewhere Product',
        imageUrl: 'https://cdn.shopify.com/redirects-elsewhere.jpg',
      },
      redirectingFetch,
    );
    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 45),
        ),
      );
    expect(row.status).toBe('failed');
    expect(row.failedReason).toContain('redirect');
  });

  it('marks failed when the content-length header exceeds the 20MB cap, without downloading the body', async () => {
    let arrayBufferCalled = false;
    const fakeFetch = (async () =>
      ({
        ok: true,
        arrayBuffer: async () => {
          arrayBufferCalled = true;
          return new Uint8Array([1, 2, 3]).buffer;
        },
        headers: new Map([
          ['content-type', 'image/jpeg'],
          ['content-length', String(21 * 1024 * 1024)],
        ]),
      }) as unknown as Response) as typeof fetch;
    await syncProduct(
      app,
      storeId,
      { id: 46, title: 'Big Product', imageUrl: 'https://cdn.shopify.com/big.jpg' },
      fakeFetch,
    );
    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 46),
        ),
      );
    expect(row.status).toBe('failed');
    expect(row.failedReason).toContain('20MB');
    expect(arrayBufferCalled).toBe(false);
  });

  it('marks failed when the actual downloaded body exceeds the 20MB cap (no content-length header)', async () => {
    const oversized = new Uint8Array(21 * 1024 * 1024);
    const fakeFetch = (async () =>
      ({
        ok: true,
        arrayBuffer: async () => oversized.buffer,
        headers: new Map([['content-type', 'image/jpeg']]),
      }) as unknown as Response) as typeof fetch;
    await syncProduct(
      app,
      storeId,
      {
        id: 47,
        title: 'Big No Header Product',
        imageUrl: 'https://cdn.shopify.com/big-no-header.jpg',
      },
      fakeFetch,
    );
    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 47),
        ),
      );
    expect(row.status).toBe('failed');
    expect(row.failedReason).toContain('20MB');
  });

  it('respects an admin-configured limit lower than the default 20MB cap', async () => {
    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyProductSyncMaxBytes: 5 } }),
    );
    try {
      const fakeFetch = (async () =>
        ({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6]).buffer,
          headers: new Map([['content-type', 'image/jpeg']]),
        }) as unknown as Response) as typeof fetch;
      await syncProduct(
        app,
        storeId,
        {
          id: 48,
          title: 'Configured Limit Product',
          imageUrl: 'https://cdn.shopify.com/c.jpg',
        },
        fakeFetch,
      );
      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 48),
          ),
        );
      expect(row.status).toBe('failed');
      expect(row.failedReason).toContain('MB');
    } finally {
      await app.redis.del('config:system');
    }
  });

  it('persists product_type/tags/vendor', async () => {
    await syncProduct(
      app,
      storeId,
      {
        id: 501,
        title: 'Test Shirt',
        imageUrl: 'https://cdn.shopify.com/shirt.jpg',
        productType: 'Shirts',
        tags: ['Sale', 'Cotton'],
        vendor: 'Acme Co',
      },
      mockFetch,
    );

    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 501),
        ),
      );
    expect(row.productType).toBe('Shirts');
    expect(row.tags).toEqual(['Sale', 'Cotton']);
    expect(row.vendor).toBe('Acme Co');
  });

  it('persists collections when a product belongs to multiple collections', async () => {
    await syncProduct(
      app,
      storeId,
      {
        id: 504,
        title: 'Summer Shirt',
        imageUrl: 'https://cdn.shopify.com/shirt4.jpg',
        collections: ['Summer Sale', 'New Arrivals'],
      },
      mockFetch,
    );

    const [row] = await app.db
      .select()
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, storeId),
          eq(schema.shopifyProductGarments.shopifyProductId, 504),
        ),
      );
    expect(row.collections).toEqual(['Summer Sale', 'New Arrivals']);
  });
});

describe('syncOneTask — full sync pagination', () => {
  it('threads the cursor across pages and syncs products from both', async () => {
    let callCount = 0;
    const originalFetch = global.fetch;
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/graphql.json')) {
        throw new Error(`unexpected fetch during full sync: ${url}`);
      }
      callCount++;
      const body = JSON.parse(String(init?.body)) as { variables?: { cursor?: string | null } };
      if (callCount === 1) {
        expect(body.variables?.cursor ?? null).toBeNull();
        return new Response(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: true, endCursor: 'p1' },
                nodes: [
                  {
                    id: 'gid://shopify/Product/601',
                    title: 'Page One Product',
                    productType: null,
                    tags: [],
                    vendor: null,
                    featuredImage: null,
                    collections: { nodes: [] },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      expect(body.variables?.cursor).toBe('p1');
      return new Response(
        JSON.stringify({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'gid://shopify/Product/602',
                  title: 'Page Two Product',
                  productType: null,
                  tags: [],
                  vendor: null,
                  featuredImage: null,
                  collections: { nodes: [] },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      await syncOneTask(app, { storeId, mode: 'full' });
      expect(callCount).toBe(2);

      const rows = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 601),
          ),
        );
      const [row2] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 602),
          ),
        );
      expect(rows[0]?.title).toBe('Page One Product');
      expect(row2?.title).toBe('Page Two Product');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('syncOneTask — product mode', () => {
  it('throws SHOPIFY_REAUTH_REQUIRED rather than blanking the garment row, on a 401 from Shopify', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;

    try {
      await expect(
        syncOneTask(app, { storeId, mode: 'product', shopifyProductId: 701 }),
      ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });

      const rows = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 701),
          ),
        );
      // No garment row written: a store-wide auth failure must not blank a
      // per-product row.
      expect(rows).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('still records a failure row for a generic (non-auth) fetch failure', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response('boom', { status: 502 })) as typeof fetch;

    try {
      await syncOneTask(app, { storeId, mode: 'product', shopifyProductId: 702 });

      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 702),
          ),
        );
      expect(row.status).toBe('failed');
      expect(row.failedReason).toContain('product fetch failed');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('still records a failure row when Shopify reports the product does not exist', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { product: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      await syncOneTask(app, { storeId, mode: 'product', shopifyProductId: 703 });

      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 703),
          ),
        );
      expect(row.status).toBe('failed');
      expect(row.failedReason).toBe('product not found on Shopify');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
