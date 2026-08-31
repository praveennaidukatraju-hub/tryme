import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
let c: Containers;
let app: TestApp;
let storeId: string;
let storeKey: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { SHOPIFY_TOKEN_ENC_KEY: ENC_KEY });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 91,
      shopDomain: 'ev.myshopify.com',
      myshopifyDomain: 'ev.myshopify.com',
      name: 'EV',
      email: 'ev@ev.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  storeKey = store.storeKey;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

function post(payload: unknown, key: string | null = storeKey) {
  return app.inject({
    method: 'POST',
    url: '/v1/shopify/customer/event',
    // A real widget always sends Origin cross-origin; requireShopifyStoreKey
    // checks it against allowedOrigins (non-empty here since upsertShopifyStore
    // seeds it from myshopifyDomain), so the fixture must supply it too.
    headers: { ...(key ? { 'x-widget-key': key } : {}), origin: 'https://ev.myshopify.com' },
    payload,
  });
}

async function events() {
  return app.db
    .select()
    .from(schema.shopifyWidgetEvents)
    .where(eq(schema.shopifyWidgetEvents.storeId, storeId));
}

describe('POST /v1/shopify/customer/event', () => {
  it('records a client event and answers 204', async () => {
    const clientId = randomUUID();
    const res = await post({
      type: 'add_to_cart',
      clientId,
      shopifyProductId: 555,
      device: 'mobile',
    });

    expect(res.statusCode).toBe(204);
    const rows = await events();
    const row = rows.find((r) => r.clientId === clientId);
    expect(row).toMatchObject({
      type: 'add_to_cart',
      shopifyProductId: 555,
      device: 'mobile',
    });
  });

  it('accepts a payload with no clientId', async () => {
    const res = await post({ type: 'button_click' });
    expect(res.statusCode).toBe(204);
  });

  it('rejects a missing store key', async () => {
    const res = await post({ type: 'button_click' }, null);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown event type', async () => {
    const res = await post({ type: 'nonsense' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a server-only refusal type submitted by a client', async () => {
    // Otherwise a shopper could manufacture refusals that never happened and
    // make a merchant think their caps are costing them traffic.
    const res = await post({ type: 'refused_store_cap' });
    expect(res.statusCode).toBe(400);
  });

  it('drops events over the rate limit with a 204 and writes nothing', async () => {
    // A 429 would surface in the widget's hot path. Analytics is allowed to
    // lose data; a shopper's try-on is not allowed to break.
    await app.redis.set(`shopify:events:rl:${storeId}`, '99999', 'EX', 60);
    const before = (await events()).length;

    const res = await post({ type: 'share', clientId: randomUUID() });

    expect(res.statusCode).toBe(204);
    expect((await events()).length).toBe(before);
    await app.redis.del(`shopify:events:rl:${storeId}`);
  });
});
