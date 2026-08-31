import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant, createTestTryonCategory } from './helpers/merchant.js';

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/2gAABEBAADAAAAhADEAAAAT8A/9k=',
  'base64',
);

let c: Containers;
let app: TestApp;
let garmentTypeId: string;
let workflowTemplateId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);

  const cat = await createTestTryonCategory(app, { slug: `demo-tryon-${randomUUID()}` });
  workflowTemplateId = cat.workflowTemplateId;

  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-tryon-gt-${randomUUID()}`,
      label: 'Demo Tryon Garment Type',
      isActive: true,
      tryonCategoryId: cat.categoryId,
    })
    .returning();
  if (!gt) throw new Error('failed to seed garment type');
  garmentTypeId = gt.id;
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function merchantToken(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function seedDemoItem(opts: { itemActive?: boolean } = {}) {
  const [set] = await app.db
    .insert(schema.demoCatalogSets)
    .values({ name: `Set ${randomUUID()}` })
    .returning();
  if (!set) throw new Error('failed to seed set');
  const [sub] = await app.db
    .insert(schema.demoCatalogSubcategories)
    .values({
      setId: set.id,
      category: 'women',
      name: 'Demo Sarees',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  if (!sub) throw new Error('failed to seed subcategory');
  const r2Key = keys.demoCatalogItem(randomUUID());
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub.id,
      label: 'Demo Tryon Product',
      actualPricePaise: 0,
      offerPricePaise: 0,
      r2Key,
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      isActive: opts.itemActive ?? true,
    })
    .returning();
  if (!item) throw new Error('failed to seed item');
  return { setId: set.id, itemId: item.id, r2Key };
}

/** Presign + PUT a real customer photo, returning its key. */
async function uploadCustomerPhoto(token: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/presign',
    headers: { authorization: `Bearer ${token}` },
    payload: { contentType: 'image/jpeg', contentLength: JPEG_1X1.length },
  });
  const { uploadUrl, r2Key } = res.json();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: JPEG_1X1,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  expect(put.ok).toBe(true);
  return r2Key as string;
}

describe('POST /v1/merchant/tryon/jobs with a demo item', () => {
  it('creates a job using the demo item image when the set is assigned', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem();
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId: demo.setId, merchantId: merchant.merchantId });

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });

    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs?.upperGarmentKey).toBe(demo.r2Key);
    expect((inputs!.params as { workflowTemplateId: string }).workflowTemplateId).toBe(
      workflowTemplateId,
    );

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.creditsCharged).toBe(5);
    expect(job?.merchantId).toBe(merchant.merchantId);
  });

  it('404s a demo item whose set is not assigned to this merchant', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem();

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s an assigned demo item when merchant demoData is disabled', async () => {
    const merchant = await createTestMerchant(app, { demoData: false });
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem();
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId: demo.setId, merchantId: merchant.merchantId });

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s an inactive demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoItem({ itemActive: false });
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId: demo.setId, merchantId: merchant.merchantId });

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: demo.itemId, customerPhotoKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an id that is neither a merchant item nor a demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: randomUUID(), customerPhotoKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("still works for the merchant's own item", async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const token = await merchantToken(merchant.userId);
    const [sub] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.merchantId,
        category: 'women',
        name: 'Mine',
        garmentSubcategoryId: garmentTypeId,
      })
      .returning();
    if (!sub) throw new Error('failed to seed subcategory');
    const ownKey = keys.merchantCatalogItem(merchant.merchantId, randomUUID());
    const [own] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        merchantId: merchant.merchantId,
        subcategoryId: sub.id,
        label: 'Mine',
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: ownKey,
        thumbnailKey: keys.merchantCatalogItemThumb(merchant.merchantId, randomUUID()),
      })
      .returning();
    if (!own) throw new Error('failed to seed item');

    const customerPhotoKey = await uploadCustomerPhoto(token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantCatalogItemId: own.id, customerPhotoKey },
    });
    expect(res.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, res.json().jobId));
    expect(inputs?.upperGarmentKey).toBe(ownKey);
  });
});
