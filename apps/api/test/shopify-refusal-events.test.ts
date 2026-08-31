import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

describe('refusals are recorded as server-written events', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  });

  afterAll(async () => {
    await app.close();
    await c.stop();
  });

  // Store credits are keyed by store id, not by any linked user — this map
  // just lets seedStore look up the balance a preceding seedOwner call meant
  // for it, mirroring the same pattern in shopify-customer.test.ts /
  // shopify-limits.test.ts.
  const ownerBalances = new Map<string, number>();

  async function seedOwner(balance: number) {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `owner-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Store Owner',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    ownerBalances.set(user.id, balance);
    return user;
  }

  let shopIdCounter = 0;
  async function seedStore(ownerUserId: string | null) {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() * 1000 + shopIdCounter++,
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();
    const balance = ownerUserId ? ownerBalances.get(ownerUserId) : undefined;
    if (balance !== undefined) {
      await app.db.insert(schema.shopifyStoreCredits).values({ storeId: store.id, balance });
    }
    return store;
  }

  // The single default funnel template every product now resolves. Created
  // lazily so tests that don't need it aren't forced to pay for it.
  let defaultFunnelTemplateId: string | null = null;
  async function seedDefaultFunnelTemplate() {
    if (defaultFunnelTemplateId) return defaultFunnelTemplateId;
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `shopify-tryon-${Date.now()}`,
        label: 'Shopify try-on test workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        garmentPhasePromptNode: '6',
        workflowType: 'tryon',
        tryonPersonNodeId: '10',
        tryonGarmentNodeId: '11',
        tryonOutputNodeId: '12',
      })
      .returning();
    const [funnel] = await app.db
      .insert(schema.shopifyFunnelTemplates)
      .values({
        slug: `default-${Date.now()}`,
        label: 'Default',
        workflowTemplateId: workflow.id,
        isDefault: true,
      })
      .returning();
    defaultFunnelTemplateId = funnel.id;
    return defaultFunnelTemplateId;
  }

  async function seedGarment(storeId: string, shopifyProductId: number) {
    const [garment] = await app.db
      .insert(schema.shopifyProductGarments)
      .values({
        storeId,
        shopifyProductId,
        r2Key: `shopify-garments/${storeId}/${shopifyProductId}/garment.jpg`,
        title: 'Test Product',
        status: 'active',
        enabled: true,
      })
      .returning();
    return garment;
  }

  async function uploadCustomerPhoto(storeKey: string, bytes: Buffer) {
    const presign = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/presign',
      headers: { 'x-widget-key': storeKey },
      payload: { contentType: 'image/jpeg', contentLength: bytes.length },
    });
    expect(presign.statusCode).toBe(200);
    const { uploadUrl, r2Key } = presign.json() as { uploadUrl: string; r2Key: string };
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.ok).toBe(true);
    return r2Key;
  }

  async function setLimits(storeId: string, limits: Record<string, unknown>) {
    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { ...row.settings, limits } })
      .where(eq(schema.shopifyStores.id, storeId));
  }

  async function createJob(store: { storeKey: string }, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: body,
    });
  }

  async function eventsOfType(storeId: string, type: string) {
    return app.db
      .select()
      .from(schema.shopifyWidgetEvents)
      .where(
        and(
          eq(schema.shopifyWidgetEvents.storeId, storeId),
          eq(schema.shopifyWidgetEvents.type, type),
        ),
      );
  }

  it('writes refused_store_cap when the store daily cap turns a shopper away', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 6001);
    // A cap of zero refuses every request, which is the cheapest way to reach
    // the store_limit branch without seeding a day's worth of jobs.
    await setLimits(store.id, { storeDailyCap: 0 });

    const clientId = randomUUID();
    const photo = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));

    const res = await createJob(store, {
      customerPhotoKey: photo,
      shopifyProductId: 6001,
      clientId,
    });

    // Soft refusal: the shopper gets a 202 with a reason, never an error.
    expect(res.statusCode).toBe(202);
    expect(res.json().reason).toBe('store_limit');

    const rows = await eventsOfType(store.id, 'refused_store_cap');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toMatchObject({
      clientId,
      shopifyProductId: 6001,
    });
  });

  it('writes refused_email_gate when the fast-path shopper-limit check gates on email', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 6002);
    await setLimits(store.id, { emailAfterNTryOns: 1 });

    const clientId = randomUUID();
    const photo1 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const first = await createJob(store, {
      customerPhotoKey: photo1,
      shopifyProductId: 6002,
      clientId,
    });
    expect(first.statusCode).toBe(201);

    const photo2 = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024));
    const gated = await createJob(store, {
      customerPhotoKey: photo2,
      shopifyProductId: 6002,
      clientId,
    });
    expect(gated.statusCode).toBe(202);
    expect(gated.json().reason).toBe('email_required');

    const rows = await eventsOfType(store.id, 'refused_email_gate');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toMatchObject({
      clientId,
      shopifyProductId: 6002,
    });
  });

  it('writes refused_shopper_cap from the race-path recheck under concurrent requests', async () => {
    // Mirrors shopify-limits.test.ts's "serializes concurrent requests" case:
    // both requests pass the fast-path check, then lockAndRecheckShopperLimits
    // serializes them and the loser is refused from inside the transaction's
    // catch — the ShopperLimitRaceRefusal path, not the fast path.
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 6003);
    await setLimits(store.id, { perShopperCap: 1, perShopperWindow: 'day' });

    const clientId = randomUUID();
    const [photoA, photoB] = await Promise.all([
      uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024)),
      uploadCustomerPhoto(store.storeKey, Buffer.alloc(1024)),
    ]);

    const [resA, resB] = await Promise.all([
      createJob(store, { customerPhotoKey: photoA, shopifyProductId: 6003, clientId }),
      createJob(store, { customerPhotoKey: photoB, shopifyProductId: 6003, clientId }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([201, 202]);

    const rows = await eventsOfType(store.id, 'refused_shopper_cap');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toMatchObject({
      clientId,
      shopifyProductId: 6003,
    });
  });
});
