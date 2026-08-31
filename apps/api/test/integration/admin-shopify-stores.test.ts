import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { createVerifiedUserToken } from '../helpers/auth.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin Shopify Stores routes', () => {
  let c: Containers;
  let app: TestApp;
  let adminAuth: Record<string, string>;
  let nonAdminAuth: Record<string, string>;
  let creditedStoreId: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    adminAuth = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { token } = await createVerifiedUserToken(app, 'shopify-stores-non-admin@x.com');
    nonAdminAuth = { authorization: `Bearer ${token}` };

    const nonce = crypto.randomUUID();
    const [creditedStore] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `credited-${nonce}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1_000_000_000),
        accessToken: 'enc:credited',
        scope: 'read_products',
        installedAt: new Date('2026-08-10T10:00:00Z'),
      })
      .returning({ id: schema.shopifyStores.id });
    const [emptyStore] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `empty-${nonce}.myshopify.com`,
        shopifyShopId: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
        accessToken: 'enc:empty',
        scope: 'read_products',
        installedAt: new Date('2026-08-09T10:00:00Z'),
        uninstalledAt: new Date('2026-08-10T10:00:00Z'),
      })
      .returning({ id: schema.shopifyStores.id });
    expect(creditedStore).toBeDefined();
    expect(emptyStore).toBeDefined();
    creditedStoreId = creditedStore.id;

    await app.db.insert(schema.shopifyStoreCredits).values({
      storeId: creditedStoreId,
      balance: 42,
    });
    await app.db.insert(schema.shopifyCreditLedger).values([
      {
        storeId: creditedStoreId,
        delta: 25,
        reason: 'SHOPIFY_TRIAL',
        externalRef: `trial:${nonce}`,
        createdAt: new Date('2026-08-10T10:00:00Z'),
      },
      {
        storeId: creditedStoreId,
        delta: -3,
        reason: 'JOB_DEDUCT',
        jobId: crypto.randomUUID(),
        createdAt: new Date('2026-08-10T11:00:00Z'),
      },
      {
        storeId: creditedStoreId,
        delta: 20,
        reason: 'SHOPIFY_SUBSCRIPTION_CYCLE',
        externalRef: `cycle:${nonce}`,
        createdAt: new Date('2026-08-10T12:00:00Z'),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('lists Shopify stores with their store-scoped credit balances', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/shopify-stores',
      headers: adminAuth,
    });

    expect(res.statusCode).toBe(200);
    const stores = res.json().stores as Array<{
      id: string;
      shopDomain: string;
      balance: number;
      installedAt: string;
      uninstalledAt: string | null;
    }>;
    const credited = stores.find((store) => store.id === creditedStoreId);
    const empty = stores.find((store) => store.shopDomain.startsWith('empty-'));
    expect(credited).toMatchObject({ balance: 42 });
    expect(empty).toMatchObject({ balance: 0 });
  });

  it('lists a Shopify store ledger newest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/shopify-stores/${creditedStoreId}/ledger`,
      headers: adminAuth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ delta: number; reason: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(body.entries.map((entry) => entry.reason)).toEqual([
      'SHOPIFY_SUBSCRIPTION_CYCLE',
      'JOB_DEDUCT',
      'SHOPIFY_TRIAL',
    ]);
    expect(body.entries.map((entry) => entry.delta)).toEqual([20, -3, 25]);
    expect(body.nextCursor).toBeNull();
  });

  it('forbids non-admin sessions from both routes', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/shopify-stores',
      headers: nonAdminAuth,
    });
    const ledgerRes = await app.inject({
      method: 'GET',
      url: `/admin/shopify-stores/${creditedStoreId}/ledger`,
      headers: nonAdminAuth,
    });

    expect(listRes.statusCode).toBe(403);
    expect(ledgerRes.statusCode).toBe(403);
  });
});
