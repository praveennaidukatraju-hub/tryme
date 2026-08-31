import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

/**
 * Drives the whole bulk-flat-upload lifecycle end to end through public
 * routes: generate-bulk (HELD) -> admin release (QUEUED + jobs:low) ->
 * simulated dispatcher completion -> reconcile-held (pending product) ->
 * delete + re-reconcile (idempotency) -> PATCH publish.
 * Every other test in this feature hand-seeds its own starting state; this is
 * the one place the whole chain is proven to actually connect.
 */
describe('merchant catalog bulk-flat lifecycle (E2E)', () => {
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

  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:low');
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  async function seedEverything() {
    const genderSlug = 'women';

    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `lifecycle-wf-${randomUUID()}`,
        label: 'Regular workflow',
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
        r2Key: 'poses/seed/pose.jpg',
        thumbnailKey: 'poses/seed/pose.thumb.jpg',
        genderSlug,
        workflowTemplateId: wf.id,
      })
      .returning();
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: genderSlug,
        label: `Face ${randomUUID()}`,
        r2Key: 'faces/seed/face.jpg',
        thumbnailKey: 'faces/seed/face.thumb.jpg',
      })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: `Bg ${randomUUID()}`,
        r2Key: 'bg/seed/bg.jpg',
        thumbnailKey: 'bg/seed/bg.thumb.jpg',
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug,
        slug: `lifecycle-type-${randomUUID()}`,
        label: 'Type',
        defaultPoseId: pose.id,
        requiresMannequinStep: true,
      })
      .returning();

    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { [genderSlug]: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const [merchantUser] = await app.db
      .insert(schema.users)
      .values({ email: `lifecycle-${randomUUID()}@test.com`, passwordHash: 'unused' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Lifecycle Merchant Co',
        contactName: 'Owner',
        phone: '9999999999',
        businessAddress: 'Test Street',
        isActive: true,
        userId: merchantUser.id,
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: merchantUser.id, balance: 500 });

    const [subcategory] = await app.db
      .insert(schema.merchantCatalogSubcategories)
      .values({
        merchantId: merchant.id,
        category: genderSlug,
        name: 'Kurtis',
        garmentSubcategoryId: garmentType.id,
      })
      .returning();

    const token = await signAccess(secret, merchantUser.id, { kind: 'access' }, '15m');
    return {
      auth: { authorization: `Bearer ${token}` },
      subcategoryId: subcategory.id,
      userId: merchantUser.id,
      merchantId: merchant.id,
    };
  }

  async function presignFlat(auth: Record<string, string>) {
    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });
    return r2Key;
  }

  it('flows a bulk-flat batch from upload through HELD, release, completion, reconcile, and publish', async () => {
    const { auth, subcategoryId } = await seedEverything();

    // 1. Upload two flat images and submit the bulk-flat batch — both HELD.
    const keyA = await presignFlat(auth);
    const keyB = await presignFlat(auth);

    const genRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate-bulk',
      headers: auth,
      payload: { subcategoryId, flatImageKeys: [keyA, keyB] },
    });
    expect(genRes.statusCode).toBe(201);
    const { jobIds } = genRes.json() as { jobIds: string[] };
    expect(jobIds).toHaveLength(2);

    for (const jobId of jobIds) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('HELD');
    }

    // 2. Admin releases the global held backlog.
    const adminHeaders = await adminAuthHeader(app);
    const releaseRes = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers: adminHeaders,
    });
    expect(releaseRes.statusCode).toBe(200);

    for (const jobId of jobIds) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('QUEUED');
      expect(job.queuedAt).toBeInstanceOf(Date);
    }
    expect(await app.redis.xlen('jobs:low')).toBe(2);

    // 3. Simulate the dispatcher completing both jobs.
    for (const jobId of jobIds) {
      const resultKey = `results/lifecycle/${jobId}.jpg`;
      const thumbnailKey = `results/lifecycle/${jobId}.thumb.jpg`;
      await app.storage.putObject(resultKey, Buffer.from('result'), 'image/jpeg');
      await app.storage.putObject(thumbnailKey, Buffer.from('thumb'), 'image/jpeg');
      await app.db
        .update(schema.jobs)
        .set({ status: 'COMPLETED', completedAt: new Date() })
        .where(eq(schema.jobs.id, jobId));
      await app.db.insert(schema.jobOutputs).values({ jobId, resultKey, thumbnailKey });
    }

    // 4. Reconcile — both jobs materialize as pending (inactive, generated) products.
    const reconcileRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    expect(reconcileRes.statusCode).toBe(200);
    const { created } = reconcileRes.json() as {
      created: Array<{ id: string; isActive: boolean; sourceKind: string }>;
    };
    expect(created).toHaveLength(2);
    for (const item of created) {
      expect(item.isActive).toBe(false);
      expect(item.sourceKind).toBe('generated');
    }

    // 5. Delete one product, then reconcile again — it must not come back.
    const [toDelete, toKeep] = created;
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/catalog/${toDelete.id}`,
      headers: auth,
    });
    expect(deleteRes.statusCode).toBeLessThan(400);

    const reReconcileRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/reconcile-held',
      headers: auth,
    });
    expect((reReconcileRes.json() as { created: unknown[] }).created).toHaveLength(0);

    // 6. Publish the surviving product with a SKU and both prices.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/merchant/catalog/${toKeep.id}`,
      headers: auth,
      payload: { sku: 'LIFECYCLE-SKU-1', actualPrice: 999, offerPrice: 799 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json() as { isActive: boolean }).isActive).toBe(true);
  });
});
