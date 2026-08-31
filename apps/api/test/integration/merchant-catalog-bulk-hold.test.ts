import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

describe('merchant catalog bulk generate — held batches', () => {
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
        slug: `regular-wf-${randomUUID()}`,
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
        slug: `type-${randomUUID()}`,
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
      .values({ email: `m-${randomUUID()}@test.com`, passwordHash: 'unused' })
      .returning();
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Merchant Co',
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

  it('creates HELD jobs that never reach Redis, while still charging credits', async () => {
    const { auth, subcategoryId, userId } = await seedEverything();
    const keyA = await presignFlat(auth);
    const keyB = await presignFlat(auth);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate-bulk',
      headers: auth,
      payload: { subcategoryId, flatImageKeys: [keyA, keyB] },
    });

    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json() as { jobIds: string[] };
    expect(jobIds).toHaveLength(2);

    for (const jobId of jobIds) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('HELD');
      // Released batches ride the low lane so they never preempt live traffic.
      expect(job.queueStream).toBe('low');
      expect(job.queuedAt).toBeNull();

      const [input] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      expect((input.params as { heldBatch?: boolean }).heldBatch).toBe(true);
    }

    // Nothing was enqueued anywhere.
    expect(await app.redis.xlen('jobs:normal')).toBe(0);
    expect(await app.redis.xlen('jobs:low')).toBe(0);

    // Credits were still deducted at upload time.
    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBeLessThan(500);
  });

  it('leaves the single-item generate flow interactive (QUEUED + enqueued)', async () => {
    const { auth, subcategoryId } = await seedEverything();
    const key = await presignFlat(auth);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: key },
    });

    expect(res.statusCode).toBe(201);
    const { jobId } = res.json() as { jobId: string };
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(await app.redis.xlen('jobs:normal')).toBe(1);
  });
});
