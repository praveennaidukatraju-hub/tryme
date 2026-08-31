import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let merchantId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  const m = await createTestMerchant(app);
  merchantId = m.merchantId;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('dynamic CORS for WordPress widget keys', () => {
  it('reflects the storefront origin registered on an active wordpress widget key', async () => {
    await createTestApiKey(app, merchantId, {
      integration: 'wordpress',
      scope: 'widget',
      allowedOrigin: 'https://allowed-wp-shop.example.com',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://allowed-wp-shop.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed-wp-shop.example.com');
  });

  it('does not allow an origin registered on a revoked wordpress widget key', async () => {
    await createTestApiKey(app, merchantId, {
      integration: 'wordpress',
      scope: 'widget',
      allowedOrigin: 'https://revoked-wp-shop.example.com',
      revoked: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://revoked-wp-shop.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow an origin nobody has registered as a widget key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://not-registered-wp.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow allowedOrigin from a non-wordpress (generic full) key', async () => {
    // allowedOrigin is only ever set by the wordpress_widget creation path, but
    // the CORS check must not trust it without integration='wordpress' either,
    // in case a row is ever created/edited outside that path.
    await createTestApiKey(app, merchantId, {
      integration: 'generic',
      scope: 'full',
      allowedOrigin: 'https://generic-key-origin.example.com',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://generic-key-origin.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('origin lookup caching', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('serves a cached allow decision for 30s after a widget key is revoked, then re-queries after the TTL expires', async () => {
      const origin = 'https://cache-test-wp-shop.example.com';
      const created = await createTestApiKey(app, merchantId, {
        integration: 'wordpress',
        scope: 'widget',
        allowedOrigin: origin,
      });

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(3_000_000);

      const first = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(first.headers['access-control-allow-origin']).toBe(origin);

      await app.db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.apiKeys.id, created.id));

      nowSpy.mockReturnValue(3_000_000 + 29_000);
      const second = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(second.headers['access-control-allow-origin']).toBe(origin);

      nowSpy.mockReturnValue(3_000_000 + 30_001);
      const third = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(third.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
