import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('merchant catalog — publishing a pending held-batch product', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seed(itemOverrides: Partial<typeof schema.merchantCatalogItems.$inferInsert>) {
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-${randomUUID()}`,
        label: 'wf',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `Pose ${randomUUID()}`,
        r2Key: 'poses/p.jpg',
        thumbnailKey: 'poses/p.thumb.jpg',
        genderSlug: 'women',
        workflowTemplateId: wf.id,
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `type-${randomUUID()}`,
        label: 'Type',
        defaultPoseId: pose.id,
      })
      .returning();
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `pub-${randomUUID()}@test.com`, passwordHash: 'x' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Co',
        contactName: 'Owner',
        phone: '9999999999',
        businessAddress: 'Street',
        isActive: true,
        userId: user.id,
      })
      .returning();
    const [subcategory] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.id,
        category: 'women',
        name: 'Kurtis',
        garmentSubcategoryId: garmentType.id,
      })
      .returning();
    const [item] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        merchantId: merchant.id,
        subcategoryId: subcategory.id,
        label: 'Job abcd1234',
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: `merchant/${randomUUID()}.jpg`,
        thumbnailKey: `merchant/${randomUUID()}.thumb.jpg`,
        sourceKind: 'generated',
        isActive: false,
        ...itemOverrides,
      })
      .returning();

    const token = await signAccess(secret, user.id, { kind: 'access' }, '15m');
    return { auth: { authorization: `Bearer ${token}` }, itemId: item.id };
  }

  it('activates a pending product once SKU and both prices are supplied', async () => {
    const { auth, itemId } = await seed({});

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { label: 'Product SH-1', sku: 'SH-1', actualPrice: 1200, offerPrice: 999 },
    });

    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(true);
    expect(row.actualPricePaise).toBe(120000);
  });

  it('leaves a pending product inactive when the SKU is still missing', async () => {
    const { auth, itemId } = await seed({});

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { actualPrice: 1200, offerPrice: 999 },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });

  it('does not resurrect a product the merchant deliberately deactivated', async () => {
    // Already published once (prices set), then switched off by the merchant.
    const { auth, itemId } = await seed({
      isActive: false,
      sku: 'OLD-1',
      actualPricePaise: 50000,
      offerPricePaise: 45000,
    });

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { sku: 'OLD-1', actualPrice: 600, offerPrice: 550 },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });

  it('respects an explicit isActive in the body', async () => {
    const { auth, itemId } = await seed({});

    await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${itemId}`,
      headers: auth,
      payload: { sku: 'SH-2', actualPrice: 800, offerPrice: 700, isActive: false },
    });

    const [row] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, itemId));
    expect(row.isActive).toBe(false);
  });
});
