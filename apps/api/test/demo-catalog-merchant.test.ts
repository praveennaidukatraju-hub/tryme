import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let garmentTypeId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  const [gt] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `demo-read-gt-${randomUUID()}`,
      label: 'Demo Read Garment Type',
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

async function merchantToken(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function seedDemoSet(
  opts: {
    setActive?: boolean;
    itemActive?: boolean;
    category?: string;
    garmentSubcategoryId?: string;
  } = {},
) {
  const [set] = await app.db
    .insert(schema.demoCatalogSets)
    .values({ name: `Set ${randomUUID()}`, isActive: opts.setActive ?? true })
    .returning();
  const [sub] = await app.db
    .insert(schema.demoCatalogSubcategories)
    .values({
      setId: set!.id,
      category: opts.category ?? 'women',
      name: 'Demo Sarees',
      garmentSubcategoryId: opts.garmentSubcategoryId ?? garmentTypeId,
    })
    .returning();
  const [item] = await app.db
    .insert(schema.demoCatalogItems)
    .values({
      subcategoryId: sub!.id,
      label: 'Demo Product',
      sku: 'DEMO-SKU',
      actualPricePaise: 250000,
      offerPricePaise: 199000,
      r2Key: keys.demoCatalogItem(randomUUID()),
      thumbnailKey: keys.demoCatalogItemThumb(randomUUID()),
      isActive: opts.itemActive ?? true,
    })
    .returning();
  return { setId: set!.id, subcategoryId: sub!.id, itemId: item!.id };
}

async function assign(setId: string, merchantId: string) {
  await app.db.insert(schema.demoCatalogAssignments).values({ setId, merchantId });
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('merchant catalog reads with demo data', () => {
  it('includes assigned demo rows by default, tagged isDemo and readOnly', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    const subs = await get('/v1/merchant/catalog/subcategories', token);
    expect(subs.statusCode).toBe(200);
    const sub = subs.json().items.find((s: { id: string }) => s.id === demo.subcategoryId);
    expect(sub).toMatchObject({
      name: 'Demo Sarees',
      category: 'women',
      garmentSubcategoryId: garmentTypeId,
      merchantId: merchant.merchantId,
      productCount: 1,
      isDemo: true,
      readOnly: true,
    });

    const items = await get('/v1/merchant/catalog', token);
    const item = items.json().items.find((i: { id: string }) => i.id === demo.itemId);
    expect(item).toMatchObject({
      label: 'Demo Product',
      sku: 'DEMO-SKU',
      subcategoryId: demo.subcategoryId,
      merchantId: merchant.merchantId,
      actualPrice: 2500,
      offerPrice: 1990,
      sourceKind: 'uploaded',
      moderationStatus: 'approved',
      sourceJobId: null,
      flatSourceKey: null,
      isDemo: true,
      readOnly: true,
    });
    expect(item.imageUrl).toContain('demo-catalog/');
  });

  it('hides demo rows from an unassigned merchant', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    await seedDemoSet();

    expect((await get('/v1/merchant/catalog/subcategories', token)).json().items).toEqual([]);
    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('hides assigned demo rows when merchant demoData is disabled', async () => {
    const merchant = await createTestMerchant(app, { demoData: false });
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    expect((await get('/v1/merchant/catalog/subcategories', token)).json().items).toEqual([]);
    expect((await get('/v1/merchant/catalog?includeDemo=true', token)).json().items).toEqual([]);
  });

  it('drops demo rows again when the set is unassigned', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);
    expect((await get('/v1/merchant/catalog', token)).json().items).toHaveLength(1);

    await app.db
      .delete(schema.demoCatalogAssignments)
      .where(eq(schema.demoCatalogAssignments.setId, demo.setId));
    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('excludes demo rows when includeDemo=false', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    expect(
      (await get('/v1/merchant/catalog/subcategories?includeDemo=false', token)).json().items,
    ).toEqual([]);
    expect((await get('/v1/merchant/catalog?includeDemo=false', token)).json().items).toEqual([]);
    // Guard against z.coerce.boolean(), which turns "false" into true.
    expect((await get('/v1/merchant/catalog?includeDemo=true', token)).json().items).toHaveLength(
      1,
    );
  });

  it('hides an inactive set and an inactive item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);

    const inactiveSet = await seedDemoSet({ setActive: false });
    await assign(inactiveSet.setId, merchant.merchantId);
    const inactiveItem = await seedDemoSet({ itemActive: false });
    await assign(inactiveItem.setId, merchant.merchantId);

    const subs = (await get('/v1/merchant/catalog/subcategories', token)).json().items;
    expect(subs.map((s: { id: string }) => s.id)).not.toContain(inactiveSet.subcategoryId);
    // The subcategory of the active set is still listed, but with zero products.
    const stillListed = subs.find((s: { id: string }) => s.id === inactiveItem.subcategoryId);
    expect(stillListed?.productCount).toBe(0);

    expect((await get('/v1/merchant/catalog', token)).json().items).toEqual([]);
  });

  it('applies the category filter to demo subcategories', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const women = await seedDemoSet({ category: 'women' });
    const men = await seedDemoSet({ category: 'men' });
    await assign(women.setId, merchant.merchantId);
    await assign(men.setId, merchant.merchantId);

    const ids = (await get('/v1/merchant/catalog/subcategories?category=women', token))
      .json()
      .items.map((s: { id: string }) => s.id);
    expect(ids).toContain(women.subcategoryId);
    expect(ids).not.toContain(men.subcategoryId);
  });

  it('filters demo subcategories to mannequin-only garment types on saree-subcategories', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);

    const [mannequinGt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `demo-read-mannequin-gt-${randomUUID()}`,
        label: 'Demo Read Mannequin Garment Type',
        isActive: true,
        requiresMannequinStep: true,
      })
      .returning();
    if (!mannequinGt) throw new Error('failed to seed mannequin garment type');

    // garmentTypeId (from beforeAll) has requiresMannequinStep: false — the non-mannequin case.
    const flat = await seedDemoSet({ garmentSubcategoryId: garmentTypeId });
    const mannequin = await seedDemoSet({ garmentSubcategoryId: mannequinGt.id });
    await assign(flat.setId, merchant.merchantId);
    await assign(mannequin.setId, merchant.merchantId);

    // No `category` param: the route's self-provisioning block only runs when
    // `category` is present, so omitting it keeps this test scoped purely to
    // the mannequinOnly join/filter, with no extra merchant-owned rows.
    const ids = (await get('/v1/merchant/catalog/saree-subcategories', token))
      .json()
      .items.map((s: { id: string }) => s.id);
    expect(ids).toContain(mannequin.subcategoryId);
    expect(ids).not.toContain(flat.subcategoryId);

    const idsExcluded = (
      await get('/v1/merchant/catalog/saree-subcategories?includeDemo=false', token)
    )
      .json()
      .items.map((s: { id: string }) => s.id);
    expect(idsExcluded).not.toContain(mannequin.subcategoryId);
    expect(idsExcluded).not.toContain(flat.subcategoryId);
  });

  it('applies subcategoryId and search filters to demo items', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const a = await seedDemoSet();
    const b = await seedDemoSet();
    await assign(a.setId, merchant.merchantId);
    await assign(b.setId, merchant.merchantId);

    const scoped = await get(`/v1/merchant/catalog?subcategoryId=${a.subcategoryId}`, token);
    expect(scoped.json().items).toHaveLength(1);
    expect(scoped.json().items[0].id).toBe(a.itemId);

    expect((await get('/v1/merchant/catalog?search=DEMO-SKU', token)).json().items).toHaveLength(2);
    expect((await get('/v1/merchant/catalog?search=no-such-thing', token)).json().items).toEqual(
      [],
    );
  });

  it("sorts the merchant's own products before demo products", async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const [ownSub] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.merchantId,
        category: 'women',
        name: 'My Sarees',
        garmentSubcategoryId: garmentTypeId,
      })
      .returning();
    await app.db.insert(schema.merchantCatalogItems).values({
      merchantId: merchant.merchantId,
      subcategoryId: ownSub!.id,
      label: 'My Product',
      actualPricePaise: 100,
      offerPricePaise: 100,
      r2Key: keys.merchantCatalogItem(merchant.merchantId, randomUUID()),
      thumbnailKey: keys.merchantCatalogItemThumb(merchant.merchantId, randomUUID()),
    });
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);

    const items = (await get('/v1/merchant/catalog', token)).json().items;
    expect(items[0].isDemo).toBeFalsy();
    expect(items.at(-1).isDemo).toBe(true);
  });

  it('404s a merchant mutation aimed at a demo item', async () => {
    const merchant = await createTestMerchant(app);
    const token = await merchantToken(merchant.userId);
    const demo = await seedDemoSet();
    await assign(demo.setId, merchant.merchantId);
    const headers = { authorization: `Bearer ${token}` };

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${demo.itemId}`,
      headers,
      payload: { label: 'hijacked' },
    });
    expect(patched.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/${demo.itemId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(404);

    const subDeleted = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/subcategories/${demo.subcategoryId}`,
      headers,
    });
    expect(subDeleted.statusCode).toBe(404);

    // And the row is untouched.
    const [row] = await app.db
      .select({ label: schema.demoCatalogItems.label })
      .from(schema.demoCatalogItems)
      .where(eq(schema.demoCatalogItems.id, demo.itemId));
    expect(row?.label).toBe('Demo Product');
  });
});
