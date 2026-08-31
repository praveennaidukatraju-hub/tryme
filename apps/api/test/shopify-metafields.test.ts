import { createLogger } from '@tryme/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  writeWidgetConfigMetafield,
  writeWidgetKeyMetafield,
} from '../src/modules/shopify/metafields.js';

const log = createLogger('test');

describe('writeWidgetKeyMetafield', () => {
  it('upserts the widget key as a shop metafield via metafieldsSet', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await writeWidgetKeyMetafield(
      'shop.myshopify.com',
      'shpat_token',
      4242,
      'wk-123',
      log,
      fakeFetch as unknown as typeof fetch,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/admin/api/');
    expect(calls[0].url).toContain('/graphql.json');
    const sent = calls[0].body as { query: string; variables: { metafields: unknown[] } };
    expect(sent.query).toContain('mutation SetShopMetafield');
    expect(sent.variables.metafields[0]).toEqual({
      ownerId: 'gid://shopify/Shop/4242',
      namespace: 'tryme',
      key: 'widget_key',
      type: 'single_line_text_field',
      value: 'wk-123',
    });
  });

  it('does not throw when the request fails', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(
      writeWidgetKeyMetafield(
        'shop.myshopify.com',
        'shpat_token',
        4242,
        'wk-123',
        log,
        fakeFetch as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not throw when fetch itself rejects', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      writeWidgetKeyMetafield(
        'shop.myshopify.com',
        'shpat_token',
        4242,
        'wk-123',
        log,
        fakeFetch as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not throw even on SHOPIFY_REAUTH_REQUIRED (unlike writeWidgetConfigMetafield)', async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(
      writeWidgetKeyMetafield(
        'shop.myshopify.com',
        'shpat_expired',
        123,
        'wk-expired',
        log,
        fakeFetch as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('writeWidgetConfigMetafield', () => {
  it('propagates Shopify reauthorization failures', async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(
      writeWidgetConfigMetafield(
        'shop.myshopify.com',
        'shpat_expired',
        123,
        { copy: { heading: 'Fit check' } },
        log,
        fakeFetch as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED', statusCode: 403 });
  });
});
