import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { createVerifiedUserToken } from './helpers/auth.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/me hasShopifyStore', () => {
  it('is false for a user with no linked store', async () => {
    const { token } = await createVerifiedUserToken(app, `no-store-${randomUUID()}@test.com`);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(false);
  });

  it('is true once a shopify_stores row has ownerUserId set to this user', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `has-store-${randomUUID()}@test.com`,
    );
    await app.db.insert(schema.shopifyStores).values({
      shopDomain: `flag-test-${randomUUID()}.myshopify.com`,
      shopifyShopId: Date.now(),
      accessToken: 'enc',
      scope: 'read_products',
      ownerUserId: userId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(true);
  });

  it('is false again once the linked store is uninstalled', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `uninstalled-store-${randomUUID()}@test.com`,
    );
    await app.db.insert(schema.shopifyStores).values({
      shopDomain: `uninstalled-flag-test-${randomUUID()}.myshopify.com`,
      shopifyShopId: Date.now(),
      accessToken: 'enc',
      scope: 'read_products',
      ownerUserId: userId,
      uninstalledAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(false);
  });
});
