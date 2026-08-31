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

const WORKER_ID = 'test-worker-merchant-mannequin';

describe('dispatcher — merchant-catalog job with needsMannequinStep', () => {
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
      {
        id: WORKER_ID,
        url: comfy.url,
        apiKey: 'test-key',
        allowedJobTypes: ['saree', 'catalogue'],
      },
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

  function templateFields(overrides: Partial<typeof schema.workflowTemplates.$inferInsert>) {
    return {
      jsonContent: {
        f: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        p: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        b: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        g: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        out: { class_type: 'SaveImage', inputs: { images: ['f', 0] } },
      },
      workflowType: 'regular',
      faceNodeId: 'f',
      poseNodeId: 'p',
      bgNodeId: 'b',
      upperNodeIds: ['g'],
      facePhasePromptNode: 'f',
      garmentPhasePromptNode: 'f',
      resultNodeId: '10',
      ...overrides,
    };
  }

  it('runs the mannequin phase inline, then saree_step2, ending COMPLETED with both outputs in R2', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `merchant-mannequin-${Date.now()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [mannequinTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-step1-${Date.now()}`,
        label: 'Merchant Step1',
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

    const [step2Template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-step2-${Date.now()}`,
        label: 'Merchant Step2',
        ...templateFields({}),
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `merchant-flat-saree-${Date.now()}`,
        label: 'Merchant Flat Saree',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: mannequinTemplate.id,
        sareeStep2WorkflowTemplateId: step2Template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'f.jpg',
        thumbnailKey: 'f.jpg',
        faceSideR2Key: 'f.jpg',
      })
      .returning();
    const [bg] = await env.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();

    // The raw flat photo — NEVER mannequin-processed, unlike
    // saree-step2-workflow-override.test.ts which seeds an already-resolved key.
    const rawGarmentKey = `merchant-catalog/flat/${job.id}/garment.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: rawGarmentKey,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'merchant_catalog', needsMannequinStep: true },
    });

    for (const key of [rawGarmentKey, 'f.jpg', 'b.jpg', 'p.jpg']) {
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
      '1-1',
    );

    const [completedJob] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(completedJob?.status).toBe('COMPLETED');

    // Mannequin phase actually ran and uploaded its intermediate output.
    const intermediate = await env.s3.send(
      new GetObjectCommand({
        Bucket: env.r2Bucket,
        Key: `outputs/${job.id}/mannequin-intermediate.png`,
      }),
    );
    expect(intermediate.$metadata.httpStatusCode).toBe(200);

    // Final saree_step2 output also exists.
    const finalOutput = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${job.id}/result.png` }),
    );
    expect(finalOutput.$metadata.httpStatusCode).toBe(200);

    // Two separate ComfyUI submissions happened — one per phase.
    const dispatchEvents = await env.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')),
      );
    expect(dispatchEvents).toHaveLength(2);
    const mannequinEvent = dispatchEvents.find(
      (e) => (e.payload as { phase?: string }).phase === 'mannequin',
    );
    expect(mannequinEvent).toBeTruthy();
    expect((mannequinEvent!.payload as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      mannequinTemplate.id,
    );
    const step2Event = dispatchEvents.find((e) => e !== mannequinEvent);
    expect((step2Event!.payload as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      step2Template.id,
    );
    // saree_step2 received the mannequin's OUTPUT key, not the raw flat photo.
    expect(
      (step2Event!.payload as { inputs?: { _r2Keys?: { effectiveUpperGarmentKey?: string } } })
        .inputs?._r2Keys?.effectiveUpperGarmentKey,
    ).toBe(`outputs/${job.id}/mannequin-intermediate.png`);
  });

  it('fails the job (with retry) when the garment type has no mannequinWorkflowTemplateId configured', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `merchant-mannequin-noconfig-${Date.now()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [step2Template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-noconfig-step2-${Date.now()}`,
        label: 'Merchant Step2 NoConfig',
        ...templateFields({}),
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `merchant-noconfig-${Date.now()}`,
        label: 'Merchant NoConfig',
        requiresMannequinStep: true,
        // mannequinWorkflowTemplateId intentionally left null
        sareeStep2WorkflowTemplateId: step2Template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'F', r2Key: 'f2.jpg', thumbnailKey: 'f2.jpg' })
      .returning();
    const [bg] = await env.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg2', r2Key: 'b2.jpg', thumbnailKey: 'b2.jpg' })
      .returning();
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose2', r2Key: 'p2.jpg', thumbnailKey: 'p2.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    const rawGarmentKey = `merchant-catalog/flat/${job.id}/garment.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: rawGarmentKey,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'merchant_catalog', needsMannequinStep: true },
    });

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-2',
    );

    // markFailed is used for this pre-flight config error — terminal immediately,
    // not a retryable failure (retrying can't fix a missing config value).
    const [failedJob] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(failedJob?.status).toBe('FAILED');
    expect(failedJob?.errorCode).toBe('MANNEQUIN_WORKFLOW_NOT_CONFIGURED');
  });
});
