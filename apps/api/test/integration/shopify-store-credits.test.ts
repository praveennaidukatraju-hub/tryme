import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  atomicDeductStore,
  grantStore,
  refundStoreAndMarkFailed,
} from '../../src/modules/credits/shopify-ledger.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('shopify-ledger', () => {
  let containers: Containers;
  let app: TestApp;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  async function makeStore(): Promise<string> {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${crypto.randomUUID()}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1e9),
        accessToken: 'enc:test',
        scope: 'read_products,write_products',
      })
      .returning({ id: schema.shopifyStores.id });
    return store.id;
  }

  it('grantStore creates a balance and is idempotent on externalRef', async () => {
    const storeId = await makeStore();
    const first = await grantStore(
      app.db,
      storeId,
      25,
      'SHOPIFY_TRIAL',
      `shopify_trial:${storeId}`,
    );
    expect(first.granted).toBe(true);
    const second = await grantStore(
      app.db,
      storeId,
      25,
      'SHOPIFY_TRIAL',
      `shopify_trial:${storeId}`,
    );
    expect(second.granted).toBe(false);
    const [row] = await app.db
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    expect(row.balance).toBe(25);
  });

  it('atomicDeductStore decrements balance and throws when insufficient', async () => {
    const storeId = await makeStore();
    await grantStore(app.db, storeId, 10, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    const balance = await atomicDeductStore(app.db, storeId, 4, crypto.randomUUID());
    expect(balance).toBe(6);
    await expect(atomicDeductStore(app.db, storeId, 100, crypto.randomUUID())).rejects.toThrow(
      'insufficient credits',
    );
  });

  it('refundStoreAndMarkFailed refunds and marks the job FAILED exactly once', async () => {
    const storeId = await makeStore();
    await grantStore(app.db, storeId, 10, 'SHOPIFY_TRIAL', `shopify_trial:${storeId}`);
    const jobId = crypto.randomUUID();
    await app.db.insert(schema.jobs).values({
      id: jobId,
      shopifyStoreId: storeId,
      status: 'QUEUED',
      creditsCharged: 3,
      source: 'shopify',
    });
    await atomicDeductStore(app.db, storeId, 3, jobId);

    const first = await refundStoreAndMarkFailed(
      app.db,
      storeId,
      3,
      jobId,
      'REFUND_ENQUEUE_FAIL',
      'ENQUEUE_FAIL',
    );
    expect(first.compensated).toBe(true);

    const second = await refundStoreAndMarkFailed(
      app.db,
      storeId,
      3,
      jobId,
      'REFUND_ENQUEUE_FAIL',
      'ENQUEUE_FAIL',
    );
    expect(second.compensated).toBe(false); // job no longer QUEUED

    const [row] = await app.db
      .select({ balance: schema.shopifyStoreCredits.balance })
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    expect(row.balance).toBe(10); // back to full, refunded exactly once
  });
});
