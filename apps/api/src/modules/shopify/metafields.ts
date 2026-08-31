import type { ShopifyWidgetConfig } from '@tryme/db';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoUserErrors, type GraphQLUserError, shopifyGraphQL, toGid } from './service.js';

// One mutation serves both metafields. metafieldsSet is an upsert, which is
// what REST POST /metafields.json is not: that endpoint 422s when a metafield
// with the same namespace/key already exists, which is exactly what happens on
// every reinstall.
const METAFIELDS_SET = `
  mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

interface MetafieldsSetData {
  metafieldsSet?: { userErrors?: GraphQLUserError[] };
}

/** Throws on any failure. The two exported wrappers below own the swallowing. */
async function setShopMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  key: string,
  type: string,
  value: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const data = await shopifyGraphQL<MetafieldsSetData>(
    shop,
    accessToken,
    METAFIELDS_SET,
    {
      metafields: [
        {
          ownerId: toGid('Shop', shopifyShopId),
          namespace: 'tryme',
          key,
          type,
          value,
        },
      ],
    },
    { fetchImpl: fetchFn },
  );

  const result = data.metafieldsSet;
  if (!result) throw new AppError('SHOPIFY', 502, 'metafieldsSet missing from response');
  assertNoUserErrors(result.userErrors, `metafieldsSet ${key}`);
}

/**
 * Never throws. Runs inside the OAuth callback, where a metafield mirror
 * failure must not consume a valid callback and strand the merchant.
 */
export async function writeWidgetKeyMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  widgetKey: string,
  log: FastifyBaseLogger,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await setShopMetafield(
      shop,
      accessToken,
      shopifyShopId,
      'widget_key',
      'single_line_text_field',
      widgetKey,
      fetchFn,
    );
  } catch (err) {
    log.error({ err, shop }, 'failed to write widget_key metafield');
  }
}

/**
 * Returns false rather than throwing — Postgres is authoritative for widget
 * config and a failed mirror surfaces to the merchant as `synced: false`.
 * SHOPIFY_REAUTH_REQUIRED is the one exception: it must propagate so the SPA
 * can send the merchant through reauth.
 */
export async function writeWidgetConfigMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  config: ShopifyWidgetConfig,
  log: FastifyBaseLogger,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await setShopMetafield(
      shop,
      accessToken,
      shopifyShopId,
      'widget_config',
      'json',
      JSON.stringify(config),
      fetchFn,
    );
    return true;
  } catch (err) {
    if (err instanceof AppError && err.code === 'SHOPIFY_REAUTH_REQUIRED') throw err;
    log.error({ err, shop }, 'failed to write widget_config metafield');
    return false;
  }
}
