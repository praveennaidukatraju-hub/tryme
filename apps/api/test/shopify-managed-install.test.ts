import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
let c: Containers;
let app: TestApp;

/**
 * Under managed installation the only thing that ever reaches Shopify on a
 * fresh install is the token exchange, so these stubs record it specifically —
 * asserting on the grant_type is what distinguishes this path from the
 * authorization-code callback, which hits the same URL with a `code`.
 */
function stubShopify(options: {
  shopDomain: string;
  shopifyShopId: number;
  exchangeStatus?: number;
}) {
  const exchanges: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/admin/oauth/access_token')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        exchanges.push(body);
        if (options.exchangeStatus && options.exchangeStatus !== 200) {
          return new Response('bad session token', { status: options.exchangeStatus });
        }
        return new Response(
          JSON.stringify({
            access_token: 'exchanged-token',
            scope: 'read_products,write_products',
            expires_in: 3600,
            refresh_token: 'refresh-me',
            refresh_token_expires_in: 7776000,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/graphql.json')) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        if (body.query?.includes('ShopDetails')) {
          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  id: `gid://shopify/Shop/${options.shopifyShopId}`,
                  myshopifyDomain: options.shopDomain,
                  name: 'Managed Install Demo',
                  email: 'owner@example.com',
                  primaryDomain: null,
                  shopOwnerName: null,
                  billingAddress: null,
                  ianaTimezone: null,
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { exchanges };
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_APP_URL: 'https://app.example.com',
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('managed installation — provisioning from a session token', () => {
  it('provisions a store on the first authenticated request from an unknown shop', async () => {
    const shopDomain = 'managed-fresh.myshopify.com';
    const { exchanges } = stubShopify({ shopDomain, shopifyShopId: 900001 });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${signSessionToken(shopDomain, API_SECRET, API_KEY)}` },
    });

    expect(res.statusCode).toBe(200);

    // The exchange must be a token exchange, not an authorization-code grant.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });
    expect(exchanges[0].subject_token).toBeTruthy();
    expect(exchanges[0].code).toBeUndefined();

    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopDomain, shopDomain));
    expect(store).toBeTruthy();
    expect(store.uninstalledAt).toBeNull();
    // Stored encrypted, and the refresh half captured so it can be renewed
    // without sending the merchant anywhere.
    expect(store.accessToken).not.toContain('exchanged-token');
    expect(store.refreshToken).toBeTruthy();
    expect(store.tokenExpiresAt).toBeTruthy();
  });

  it('does not exchange again for an already-installed store', async () => {
    const shopDomain = 'managed-existing.myshopify.com';
    await upsertShopifyStore(
      app,
      {
        shopifyShopId: 900002,
        shopDomain,
        myshopifyDomain: shopDomain,
        name: 'Existing',
        email: 'e@example.com',
      },
      'already-have-this',
      'read_products',
    );

    const { exchanges } = stubShopify({ shopDomain, shopifyShopId: 900002 });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${signSessionToken(shopDomain, API_SECRET, API_KEY)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(exchanges).toHaveLength(0);
  });

  it('re-provisions a store that was previously uninstalled', async () => {
    const shopDomain = 'managed-reinstall.myshopify.com';
    await upsertShopifyStore(
      app,
      {
        shopifyShopId: 900003,
        shopDomain,
        myshopifyDomain: shopDomain,
        name: 'Reinstall',
        email: 'r@example.com',
      },
      'stale-token',
      'read_products',
    );
    await app.db
      .update(schema.shopifyStores)
      .set({ uninstalledAt: new Date() })
      .where(eq(schema.shopifyStores.shopifyShopId, 900003));

    const { exchanges } = stubShopify({ shopDomain, shopifyShopId: 900003 });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${signSessionToken(shopDomain, API_SECRET, API_KEY)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(exchanges).toHaveLength(1);

    const rows = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopifyShopId, 900003));
    // Reactivated in place, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0].uninstalledAt).toBeNull();
  });

  it('surfaces a rejected session token as an error rather than provisioning', async () => {
    const shopDomain = 'managed-badtoken.myshopify.com';
    // Shopify answers 400 when the session token is expired or invalid.
    stubShopify({ shopDomain, shopifyShopId: 900004, exchangeStatus: 400 });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${signSessionToken(shopDomain, API_SECRET, API_KEY)}` },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const rows = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopDomain, shopDomain));
    expect(rows).toHaveLength(0);
  });

  it('still rejects a request with no session token at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/shopify/me' });
    expect(res.statusCode).toBe(401);
  });

  it('provisions once when several first requests race', async () => {
    const shopDomain = 'managed-race.myshopify.com';
    const { exchanges } = stubShopify({ shopDomain, shopifyShopId: 900005 });
    const auth = { authorization: `Bearer ${signSessionToken(shopDomain, API_SECRET, API_KEY)}` };

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'GET', url: '/v1/shopify/me', headers: auth }),
      ),
    );

    // Whoever wins the lock does the single exchange; the losers wait for the
    // row rather than exchanging in parallel.
    expect(exchanges).toHaveLength(1);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);

    const rows = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopDomain, shopDomain));
    expect(rows).toHaveLength(1);
  });
});
