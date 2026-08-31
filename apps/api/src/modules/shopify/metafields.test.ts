import { describe, expect, it, vi } from 'vitest';
import { writeWidgetConfigMetafield } from './metafields.js';

const log = { error: vi.fn(), info: vi.fn() } as never;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('writeWidgetConfigMetafield', () => {
  it('posts a metafieldsSet mutation scoped to the shop and returns true', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { metafieldsSet: { userErrors: [] } } }));

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      4242,
      { theme: { accentColor: '#ff0000' } },
      log,
      fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/graphql.json');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': 'tok',
    });
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.query).toContain('mutation SetShopMetafield');
    const mf = sent.variables.metafields[0];
    expect(mf.ownerId).toBe('gid://shopify/Shop/4242');
    expect(mf.namespace).toBe('tryme');
    expect(mf.key).toBe('widget_config');
    expect(mf.type).toBe('json');
    expect(JSON.parse(mf.value)).toEqual({ theme: { accentColor: '#ff0000' } });
  });

  it('returns false when Shopify reports userErrors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { metafieldsSet: { userErrors: [{ field: ['value'], message: 'bad' }] } },
      }),
    );

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      1,
      {},
      log,
      fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(false);
  });

  it('returns false when Shopify reports top-level GraphQL errors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: 'invalid mutation' }] }));

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      1,
      {},
      log,
      fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(false);
  });

  it('returns false when Shopify omits metafieldsSet from a 200 response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));

    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      1,
      {},
      log,
      fetchFn as unknown as typeof fetch,
    );

    expect(ok).toBe(false);
  });

  it('returns false on a non-ok HTTP response instead of throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      1,
      {},
      log,
      fetchFn as unknown as typeof fetch,
    );
    expect(ok).toBe(false);
  });

  it('returns false when the network call throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('boom'));
    const ok = await writeWidgetConfigMetafield(
      's.myshopify.com',
      'tok',
      1,
      {},
      log,
      fetchFn as unknown as typeof fetch,
    );
    expect(ok).toBe(false);
  });
});
