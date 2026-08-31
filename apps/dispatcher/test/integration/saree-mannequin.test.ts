import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-mannequin';

describe('dispatcher — saree mannequin (step 1) job', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['saree'] },
    ]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({});
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  async function seedMannequinJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-${Date.now()}`,
        label: 'Step1',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-${Date.now()}`,
        label: 'Flat Saree',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'F', r2Key: 'face/f.jpg', thumbnailKey: 'face/f.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      faceId: face.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin' },
    });

    for (const key of [`inputs/${job.id}/garment.jpg`, 'face/f.jpg']) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job.id, userId: user.id };
  }

  it('processes a saree_mannequin job to COMPLETED with 0 credits, output uploaded', async () => {
    const { jobId, userId } = await seedMannequinJob();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-1',
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');
    expect(job?.creditsCharged).toBe(0);

    const obj = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${jobId}/result.png` }),
    );
    expect(obj.$metadata.httpStatusCode).toBe(200);
  });

  async function seedMannequinJobNoPersonNode() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-noface-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-nopersonnode-${Date.now()}`,
        label: 'Step1 No Person Node',
        jsonContent: {
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: null,
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-noface-${Date.now()}`,
        label: 'Flat Saree No Face',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: template.id,
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      faceId: null,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin' },
    });

    await env.s3.send(
      new PutObjectCommand({
        Bucket: env.r2Bucket,
        Key: `inputs/${job.id}/garment.jpg`,
        Body: Buffer.from('stub'),
        ContentType: 'image/jpeg',
      }),
    );

    return { jobId: job.id, userId: user.id };
  }

  it('processes a saree_mannequin job with no person node and null faceId to COMPLETED', async () => {
    const { jobId, userId } = await seedMannequinJobNoPersonNode();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-2',
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');

    const prompt = comfy.lastPrompt();
    // Garment node was patched with the uploaded file; no person node exists to patch.
    expect(prompt?.prompt['2']?.inputs?.image).toBeTruthy();
  });

  it('uses the snapshotted style workflow template instead of the garment type default', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-style-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [defaultTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-default-${Date.now()}`,
        label: 'Step1 Default',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [styleTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-style-${Date.now()}`,
        label: 'Step1 Style',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-style-${Date.now()}`,
        label: 'Flat Saree Style',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: defaultTemplate.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'face/fstyle.jpg',
        thumbnailKey: 'face/fstyle.jpg',
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      faceId: face.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin', workflowTemplateId: styleTemplate.id },
    });

    for (const key of [`inputs/${job.id}/garment.jpg`, 'face/fstyle.jpg']) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-3',
    );

    const [completedJob] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(completedJob?.status).toBe('COMPLETED');

    const [dispatchEvent] = await env.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')),
      );
    expect((dispatchEvent?.payload as { workflowTemplateId?: string })?.workflowTemplateId).toBe(
      styleTemplate.id,
    );
  });

  it('processes a dev-API saree_mannequin job with garmentTypeId: null and a snapshotted workflowTemplateId to COMPLETED', async () => {
    // Mirrors the exact shape createDevSareeMannequinJob writes: garmentTypeId
    // and faceId are always null, and the workflow is resolved entirely off
    // params.workflowTemplateId — garment_subcategories is never touched.
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `mannequin-dev-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();

    const [devTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-dev-${Date.now()}`,
        label: 'Step1 Dev',
        jsonContent: {
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: null,
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();

    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      faceId: null,
      garmentTypeId: null,
      params: { kind: 'saree_mannequin', workflowTemplateId: devTemplate.id },
    });

    await env.s3.send(
      new PutObjectCommand({
        Bucket: env.r2Bucket,
        Key: `inputs/${job.id}/garment.jpg`,
        Body: Buffer.from('stub'),
        ContentType: 'image/jpeg',
      }),
    );

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-4',
    );

    const [completedJob] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    // Prior to the guard fix this job would have been marked FAILED with
    // MANNEQUIN_INPUTS_MISSING before ever reaching the snapshot check.
    expect(completedJob?.status).toBe('COMPLETED');

    const [dispatchEvent] = await env.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')),
      );
    expect((dispatchEvent?.payload as { workflowTemplateId?: string })?.workflowTemplateId).toBe(
      devTemplate.id,
    );
  });

  async function seedTwoInputMannequinJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `mannequin-two-input-${Date.now()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-two-input-${Date.now()}`,
        label: 'Step1 Two Input',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '3': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1_two_input',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonGarmentNodeId2: '3',
        tryonOutputNodeId: '10',
      })
      .returning();
    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-two-input-${Date.now()}`,
        label: 'Flat Saree Two Input',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: template.id,
      })
      .returning();
    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'face/ftwoinput.jpg',
        thumbnailKey: 'face/ftwoinput.jpg',
      })
      .returning();
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 0 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `inputs/${job.id}/garment.jpg`,
      thirdGarmentKey: `inputs/${job.id}/pallu.jpg`,
      faceId: face.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'saree_mannequin', workflowTemplateId: template.id },
    });
    for (const key of [
      `inputs/${job.id}/garment.jpg`,
      `inputs/${job.id}/pallu.jpg`,
      'face/ftwoinput.jpg',
    ]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }
    return { jobId: job.id, userId: user.id };
  }

  it('patches both body and pallu nodes for a two-input mannequin job', async () => {
    const { jobId, userId } = await seedTwoInputMannequinJob();
    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-5',
    );
    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');
    const prompt = comfy.lastPrompt();
    expect(prompt?.prompt['2']?.inputs?.image).toContain('mannequin_garment_');
    expect(prompt?.prompt['3']?.inputs?.image).toContain('mannequin_pallu_');
  });
});
