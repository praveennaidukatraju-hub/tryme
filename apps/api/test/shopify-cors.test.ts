import { randomUUID } from 'node:crypto';

import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let shopId = 1;

function shopifyStore(overrides: {
  shopDomain: string;
  allowedOrigins: string[];
  uninstalledAt?: Date | null;
}) {
  shopId += 1;
  return {
    shopDomain: overrides.shopDomain,
    shopifyShopId: shopId,
    accessToken: 'enc:test',
    scope: 'read_products',
    allowedOrigins: overrides.allowedOrigins,
    uninstalledAt: overrides.uninstalledAt ?? null,
  };
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.db.insert(schema.shopifyStores).values(
    shopifyStore({
      shopDomain: `allowed-${randomUUID()}.myshopify.com`,
      allowedOrigins: ['https://allowed.example.com'],
    }),
  );
  await app.db.insert(schema.shopifyStores).values(
    shopifyStore({
      shopDomain: `uninstalled-${randomUUID()}.myshopify.com`,
      allowedOrigins: ['https://inactive.example.com'],
      uninstalledAt: new Date(),
    }),
  );
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('dynamic CORS', () => {
  it('reflects the static app origin (existing behavior unchanged)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('reflects an origin listed in some shopifyStores.allowedOrigins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://allowed.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
  });

  it('does not allow an origin nobody has registered', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://not-registered.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow an origin from an uninstalled store', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://inactive.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('origin lookup caching', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('serves a cached allow decision for 30s after a store uninstalls, then re-queries after the TTL expires', async () => {
      const origin = `https://cache-test-${randomUUID()}.example.com`;
      const shopDomain = `cache-test-${randomUUID()}.myshopify.com`;
      await app.db.insert(schema.shopifyStores).values(
        shopifyStore({
          shopDomain,
          allowedOrigins: [origin],
        }),
      );

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1_000_000);

      // First call: DB says installed -> allowed, gets cached.
      const first = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin },
      });
      expect(first.headers['access-control-allow-origin']).toBe(origin);

      // Uninstall directly in the DB, bypassing any cache invalidation (there is none by design).
      await app.db
        .update(schema.shopifyStores)
        .set({ uninstalledAt: new Date() })
        .where(eq(schema.shopifyStores.shopDomain, shopDomain));

      // Still within the 30s TTL: must still reflect the stale cached "allowed" answer.
      nowSpy.mockReturnValue(1_000_000 + 29_000);
      const second = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin },
      });
      expect(second.headers['access-control-allow-origin']).toBe(origin);

      // Past the TTL: cache entry expired, fresh DB lookup sees the uninstalled row -> disallowed.
      nowSpy.mockReturnValue(1_000_000 + 30_001);
      const third = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin },
      });
      expect(third.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('serves a cached deny decision for an unregistered origin without a fresh DB hit each time', async () => {
      const origin = `https://never-registered-${randomUUID()}.example.com`;
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(2_000_000);

      const first = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(first.headers['access-control-allow-origin']).toBeUndefined();

      // Now register it as an installed store, but stay within the TTL window: the
      // cached negative result should still win until the TTL expires.
      await app.db.insert(schema.shopifyStores).values(
        shopifyStore({
          shopDomain: `late-register-${randomUUID()}.myshopify.com`,
          allowedOrigins: [origin],
        }),
      );

      nowSpy.mockReturnValue(2_000_000 + 29_000);
      const second = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(second.headers['access-control-allow-origin']).toBeUndefined();

      nowSpy.mockReturnValue(2_000_000 + 30_001);
      const third = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(third.headers['access-control-allow-origin']).toBe(origin);
    });
  });
});
