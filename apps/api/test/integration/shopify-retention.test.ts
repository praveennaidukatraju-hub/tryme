import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShopifyRetention } from '../../../dispatcher/src/shopify/retention.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('shopify retention sweeper', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // A monotonic counter, not Math.random(), guarantees uniqueness even when
  // two seeds land in the same millisecond — which happens often enough in
  // this suite to intermittently collide on the shopifyShopId unique index.
  let shopIdCounter = 0;

  async function seedStoreWithRetention(retention: Record<string, unknown>) {
    const uniqueSuffix = `${Date.now()}-${shopIdCounter++}`;
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `ret-${uniqueSuffix}.myshopify.com`,
        shopifyShopId: Date.now() * 1000 + shopIdCounter,
        accessToken: 'enc',
        scope: 'read_products',
        settings: { retention },
      })
      .returning();
    return store;
  }

  it('deletes an expired shopper photo but keeps the billing row', async () => {
    const store = await seedStoreWithRetention({ shopperPhotoDays: 7 });
    const key = `shopify-inputs/${store.id}/old/photo`;
    await app.storage.putObject(key, Buffer.from('x'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        customerPhotoKey: key,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(30),
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const [after] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after).toBeDefined();
    expect(after.creditsCharged).toBe(1);
    expect(after.customerPhotoKey).toBeNull();
    await expect(app.storage.headObject(key)).rejects.toThrow();
  });

  it('leaves everything alone when the merchant configured no retention', async () => {
    const store = await seedStoreWithRetention({});
    const key = `shopify-inputs/${store.id}/keep/photo`;
    await app.storage.putObject(key, Buffer.from('x'), 'image/jpeg');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        customerPhotoKey: key,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(400),
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const [after] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(after.customerPhotoKey).toBe(key);
  });

  it('deletes expired shopper records and nulls the job link without deleting the job', async () => {
    const store = await seedStoreWithRetention({ shopperRecordDays: 90 });
    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId: store.id,
        clientId: 'old-client',
        email: 'old@example.com',
        lastSeenAt: daysAgo(200),
      })
      .returning();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        shopifyShopperId: shopper.id,
        creditsCharged: 1,
        source: 'shopify',
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const remaining = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(remaining).toHaveLength(0);

    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(afterJob).toBeDefined();
    expect(afterJob.shopifyShopperId).toBeNull();
  });

  it('nulls only the key whose delete succeeded when its sibling delete fails', async () => {
    const store = await seedStoreWithRetention({ resultDays: 30 });
    const resultKey = `shopify-results/${store.id}/old/result`;
    const thumbnailKey = `shopify-results/${store.id}/old/thumbnail`;
    await app.storage.putObject(resultKey, Buffer.from('x'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('x'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(100),
      })
      .returning();
    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey,
      thumbnailKey,
    });

    // Wraps the real storage so the thumbnail delete transiently fails while
    // the result delete succeeds — proves the two columns are nulled
    // independently rather than as an all-or-nothing pair.
    const flakyStorage: typeof app.storage = {
      ...app.storage,
      deleteObject: async (key: string) => {
        if (key === thumbnailKey) throw new Error('simulated transient failure');
        return app.storage.deleteObject(key);
      },
    };

    await runShopifyRetention(app.db, flakyStorage, app.log);

    const [after] = await app.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, job.id));
    expect(after).toBeDefined();
    expect(after.resultKey).toBeNull();
    expect(after.thumbnailKey).toBe(thumbnailKey);
    await expect(app.storage.headObject(resultKey)).rejects.toThrow();
  });

  it('keeps a row in scope across passes when one key clears and its sibling keeps failing', async () => {
    const store = await seedStoreWithRetention({ resultDays: 30 });
    const resultKey = `shopify-results/${store.id}/old2/result`;
    const thumbnailKey = `shopify-results/${store.id}/old2/thumbnail`;
    await app.storage.putObject(resultKey, Buffer.from('x'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('x'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(100),
      })
      .returning();
    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey,
      thumbnailKey,
    });

    // thumbnailKey's delete fails on every call (permanent, not just
    // transient), so pass 1 should clear resultKey but leave thumbnailKey.
    // The bug this guards against: once resultKey goes null, a WHERE clause
    // that only checks isNotNull(resultKey) would drop the row from every
    // future pass, silently orphaning the still-populated thumbnailKey.
    const alwaysFailsThumbnail: typeof app.storage = {
      ...app.storage,
      deleteObject: async (key: string) => {
        if (key === thumbnailKey) throw new Error('permanent simulated failure');
        return app.storage.deleteObject(key);
      },
    };

    await runShopifyRetention(app.db, alwaysFailsThumbnail, app.log);
    await runShopifyRetention(app.db, alwaysFailsThumbnail, app.log);

    const [after] = await app.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, job.id));
    expect(after).toBeDefined();
    expect(after.resultKey).toBeNull();
    // Still non-null after a SECOND pass proves the row was still selected
    // by the WHERE clause and its delete retried, not silently dropped.
    expect(after.thumbnailKey).toBe(thumbnailKey);
    await expect(app.storage.headObject(thumbnailKey)).resolves.toBeDefined();
  });

  it('keeps an age-expired shopper whose job still references a live photo', async () => {
    // shopperRecordDays is misconfigured shorter than shopperPhotoDays here
    // (the UI tells merchants to do the opposite, but nothing enforces it), so
    // the photo purge does not reach this job before the record purge would.
    // Deleting the shopper row now would null jobs.shopify_shopper_id via
    // ON DELETE SET NULL and destroy the only path redactShopperData has from
    // the data subject to this object — it could never be erased on request.
    const store = await seedStoreWithRetention({ shopperPhotoDays: 90, shopperRecordDays: 90 });
    const photoKey = `shopify-inputs/${store.id}/live/photo`;
    await app.storage.putObject(photoKey, Buffer.from('x'), 'image/jpeg');

    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({
        storeId: store.id,
        clientId: 'stale-but-referenced',
        lastSeenAt: daysAgo(200),
      })
      .returning();

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        shopifyShopperId: shopper.id,
        customerPhotoKey: photoKey,
        creditsCharged: 1,
        source: 'shopify',
        // Younger than shopperPhotoDays, so the photo branch leaves it alone.
        createdAt: daysAgo(10),
      })
      .returning();

    await runShopifyRetention(app.db, app.storage, app.log);

    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(rows).toHaveLength(1);

    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    // The linkage — the thing GDPR redaction navigates — must survive too.
    expect(afterJob.shopifyShopperId).toBe(shopper.id);
    expect(afterJob.customerPhotoKey).toBe(photoKey);
  });

  it('deletes an age-expired shopper once nothing of theirs is left in storage', async () => {
    // The complement of the test above: with every key already null there is no
    // object left to orphan, so the guard must not block the delete. Without
    // this, the fix could silently turn shopperRecordDays into a no-op.
    const store = await seedStoreWithRetention({ shopperRecordDays: 90 });

    const [shopper] = await app.db
      .insert(schema.shopifyShoppers)
      .values({ storeId: store.id, clientId: 'stale-and-clean', lastSeenAt: daysAgo(200) })
      .returning();

    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        status: 'COMPLETED',
        shopifyStoreId: store.id,
        shopifyShopperId: shopper.id,
        customerPhotoKey: null,
        creditsCharged: 1,
        source: 'shopify',
        createdAt: daysAgo(200),
      })
      .returning();
    // A jobOutputs row exists but both keys are already purged.
    await app.db
      .insert(schema.jobOutputs)
      .values({ jobId: job.id, resultKey: null, thumbnailKey: null });

    await runShopifyRetention(app.db, app.storage, app.log);

    const rows = await app.db
      .select()
      .from(schema.shopifyShoppers)
      .where(eq(schema.shopifyShoppers.id, shopper.id));
    expect(rows).toHaveLength(0);

    // Billing row survives with the link severed, as designed.
    const [afterJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(afterJob).toBeDefined();
    expect(afterJob.shopifyShopperId).toBeNull();
  });
});
