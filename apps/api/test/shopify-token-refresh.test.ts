import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptToken, encryptToken } from '../src/lib/crypto.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { getValidAccessToken } from '../src/modules/shopify/token.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 21).toString('base64');
let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_KEY: 'k',
    SHOPIFY_API_SECRET: 's',
  });
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

let shopSeq = 0;

/** Fresh store per test so refreshes in one cannot bleed into another. */
async function seedStore(over: Partial<typeof schema.shopifyStores.$inferInsert> = {}) {
  shopSeq += 1;
  const domain = `t${shopSeq}.myshopify.com`;
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 9000 + shopSeq,
      shopDomain: domain,
      myshopifyDomain: domain,
      name: 'T',
      email: 't@t.com',
    },
    'plain-access-token',
    'read_products',
  );
  if (Object.keys(over).length > 0) {
    await app.db
      .update(schema.shopifyStores)
      .set(over)
      .where(eq(schema.shopifyStores.id, store.id));
  }
  const [row] = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.id, store.id));
  return row;
}

function stubFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('getValidAccessToken', () => {
  it('returns a legacy perpetual token untouched, without calling Shopify', async () => {
    // Stores installed before expiring tokens shipped have no refresh half.
    // Trying to refresh one would 400 and lock out a store that works fine.
    const store = await seedStore({
      refreshToken: null,
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    const f = stubFetch({});

    expect(await getValidAccessToken(app, store)).toBe('plain-access-token');
    expect(f).not.toHaveBeenCalled();
  });

  it('does not refresh a token with life left', async () => {
    const store = await seedStore({
      refreshToken: encryptToken('rt', ENC_KEY),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });
    const f = stubFetch({});

    expect(await getValidAccessToken(app, store)).toBe('plain-access-token');
    expect(f).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the rotated pair encrypted', async () => {
    const store = await seedStore({
      refreshToken: encryptToken('old-rt', ENC_KEY),
      tokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });
    const f = stubFetch({
      access_token: 'rotated-at',
      refresh_token: 'rotated-rt',
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    });

    expect(await getValidAccessToken(app, store)).toBe('rotated-at');

    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-rt' });

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(decryptToken(row.accessToken, ENC_KEY)).toBe('rotated-at');
    // The old refresh token is single-use — keeping it would guarantee a 400
    // on the next refresh.
    expect(decryptToken(row.refreshToken as string, ENC_KEY)).toBe('rotated-rt');
    expect(row.accessToken).not.toContain('rotated-at');
    expect(row.tokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('demands reauthorization once the refresh token itself has expired', async () => {
    const store = await seedStore({
      refreshToken: encryptToken('rt', ENC_KEY),
      tokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const f = stubFetch({});

    await expect(getValidAccessToken(app, store)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
    });
    // No point spending a call on a token Shopify has already dropped.
    expect(f).not.toHaveBeenCalled();
  });

  it('demands reauthorization when the stored token was encrypted under another key', async () => {
    // Reachable two ways in practice: rotating SHOPIFY_TOKEN_ENC_KEY, and
    // restoring a database dump into an environment holding a different key —
    // how staging receives production's rows. Raw, AES-GCM authentication
    // failure throws a bare node:crypto Error that nothing matches on, so it
    // escaped as a 500 and the hourly billing sync logged it forever with no
    // route to recovery. As SHOPIFY_REAUTH_REQUIRED the SPA can send the
    // merchant through reauth, which rewrites the column under the live key.
    const store = await seedStore({
      accessToken: encryptToken('at', Buffer.alloc(32, 99).toString('base64')),
      refreshToken: null,
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    const f = stubFetch({});

    await expect(getValidAccessToken(app, store)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
      statusCode: 403,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('demands reauthorization when only the refresh half fails to decrypt', async () => {
    // The access token decrypts but is expired, so recovery depends on the
    // refresh half — which is ciphertext under a key we no longer hold. Without
    // the wrapper this path threw the raw crypto error from inside the refresh
    // lock, leaving the caller with a 500 rather than a recoverable signal.
    const store = await seedStore({
      refreshToken: encryptToken('rt', Buffer.alloc(32, 99).toString('base64')),
      tokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });
    const f = stubFetch({});

    await expect(getValidAccessToken(app, store)).rejects.toMatchObject({
      code: 'SHOPIFY_REAUTH_REQUIRED',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('refreshes once when callers race, not once per caller', async () => {
    // Refresh tokens are single-use: a second concurrent rotation with the same
    // token is what orphans a store.
    const store = await seedStore({
      refreshToken: encryptToken('old-rt', ENC_KEY),
      tokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });
    const f = stubFetch({
      access_token: 'once-at',
      refresh_token: 'once-rt',
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
    });

    const results = await Promise.all([
      getValidAccessToken(app, store),
      getValidAccessToken(app, store),
      getValidAccessToken(app, store),
    ]);

    expect(results).toEqual(['once-at', 'once-at', 'once-at']);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('stores the refresh half at install so the first expiry is recoverable', async () => {
    // Regression guard: the OAuth callback used to destructure only
    // access_token and scope, dropping refresh_token on the floor. Every store
    // installed that way was unrecoverable one hour later.
    const domain = 'install.myshopify.com';
    const store = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 8123,
        shopDomain: domain,
        myshopifyDomain: domain,
        name: 'I',
        email: 'i@i.com',
      },
      'at',
      'read_products',
      {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 7776000_000),
      },
    );

    expect(store.refreshToken).toBeTruthy();
    expect(decryptToken(store.refreshToken as string, ENC_KEY)).toBe('rt');
    expect(store.tokenExpiresAt).toBeTruthy();
    expect(store.refreshTokenExpiresAt).toBeTruthy();
  });
});
