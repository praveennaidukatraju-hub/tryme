import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string, balance = 100) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  await app.db.insert(schema.userCredits).values({ userId: merchantUser.id, balance });
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedGarmentTypeWithWorkflow(app: TestApp) {
  const [template] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `template-${randomUUID()}`,
      label: 'Try-on workflow',
      jsonContent: {},
      poseNodeId: 'pose',
      upperNodeIds: [],
      garmentPhasePromptNode: 'garment',
      workflowType: 'tryon',
      isActive: true,
    })
    .returning();
  const [tryonCategory] = await app.db
    .insert(schema.tryonCategories)
    .values({
      name: `category-${randomUUID()}`,
      slug: `category-${randomUUID()}`,
      workflowTemplateId: template.id,
      isActive: true,
    })
    .returning();
  const [garmentType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `shirt-${randomUUID()}`,
      label: 'Shirt',
      tryonCategoryId: tryonCategory.id,
    })
    .returning();
  return garmentType;
}

async function seedCatalogItem(app: TestApp, merchantId: string, garmentTypeId: string) {
  const [subcategory] = await app.db
    .insert(schema.merchantCatalogSubcategories)
    .values({
      merchantId,
      category: 'women',
      name: 'Casual Shirts',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  const imageKey = `merchant-catalog/${merchantId}/${randomUUID()}/image.jpg`;
  const thumbKey = `merchant-catalog/${merchantId}/${randomUUID()}/thumb.jpg`;
  await app.storage.putObject(imageKey, Buffer.from('img'), 'image/jpeg');
  await app.storage.putObject(thumbKey, Buffer.from('thumb'), 'image/jpeg');
  const [item] = await app.db
    .insert(schema.merchantCatalogItems)
    .values({
      merchantId,
      subcategoryId: subcategory.id,
      label: 'Red Shirt',
      actualPricePaise: 200000,
      offerPricePaise: 180000,
      r2Key: imageKey,
      thumbnailKey: thumbKey,
    })
    .returning();
  return item;
}

// Two-input (body+pallu) garment type — deliberately has NO tryonCategoryId, mirroring the
// real saree row (verified via psql during planning: tryon_categories is empty locally and
// garment_subcategories.tryon_category_id is null for saree). The two-input path must never
// depend on that lookup — see resolveTryonGarment.ts.
async function seedTwoInputGarmentType(app: TestApp, opts: { templateActive?: boolean } = {}) {
  const [template] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `two-input-template-${randomUUID()}`,
      label: 'Two-input tryon workflow',
      jsonContent: {},
      poseNodeId: 'pose',
      upperNodeIds: [],
      garmentPhasePromptNode: 'garment',
      workflowType: 'saree_step1_two_input',
      tryonPersonNodeId: '26',
      tryonGarmentNodeId: '30',
      tryonGarmentNodeId2: '27',
      tryonOutputNodeId: '25',
      isActive: opts.templateActive ?? true,
    })
    .returning();
  const [garmentType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `saree-${randomUUID()}`,
      label: 'Saree',
      twoInputTryonWorkflowTemplateId: template.id,
    })
    .returning();
  return { garmentType, template };
}

async function seedCatalogItemWithSecondImage(
  app: TestApp,
  merchantId: string,
  garmentTypeId: string,
) {
  const [subcategory] = await app.db
    .insert(schema.merchantCatalogSubcategories)
    .values({
      merchantId,
      category: 'women',
      name: 'Sarees',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  const imageKey = `merchant-catalog/${merchantId}/${randomUUID()}/image.jpg`;
  const thumbKey = `merchant-catalog/${merchantId}/${randomUUID()}/thumb.jpg`;
  const secondImageKey = `merchant-catalog/${merchantId}/${randomUUID()}/second.jpg`;
  const secondThumbKey = `merchant-catalog/${merchantId}/${randomUUID()}/second-thumb.jpg`;
  await app.storage.putObject(imageKey, Buffer.from('body'), 'image/jpeg');
  await app.storage.putObject(thumbKey, Buffer.from('body-thumb'), 'image/jpeg');
  await app.storage.putObject(secondImageKey, Buffer.from('pallu'), 'image/jpeg');
  await app.storage.putObject(secondThumbKey, Buffer.from('pallu-thumb'), 'image/jpeg');
  const [item] = await app.db
    .insert(schema.merchantCatalogItems)
    .values({
      merchantId,
      subcategoryId: subcategory.id,
      label: 'Two-Input Saree',
      actualPricePaise: 200000,
      offerPricePaise: 180000,
      r2Key: imageKey,
      thumbnailKey: thumbKey,
      secondR2Key: secondImageKey,
      secondThumbnailKey: secondThumbKey,
    })
    .returning();
  return item;
}

async function presignAndUploadCustomerPhoto(app: TestApp, auth: Record<string, string>) {
  const presigned = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/presign',
    headers: auth,
    payload: { contentType: 'image/jpeg', contentLength: 1024 },
  });
  const { r2Key } = presigned.json() as { r2Key: string };
  await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');
  return r2Key;
}

describe('merchant try-on jobs', () => {
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

  it('presigns a customer photo, creates a job charging the admin-configured tryon cost, and rejects a photo key from a different merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-a@example.com');
    const { merchant: otherMerchant } = await createMerchant(app, 'tryon-b@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(presigned.statusCode).toBe(200);
    const { r2Key } = presigned.json() as { r2Key: string; uploadUrl: string };
    expect(r2Key.startsWith(`merchant-inputs/${merchant.id}/`)).toBe(true);
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json() as { jobId: string };

    const [jobRow] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(jobRow.creditsCharged).toBe(5); // SIMPLE_TRYON_COST default, no config:system override in this test
    expect(jobRow.merchantId).toBe(merchant.id);
    expect(jobRow.userId).toBe(merchantUser.id);
    expect(jobRow.source).toBe('merchant_tryon');

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchantUser.id));
    expect(credits.balance).toBe(95);

    const otherAuth = await authHeader(
      (await createMerchant(app, 'tryon-c@example.com')).merchantUser.id,
    );
    const crossMerchant = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: otherAuth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(crossMerchant.statusCode).toBe(404);
    void otherMerchant;
  });

  it('402s with no job row when merchant credits are insufficient', async () => {
    const { merchant, merchantUser } = await createMerchant(
      app,
      'tryon-low-balance@example.com',
      2,
    );
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(402);
    expect(created.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_CREDITS', message: 'insufficient credits' },
    });

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.merchantId, merchant.id));
    expect(jobs).toHaveLength(0);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchantUser.id));
    expect(credits.balance).toBe(2);
  });

  it('rejects a customer photo above the admin-configured limit', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-limit@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { merchantTryonMaxBytes: 1024 } }),
    );
    try {
      const presigned = await app.inject({
        method: 'POST',
        url: '/v1/merchant/tryon/presign',
        headers: auth,
        payload: { contentType: 'image/jpeg', contentLength: 2048 },
      });
      expect(presigned.statusCode).toBe(200);
      const { r2Key } = presigned.json() as { r2Key: string };
      await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

      const jobRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/tryon/jobs',
        headers: auth,
        payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
      });
      expect(jobRes.statusCode).toBe(413);
      expect(jobRes.json().error.message).toContain('MB limit');
    } finally {
      await app.redis.del('config:system');
    }
  });

  it('returns job status scoped to the owning merchant, 404s for another merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-e@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    const { jobId } = created.json() as { jobId: string };

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { status: string; liked: boolean; inCart: boolean };
    expect(body.status).toBe('QUEUED');
    expect(body.liked).toBe(false);
    expect(body.inCart).toBe(false);

    const otherAuth = await authHeader(
      (await createMerchant(app, 'tryon-f@example.com')).merchantUser.id,
    );
    const crossMerchant = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: otherAuth,
    });
    expect(crossMerchant.statusCode).toBe(404);
  });
  it('cancels a queued job and refunds the charged credits', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-g@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    const { jobId } = created.json() as { jobId: string };

    const [creditsAfterCreate] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchantUser.id));
    expect(creditsAfterCreate.balance).toBe(95); // 100 - 5 (SIMPLE_TRYON_COST default)

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { status: string }).status).toBe('CANCELLED');

    const [creditsAfterCancel] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchantUser.id));
    expect(creditsAfterCancel.balance).toBe(100); // fully refunded

    const [ledgerRow] = await app.db
      .select()
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.jobId, jobId),
          eq(schema.creditLedger.reason, 'REFUND_CANCELLED'),
        ),
      );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.delta).toBe(5);

    const cancelledAgain = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(cancelledAgain.statusCode).toBe(409);

    const [creditsAfterSecondCancel] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchantUser.id));
    expect(creditsAfterSecondCancel.balance).toBe(100); // unaffected by failed second cancel
  });
  it('rejects a job when the garment type has no tryon category configured', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-d@example.com');
    const auth = await authHeader(merchantUser.id);
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `unmapped-${randomUUID()}`, label: 'Unmapped' })
      .returning();
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: { code: string } }).error.code).toBe('VALIDATION');
  });
  it('resolves a presigned GET URL for a customer photo the merchant owns, rejects other merchants', async () => {
    const { merchantUser } = await createMerchant(app, 'tryon-h@example.com');
    const auth = await authHeader(merchantUser.id);
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const resolved = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/photo-url?r2Key=${encodeURIComponent(r2Key)}`,
      headers: auth,
    });
    expect(resolved.statusCode).toBe(200);
    expect(typeof (resolved.json() as { url: string }).url).toBe('string');

    const otherAuth = await authHeader(
      (await createMerchant(app, 'tryon-i@example.com')).merchantUser.id,
    );
    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/photo-url?r2Key=${encodeURIComponent(r2Key)}`,
      headers: otherAuth,
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('resolves the two-input template and carries the pallu key as thirdGarmentKey when the catalog item has a second image', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-two-input-a@example.com');
    const auth = await authHeader(merchantUser.id);
    const { garmentType, template } = await seedTwoInputGarmentType(app);
    const item = await seedCatalogItemWithSecondImage(app, merchant.id, garmentType.id);
    const r2Key = await presignAndUploadCustomerPhoto(app, auth);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json() as { jobId: string };

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(item.r2Key);
    expect(inputs.thirdGarmentKey).toBe(item.secondR2Key);
    expect((inputs.params as { workflowTemplateId: string }).workflowTemplateId).toBe(template.id);
  });

  it('does not send thirdGarmentKey for a single-image catalog item on a two-input-capable garment type', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-two-input-b@example.com');
    const auth = await authHeader(merchantUser.id);
    const { garmentType } = await seedTwoInputGarmentType(app);
    // Single-image item — same garment type, but no secondR2Key on this particular item.
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);
    const r2Key = await presignAndUploadCustomerPhoto(app, auth);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    // The garment type has no tryonCategoryId (mirrors the real saree row), so a
    // single-image item on it falls through to the ordinary assertWorkflow check and is
    // rejected the same way the existing "no tryon category configured" test expects —
    // this is the guardrail against silently ignoring a configured two-input template.
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: { code: string } }).error.code).toBe('VALIDATION');
  });

  it('rejects a two-input catalog item when the garment type has no two-input workflow configured', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-two-input-c@example.com');
    const auth = await authHeader(merchantUser.id);
    // No twoInputTryonWorkflowTemplateId set at all.
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `unconfigured-saree-${randomUUID()}`, label: 'Saree' })
      .returning();
    const item = await seedCatalogItemWithSecondImage(app, merchant.id, garmentType.id);
    const r2Key = await presignAndUploadCustomerPhoto(app, auth);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(400);
    const body = created.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('garment type has no two-input tryon workflow configured');

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.merchantId, merchant.id));
    expect(jobs).toHaveLength(0);
  });

  it('rejects a two-input catalog item when the two-input workflow template is inactive', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-two-input-d@example.com');
    const auth = await authHeader(merchantUser.id);
    const { garmentType } = await seedTwoInputGarmentType(app, { templateActive: false });
    const item = await seedCatalogItemWithSecondImage(app, merchant.id, garmentType.id);
    const r2Key = await presignAndUploadCustomerPhoto(app, auth);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(400);
    const body = created.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('two-input tryon workflow is inactive');
  });
});
