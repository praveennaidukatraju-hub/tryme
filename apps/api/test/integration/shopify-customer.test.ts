import { Buffer } from 'node:buffer';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('shopify customer routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const ownerBalances = new Map<string, number>();

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

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

  async function seedStore(ownerUserId: string | null) {
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `test-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
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

  /** The single default funnel template every product now resolves. Created
   *  lazily so the test that asserts the no-default path isn't forced to depend
   *  on it — that test runs against a database where this was never called. */
  let defaultFunnelTemplateId: string | null = null;
  let defaultWorkflowTemplateId: string | null = null;
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
    defaultWorkflowTemplateId = workflow.id;
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

  it('rejects presign without a store key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/presign',
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the account/exchange route no longer exists', async () => {
    const store = await seedStore(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/account/exchange',
      headers: { 'x-widget-key': store.storeKey },
      payload: { code: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects job creation when the store has no credit balance', async () => {
    const store = await seedStore(null);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: 'shopify-inputs/x/photo.jpg', shopifyProductId: 1 },
    });
    expect(res.statusCode).toBe(402);
  });

  it('rejects job creation when the store has insufficient credits', async () => {
    const owner = await seedOwner(0);
    const store = await seedStore(owner.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: 'shopify-inputs/x/photo.jpg', shopifyProductId: 1 },
    });
    expect(res.statusCode).toBe(402);
  });

  it('refuses to enqueue when no default funnel template exists, without charging credits', async () => {
    // Runs before any test calls seedDefaultFunnelTemplate(), so the table is
    // empty. Ordering matters — do not move this below a test that seeds one.
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 71);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 71 },
    });
    // 202, not 4xx: same shape the widget already handles for a product that is
    // still syncing or switched off.
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty('jobId');

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits.balance).toBe(100);

    const jobs = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.shopifyStoreId, store.id));
    expect(jobs).toHaveLength(0);
  });

  it('pins the default template workflow onto the job params', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 72);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 72 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputs.params as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      defaultWorkflowTemplateId,
    );
  });

  it('ignores a store-level workflowTemplateId setting', async () => {
    // settings.workflowTemplateId is vestigial — nothing writes it in production
    // and it must not silently override the admin-set default.
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { workflowTemplateId: '00000000-0000-0000-0000-000000000001' } })
      .where(eq(schema.shopifyStores.id, store.id));
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 73);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 73 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputs.params as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      defaultWorkflowTemplateId,
    );
  });

  it('creates a job billed to the store and deducts its credits, needing no shopper auth at all', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 7);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 7 },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBeNull();
    expect(job.source).toBe('shopify');

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits.balance).toBeLessThan(100);
  });

  it('allows a try-on for a product enabled only via an enabled collection', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: 900,
      r2Key: `shopify-garments/${store.id}/900/garment.jpg`,
      title: 'Collection Shirt',
      status: 'active',
      enabled: false,
    });
    await app.db.insert(schema.shopifyEnabledCollections).values({
      storeId: store.id,
      shopifyCollectionId: 500,
    });
    await app.db.insert(schema.shopifyCollectionProducts).values({
      storeId: store.id,
      shopifyCollectionId: 500,
      shopifyProductId: 900,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 900 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('jobId');
  });

  it('refuses a try-on for a product excluded despite global mode', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { activation: { mode: 'global' } } })
      .where(eq(schema.shopifyStores.id, store.id));
    // enabled: true is deliberate — the old code's plain `!garment.enabled`
    // check would have let this one through (a real regression). Only the
    // resolver's exclusion-first rule catches it.
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: 901,
      r2Key: `shopify-garments/${store.id}/901/garment.jpg`,
      title: 'Excluded Shirt',
      status: 'active',
      enabled: true,
      excluded: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 901 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).not.toHaveProperty('jobId');
    expect(res.json().message).toBe('This product is not available for try-on right now.');
  });

  it('rejects a customer photo above the admin-configured limit', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 8);

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyCustomerPhotoMaxBytes: 1024 } }),
    );
    try {
      const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(2048));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/shopify/customer/jobs',
        headers: { 'x-widget-key': store.storeKey },
        payload: { customerPhotoKey: r2Key, shopifyProductId: 8 },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.message).toContain('MB limit');
    } finally {
      await app.redis.del('config:system');
    }
  });

  it('scopes job status/events by store, not by shopper identity', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const otherStore = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 9);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 9 },
    });
    expect(createRes.statusCode).toBe(201);
    const { jobId } = createRes.json() as { jobId: string };

    const ownRes = await app.inject({
      method: 'GET',
      url: `/v1/shopify/customer/jobs/${jobId}`,
      headers: { 'x-widget-key': store.storeKey },
    });
    expect(ownRes.statusCode).toBe(200);
    const ownBody = ownRes.json();
    expect(ownBody).toHaveProperty('id', jobId);
    expect(ownBody).toHaveProperty('status');
    expect(ownBody).toHaveProperty('resultUrl');
    expect(ownBody).not.toHaveProperty('shopifyStoreId');

    const otherRes = await app.inject({
      method: 'GET',
      url: `/v1/shopify/customer/jobs/${jobId}`,
      headers: { 'x-widget-key': otherStore.storeKey },
    });
    expect(otherRes.statusCode).toBe(404);
  });

  it('extends the upload ownership TTL to 24h after a successful job creation', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 11);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 11 },
    });
    expect(res.statusCode).toBe(201);

    const ttl = await app.redis.ttl(`shopify:upload:${r2Key}`);
    expect(ttl).toBeGreaterThan(600);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('reuses the same photo for a second, different product', async () => {
    await seedDefaultFunnelTemplate();
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await seedGarment(store.id, 12);
    await seedGarment(store.id, 13);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 12 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/jobs',
      headers: { 'x-widget-key': store.storeKey },
      payload: { customerPhotoKey: r2Key, shopifyProductId: 13 },
    });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { jobId: string }).jobId).not.toBe(
      (first.json() as { jobId: string }).jobId,
    );
  });

  it('returns a presigned preview URL for a photo owned by this store', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { previewUrl: string };
    expect(body.previewUrl).toContain(r2Key);
  });

  it('rejects a preview request for a photo belonging to a different store', async () => {
    const store = await seedStore(null);
    const otherStore = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(otherStore.storeKey, Buffer.from('photo-bytes'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a preview request once the ownership marker has expired', async () => {
    const store = await seedStore(null);
    const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.from('photo-bytes'));
    await app.redis.del(`shopify:upload:${r2Key}`);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/customer/photo/preview',
      headers: { 'x-widget-key': store.storeKey },
      payload: { r2Key },
    });
    expect(res.statusCode).toBe(404);
  });
});
