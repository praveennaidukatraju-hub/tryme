import type { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { shopifyAdminFetch } from '../src/modules/shopify/service.js';
import { needsRefresh, refreshAccessToken, toTokenGrant } from '../src/modules/shopify/token.js';

type Store = typeof schema.shopifyStores.$inferSelect;

const NOW = new Date('2026-07-28T12:00:00Z');

/** Only the fields token.ts reads — enough for the pure helpers under test. */
function fakeApp(): FastifyInstance {
  return {
    env: { SHOPIFY_API_KEY: 'key', SHOPIFY_API_SECRET: 'secret' },
    log: { error: vi.fn(), info: vi.fn() },
  } as unknown as FastifyInstance;
}

function store(over: Partial<Store>): Store {
  return {
    id: 's1',
    shopDomain: 'demo.myshopify.com',
    accessToken: 'enc',
    refreshToken: 'encrefresh',
    tokenExpiresAt: new Date(NOW.getTime() + 3600_000),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 90 * 86400_000),
    ...over,
  } as Store;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('toTokenGrant', () => {
  it('derives both expiries from the response', () => {
    const g = toTokenGrant(
      {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
      },
      NOW,
    );
    expect(g.accessToken).toBe('at');
    expect(g.refreshToken).toBe('rt');
    expect(g.expiresAt?.toISOString()).toBe('2026-07-28T13:00:00.000Z');
    expect(g.refreshTokenExpiresAt?.toISOString()).toBe('2026-10-26T12:00:00.000Z');
  });

  it('trusts refresh_token_expires_in over the documented 90 days', () => {
    // Shopify has been observed returning materially shorter windows; assuming
    // 90d would leave us treating a dead refresh token as usable.
    const g = toTokenGrant(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600, refresh_token_expires_in: 600 },
      NOW,
    );
    expect(g.refreshTokenExpiresAt?.toISOString()).toBe('2026-07-28T12:10:00.000Z');
  });

  it('marks a response with no refresh_token as a perpetual token', () => {
    const g = toTokenGrant({ access_token: 'at' }, NOW);
    expect(g.refreshToken).toBeNull();
    expect(g.expiresAt).toBeNull();
    expect(g.refreshTokenExpiresAt).toBeNull();
  });
});

describe('needsRefresh', () => {
  it('never refreshes a legacy row that has no refresh token', () => {
    expect(needsRefresh(store({ refreshToken: null, tokenExpiresAt: null }), NOW)).toBe(false);
  });

  it('is false while the token has comfortable life left', () => {
    expect(needsRefresh(store({}), NOW)).toBe(false);
  });

  it('is true once expired', () => {
    expect(needsRefresh(store({ tokenExpiresAt: new Date(NOW.getTime() - 1000) }), NOW)).toBe(true);
  });

  it('refreshes ahead of expiry, not at it, to cover skew and in-flight time', () => {
    // 2 min left — inside the 5 min skew window.
    expect(needsRefresh(store({ tokenExpiresAt: new Date(NOW.getTime() + 120_000) }), NOW)).toBe(
      true,
    );
    // 10 min left — outside it.
    expect(needsRefresh(store({ tokenExpiresAt: new Date(NOW.getTime() + 600_000) }), NOW)).toBe(
      false,
    );
  });
});

describe('refreshAccessToken', () => {
  it('posts grant_type=refresh_token and returns the new grant', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        refresh_token_expires_in: 7776000,
      }),
    );
    const g = await refreshAccessToken(
      fakeApp(),
      'demo.myshopify.com',
      'old-rt',
      fetchImpl as unknown as typeof fetch,
    );

    expect(g.accessToken).toBe('new-at');
    expect(g.refreshToken).toBe('new-rt');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.myshopify.com/admin/oauth/access_token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-rt',
    });
  });

  it('retries a 5xx with the same refresh token and succeeds', async () => {
    // Shopify rotates server-side before replying, so a retry must reuse the
    // original token — its 1h idempotency window returns the same new grant.
    // Sending a different token here would consume nothing and lock the store out.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'at2', refresh_token: 'rt2' }));

    const g = await refreshAccessToken(
      fakeApp(),
      'demo.myshopify.com',
      'old-rt',
      fetchImpl as unknown as typeof fetch,
    );

    expect(g.accessToken).toBe('at2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(JSON.parse(init.body as string).refresh_token).toBe('old-rt');
    }
  });

  it('does not retry a 4xx — the refresh token is genuinely dead', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    await expect(
      refreshAccessToken(
        fakeApp(),
        'demo.myshopify.com',
        'dead-rt',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED', statusCode: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces SHOPIFY_REAUTH_REQUIRED after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const err = await refreshAccessToken(
      fakeApp(),
      'demo.myshopify.com',
      'rt',
      fetchImpl as unknown as typeof fetch,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('SHOPIFY_REAUTH_REQUIRED');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries network-level failures, which give no signal about rotation', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'at3', refresh_token: 'rt3' }));

    const g = await refreshAccessToken(
      fakeApp(),
      'demo.myshopify.com',
      'rt',
      fetchImpl as unknown as typeof fetch,
    );
    expect(g.accessToken).toBe('at3');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('shopifyAdminFetch refresh-on-401', () => {
  it('refreshes once and retries when a token lapses mid-run', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onUnauthorized = vi.fn(async () => 'fresh-token');

    const res = await shopifyAdminFetch(
      'demo.myshopify.com',
      'stale-token',
      '/products.json',
      {},
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onUnauthorized,
      },
    );

    expect(res.status).toBe(200);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const headersOf = (i: number) =>
      (fetchImpl.mock.calls[i][1] as RequestInit).headers as Record<string, string>;
    expect(headersOf(0)['X-Shopify-Access-Token']).toBe('stale-token');
    expect(headersOf(1)['X-Shopify-Access-Token']).toBe('fresh-token');
  });

  it('does not retry when the refresh hands back the same token', async () => {
    // The token was already current, so the 401 is a real authorization
    // failure. Retrying identically would just spend a second call to fail.
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const onUnauthorized = vi.fn(async () => 'same-token');

    await expect(
      shopifyAdminFetch(
        'demo.myshopify.com',
        'same-token',
        '/products.json',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          onUnauthorized,
        },
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves 403 alone — a scope verdict survives any refresh', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const onUnauthorized = vi.fn(async () => 'fresh-token');

    await expect(
      shopifyAdminFetch(
        'demo.myshopify.com',
        'tok',
        '/themes.json',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          onUnauthorized,
        },
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still accepts a bare fetch as the fifth argument', async () => {
    // Existing callers pass fetchImpl positionally; that shape must keep working.
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const res = await shopifyAdminFetch(
      'demo.myshopify.com',
      'tok',
      '/products.json',
      {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
