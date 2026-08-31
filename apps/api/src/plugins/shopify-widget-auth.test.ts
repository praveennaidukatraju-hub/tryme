import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const SECRET = 'shpss_test_secret';

function signAppProxyQuery(params: Record<string, string>): Record<string, string> {
  const msg = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  const signature = createHmac('sha256', SECRET).update(msg).digest('hex');
  return { ...params, signature };
}

describe('requireShopifyStoreKey', () => {
  it('throws UNAUTHORIZED when x-widget-key header is missing', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select: vi.fn() },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock — Fastify plugin type is opaque
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const req = { headers: {} } as never;
    await expect(
      (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req),
    ).rejects.toThrow('Missing X-Widget-Key header');
  });

  it('throws UNAUTHORIZED (not a raw DB error) when x-widget-key is not a valid UUID', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const select = vi.fn();
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock — Fastify plugin type is opaque
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const req = { headers: { 'x-widget-key': 'not-a-uuid' } } as never;
    await expect(
      (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req),
    ).rejects.toThrow('Invalid or inactive store key');
    // Must reject before ever touching the DB — a malformed uuid literal would
    // otherwise throw an unhandled Postgres error (500) instead of a clean 401.
    expect(select).not.toHaveBeenCalled();
  });

  it('rejects an app proxy request with a tampered signature', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const select = vi.fn();
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select },
      env: { SHOPIFY_API_SECRET: SECRET },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock — Fastify plugin type is opaque
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const query = signAppProxyQuery({
      shop: 'a.myshopify.com',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    query.shop = 'evil.myshopify.com'; // tamper after signing
    const req = { headers: {}, query } as never;
    await expect(
      (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req),
    ).rejects.toThrow('Invalid app proxy signature');
    expect(select).not.toHaveBeenCalled();
  });

  it('rejects an app proxy request with an expired timestamp even with a valid signature', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select: vi.fn() },
      env: { SHOPIFY_API_SECRET: SECRET },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock — Fastify plugin type is opaque
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1h old
    const query = signAppProxyQuery({ shop: 'a.myshopify.com', timestamp: staleTimestamp });
    const req = { headers: {}, query } as never;
    await expect(
      (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req),
    ).rejects.toThrow('App proxy request expired');
  });

  it('resolves the store by shop domain on a validly signed, fresh app proxy request', async () => {
    const { shopifyWidgetAuthPlugin } = await import('./shopify-widget-auth.js');
    const decorated: Record<string, unknown> = {};
    const store = { id: 'store-1', uninstalledAt: null, shopDomain: 'a.myshopify.com' };
    const limit = vi.fn().mockResolvedValue([store]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const app = {
      decorate: (name: string, fn: unknown) => {
        decorated[name] = fn;
      },
      db: { select },
      env: { SHOPIFY_API_SECRET: SECRET },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test mock — Fastify plugin type is opaque
    await (shopifyWidgetAuthPlugin as any)(app, {}, () => {});
    const query = signAppProxyQuery({
      shop: 'a.myshopify.com',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const req = { headers: {}, query } as { shopifyStoreId?: string; query: unknown };
    await (decorated.requireShopifyStoreKey as (req: unknown) => Promise<void>)(req);
    expect(req.shopifyStoreId).toBe('store-1');
  });
});
