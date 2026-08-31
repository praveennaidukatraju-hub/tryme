import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countingIdentity,
  resolveShopper,
  shopperIdFilter,
} from '../src/modules/shopify/shopper.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let containers: Containers;
let app: TestApp;
let storeId: string;
let otherStoreId: string;

beforeAll(async () => {
  containers = await startContainers();
  app = await buildTestApp(containers);

  const [store, otherStore] = await app.db
    .insert(schema.shopifyStores)
    .values([
      {
        shopDomain: 'shopper-test.myshopify.com',
        shopifyShopId: 9001,
        accessToken: 'token',
        scope: 'read_products',
      },
      {
        shopDomain: 'shopper-other-store.myshopify.com',
        shopifyShopId: 9002,
        accessToken: 'token',
        scope: 'read_products',
      },
    ])
    .returning();

  storeId = store.id;
  otherStoreId = otherStore.id;
});

afterAll(async () => {
  await app?.close();
  await containers?.stop();
});

describe('resolveShopper', () => {
  it('keeps one browser row while enriching and retaining its strongest known signals', async () => {
    const first = await resolveShopper(app, storeId, {
      clientId: 'browser-one',
      email: ' First@Example.COM ',
    });
    const enriched = await resolveShopper(app, storeId, {
      clientId: 'browser-one',
      shopifyCustomerId: 501,
      email: 'Person@Example.COM',
    });
    const afterAnonymousRequest = await resolveShopper(app, storeId, {
      clientId: 'browser-one',
      shopifyCustomerId: null,
      email: null,
    });
    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.storeId, storeId));

    expect(first.id).toBe(enriched.id);
    expect(enriched.id).toBe(afterAnonymousRequest.id);
    expect(afterAnonymousRequest).toMatchObject({
      clientId: 'browser-one',
      shopifyCustomerId: 501,
      email: 'person@example.com',
    });
    expect(afterAnonymousRequest.emailCapturedAt).toBeInstanceOf(Date);
    expect(rows.filter((row) => row.clientId === 'browser-one')).toHaveLength(1);
  });
});

describe('shopperIdFilter', () => {
  it('selects every browser sharing the email identity in this store only', async () => {
    const first = await resolveShopper(app, storeId, {
      clientId: 'browser-email-one',
      email: 'Shared@Example.COM',
    });
    await resolveShopper(app, storeId, {
      clientId: 'browser-email-two',
      email: 'shared@example.com',
    });
    await resolveShopper(app, otherStoreId, {
      clientId: 'browser-other-store',
      email: 'shared@example.com',
    });

    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(shopperIdFilter(storeId, countingIdentity(first)));

    expect(rows.map((row) => row.clientId).sort()).toEqual([
      'browser-email-one',
      'browser-email-two',
    ]);
  });
});
