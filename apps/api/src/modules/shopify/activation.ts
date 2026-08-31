import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface EffectiveEnablementInput {
  mode: 'global' | 'selective';
  individuallyEnabled: boolean;
  individuallyExcluded: boolean;
  inEnabledCollection: boolean;
  inExcludedCollection: boolean;
}

/**
 * The one place the activation precedence rule is allowed to live. Exclusion
 * is checked first in every branch, including under global mode — a product
 * excluded while global mode is on stays excluded. Every other caller in this
 * codebase (the try-on enforcement point, every list endpoint, every summary
 * count) must go through this function or `resolveEffectiveEnabled` rather
 * than re-deriving the rule.
 */
export function computeEffectiveEnabled(input: EffectiveEnablementInput): boolean {
  if (input.individuallyExcluded || input.inExcludedCollection) return false;
  if (input.mode === 'global') return true;
  return input.individuallyEnabled || input.inEnabledCollection;
}

async function isInCollectionSet(
  app: FastifyInstance,
  storeId: string,
  shopifyProductId: number,
  collectionSetTable:
    | typeof schema.shopifyEnabledCollections
    | typeof schema.shopifyExcludedCollections,
): Promise<boolean> {
  const [row] = await app.db
    .select({ one: sql<number>`1` })
    .from(schema.shopifyCollectionProducts)
    .innerJoin(
      collectionSetTable,
      and(
        eq(collectionSetTable.storeId, schema.shopifyCollectionProducts.storeId),
        eq(
          collectionSetTable.shopifyCollectionId,
          schema.shopifyCollectionProducts.shopifyCollectionId,
        ),
      ),
    )
    .where(
      and(
        eq(schema.shopifyCollectionProducts.storeId, storeId),
        eq(schema.shopifyCollectionProducts.shopifyProductId, shopifyProductId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * DB-backed wrapper around `computeEffectiveEnabled` for a single product.
 * Two collection-membership lookups plus the pure resolver — this is the
 * function `customer.routes.ts` calls at the actual try-on enforcement point.
 */
export async function resolveEffectiveEnabled(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  garment: { shopifyProductId: number; enabled: boolean; excluded: boolean },
): Promise<boolean> {
  const [inEnabledCollection, inExcludedCollection] = await Promise.all([
    isInCollectionSet(app, store.id, garment.shopifyProductId, schema.shopifyEnabledCollections),
    isInCollectionSet(app, store.id, garment.shopifyProductId, schema.shopifyExcludedCollections),
  ]);

  return computeEffectiveEnabled({
    mode: store.settings.activation?.mode ?? 'selective',
    individuallyEnabled: garment.enabled,
    individuallyExcluded: garment.excluded,
    inEnabledCollection,
    inExcludedCollection,
  });
}
