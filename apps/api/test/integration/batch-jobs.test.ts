import { schema } from '@tryme/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('POST /v1/jobs/batch', () => {
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
    await app.redis.del('jobs:priority');
    await app.redis.del('config:system');
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
  });

  async function registerUser(email: string, tier = 'free') {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const token = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token, userId: user.id };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function seedCreditPlan(slug = 'free') {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, watermark: false })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark: false } });
  }

  /** Uploads are bound to their owner in Redis by /v1/uploads/presign; tests bind directly. */
  async function uploadKey(userId: string, token: string) {
    const key = `inputs/${token}/garment.jpg`;
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
    return key;
  }

  async function seedCatalog() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [poseA] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PA', r2Key: 'pa.jpg', thumbnailKey: 'pa.jpg' })
      .returning();
    const [poseB] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PB', r2Key: 'pb.jpg', thumbnailKey: 'pb.jpg' })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ label: 'Shirt', slug: `shirt-${Date.now()}`, genderSlug: 'men' })
      .returning();
    return {
      faceId: face.id,
      bgId: bg.id,
      poseAId: poseA.id,
      poseBId: poseB.id,
      garmentTypeId: garmentType.id,
    };
  }

  it('creates one job per pose per row, one catalogue per row, under one batchId', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-happy@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g1 = await uploadKey(userId, '11111111-1111-4111-8111-111111111111');
    const g2 = await uploadKey(userId, '22222222-2222-4222-8222-222222222222');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g1,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
          {
            upperGarmentKey: g2,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.totalJobs).toBe(3);
    expect(body.catalogues).toHaveLength(2);
    expect(body.catalogues[0].jobIds).toHaveLength(2);
    expect(body.catalogues[1].jobIds).toHaveLength(1);
    expect(body.catalogues[0].catalogueId).not.toBe(body.catalogues[1].catalogueId);
    expect(body.failedJobIds).toEqual([]);

    const allJobIds = body.catalogues.flatMap((cg: { jobIds: string[] }) => cg.jobIds);
    const jobRows = await app.db
      .select({ batchId: schema.jobs.batchId, status: schema.jobs.status })
      .from(schema.jobs)
      .where(inArray(schema.jobs.id, allJobIds));
    expect(jobRows).toHaveLength(3);
    expect(new Set(jobRows.map((j) => j.batchId))).toEqual(new Set([body.batchId]));
    expect(jobRows.every((j) => j.status === 'QUEUED')).toBe(true);

    const streamLen = await app.redis.xlen('jobs:normal');
    expect(streamLen).toBe(3);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1000 - body.creditsCharged);
  });

  it('allows the same garment on two rows with different poses', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-dup-garment@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '33333333-3333-4333-8333-333333333333');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().catalogues).toHaveLength(2);
  });

  it('produces job_inputs identical to the equivalent single-job submissions', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-parity@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const gBatch = await uploadKey(userId, '44444444-4444-4444-8444-444444444444');
    const gSingle = await uploadKey(userId, '55555555-5555-4555-8555-555555555555');

    const batchRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        userHint: 'crisp lighting',
        rows: [
          {
            upperGarmentKey: gBatch,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });
    expect(batchRes.statusCode).toBe(201);

    const singleRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: gSingle,
          faceId: cat.faceId,
          backgroundId: cat.bgId,
          poseIds: [cat.poseAId, cat.poseBId],
          garmentTypeId: cat.garmentTypeId,
        },
        aspectRatio: '1:1',
        resolution: '2K',
        userHint: 'crisp lighting',
      },
    });
    expect(singleRes.statusCode).toBe(201);

    const batchJobIds: string[] = batchRes.json().catalogues[0].jobIds;
    const singleJobIds: string[] = singleRes.json().jobIds;

    // Compare everything except the fields that are expected to differ: the job
    // id, and the garment key (each submission uploaded its own).
    const strip = (row: Record<string, unknown>) => {
      const { jobId, upperGarmentKey, ...rest } = row;
      return rest;
    };
    const load = async (ids: string[]) => {
      const rows = await app.db
        .select()
        .from(schema.jobInputs)
        .where(inArray(schema.jobInputs.jobId, ids));
      return rows
        .map((r) => strip(r as unknown as Record<string, unknown>))
        .sort((a, b) => String(a.poseId).localeCompare(String(b.poseId)));
    };

    expect(await load(batchJobIds)).toEqual(await load(singleJobIds));
  });

  it('rejects a batch whose garment type requires the mannequin two-pass flow', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-mannequin@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const [mannequinGarmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        label: 'Saree',
        slug: `saree-${Date.now()}`,
        genderSlug: 'men',
        requiresMannequinStep: true,
      })
      .returning();
    const g = await uploadKey(userId, '66666666-6666-4666-8666-666666666666');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: mannequinGarmentType.id,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);

    // No job or credit-ledger residue from the rejected batch.
    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(0);
  });

  it('rolls back the whole batch — no jobs, no credit deduction — when credits run out mid-batch', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-rollback@x.com');
    // Two rows of two poses each = 4 jobs @ 35 credits (2K) = 140 needed.
    // 100 covers only the first two jobs, so atomicDeduct throws on the third,
    // inside the single batch transaction.
    await grantCredits(userId, 100);
    const cat = await seedCatalog();
    const g1 = await uploadKey(userId, '77777777-7777-4777-8777-777777777777');
    const g2 = await uploadKey(userId, '88888888-8888-4888-8888-888888888888');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g1,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
          {
            upperGarmentKey: g2,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(402);

    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(0);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(100);

    const streamLen = await app.redis.xlen('jobs:normal');
    expect(streamLen).toBe(0);
  });

  it('rejects the whole batch when the balance is short, charging nothing', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-poor@x.com');
    await grantCredits(userId, 1);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '66666666-6666-4666-8666-666666666666');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('INSUFFICIENT_CREDITS');
    expect(res.json().error.required).toBeGreaterThan(res.json().error.available);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);

    const ledger = await app.db
      .select({ id: schema.creditLedger.id })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger).toHaveLength(0);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1);
  });

  it('rejects a batch whose total job count exceeds the admin cap', async () => {
    await seedCreditPlan();
    await app.redis.set('config:system', JSON.stringify({ maxBatchJobs: 2 }));
    const { token, userId } = await registerUser('batch-cap@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '77777777-7777-4777-8777-777777777777');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(res.json().error.totalJobs).toBe(3);
    expect(res.json().error.maxBatchJobs).toBe(2);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);
  });

  it('names the offending row when it references an inactive pose', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-badrow@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, '88888888-8888-4888-8888-888888888888');
    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: false })
      .where(eq(schema.modelPoseAssets.id, cat.poseBId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseBId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_CATALOG');
    expect(res.json().error.rowIndex).toBe(1);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);

    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: true })
      .where(eq(schema.modelPoseAssets.id, cat.poseBId));
  });

  it('names the offending row when its garment key belongs to another user', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-thief@x.com');
    const other = await registerUser('batch-victim@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const mine = await uploadKey(userId, '99999999-9999-4999-8999-999999999999');
    const theirs = await uploadKey(other.userId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: mine,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
          {
            upperGarmentKey: theirs,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.rowIndex).toBe(1);

    const jobs = await app.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobs).toHaveLength(0);
  });

  it('accepts a past-upload garment key from the caller’s own job history after the 24h binding expired', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-past-upload@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const pastKey = await uploadKey(userId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    // The tray's "Past uploads" tab sources keys from GET /v1/assets, i.e. this
    // user's own job_inputs rows — seed one so the key has that provenance.
    const [pastJob] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED' })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: pastJob.id,
      upperGarmentKey: pastKey,
      faceId: cat.faceId,
      backgroundId: cat.bgId,
      poseId: cat.poseAId,
      garmentTypeId: cat.garmentTypeId,
    });

    // Simulate the 24h upload:owner TTL lapsing — the key is still demonstrably
    // the caller's, but the Redis binding is gone.
    await app.redis.del(`upload:owner:${pastKey}`);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: pastKey,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalJobs).toBe(1);
  });

  it('rejects a row that repeats the same pose', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-duppose@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseAId],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.rowIndex).toBe(0);
  });

  it('refunds and fails every job when the queue is unreachable', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-noqueue@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          garmentTypeId: cat.garmentTypeId,
          aspectRatio: '1:1',
          resolution: '2K',
          rows: [
            {
              upperGarmentKey: g,
              faceId: cat.faceId,
              backgroundId: cat.bgId,
              poseIds: [cat.poseAId, cat.poseBId],
            },
          ],
        },
      });
    } finally {
      app.redis.xadd = realXadd;
    }

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ENQUEUE_FAIL');

    const jobRows = await app.db
      .select({ status: schema.jobs.status, errorCode: schema.jobs.errorCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.status === 'FAILED' && j.errorCode === 'ENQUEUE_FAIL')).toBe(
      true,
    );

    // Charged then refunded, so the net balance is whole again.
    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits.balance).toBe(1000);
  });

  it('returns 201 with failedJobIds when only some enqueues fail', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-partialqueue@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

    const realXadd = app.redis.xadd.bind(app.redis);
    let calls = 0;
    app.redis.xadd = (async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('redis blip');
      return (realXadd as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof app.redis.xadd;

    let res: Awaited<ReturnType<typeof app.inject>>;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          garmentTypeId: cat.garmentTypeId,
          aspectRatio: '1:1',
          resolution: '2K',
          rows: [
            {
              upperGarmentKey: g,
              faceId: cat.faceId,
              backgroundId: cat.bgId,
              poseIds: [cat.poseAId, cat.poseBId],
            },
          ],
        },
      });
    } finally {
      app.redis.xadd = realXadd;
    }

    expect(res.statusCode).toBe(201);
    expect(res.json().failedJobIds).toHaveLength(1);

    const failedId = res.json().failedJobIds[0];
    const [failed] = await app.db
      .select({ status: schema.jobs.status, errorCode: schema.jobs.errorCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, failedId));
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('ENQUEUE_FAIL');
  });

  it("reports per-catalogue progress for a batch, and 404s another user's batch", async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('batch-progress@x.com');
    const stranger = await registerUser('batch-stranger@x.com');
    await grantCredits(userId, 1000);
    const cat = await seedCatalog();
    const g = await uploadKey(userId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId: cat.garmentTypeId,
        aspectRatio: '1:1',
        resolution: '2K',
        rows: [
          {
            upperGarmentKey: g,
            faceId: cat.faceId,
            backgroundId: cat.bgId,
            poseIds: [cat.poseAId, cat.poseBId],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { batchId, catalogues } = created.json();

    // Drive one job to COMPLETED so the counts are not all zero.
    await app.db
      .update(schema.jobs)
      .set({ status: 'COMPLETED' })
      .where(eq(schema.jobs.id, catalogues[0].jobIds[0]));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/batches/${batchId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.batchId).toBe(batchId);
    expect(body.totalJobs).toBe(2);
    expect(body.catalogues).toHaveLength(1);
    expect(body.catalogues[0].catalogueId).toBe(catalogues[0].catalogueId);
    expect(body.catalogues[0].total).toBe(2);
    expect(body.catalogues[0].completed).toBe(1);
    expect(body.catalogues[0].failed).toBe(0);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/batches/${batchId}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(foreign.statusCode).toBe(404);
  });
});
