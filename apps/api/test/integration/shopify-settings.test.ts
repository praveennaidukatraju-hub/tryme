import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../../src/modules/shopify/auth.routes.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';
import { signSessionToken } from '../helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let storeId: string;
let token: string;

describe('shopify settings routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx, {
      SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
      SHOPIFY_API_SECRET: API_SECRET,
      SHOPIFY_API_KEY: API_KEY,
    });
    const store = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 77,
        shopDomain: 'settings.myshopify.com',
        myshopifyDomain: 'settings.myshopify.com',
        name: 'S',
        email: 's@s.com',
      },
      'tok',
      'read_products',
    );
    storeId = store.id;
    token = signSessionToken('settings.myshopify.com', API_SECRET, API_KEY);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('authenticates before validating a settings patch', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      payload: { limits: { storeDailyCap: 777 } },
    });
    expect(res.statusCode).toBe(401);

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings).toEqual({});
  });

  it('rejects a limit value outside the allowed option set', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 777 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('merges limits without clobbering unrelated settings', async () => {
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: { themeBlockConfirmed: true, retention: { resultDays: 90 } } })
      .where(eq(schema.shopifyStores.id, storeId));

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 250, perShopperCap: 5, perShopperWindow: 'week' } },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.themeBlockConfirmed).toBe(true);
    expect(row.settings.limits?.storeDailyCap).toBe(250);
    expect(row.settings.limits?.perShopperWindow).toBe('week');
    expect(row.settings.retention?.resultDays).toBe(90);
  });

  it('accepts null to turn a limit back off', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: 100 } },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/shopify/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { limits: { storeDailyCap: null } },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.limits?.storeDailyCap).toBeNull();
  });

  it('lists only shoppers who gave an email, with consent and try-on count', async () => {
    await app.db.insert(schema.shopifyShoppers).values([
      { storeId, clientId: 'c-anon' },
      { storeId, clientId: 'c-mail', email: 'a@b.com', emailConsent: true },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/shoppers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: { email: string; emailConsent: boolean }[] };
    // Scoped to this test's own rows: the file shares one store across tests,
    // so an absolute count would break as soon as another test seeds a shopper.
    expect(items.find((i) => i.email === 'a@b.com')?.emailConsent).toBe(true);
    // The anonymous row must never appear — it exists for limit counting, and
    // is not a mailing-list entry.
    expect(items.some((i) => i.email == null)).toBe(false);
  });

  it('exports the same rows as CSV', async () => {
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId, clientId: 'c-csv', email: 'csv@b.com', emailConsent: false });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/shoppers.csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('email,consent,first_seen,try_ons');
    expect(res.body).toContain('csv@b.com,no,');
  });

  it('customers_redact deletes the matching shopper row', async () => {
    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId,
        clientId: 'gdpr-client',
        shopifyCustomerId: 4242,
        email: 'redact@example.com',
      })
      .returning();

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const removed = await redactShopperData(app, storeId, {
      shopifyCustomerId: 4242,
      email: null,
    });

    expect(removed.removed).toBe(1);
    expect(removed.incomplete).toBe(0);
    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(rows).toHaveLength(0);
  });

  it('customers_redact also matches on email alone, for shoppers who never logged in', async () => {
    await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId, clientId: 'anon-mail', email: 'only-mail@example.com' });

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const removed = await redactShopperData(app, storeId, {
      shopifyCustomerId: null,
      email: 'only-mail@example.com',
    });
    expect(removed.removed).toBe(1);
  });

  it('refuses to match anything when the payload identifies no subject', async () => {
    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    // An empty payload must never be read as "delete everything".
    expect(await redactShopperData(app, storeId, {})).toEqual({ removed: 0, incomplete: 0 });
  });

  it('leaves the shopper row and the failed key in place when an object delete fails', async () => {
    // Regression test for Corrections 1 and 2: a shopper's row (and any key
    // that didn't successfully delete) must survive a partial R2 failure so a
    // future retry can find and finish the job — deleting the row here would
    // destroy the only remaining pointer to the still-orphaned object.
    const photoKey = `shopify-inputs/${storeId}/gdpr-fail/photo`;
    const resultKey = `shopify-results/${storeId}/gdpr-fail/result`;
    const thumbnailKey = `shopify-results/${storeId}/gdpr-fail/thumbnail`;
    await app.storage.putObject(photoKey, Buffer.from('x'), 'image/jpeg');
    await app.storage.putObject(resultKey, Buffer.from('x'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('x'), 'image/jpeg');

    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId,
        clientId: 'gdpr-fail-client',
        shopifyCustomerId: 9999,
        email: 'fail@example.com',
      })
      .returning();

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: storeId,
        shopifyShopperId: shopper.id,
        customerPhotoKey: photoKey,
        creditsCharged: 1,
        source: 'shopify',
      })
      .returning();
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey, thumbnailKey });

    // Wraps the real storage so the thumbnail delete fails while the photo
    // and result deletes succeed — proves the row/columns are only cleared
    // when their own delete actually succeeded, not as an all-or-nothing batch.
    const originalDelete = app.storage.deleteObject.bind(app.storage);
    app.storage.deleteObject = async (key: string) => {
      if (key === thumbnailKey) throw new Error('simulated failure');
      return originalDelete(key);
    };

    try {
      const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
      const removed = await redactShopperData(app, storeId, {
        shopifyCustomerId: 9999,
        email: null,
      });

      // (a) the returned count does not include this shopper
      expect(removed.removed).toBe(0);
      // ...and the partial failure is visible to the caller, which is the only
      // signal an operator gets: nothing ever retries a GDPR redaction.
      expect(removed.incomplete).toBe(1);

      // (b) the shopifyShoppers row for this shopper still exists
      const rows = await app.db
        .select()
        .from(schema.shopifyShoppers)
        .where(eq(schema.shopifyShoppers.id, shopper.id));
      expect(rows).toHaveLength(1);

      const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
      const [afterOut] = await app.db
        .select()
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, job.id));

      // (d) keys that did successfully delete are null
      expect(afterJob.customerPhotoKey).toBeNull();
      expect(afterOut.resultKey).toBeNull();
      // (c) the key that failed to delete is still non-null
      expect(afterOut.thumbnailKey).toBe(thumbnailKey);
    } finally {
      app.storage.deleteObject = originalDelete;
    }
  });

  // Its own store: matchAll erases every shopper of the store it is pointed at,
  // which would wipe the shared store's rows out from under the other tests.
  async function seedIsolatedStore(shopId: number, domain: string) {
    const store = await upsertShopifyStore(
      app,
      {
        shopifyShopId: shopId,
        shopDomain: domain,
        myshopifyDomain: domain,
        name: 'S',
        email: 's@s.com',
      },
      'tok',
      'read_products',
    );
    return store.id;
  }

  async function seedUnlinkedJob(otherStoreId: string, tag: string) {
    const photoKey = `shopify-inputs/${otherStoreId}/${tag}/photo`;
    const resultKey = `shopify-results/${otherStoreId}/${tag}/result`;
    await app.storage.putObject(photoKey, Buffer.from('x'), 'image/jpeg');
    await app.storage.putObject(resultKey, Buffer.from('x'), 'image/jpeg');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: otherStoreId,
        // The whole point: no shopper row has ever pointed at this job.
        shopifyShopperId: null,
        customerPhotoKey: photoKey,
        creditsCharged: 1,
        source: 'shopify',
      })
      .returning();
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey });
    return { job, photoKey, resultKey };
  }

  it('shop_redact also purges jobs no shopper row points at', async () => {
    // Legacy widget traffic that never sent a clientId, or a job whose link
    // retention already severed, is invisible to the per-shopper walk. Before
    // this fix its photo and result survived a full-store erasure forever.
    const otherStoreId = await seedIsolatedStore(781, 'shop-redact.myshopify.com');
    const { job, photoKey, resultKey } = await seedUnlinkedJob(otherStoreId, 'unlinked');

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const result = await redactShopperData(app, otherStoreId, { matchAll: true });
    expect(result.incomplete).toBe(0);

    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    const [afterOut] = await app.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, job.id));
    expect(afterJob.customerPhotoKey).toBeNull();
    expect(afterOut.resultKey).toBeNull();

    // The billing row itself is never deleted.
    expect(afterJob.id).toBe(job.id);

    // And the objects really are gone from storage, not just dereferenced.
    await expect(app.storage.headObject(photoKey)).rejects.toBeTruthy();
    await expect(app.storage.headObject(resultKey)).rejects.toBeTruthy();
  });

  it('customers_redact leaves unlinked jobs alone — it erases one subject, not the shop', async () => {
    const otherStoreId = await seedIsolatedStore(782, 'cust-redact.myshopify.com');
    const { job, photoKey } = await seedUnlinkedJob(otherStoreId, 'not-mine');

    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId: otherStoreId, clientId: 'subject', shopifyCustomerId: 5150 })
      .returning();

    const { redactShopperData } = await import('../../src/modules/shopify/gdpr.js');
    const result = await redactShopperData(app, otherStoreId, {
      shopifyCustomerId: 5150,
      email: null,
    });
    expect(result.removed).toBe(1);
    expect(result.incomplete).toBe(0);

    // The named subject is gone...
    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(rows).toHaveLength(0);

    // ...but somebody else's unlinked job is untouched. Widening
    // customers_redact to the whole store would erase data of subjects who
    // never asked for it.
    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(afterJob.customerPhotoKey).toBe(photoKey);
  });
});
