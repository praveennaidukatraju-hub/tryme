import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { numericIdFromGid, type SyncTask, shopifyGraphQL, toGid } from './service.js';
import { getValidAccessToken } from './token.js';

/**
 * Normalized product shape consumed by syncProduct.
 *
 * Deliberately not Shopify's wire format: syncProduct is business logic and is
 * tested directly, so the GraphQL response is mapped into this at the fetch
 * boundary by toShopifyProduct below.
 */
export interface ShopifyProduct {
  id: number;
  title: string;
  imageUrl?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  vendor?: string | null;
  collections?: string[] | null;
}

/** Minimal shape we need from a fetch Response — lets tests pass a plain object
 *  (e.g. `headers: new Map(...)`) without reaching for `any`. */
interface FetchLikeResponse {
  ok: boolean;
  status?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null | undefined };
}
type FetchLike = (url: string, init?: RequestInit) => Promise<FetchLikeResponse>;

const ALLOWED_HOSTS = /(^|\.)(myshopify\.com|shopify\.com|cdn\.shopify\.com)$/;
const FETCH_TIMEOUT_MS = 10_000;

// Shopify product-level garment rows (no specific variant) are stored with this
// sentinel instead of NULL. Postgres UNIQUE constraints treat every NULL as distinct
// from every other NULL, so `ON CONFLICT (store_id, product_id, variant_id)` would
// never match an existing NULL-variant row on a repeat sync — each full/product sync
// would INSERT a fresh duplicate row instead of updating the one already there.
// Real Shopify variant IDs are large positive bigints, so 0 can never collide with one.
const NO_VARIANT_SENTINEL = 0;

export function assertShopifyCdn(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('image url must be https');
  if (!ALLOWED_HOSTS.test(u.hostname)) throw new Error(`image host not allowed: ${u.hostname}`);
}

// Shared selection set. Product.collections returns titles inline, which is why
// there is no longer a collects.json call or a collection-title map here: the
// REST version needed one extra request per product to learn the same thing.
//
// collections(first: 25) caps what REST paginated fully. That is safe because
// shopify_product_garments.collections is written and never read — activation
// resolves membership through shopify_collection_products (populated by
// collections.sync.ts), not this column.
const PRODUCT_FIELDS = `
  id
  title
  productType
  tags
  vendor
  featuredImage { url }
  collections(first: 25) { nodes { title } }
`;

const PRODUCTS_PAGE = `
  query ProductsPage($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const ONE_PRODUCT = `
  query OneProduct($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

interface GraphQLProductNode {
  id: string;
  title: string;
  productType?: string | null;
  tags?: string[] | null;
  vendor?: string | null;
  featuredImage?: { url?: string | null } | null;
  collections?: { nodes: Array<{ title: string }> } | null;
}

interface ProductsPageData {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GraphQLProductNode[];
  };
}

/** GraphQL wire shape → the normalized shape syncProduct consumes. */
function toShopifyProduct(node: GraphQLProductNode): ShopifyProduct {
  return {
    id: numericIdFromGid(node.id),
    title: node.title,
    imageUrl: node.featuredImage?.url ?? null,
    // Empty string is Shopify's "unset" for these, and the columns are nullable.
    productType: node.productType || null,
    tags: node.tags && node.tags.length > 0 ? node.tags : null,
    vendor: node.vendor || null,
    collections: node.collections?.nodes.map((c) => c.title) ?? null,
  };
}

async function upsertGarment(
  app: FastifyInstance,
  storeId: string,
  productId: number,
  r2Key: string,
  title: string,
  status: string,
  productType: string | null,
  tags: string[] | null,
  vendor: string | null,
  collections: string[] | null,
  failedReason?: string,
) {
  const [row] = await app.db
    .insert(schema.shopifyProductGarments)
    .values({
      storeId,
      shopifyProductId: productId,
      shopifyVariantId: NO_VARIANT_SENTINEL,
      r2Key,
      title,
      status,
      productType,
      tags,
      vendor,
      collections,
      failedReason,
    })
    .onConflictDoUpdate({
      target: [
        schema.shopifyProductGarments.storeId,
        schema.shopifyProductGarments.shopifyProductId,
        schema.shopifyProductGarments.shopifyVariantId,
      ],
      set: {
        title,
        status,
        productType,
        tags,
        vendor,
        collections,
        failedReason: failedReason ?? null,
        syncedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

/** Records a failed sync for a product we couldn't even fetch from Shopify
 *  (deleted, wrong API scope, deprecated REST resource, etc.) — no product
 *  data is available, so title/productType/tags/vendor/collections stay null. */
async function upsertGarmentFailure(
  app: FastifyInstance,
  storeId: string,
  productId: number,
  failedReason: string,
): Promise<void> {
  const r2Key = `shopify-garments/${storeId}/${productId}/garment.jpg`;
  await upsertGarment(
    app,
    storeId,
    productId,
    r2Key,
    '',
    'failed',
    null,
    null,
    null,
    null,
    failedReason,
  );
}

export async function syncProduct(
  app: FastifyInstance,
  storeId: string,
  product: ShopifyProduct,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  const r2Key = `shopify-garments/${storeId}/${product.id}/garment.jpg`;
  const productType = product.productType ?? null;
  const tags = product.tags ?? null;
  const vendor = product.vendor ?? null;
  const collections = product.collections ?? null;
  const src = product.imageUrl;
  if (!src) {
    await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'failed',
      productType,
      tags,
      vendor,
      collections,
      'no product image',
    );
    return;
  }
  try {
    assertShopifyCdn(src);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: FetchLikeResponse;
    try {
      res = await fetchFn(src, { redirect: 'error', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const maxSyncBytes = await getUploadLimitBytes(app, 'shopifyProductSyncMaxBytes');
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxSyncBytes) {
      throw new Error(`product image exceeds ${maxSyncBytes / (1024 * 1024)}MB`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxSyncBytes) {
      throw new Error(`product image exceeds ${maxSyncBytes / (1024 * 1024)}MB`);
    }
    const buf = Buffer.from(arrayBuffer);
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    await app.storage.putObject(r2Key, buf, ct);
    await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'active',
      productType,
      tags,
      vendor,
      collections,
    );
  } catch (err) {
    app.log.warn({ err, storeId, productId: product.id }, 'product sync failed');
    await upsertGarment(
      app,
      storeId,
      product.id,
      r2Key,
      product.title,
      'failed',
      productType,
      tags,
      vendor,
      collections,
      (err as Error).message,
    );
  }
}

export async function syncOneTask(app: FastifyInstance, task: SyncTask): Promise<void> {
  const [store] = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.id, task.storeId))
    .limit(1);
  if (!store || store.uninstalledAt) return;
  // Refreshed up front rather than decrypted: this runs unattended, so there is
  // no merchant present to reauthorize if the stored token has aged out.
  let token = await getValidAccessToken(app, store);
  const shop = store.shopDomain;
  // A full sync of a large catalog outlives the one-hour token: 250 products a
  // page, a collects call each, throttled. Re-reading through
  // getValidAccessToken rather than forcing a rotation means a token another
  // process already refreshed is reused, and only a genuinely stale one is
  // rotated. Reassigning `token` also fixes up the helpers below, which read it
  // at call time.
  const onUnauthorized = async () => {
    token = await getValidAccessToken(app, store);
    return token;
  };

  if (task.mode === 'collection') {
    if (task.shopifyCollectionId === undefined) return;
    const { syncCollectionMembership, CollectionNotFoundError } = await import(
      './collections.sync.js'
    );
    const shopifyCollectionId = task.shopifyCollectionId;
    try {
      await syncCollectionMembership(app, store, shopifyCollectionId);
    } catch (err) {
      if (err instanceof CollectionNotFoundError) {
        // Confirmed deleted on Shopify's side — the selection itself is
        // meaningless now, so remove it along with the cached membership,
        // not just the membership.
        await app.db
          .delete(schema.shopifyCollections)
          .where(
            and(
              eq(schema.shopifyCollections.storeId, store.id),
              eq(schema.shopifyCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyCollectionProducts)
          .where(
            and(
              eq(schema.shopifyCollectionProducts.storeId, store.id),
              eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyEnabledCollections)
          .where(
            and(
              eq(schema.shopifyEnabledCollections.storeId, store.id),
              eq(schema.shopifyEnabledCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        await app.db
          .delete(schema.shopifyExcludedCollections)
          .where(
            and(
              eq(schema.shopifyExcludedCollections.storeId, store.id),
              eq(schema.shopifyExcludedCollections.shopifyCollectionId, shopifyCollectionId),
            ),
          );
        app.log.info(
          { storeId: task.storeId, shopifyCollectionId },
          'collection deleted on Shopify — removed selection and cached membership',
        );
        return;
      }
      // Anything else (rate limit, 5xx, network) is not a deletion — log and
      // let next cycle's tick re-enqueue this same collection. The outer
      // sync-consumer loop already isolates one task's throw from the rest of
      // the stream, so re-throwing here would be redundant, not additive.
      app.log.warn(
        { err, storeId: task.storeId, shopifyCollectionId },
        'scheduled collection resync failed — will retry next cycle',
      );
    }
    return;
  }

  if (task.mode === 'product' && task.shopifyProductId) {
    let node: GraphQLProductNode | null;
    try {
      const data = await shopifyGraphQL<{ product: GraphQLProductNode | null }>(
        shop,
        token,
        ONE_PRODUCT,
        { id: toGid('Product', task.shopifyProductId) },
        { onUnauthorized },
      );
      node = data.product;
    } catch (err) {
      // SHOPIFY_REAUTH_REQUIRED is a store-wide auth failure, not a per-product
      // one — blanking this one garment row doesn't address it, and the whole
      // store needs reauth. Propagate it exactly as the old REST code did,
      // rather than letting it fall into the generic "couldn't fetch" path
      // below and blank a healthy, previously-synced product out of the
      // storefront widget until the next successful sync.
      if (err instanceof AppError && err.code === 'SHOPIFY_REAUTH_REQUIRED') throw err;
      // Previously a silent no-op: no row, no log — a persistently-failing
      // product re-enqueued via customer.routes.ts on every try-on attempt and
      // never left a trace to debug from.
      app.log.warn(
        { err, storeId: store.id, productId: task.shopifyProductId },
        'shopify product fetch failed during sync',
      );
      await upsertGarmentFailure(
        app,
        store.id,
        task.shopifyProductId,
        `product fetch failed: ${(err as Error).message}`,
      );
      return;
    }

    if (!node) {
      app.log.warn(
        { storeId: store.id, productId: task.shopifyProductId },
        'shopify product not found during sync',
      );
      await upsertGarmentFailure(
        app,
        store.id,
        task.shopifyProductId,
        'product not found on Shopify',
      );
      return;
    }

    await syncProduct(app, store.id, toShopifyProduct(node));
    return;
  }

  // Full sync, 25 products a page. Page size is bounded by Shopify's calculated
  // query cost (1000 per query): products(25) with a nested collections(25) is
  // roughly 25 + 25×25 = 650.
  let cursor: string | null = null;
  do {
    // onUnauthorized reassigns the outer `token`: a full sync of a large catalog
    // outlives the one-hour token, and this runs unattended with no merchant
    // present to reauthorize.
    const data: ProductsPageData = await shopifyGraphQL<ProductsPageData>(
      shop,
      token,
      PRODUCTS_PAGE,
      { cursor },
      { onUnauthorized },
    );
    for (const node of data.products.nodes) {
      await syncProduct(app, store.id, toShopifyProduct(node));
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (cursor) await new Promise((r) => setTimeout(r, 500)); // throttle
  } while (cursor);
}
