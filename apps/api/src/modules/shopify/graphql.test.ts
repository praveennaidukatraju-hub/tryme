import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { assertNoUserErrors, numericIdFromGid, shopifyGraphQL, toGid } from './service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Never actually sleeps — keeps the throttle-retry tests instant. */
const noSleep = async () => {};

describe('toGid / numericIdFromGid', () => {
  it('builds a global id from a resource and numeric id', () => {
    expect(toGid('Product', 42)).toBe('gid://shopify/Product/42');
    expect(toGid('Shop', '7')).toBe('gid://shopify/Shop/7');
  });

  it('round-trips back to the numeric id', () => {
    expect(numericIdFromGid(toGid('Collection', 500))).toBe(500);
    expect(numericIdFromGid('gid://shopify/ProductImage/111')).toBe(111);
  });

  it('throws on a malformed gid rather than returning NaN', () => {
    // A silently-NaN id would write a corrupt row, so this must be loud.
    expect(() => numericIdFromGid('not-a-gid')).toThrow(AppError);
    expect(() => numericIdFromGid('gid://shopify/Product/')).toThrow(AppError);
    expect(() => numericIdFromGid('gid://shopify/Product/abc')).toThrow(AppError);
  });
});

describe('assertNoUserErrors', () => {
  it('is a no-op for empty, undefined, or null', () => {
    expect(() => assertNoUserErrors([], 'ctx')).not.toThrow();
    expect(() => assertNoUserErrors(undefined, 'ctx')).not.toThrow();
    expect(() => assertNoUserErrors(null, 'ctx')).not.toThrow();
  });

  it('throws with the context and the first message', () => {
    expect(() =>
      assertNoUserErrors([{ field: ['value'], message: 'bad value' }], 'metafieldsSet widget_key'),
    ).toThrow(/metafieldsSet widget_key: bad value/);
  });
});

describe('shopifyGraphQL', () => {
  it('POSTs query and variables to /graphql.json and returns data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { shop: { name: 'S' } } }));

    const data = await shopifyGraphQL<{ shop: { name: string } }>(
      's.myshopify.com',
      'tok',
      'query Q { shop { name } }',
      { a: 1 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(data).toEqual({ shop: { name: 'S' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Deliberately not asserting the exact version segment — SHOPIFY_API_VERSION
    // is bumped centrally and this test must not become a second place to update.
    expect(url).toContain('https://s.myshopify.com/admin/api/');
    expect(url).toContain('/graphql.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': 'tok',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'query Q { shop { name } }',
      variables: { a: 1 },
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      shopifyGraphQL(
        's.myshopify.com',
        'tok',
        'query Q { x }',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on top-level GraphQL errors even though the status is 200', async () => {
    // A GraphQL endpoint answers 200 on a query it refused. Without this check
    // every caller would silently read undefined.
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'bad field' }] }));
    await expect(
      shopifyGraphQL(
        's.myshopify.com',
        'tok',
        'query Q { x }',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/bad field/);
  });

  it('throws when a 200 response carries no data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      shopifyGraphQL(
        's.myshopify.com',
        'tok',
        'query Q { x }',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/no data/);
  });

  it('retries a THROTTLED response and returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const data = await shopifyGraphQL<{ ok: boolean }>(
      's.myshopify.com',
      'tok',
      'query Q { ok }',
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
    );

    expect(data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 throttled attempts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
    );

    await expect(
      shopifyGraphQL(
        's.myshopify.com',
        'tok',
        'query Q { ok }',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/throttled/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('surfaces a 401 as SHOPIFY_REAUTH_REQUIRED via shopifyAdminFetch', async () => {
    // Delegated, not reimplemented — this asserts the delegation still holds.
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    await expect(
      shopifyGraphQL(
        's.myshopify.com',
        'tok',
        'query Q { x }',
        {},
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });
  });
});
