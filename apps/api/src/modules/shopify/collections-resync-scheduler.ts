import { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { enqueueSync } from './service.js';

/**
 * One tick: enqueue a `collection`-mode sync task for every (store, collection)
 * pair currently selected in either the enabled or excluded set. A store with
 * no selections triggers zero Shopify calls — this never touches a collection
 * nobody picked.
 */
export async function runResyncTick(app: FastifyInstance): Promise<void> {
  const enabled = await app.db
    .select({
      storeId: schema.shopifyEnabledCollections.storeId,
      shopifyCollectionId: schema.shopifyEnabledCollections.shopifyCollectionId,
    })
    .from(schema.shopifyEnabledCollections);
  const excluded = await app.db
    .select({
      storeId: schema.shopifyExcludedCollections.storeId,
      shopifyCollectionId: schema.shopifyExcludedCollections.shopifyCollectionId,
    })
    .from(schema.shopifyExcludedCollections);

  const pairs = new Map<string, { storeId: string; shopifyCollectionId: number }>();
  for (const row of [...enabled, ...excluded]) {
    pairs.set(`${row.storeId}:${row.shopifyCollectionId}`, row);
  }

  for (const { storeId, shopifyCollectionId } of pairs.values()) {
    await enqueueSync(app.redis, { storeId, mode: 'collection', shopifyCollectionId });
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Call once after `app.listen(...)`, alongside `startSyncConsumer(app)` —
 * mirrors that function's "start once, get a stop function back" shape.
 */
export function startCollectionResyncScheduler(
  app: FastifyInstance,
  intervalMs: number = HOUR_MS,
): () => void {
  const timer = setInterval(() => {
    void runResyncTick(app).catch((err) => {
      app.log.error({ err }, 'collection resync tick failed');
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
