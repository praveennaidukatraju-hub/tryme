import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { numericIdFromGid, shopifyGraphQL, toGid } from './service.js';
import { getValidAccessToken } from './token.js';

/**
 * Thrown when Shopify reports no collection at this id — i.e. it was deleted.
 * The scheduled resync treats this specifically as "clean up this collection's
 * rows"; every other failure (rate limit, 5xx, network) throws from
 * shopifyGraphQL instead and is retried next cycle unchanged.
 */
export class CollectionNotFoundError extends Error {
  constructor(shopifyCollectionId: number) {
    super(`collection ${shopifyCollectionId} not found`);
    this.name = 'CollectionNotFoundError';
  }
}

const COLLECTION_MEMBERS = `
  query CollectionMembers($id: ID!, $cursor: String) {
    collection(id: $id) {
      title
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

interface CollectionMembersData {
  collection: {
    title: string;
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string }>;
    };
  } | null;
}

const COLLECTION_LIST = `
  query CollectionList($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
`;

interface CollectionListData {
  collections: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; title: string }>;
  };
}

/**
 * One collection's title and its full membership.
 *
 * GraphQL returns both in a single query, and returns `collection: null` for a
 * deleted collection — which is the whole of the not-found detection. The REST
 * version needed two probing fetches (custom then smart) plus explicit status
 * discrimination to reach the same conclusion.
 */
async function fetchCollectionTitleAndMembers(
  shop: string,
  token: string,
  shopifyCollectionId: number,
): Promise<{ title: string; productIds: number[] }> {
  const id = toGid('Collection', shopifyCollectionId);
  const productIds: number[] = [];
  let title = '';
  let cursor: string | null = null;

  do {
    const data: CollectionMembersData = await shopifyGraphQL<CollectionMembersData>(
      shop,
      token,
      COLLECTION_MEMBERS,
      { id, cursor },
    );
    if (!data.collection) throw new CollectionNotFoundError(shopifyCollectionId);
    title = data.collection.title;
    for (const node of data.collection.products.nodes) {
      productIds.push(numericIdFromGid(node.id));
    }
    const page = data.collection.products.pageInfo;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor);

  return { title, productIds };
}

/**
 * id → title for every collection on the store.
 *
 * GraphQL exposes one `collections` connection, so the REST split between
 * custom_collections and smart_collections is gone.
 */
export async function fetchCollectionTitleMap(
  shop: string,
  token: string,
): Promise<Map<number, string>> {
  const titleById = new Map<number, string>();
  let cursor: string | null = null;

  do {
    const data: CollectionListData = await shopifyGraphQL<CollectionListData>(
      shop,
      token,
      COLLECTION_LIST,
      { cursor },
    );
    for (const node of data.collections.nodes) {
      titleById.set(numericIdFromGid(node.id), node.title);
    }
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);

  return titleById;
}

/**
 * Pulls one collection's title and full membership from Shopify and replaces
 * (not diffs) that collection's rows in `shopify_collection_products`, in one
 * transaction — a failure here must not leave a collection showing partial
 * membership.
 */
export async function syncCollectionMembership(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyCollectionId: number,
): Promise<{ title: string; productCount: number }> {
  const token = await getValidAccessToken(app, store);
  const { title, productIds } = await fetchCollectionTitleAndMembers(
    store.shopDomain,
    token,
    shopifyCollectionId,
  );

  await app.db.transaction(async (tx) => {
    await tx
      .insert(schema.shopifyCollections)
      .values({ storeId: store.id, shopifyCollectionId, title })
      .onConflictDoUpdate({
        target: [schema.shopifyCollections.storeId, schema.shopifyCollections.shopifyCollectionId],
        set: { title, syncedAt: new Date() },
      });

    await tx
      .delete(schema.shopifyCollectionProducts)
      .where(
        and(
          eq(schema.shopifyCollectionProducts.storeId, store.id),
          eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
        ),
      );

    if (productIds.length > 0) {
      await tx.insert(schema.shopifyCollectionProducts).values(
        productIds.map((shopifyProductId) => ({
          storeId: store.id,
          shopifyCollectionId,
          shopifyProductId,
        })),
      );
    }
  });

  return { title, productCount: productIds.length };
}

/**
 * Live search over every collection, for the "Add collections"/"Exclude
 * collections" picker modal.
 *
 * Fetches the full list and filters in memory. Shopify's native
 * `query: "title:*needle*"` search was considered and rejected: it tokenizes on
 * word boundaries, so it would silently change which collections a merchant
 * sees for mid-word queries. Not worth a UX regression inside a compliance
 * migration.
 */
export async function searchCollections(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  q: string,
): Promise<Array<{ shopifyCollectionId: number; title: string }>> {
  const token = await getValidAccessToken(app, store);
  const titleById = await fetchCollectionTitleMap(store.shopDomain, token);
  const needle = q.toLowerCase();
  return [...titleById.entries()]
    .filter(([, title]) => title.toLowerCase().includes(needle))
    .map(([shopifyCollectionId, title]) => ({ shopifyCollectionId, title }));
}
