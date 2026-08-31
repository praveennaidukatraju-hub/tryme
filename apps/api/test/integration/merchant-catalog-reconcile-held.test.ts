import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('merchant catalog reconcile-held', () => {
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

  async function seedMerchantWithCompletedHeldJob() {
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
      .values({ email: `rec-${randomUUID()}@test.com`, passwordHash: 'x' })
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

    // A completed, released, held job with a real object in storage.
    const resultKey = `results/${randomUUID()}.jpg`;
    await app.storage.putObject(resultKey, Buffer.from('result'), 'image/jpeg');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'COMPLETED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'flat/source.jpg',
      params: { kind: 'merchant_catalog', subcategoryId: subcategory.id, heldBatch: true },
    });
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey });

    const token = await signAccess(secret, user.id, { kind: 'access' }, '15m');
    return {
      auth: { authorization: `Bearer ${token}` },
      jobId: job.id,
      subcategoryId: subcategory.id,
    };
  }

  it('creates an inactive product row for each completed held job', async () => {
    const { auth, jobId } = await seedMerchantWithCompletedHeldJob();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const { created } = res.json() as { created: Array<{ id: string }> };
    expect(created).toHaveLength(1);

    const [item] = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.sourceJobId, jobId));
    // Invisible to the kiosk until the merchant fills in SKU + prices.
    expect(item.isActive).toBe(false);
    expect(item.sourceKind).toBe('generated');
    expect(item.flatSourceKey).toBe('flat/source.jpg');
    expect(item.actualPricePaise).toBe(0);
  });

  it('is idempotent — a second call creates nothing new', async () => {
    const { auth } = await seedMerchantWithCompletedHeldJob();

    await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    expect((second.json() as { created: unknown[] }).created).toHaveLength(0);
  });

  it('keeps the pending product out of the kiosk catalog', async () => {
    const { auth } = await seedMerchantWithCompletedHeldJob();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });

    const rows = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.isActive, true));
    expect(rows).toHaveLength(0);
  });

  it('does not resurrect a deleted product on a later reconcile (idempotency lives on the job)', async () => {
    const { auth, jobId } = await seedMerchantWithCompletedHeldJob();

    const first = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    const { created } = first.json() as { created: Array<{ id: string }> };
    expect(created).toHaveLength(1);

    // The job is marked reconciled after the first successful pass.
    const [inputRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect((inputRow.params as { heldReconciled?: boolean }).heldReconciled).toBe(true);

    // Merchant doesn't want it — hard-deletes the product.
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/${created[0].id}`,
      headers: auth,
    });
    expect(deleteRes.statusCode).toBeLessThan(400);

    const remaining = await app.db
      .select()
      .from(schema.merchantCatalogItems)
      .where(eq(schema.merchantCatalogItems.id, created[0].id));
    expect(remaining).toHaveLength(0);

    // Calling reconcile-held again must NOT recreate the deleted product.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    expect((second.json() as { created: unknown[] }).created).toHaveLength(0);
  });

  it('reports a job missing subcategoryId in `failed`, not silently skipped', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `rec-malformed-${randomUUID()}@test.com`, passwordHash: 'x' })
      .returning();
    // The reconcile-held route resolves the caller's merchant by userId, so
    // this row must exist even though the binding itself is otherwise unused.
    await app.db.insert(schema.merchants).values({
      companyName: 'Co',
      contactName: 'Owner',
      phone: '9999999999',
      businessAddress: 'Street',
      isActive: true,
      userId: user.id,
    });

    // Completed, released, held job whose job_inputs.params never got a
    // subcategoryId — e.g. a data bug upstream. This can never be fixed by
    // retrying, so it must be visible in `failed` on every call, not silently
    // re-selected forever.
    const resultKey = `results/${randomUUID()}.jpg`;
    await app.storage.putObject(resultKey, Buffer.from('result'), 'image/jpeg');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'COMPLETED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'flat/source.jpg',
      params: { kind: 'merchant_catalog', heldBatch: true }, // no subcategoryId
    });
    await app.db.insert(schema.jobOutputs).values({ jobId: job.id, resultKey });

    const token = await signAccess(secret, user.id, { kind: 'access' }, '15m');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { created: unknown[]; failed: number };
    expect(body.created).toHaveLength(0);
    expect(body.failed).toBeGreaterThanOrEqual(1);

    // Never stamped reconciled — it stays visible (still selectable) rather
    // than silently succeeding.
    const [inputRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, job.id));
    expect((inputRow.params as { heldReconciled?: boolean }).heldReconciled).toBeUndefined();
  });
});
