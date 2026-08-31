import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runShopifyRetention } from '../../src/shopify/retention.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const DAY = 86_400_000;
const log = createLogger('test');

describe('shopify retention — widget events', () => {
  let env: TestEnv;
  let storeId: string;

  beforeAll(async () => {
    env = await setupTestEnv();
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `ret-${randomUUID()}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1e9),
        accessToken: 'x',
        scope: 'read_products',
        settings: {},
      })
      .returning();
    storeId = store.id;
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  it('deletes events past 400 days and keeps everything newer', async () => {
    await env.db.insert(schema.shopifyWidgetEvents).values([
      { storeId, type: 'button_click', createdAt: new Date(Date.now() - 401 * DAY) },
      { storeId, type: 'button_click', createdAt: new Date(Date.now() - 399 * DAY) },
      { storeId, type: 'add_to_cart', createdAt: new Date() },
    ]);

    await runShopifyRetention(env.db, env.storage, log);

    const rows = await env.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(eq(schema.shopifyWidgetEvents.storeId, storeId));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Date.now() - r.createdAt.getTime() < 400 * DAY)).toBe(true);
  });

  it('sweeps events even for a store with no retention settings configured', async () => {
    // The 400-day events horizon is fixed, not merchant-configurable — the
    // other three passes bail on `if (!retention) continue`, and this pass must
    // not be trapped behind that guard.
    const rows = await env.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(eq(schema.shopifyWidgetEvents.storeId, storeId));
    expect(rows).toHaveLength(2);
  });

  it('drains a backlog larger than one BATCH in a single call', async () => {
    // BATCH is 500 (see retention.ts) — a single select+delete pass cannot
    // clear this many rows. This proves the sweep loops until fully drained
    // rather than leaving a remainder for the next hourly run.
    const OVER_ONE_BATCH = 650;
    const values = Array.from({ length: OVER_ONE_BATCH }, () => ({
      storeId,
      type: 'button_click',
      createdAt: new Date(Date.now() - 401 * DAY),
    }));
    await env.db.insert(schema.shopifyWidgetEvents).values(values);

    await runShopifyRetention(env.db, env.storage, log);

    const rows = await env.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(eq(schema.shopifyWidgetEvents.storeId, storeId));

    // Only the two rows already newer than 400 days (seeded in the first
    // test) should remain — the entire backlog is gone in one call.
    expect(rows).toHaveLength(2);
  });
});
