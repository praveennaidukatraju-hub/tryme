import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('admin credit analysis routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  async function seedUser(balance: number) {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `credit-analysis-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Spend Test User',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance });
    return user;
  }

  async function seedJob(
    userId: string,
    opts: { source: string; creditsCharged: number; status?: string },
  ) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        status: opts.status ?? 'COMPLETED',
        creditsCharged: opts.creditsCharged,
        source: opts.source,
      })
      .returning();
    return job;
  }

  it('ranks users by total completed-job spend, descending', async () => {
    const bigSpender = await seedUser(1000);
    const smallSpender = await seedUser(1000);
    await seedJob(bigSpender.id, { source: 'catalog', creditsCharged: 50 });
    await seedJob(smallSpender.id, { source: 'catalog', creditsCharged: 5 });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/credit-analysis/users?days=all&pageSize=100',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; totalSpent: number }[] };
    const bigIdx = body.items.findIndex((i) => i.id === bigSpender.id);
    const smallIdx = body.items.findIndex((i) => i.id === smallSpender.id);
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(smallIdx).toBeGreaterThan(bigIdx);
  });

  it('excludes non-COMPLETED jobs from the spend total', async () => {
    const user = await seedUser(1000);
    await seedJob(user.id, { source: 'catalog', creditsCharged: 50, status: 'FAILED' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&search=${encodeURIComponent(user.email)}`,
      headers: authHeader,
    });
    const body = res.json() as { items: { totalSpent: number; totalJobs: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].totalSpent).toBe(0);
    expect(body.items[0].totalJobs).toBe(0);
  });

  it('filters by job source', async () => {
    const user = await seedUser(1000);
    await seedJob(user.id, { source: 'catalog', creditsCharged: 20 });
    await seedJob(user.id, { source: 'shopify', creditsCharged: 7 });

    const catalogRes = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&source=catalog&search=${encodeURIComponent(user.email)}`,
      headers: authHeader,
    });
    const catalogBody = catalogRes.json() as { items: { totalSpent: number }[] };
    expect(catalogBody.items[0].totalSpent).toBe(20);

    const shopifyRes = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&source=shopify&search=${encodeURIComponent(user.email)}`,
      headers: authHeader,
    });
    const shopifyBody = shopifyRes.json() as { items: { totalSpent: number }[] };
    expect(shopifyBody.items[0].totalSpent).toBe(7);
  });

  it('attributes a merchant-owned job with userId=null via the merchant owner', async () => {
    const merchantOwner = await seedUser(1000);
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Merchant Co',
        contactName: 'Owner',
        phone: '9999999999',
        websiteUrl: 'https://example.com',
        companySize: '1-10',
        purpose: 'test',
        businessAddress: 'Test St',
        isActive: true,
        userId: merchantOwner.id,
      })
      .returning();
    // biome-ignore lint/suspicious/noExplicitAny: exercising the defensive COALESCE(jobs.userId, merchants.userId) attribution fallback (apps/api/src/modules/admin/credit-analysis.routes.ts) with a synthetic null-userId row — no current writer produces this shape.
    await (app.db.insert(schema.jobs).values as any)({
      userId: null,
      merchantId: merchant.id,
      status: 'COMPLETED',
      creditsCharged: 15,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&search=${encodeURIComponent(merchantOwner.email)}`,
      headers: authHeader,
    });
    const body = res.json() as { items: { id: string; totalSpent: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(merchantOwner.id);
    expect(body.items[0].totalSpent).toBe(15);
  });

  it('detail view returns dailySpend, ledger (tagged with job source), and no topProducts for a non-Shopify user', async () => {
    const user = await seedUser(1000);
    const job = await seedJob(user.id, { source: 'catalog', creditsCharged: 10 });
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: -10, reason: 'JOB_DISPATCH', jobId: job.id });
    // An account-level entry with no linked job (e.g. FREE_TRIAL/PAYMENT/admin grant)
    // — should surface with source: null, not be dropped.
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: 50, reason: 'FREE_TRIAL' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${user.id}?days=all`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dailySpend: unknown[];
      ledger: { reason: string; source: string | null }[];
      topProducts: unknown[];
      hasShopifyStore: boolean;
    };
    expect(body.dailySpend.length).toBeGreaterThan(0);
    expect(body.ledger).toHaveLength(2);
    expect(body.ledger.find((l) => l.reason === 'JOB_DISPATCH')?.source).toBe('catalog');
    expect(body.ledger.find((l) => l.reason === 'FREE_TRIAL')?.source).toBeNull();
    expect(body.topProducts).toEqual([]);
    expect(body.hasShopifyStore).toBe(false);
  });

  it('detail view ledger respects the source filter, dropping non-matching and account-level entries', async () => {
    const user = await seedUser(1000);
    const catalogJob = await seedJob(user.id, { source: 'catalog', creditsCharged: 10 });
    const shopifyJob = await seedJob(user.id, { source: 'shopify', creditsCharged: 7 });
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: -10, reason: 'JOB_DISPATCH', jobId: catalogJob.id });
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: -7, reason: 'JOB_DISPATCH', jobId: shopifyJob.id });
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: 50, reason: 'FREE_TRIAL' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${user.id}?days=all&source=shopify`,
      headers: authHeader,
    });
    const body = res.json() as {
      ledger: { reason: string; source: string | null; delta: number }[];
    };
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0]).toMatchObject({ source: 'shopify', delta: -7 });
  });

  it('detail view returns topProducts for a Shopify-linked user, scoped to their own store', async () => {
    const owner = await seedUser(1000);
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `credit-analysis-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: owner.id,
      })
      .returning();
    // Real Shopify product IDs are large (e.g. 13 digits) — well beyond Postgres int4
    // range (~2.1B). Regression guard for a bug where the route cast this to ::int
    // and overflowed with "value ... is out of range for type integer".
    const bigProductId = 10410278388029;
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: bigProductId,
      r2Key: `shopify-garments/${store.id}/${bigProductId}/garment.jpg`,
      title: 'Blue Shirt',
      status: 'active',
      enabled: true,
    });
    const job = await seedJob(owner.id, { source: 'shopify', creditsCharged: 8 });
    await app.db
      .update(schema.jobs)
      .set({ shopifyStoreId: store.id })
      .where(eq(schema.jobs.id, job.id));
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `shopify-garments/x/${bigProductId}/garment.jpg`,
      params: { kind: 'shopify', shopifyProductId: bigProductId },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${owner.id}?days=all`,
      headers: authHeader,
    });
    const body = res.json() as {
      hasShopifyStore: boolean;
      topProducts: { shopifyProductId: number; title: string | null; creditsSpent: number }[];
    };
    expect(body.hasShopifyStore).toBe(true);
    expect(body.topProducts).toHaveLength(1);
    expect(body.topProducts[0]).toMatchObject({
      shopifyProductId: bigProductId,
      title: 'Blue Shirt',
      creditsSpent: 8,
    });
  });

  it('404s for an unknown user id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${randomUUID()}`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(404);
  });
});
