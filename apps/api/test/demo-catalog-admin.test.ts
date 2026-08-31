import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAuthHeader } from './helpers/admin.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

// Smallest valid JPEG - enough for a real PUT and a real headObject content-type check.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/2gAMAwEAAhADEAAAAT8A/9k=',
  'base64',
);

let c: Containers;
let app: TestApp;
let garmentTypeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  // Redis DB 15 is shared across integration runs; isolate this file from a
  // previous run's per-IP admin-login bucket before creating its test admins.
  await app.redis.del('fastify-rate-limit-POST/admin/auth/login-127.0.0.1');

  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-gt-${randomUUID()}`,
      label: 'Demo Garment Type',
      isActive: true,
    })
    .returning();
  if (!gt) throw new Error('failed to seed garment type');
  garmentTypeId = gt.id;
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function seedSet() {
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
      name: 'Sarees',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  if (!sub) throw new Error('failed to seed subcategory');
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub.id,
      label: 'Demo Saree',
      actualPricePaise: 250000,
      offerPricePaise: 199000,
      r2Key: keys.demoCatalogItem(randomUUID()),
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
    })
    .returning();
  if (!item) throw new Error('failed to seed item');
  return { setId: set.id, subcategoryId: sub.id, itemId: item.id };
}

describe('demo catalog schema', () => {
  it('defaults a new set to active and a new item to active+approved', async () => {
    const { setId, itemId } = await seedSet();
    const [set] = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, setId));
    expect(set?.isActive).toBe(true);
    expect(set?.sortOrder).toBe(0);

    const [item] = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, itemId));
    expect(item?.isActive).toBe(true);
    expect(item?.sku).toBeNull();
  });

  it('cascades set deletion down to subcategories and items', async () => {
    const { setId, subcategoryId, itemId } = await seedSet();
    await app.db.delete(schema.demoCatalogSets).where(eq(schema.demoCatalogSets.id, setId));

    const subs = await app.db
      .select()
      .from(schema.demoCatalogSubcategories)
      .where(eq(schema.demoCatalogSubcategories.id, subcategoryId));
    const items = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, itemId));
    expect(subs).toHaveLength(0);
    expect(items).toHaveLength(0);
  });

  it('cascades merchant deletion down to assignments only', async () => {
    const { setId } = await seedSet();
    const merchant = await createTestMerchant(app);
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId, merchantId: merchant.merchantId });

    await app.db.delete(schema.merchants).where(eq(schema.merchants.id, merchant.merchantId));

    const assignments = await app.db
      .select()
      .from(schema.demoCatalogAssignments)
      .where(eq(schema.demoCatalogAssignments.setId, setId));
    expect(assignments).toHaveLength(0);

    const sets = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, setId));
    expect(sets).toHaveLength(1);
  });

  it('rejects assigning the same set to the same merchant twice', async () => {
    const { setId } = await seedSet();
    const merchant = await createTestMerchant(app);
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId, merchantId: merchant.merchantId });
    await expect(
      app.db
        .insert(schema.demoCatalogAssignments)
        .values({ setId, merchantId: merchant.merchantId }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('storage keys', () => {
  it('namespaces demo objects under demo-catalog/', () => {
    expect(keys.demoCatalogItem('abc')).toBe('demo-catalog/abc/image.jpg');
    expect(keys.demoCatalogItemThumb('abc')).toBe('demo-catalog/abc/thumb.jpg');
  });
});

describe('admin demo set + subcategory routes', () => {
  let authHeaders: Record<string, string>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    authHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
  });

  beforeEach(() => {
    infoSpy = vi.spyOn(app.log, 'info');
    errorSpy = vi.spyOn(app.log, 'error');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const auth = () => authHeaders;

  it('creates, lists, patches and deletes a set', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Womens Showroom', description: 'Sales demo' },
    });
    expect(created.statusCode).toBe(201);
    const setId = created.json().id;
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSetId: setId,
        fields: ['name', 'description'],
      }),
      'demo set created',
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
    });
    const row = listed.json().items.find((s: { id: string }) => s.id === setId);
    expect(row).toMatchObject({
      name: 'Womens Showroom',
      isActive: true,
      subcategoryCount: 0,
      productCount: 0,
      assignedMerchantCount: 0,
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
      payload: { isActive: false, name: 'Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSetId: setId,
        fields: expect.arrayContaining(['isActive', 'name']),
      }),
      'demo set updated',
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSetId: setId,
        fields: expect.arrayContaining(['id', 'name']),
      }),
      'demo set deleted',
    );

    const gone = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: auth(),
      payload: { name: 'x' },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects an empty patch body', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Empty patch target' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${created.json().id}`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates, lists, patches and deletes subcategories under a set', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'With subs' },
    });
    const setId = set.json().id;

    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: { setId, category: 'women', name: 'Sarees', garmentSubcategoryId: garmentTypeId },
    });
    expect(created.statusCode).toBe(201);
    const subcategoryId = created.json().id;
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSetId: setId,
        demoSubcategoryId: subcategoryId,
        fields: ['setId', 'category', 'name', 'garmentSubcategoryId'],
      }),
      'demo subcategory created',
    );

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/subcategories`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({ name: 'Sarees', productCount: 0 });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/subcategories/${subcategoryId}`,
      headers: auth(),
      payload: { name: 'Silk Sarees' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: subcategoryId, name: 'Silk Sarees' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSubcategoryId: subcategoryId,
        fields: ['name'],
      }),
      'demo subcategory updated',
    );

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/subcategories/${subcategoryId}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSubcategoryId: subcategoryId,
        fields: expect.arrayContaining(['id', 'name']),
      }),
      'demo subcategory deleted',
    );

    const gone = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/subcategories/${subcategoryId}`,
      headers: auth(),
      payload: { name: 'Gone' },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('reports positive product and assignment aggregates', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Aggregate set' },
    });
    const setId = set.json().id;
    const subcategory = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId,
        category: 'women',
        name: 'Aggregate subcategory',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    const subcategoryId = subcategory.json().id;
    await app.db.insert(schema.demoCatalogItems).values([
      {
        subcategoryId,
        label: 'Aggregate product one',
        r2Key: keys.demoCatalogItem(randomUUID()),
        thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      },
      {
        subcategoryId,
        label: 'Aggregate product two',
        r2Key: keys.demoCatalogItem(randomUUID()),
        thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      },
    ]);
    const merchant = await createTestMerchant(app);
    await app.db
      .insert(schema.demoCatalogAssignments)
      .values({ setId, merchantId: merchant.merchantId });

    const sets = await app.inject({
      method: 'GET',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
    });
    const listedSet = sets.json().items.find((item: { id: string }) => item.id === setId);
    expect(listedSet).toMatchObject({
      subcategoryCount: 1,
      productCount: 2,
      assignedMerchantCount: 1,
    });

    const subcategories = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/subcategories`,
      headers: auth(),
    });
    expect(subcategories.json().items[0]).toMatchObject({ id: subcategoryId, productCount: 2 });
  });

  it('404s a subcategory patch with an unknown garment type', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Patch garment validation' },
    });
    const subcategory = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: set.json().id,
        category: 'women',
        name: 'Patch target',
        garmentSubcategoryId: garmentTypeId,
      },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/subcategories/${subcategory.json().id}`,
      headers: auth(),
      payload: { garmentSubcategoryId: randomUUID() },
    });
    expect(patched.statusCode).toBe(404);
    expect(patched.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'garment type not found' },
    });
  });

  it('deletes a subcategory and its real storage objects', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Storage cleanup set' },
    });
    const subcategory = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: set.json().id,
        category: 'women',
        name: 'Storage cleanup subcategory',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    const subcategoryId = subcategory.json().id;
    const itemId = randomUUID();
    const r2Key = keys.demoCatalogItem(itemId);
    const thumbnailKey = keys.demoCatalogItemThumb(itemId);
    await app.storage.putObject(r2Key, Buffer.from('image'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('thumbnail'), 'image/jpeg');
    await app.db.insert(schema.demoCatalogItems).values({
      id: itemId,
      subcategoryId,
      label: 'Storage cleanup item',
      r2Key,
      thumbnailKey,
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/subcategories/${subcategoryId}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      await app.db
        .select()
        .from(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.id, itemId)),
    ).toHaveLength(0);
    await expect(app.storage.headObject(r2Key)).rejects.toThrow();
    await expect(app.storage.headObject(thumbnailKey)).rejects.toThrow();
  });

  it('surfaces and audits storage failures after a set cascade', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Storage failure set' },
    });
    const setId = set.json().id;
    const subcategory = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId,
        category: 'women',
        name: 'Storage failure subcategory',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    const itemId = randomUUID();
    const r2Key = keys.demoCatalogItem(itemId);
    const thumbnailKey = keys.demoCatalogItemThumb(itemId);
    await app.storage.putObject(r2Key, Buffer.from('image'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('thumbnail'), 'image/jpeg');
    await app.db.insert(schema.demoCatalogItems).values({
      id: itemId,
      subcategoryId: subcategory.json().id,
      label: 'Storage failure item',
      r2Key,
      thumbnailKey,
    });

    const realDeleteObject = app.storage.deleteObject.bind(app.storage);
    app.storage.deleteObject = async (key) => {
      if (key === thumbnailKey) throw new Error('simulated storage outage');
      await realDeleteObject(key);
    };
    const deleted = await (async () => {
      try {
        return await app.inject({
          method: 'DELETE',
          url: `/admin/demo-catalog/sets/${setId}`,
          headers: auth(),
        });
      } finally {
        app.storage.deleteObject = realDeleteObject;
      }
    })();

    expect(deleted.statusCode).toBe(502);
    expect(deleted.json()).toEqual({
      error: {
        code: 'STORAGE_DELETE_FAILED',
        message: 'demo set deleted but object cleanup failed',
      },
    });
    expect(
      await app.db
        .select()
        .from(schema.demoCatalogSets)
        .where(eq(schema.demoCatalogSets.id, setId)),
    ).toHaveLength(0);
    await expect(app.storage.headObject(r2Key)).rejects.toThrow();
    await expect(app.storage.headObject(thumbnailKey)).resolves.toMatchObject({ contentLength: 9 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        demoSetId: setId,
        fields: expect.arrayContaining(['id', 'name']),
        databaseDeleted: true,
        deletedObjectKeys: [r2Key],
        failedObjects: [
          {
            field: 'thumbnailKey',
            key: thumbnailKey,
            error: expect.objectContaining({ message: 'simulated storage outage' }),
          },
        ],
      }),
      'demo set deleted with object cleanup failures',
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ demoSetId: setId }),
      'demo set deleted',
    );
  });

  it('allows ADMIN edits but denies ADMIN deletes and all SUPPORT mutations', async () => {
    const adminHeaders = await adminAuthHeader(app, 'ADMIN');
    const supportHeaders = await adminAuthHeader(app, 'SUPPORT');
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: adminHeaders,
      payload: { name: 'Role matrix set' },
    });
    expect(set.statusCode).toBe(201);
    const setId = set.json().id;
    const setPatch = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/sets/${setId}`,
      headers: adminHeaders,
      payload: { name: 'ADMIN renamed' },
    });
    expect(setPatch.statusCode).toBe(200);
    const subcategory = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: adminHeaders,
      payload: {
        setId,
        category: 'women',
        name: 'Role matrix subcategory',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    expect(subcategory.statusCode).toBe(201);
    const subcategoryId = subcategory.json().id;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/admin/demo-catalog/subcategories/${subcategoryId}`,
          headers: adminHeaders,
          payload: { name: 'ADMIN renamed subcategory' },
        })
      ).statusCode,
    ).toBe(200);
    for (const url of [
      `/admin/demo-catalog/sets/${setId}`,
      `/admin/demo-catalog/subcategories/${subcategoryId}`,
    ]) {
      expect((await app.inject({ method: 'DELETE', url, headers: adminHeaders })).statusCode).toBe(
        403,
      );
    }

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/demo-catalog/sets',
          headers: supportHeaders,
          payload: { name: 'Denied support set' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/demo-catalog/subcategories',
          headers: supportHeaders,
          payload: {
            setId,
            category: 'women',
            name: 'Denied support subcategory',
            garmentSubcategoryId: garmentTypeId,
          },
        })
      ).statusCode,
    ).toBe(403);
    for (const url of [
      `/admin/demo-catalog/sets/${setId}`,
      `/admin/demo-catalog/subcategories/${subcategoryId}`,
    ]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url,
            headers: supportHeaders,
            payload: { name: 'Denied support patch' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'DELETE', url, headers: supportHeaders })).statusCode,
      ).toBe(403);
    }
  });

  it('404s a subcategory pointed at a set that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: randomUUID(),
        category: 'women',
        name: 'Orphan',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s an unknown category', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: auth(),
      payload: { name: 'Bad category' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: auth(),
      payload: {
        setId: set.json().id,
        category: 'aliens',
        name: 'Nope',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401s without a token and 403s a SUPPORT admin', async () => {
    const anon = await app.inject({ method: 'GET', url: '/admin/demo-catalog/sets' });
    expect(anon.statusCode).toBe(401);

    const supportHeaders = await adminAuthHeader(app, 'SUPPORT');
    const support = await app.inject({
      method: 'GET',
      url: '/admin/demo-catalog/sets',
      headers: supportHeaders,
    });
    expect(support.statusCode).toBe(403);
  });
});

describe('admin demo item routes', () => {
  let authHeaders: Record<string, string>;
  let subcategoryId: string;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    authHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: authHeaders,
      payload: { name: 'Items set' },
    });
    const sub = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/subcategories',
      headers: authHeaders,
      payload: {
        setId: set.json().id,
        category: 'women',
        name: 'Sarees',
        garmentSubcategoryId: garmentTypeId,
      },
    });
    subcategoryId = sub.json().id;
  });

  beforeEach(() => {
    infoSpy = vi.spyOn(app.log, 'info');
    errorSpy = vi.spyOn(app.log, 'error');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const auth = () => authHeaders;

  /** Presigns, PUTs a real 1x1 JPEG, and returns the key. */
  async function uploadAsset(kind: 'image' | 'thumbnail') {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/presign',
      headers: auth(),
      payload: { kind, contentType: 'image/jpeg', contentLength: JPEG_1X1.length },
    });
    expect(res.statusCode).toBe(200);
    const { assetId, uploadUrl, r2Key } = res.json();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        entity: 'demoCatalogUpload',
        entityId: assetId,
        fields: ['kind', 'contentType', 'contentLength'],
      }),
      'demo catalog upload presigned',
    );
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: JPEG_1X1,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(put.ok).toBe(true);
    return r2Key as string;
  }

  it('creates an item from uploaded assets and returns rupee prices', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([
      uploadAsset('image'),
      uploadAsset('thumbnail'),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Red Saree',
        sku: 'DEMO-1',
        actualPrice: 2500,
        offerPrice: 1990,
        r2Key,
        thumbnailKey,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      label: 'Red Saree',
      sku: 'DEMO-1',
      actualPrice: 2500,
      offerPrice: 1990,
    });
    expect(res.json().imageUrl).toContain('demo-catalog/');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        entity: 'demoCatalogItem',
        entityId: res.json().id,
        fields: [
          'subcategoryId',
          'label',
          'sku',
          'actualPrice',
          'offerPrice',
          'r2Key',
          'thumbnailKey',
        ],
      }),
      'demo item created',
    );
  });

  it('lists items for a subcategory and filters by search', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/items?subcategoryId=${subcategoryId}&search=DEMO-1`,
      headers: auth(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const miss = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/items?subcategoryId=${subcategoryId}&search=nothing-matches`,
      headers: auth(),
    });
    expect(miss.json().items).toHaveLength(0);
  });

  it('patches prices and active flag', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([
      uploadAsset('image'),
      uploadAsset('thumbnail'),
    ]);
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Patch me',
        actualPrice: 100,
        offerPrice: 90,
        r2Key,
        thumbnailKey,
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/demo-catalog/items/${created.json().id}`,
      headers: auth(),
      payload: { offerPrice: 50, isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ offerPrice: 50, isActive: false, actualPrice: 100 });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        entity: 'demoCatalogItem',
        entityId: created.json().id,
        fields: ['offerPrice', 'isActive'],
      }),
      'demo item updated',
    );
  });

  it('deletes an item and its objects', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([
      uploadAsset('image'),
      uploadAsset('thumbnail'),
    ]);
    const created = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Delete me',
        actualPrice: 10,
        offerPrice: 10,
        r2Key,
        thumbnailKey,
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/demo-catalog/items/${created.json().id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    await expect(app.storage.headObject(r2Key)).rejects.toThrow();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        entity: 'demoCatalogItem',
        entityId: created.json().id,
        fields: expect.arrayContaining(['r2Key', 'thumbnailKey']),
      }),
      'demo item deleted',
    );
  });

  it('surfaces and audits storage failures on item delete', async () => {
    const itemId = randomUUID();
    const r2Key = keys.demoCatalogItem(itemId);
    const thumbnailKey = keys.demoCatalogItemThumb(itemId);
    await app.storage.putObject(r2Key, Buffer.from('image'), 'image/jpeg');
    await app.storage.putObject(thumbnailKey, Buffer.from('thumbnail'), 'image/jpeg');
    await app.db.insert(schema.demoCatalogItems).values({
      id: itemId,
      subcategoryId,
      label: 'Storage failure item',
      r2Key,
      thumbnailKey,
    });

    const realDeleteObject = app.storage.deleteObject.bind(app.storage);
    app.storage.deleteObject = async (key) => {
      if (key === thumbnailKey) throw new Error('simulated storage outage');
      await realDeleteObject(key);
    };
    const deleted = await (async () => {
      try {
        return await app.inject({
          method: 'DELETE',
          url: `/admin/demo-catalog/items/${itemId}`,
          headers: auth(),
        });
      } finally {
        app.storage.deleteObject = realDeleteObject;
      }
    })();

    expect(deleted.statusCode).toBe(502);
    expect(deleted.json()).toEqual({
      error: {
        code: 'STORAGE_DELETE_FAILED',
        message: 'demo item deleted but object cleanup failed',
      },
    });
    expect(
      await app.db
        .select()
        .from(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.id, itemId)),
    ).toHaveLength(0);
    await expect(app.storage.headObject(r2Key)).rejects.toThrow();
    await expect(app.storage.headObject(thumbnailKey)).resolves.toMatchObject({ contentLength: 9 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: expect.any(String),
        entity: 'demoCatalogItem',
        entityId: itemId,
        databaseDeleted: true,
        deletedObjectKeys: [r2Key],
        failedObjects: [
          {
            field: 'thumbnailKey',
            key: thumbnailKey,
            error: expect.objectContaining({ message: 'simulated storage outage' }),
          },
        ],
      }),
      'demo item deleted with object cleanup failures',
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityId: itemId }),
      'demo item deleted',
    );
  });

  it('rejects a key outside demo-catalog/', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId,
        label: 'Bad key',
        actualPrice: 10,
        offerPrice: 10,
        r2Key: 'merchant-catalog/somebody/else/image.jpg',
        thumbnailKey: 'merchant-catalog/somebody/else/thumb.jpg',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an item pointed at a subcategory that does not exist', async () => {
    const [r2Key, thumbnailKey] = await Promise.all([
      uploadAsset('image'),
      uploadAsset('thumbnail'),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/items',
      headers: auth(),
      payload: {
        subcategoryId: randomUUID(),
        label: 'Orphan',
        actualPrice: 10,
        offerPrice: 10,
        r2Key,
        thumbnailKey,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('admin demo set assignments', () => {
  let authHeaders: Record<string, string>;
  let setId: string;

  beforeAll(async () => {
    // This file's earlier describe blocks already spend 5 of the route's
    // 5-per-minute admin-login budget; reset it here so this block's own
    // logins don't 429 (same pattern as the file-level beforeAll above).
    await app.redis.del('fastify-rate-limit-POST/admin/auth/login-127.0.0.1');
    authHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const set = await app.inject({
      method: 'POST',
      url: '/admin/demo-catalog/sets',
      headers: authHeaders,
      payload: { name: 'Assignable' },
    });
    setId = set.json().id;
  });

  const auth = () => authHeaders;

  it('replaces the assignment list wholesale and is idempotent', async () => {
    const a = await createTestMerchant(app);
    const b = await createTestMerchant(app);

    const first = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId, b.merchantId] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().assignedMerchantCount).toBe(2);

    const again = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId, b.merchantId] },
    });
    expect(again.json().assignedMerchantCount).toBe(2);

    const shrunk = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [b.merchantId] },
    });
    expect(shrunk.json().assignedMerchantCount).toBe(1);

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({
      merchantId: b.merchantId,
      companyName: 'Test Co',
    });
  });

  it('clears every assignment on an empty list', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [] },
    });
    expect(res.json().assignedMerchantCount).toBe(0);
  });

  it('404s an unknown merchant id and changes nothing', async () => {
    const a = await createTestMerchant(app);
    await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [a.merchantId] },
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
      payload: { merchantIds: [randomUUID()] },
    });
    expect(res.statusCode).toBe(404);

    const listed = await app.inject({
      method: 'GET',
      url: `/admin/demo-catalog/sets/${setId}/assignments`,
      headers: auth(),
    });
    expect(listed.json().items).toHaveLength(1);
  });

  it('404s an unknown set id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/demo-catalog/sets/${randomUUID()}/assignments`,
      headers: auth(),
      payload: { merchantIds: [] },
    });
    expect(res.statusCode).toBe(404);
  });
});
