import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('simple tryon (garment from catalog)', () => {
  let c: Containers;
  let app: TestApp;
  let realHeadObject: typeof app.storage.headObject | undefined;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    realHeadObject = app.storage.headObject?.bind(app.storage);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
  });
  afterEach(() => {
    if (realHeadObject) app.storage.headObject = realHeadObject;
  });

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  // Seeds an eligible source job: an active tryon workflow → an active tryon
  // category pointing at it → a garment type mapped to that category → a
  // COMPLETED job owned by `userId` whose job_inputs.garmentTypeId points at
  // that garment type, with a job_outputs row (thumbnail optional).
  // By default also sets job_inputs.poseId (a real model_pose_assets row) to
  // mimic a Studio-flow job — createJob always sets poseId, createSimpleTryonJob
  // never does, so poseId is the picker's studio-vs-tryon discriminator.
  // Pass studioFlow: false to seed a tryon-chain-generated job instead (no poseId).
  async function seedEligibleSourceJob(
    userId: string,
    opts?: {
      withThumbnail?: boolean;
      categoryActive?: boolean;
      workflowActive?: boolean;
      studioFlow?: boolean;
      resultKey?: string;
    },
  ) {
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `tryon-wf-${randomUUID()}`,
        label: 'Tryon workflow',
        workflowType: 'tryon',
        jsonContent: {},
        isActive: opts?.workflowActive ?? true,
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();

    const [category] = await app.db
      .insert(schema.tryonCategories)
      .values({
        name: 'Upper',
        slug: `upper-${randomUUID()}`,
        workflowTemplateId: workflow.id,
        isActive: opts?.categoryActive ?? true,
      })
      .returning();

    const [subcat] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `shirt-${randomUUID()}`,
        label: 'Shirt',
        tryonCategoryId: category.id,
      })
      .returning();

    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();

    let poseId: string | null = null;
    if (opts?.studioFlow ?? true) {
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: `Pose ${randomUUID()}`,
          r2Key: 'poses/seed/pose.jpg',
          thumbnailKey: 'poses/seed/pose.thumb.jpg',
        })
        .returning();
      poseId = pose.id;
    }

    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/seed/garment.jpg',
      garmentTypeId: subcat.id,
      poseId,
    });

    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey: opts?.resultKey ?? keys.output(job.id),
      thumbnailKey: opts?.withThumbnail === false ? null : keys.outputThumb(job.id),
    });

    return { jobId: job.id, workflowTemplateId: workflow.id, subcategoryId: subcat.id };
  }

  it('happy path: deducts 5 credits, uses keys.output(sourceJobId) as garment, resolves workflow', async () => {
    const { token, userId } = await registerUser('tryon-happy@x.com');
    await grantCredits(userId, 100);
    const {
      jobId: sourceJobId,
      workflowTemplateId,
      subcategoryId,
    } = await seedEligibleSourceJob(userId);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId, catalogueId } = res.json();
    expect(jobId).toBeTruthy();
    expect(catalogueId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
    expect(job.source).toBe('tryon');

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(95);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(keys.output(sourceJobId));
    expect(inputs.garmentTypeId).toBe(subcategoryId);
    const params = inputs.params as Record<string, unknown>;
    expect(params.personKey).toBe(personKey);
    expect(params.workflowTemplateId).toBe(workflowTemplateId);

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);
  });

  // Tryon-direct results (source='tryon'/'api_tryon') are stored WebP-encoded
  // (see apps/dispatcher/src/workflow/finalize.ts), so a chained job's garment
  // key must come from the source job's actual stored job_outputs.resultKey —
  // reconstructing via keys.output(sourceJobId) would point at a .png key that
  // was never uploaded, silently breaking the "try again with a different
  // garment" flow.
  it('uses the source job stored resultKey as the garment — not a reconstructed .png key', async () => {
    const { token, userId } = await registerUser('tryon-webp-chain@x.com');
    await grantCredits(userId, 100);
    const webpResultKey = 'outputs/some-prior-tryon-job/result.webp';
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId, {
      resultKey: webpResultKey,
    });
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(webpResultKey);
    expect(inputs.upperGarmentKey).not.toBe(keys.output(sourceJobId));
  });

  it('rejects with FORBIDDEN when sourceJobId belongs to another user', async () => {
    const { userId: otherUserId } = await registerUser('tryon-owner@x.com');
    const { jobId: sourceJobId } = await seedEligibleSourceJob(otherUserId);

    const { token, userId } = await registerUser('tryon-thief@x.com');
    await grantCredits(userId, 100);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects with NOT_FOUND when sourceJobId does not exist', async () => {
    const { token, userId } = await registerUser('tryon-missing@x.com');
    await grantCredits(userId, 100);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId: randomUUID() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects with VALIDATION when the source job is not COMPLETED', async () => {
    const { token, userId } = await registerUser('tryon-notdone@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId);
    await app.db
      .update(schema.jobs)
      .set({ status: 'QUEUED' })
      .where(eq(schema.jobs.id, sourceJobId));
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects with VALIDATION when the garment type has no tryon category mapped', async () => {
    const { token, userId } = await registerUser('tryon-unmapped@x.com');
    await grantCredits(userId, 100);
    const [subcat] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `unmapped-${randomUUID()}`, label: 'Unmapped' })
      .returning();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/seed/garment.jpg',
      garmentTypeId: subcat.id,
    });
    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey: keys.output(job.id),
      thumbnailKey: keys.outputThumb(job.id),
    });
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId: job.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects with VALIDATION when the mapped tryon category is inactive (admin kill-switch)', async () => {
    const { token, userId } = await registerUser('tryon-catinactive@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId, { categoryActive: false });
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects with VALIDATION when the mapped workflow template is inactive (admin kill-switch)', async () => {
    const { token, userId } = await registerUser('tryon-wfinactive@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId, { workflowActive: false });
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/simple-tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: { personKey, sourceJobId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refunds credits and marks FAILED on enqueue failure', async () => {
    const { token, userId } = await registerUser('tryon-enqfail@x.com');
    await grantCredits(userId, 100);
    const { jobId: sourceJobId } = await seedEligibleSourceJob(userId);
    const personKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, personKey);

    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/simple-tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: { personKey, sourceJobId },
      });
      expect(res.statusCode).toBe(503);

      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(100);

      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.userId, userId), ne(schema.jobs.id, sourceJobId)));
      expect(job.status).toBe('FAILED');
      expect(job.errorCode).toBe('ENQUEUE_FAIL');
    } finally {
      app.redis.xadd = realXadd;
    }
  });

  describe('GET /v1/tryon/garment-images', () => {
    it('returns only eligible completed images owned by the caller', async () => {
      const { token, userId } = await registerUser('tryon-picker@x.com');
      const { jobId: eligibleJobId } = await seedEligibleSourceJob(userId);

      // Ineligible: garmentTypeId set but no tryonCategoryId mapping.
      const [unmapped] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'men', slug: `um-${randomUUID()}`, label: 'Unmapped' })
        .returning();
      const [unmappedJob] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: unmappedJob.id,
        upperGarmentKey: 'inputs/seed/garment.jpg',
        garmentTypeId: unmapped.id,
      });
      await app.db.insert(schema.jobOutputs).values({
        jobId: unmappedJob.id,
        resultKey: keys.output(unmappedJob.id),
      });

      // Ineligible: another user's eligible job.
      const { userId: otherUserId } = await registerUser('tryon-picker-other@x.com');
      await seedEligibleSourceJob(otherUserId);

      // Ineligible: mapped tryon category is inactive (admin kill-switch).
      await seedEligibleSourceJob(userId, { categoryActive: false });

      // Ineligible: mapped workflow template is inactive (admin kill-switch).
      await seedEligibleSourceJob(userId, { workflowActive: false });

      // Ineligible: tryon-chain-generated image (no poseId — not from Studio).
      await seedEligibleSourceJob(userId, { studioFlow: false });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/tryon/garment-images',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ jobId: string; garmentTypeName: string }>;
      expect(body.map((r) => r.jobId)).toEqual([eligibleJobId]);
      expect(body[0].garmentTypeName).toBe('Shirt');
    });
  });
});
