import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 3).toString('base64');
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
      shopifyShopId: 55,
      shopDomain: 'p.myshopify.com',
      myshopifyDomain: 'p.myshopify.com',
      name: 'P',
      email: 'p@p.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('p.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    {
      storeId,
      shopifyProductId: 1,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/1/garment.jpg`,
      title: 'Red Shirt',
      status: 'active',
      enabled: true,
    },
    {
      storeId,
      shopifyProductId: 2,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/2/garment.jpg`,
      title: 'Blue Shirt',
      status: 'processing',
      enabled: false,
    },
  ]);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/products', () => {
  it("lists this store's synced products with status and enabled state", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    const red = body.items.find((p: { shopifyProductId: number }) => p.shopifyProductId === 1);
    expect(red.title).toBe('Red Shirt');
    expect(red.status).toBe('active');
    expect(red.enabled).toBe(true);
    expect(red.thumbnailUrl).toContain(`shopify-garments/${storeId}/1/garment.jpg`);
    expect(red.thumbnailUrl).toContain('X-Amz-Signature');
    const blue = body.items.find((p: { shopifyProductId: number }) => p.shopifyProductId === 2);
    expect(blue.enabled).toBe(false);
  });

  it('paginates with page/pageSize', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?page=1&pageSize=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
  });

  it('filters by enabled', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?enabled=true',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.every((p: { enabled: boolean }) => p.enabled)).toBe(true);
  });

  it('filters by enabled=false, not treating the literal string "false" as truthy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?enabled=false',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((p: { enabled: boolean }) => p.enabled === false)).toBe(true);
  });

  it('filters by excluded=false, not treating the literal string "false" as truthy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?excluded=false',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((p: { excluded: boolean }) => p.excluded === false)).toBe(true);
  });

  it('filters by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?status=processing',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Blue Shirt');
  });

  it('filters by search query, case-insensitive', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/products?q=red',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe('Red Shirt');
  });

  it('filters by excluded', async () => {
    // Excludes product 2, asserts the filter, then reverts — this file's
    // fixture rows are shared across the whole describe block and later
    // tests assume product 2 starts un-excluded.
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: true },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/products?excluded=true',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe('Blue Shirt');
    } finally {
      await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/2',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { excluded: false },
      });
    }
  });
});

describe('GET /v1/shopify/products/:id/images', () => {
  it('returns the live image list from Shopify for that product', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      expect(url).toContain('/graphql.json');
      return new Response(
        JSON.stringify({
          data: {
            product: {
              images: {
                nodes: [
                  {
                    id: 'gid://shopify/ProductImage/111',
                    url: 'https://cdn.shopify.com/s/files/1/one.jpg',
                  },
                  {
                    id: 'gid://shopify/ProductImage/222',
                    url: 'https://cdn.shopify.com/s/files/1/two.jpg',
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/shopify/products/1/images',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        images: [
          { id: 111, src: 'https://cdn.shopify.com/s/files/1/one.jpg' },
          { id: 222, src: 'https://cdn.shopify.com/s/files/1/two.jpg' },
        ],
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('PATCH /v1/shopify/products/:id', () => {
  it('rejects a garment image above the admin-configured limit', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                images: {
                  nodes: [
                    {
                      id: 'gid://shopify/ProductImage/1',
                      url: 'https://cdn.shopify.com/oversized.jpg',
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return {
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: async () => new Uint8Array(2048).buffer,
      } as unknown as Response;
    }) as typeof fetch;

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyProductImageMaxBytes: 1024 } }),
    );
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/oversized.jpg' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('MB');
    } finally {
      await app.redis.del('config:system');
      global.fetch = originalFetch;
    }
  });

  it('rejects enabling a product that is not active', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enables an active product', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/1',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it('disables a product regardless of status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it("rejects a garmentImageUrl not in the product's real Shopify image list", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                images: {
                  nodes: [
                    {
                      id: 'gid://shopify/ProductImage/1',
                      url: 'https://cdn.shopify.com/s/files/1/real.jpg',
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
        headers: { get: () => 'image/jpeg' },
      } as Response;
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/s/files/1/fake.jpg' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("swaps the garment image to a real one from the product's image list", async () => {
    const originalFetch = global.fetch;
    let downloadedFrom: string | undefined;
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                images: {
                  nodes: [
                    {
                      id: 'gid://shopify/ProductImage/1',
                      url: 'https://cdn.shopify.com/s/files/1/new.jpg',
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      downloadedFrom = url;
      return {
        ok: true,
        redirected: false,
        arrayBuffer: async () => new ArrayBuffer(4),
        headers: { get: () => 'image/jpeg' },
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/s/files/1/new.jpg' },
      });
      expect(res.statusCode).toBe(200);
      expect(downloadedFrom).toBe('https://cdn.shopify.com/s/files/1/new.jpg');
      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(eq(schema.shopifyProductGarments.shopifyProductId, 1));
      expect(row.r2Key).not.toBe(`shopify-garments/${storeId}/1/garment.jpg`);
      expect(row.r2Key).toContain(`shopify-garments/${storeId}/1/garment-`);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('PATCH /v1/shopify/products/:id — excluded', () => {
  it('excludes a product regardless of status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toBe(true);
  });

  it('un-excludes a product', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/products/2',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { excluded: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().excluded).toBe(false);
  });
});
