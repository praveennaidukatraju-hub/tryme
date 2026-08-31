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

const WORKER_ID = 'test-worker-step2-override';

describe('dispatcher — saree step-2 workflow override', () => {
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
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['catalogue'] },
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

  function baseWorkflowFields(overrides: Partial<typeof schema.workflowTemplates.$inferInsert>) {
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
      // The comfy-mock's /history handler hardcodes output images under node
      // '10' (see comfy-mock.ts) — match that here so fetchHistory's
      // resultNodeId filter actually finds them (same pattern as
      // shopify.test.ts's OUTPUT_NODE_ID).
      resultNodeId: '10',
      ...overrides,
    };
  }

  it('uses garment_subcategories.sareeStep2WorkflowTemplateId, ignoring the pose default', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `step2-override-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [wrongWorkflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({ slug: `wrong-${Date.now()}`, label: 'Wrong', ...baseWorkflowFields({}) })
      .returning();
    const [correctWorkflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({ slug: `correct-${Date.now()}`, label: 'Correct', ...baseWorkflowFields({}) })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-${Date.now()}`,
        label: 'Flat Saree',
        requiresMannequinStep: true,
        sareeStep2WorkflowTemplateId: correctWorkflow.id,
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
    // Pose's OWN default workflow is the "wrong" one — the override must win.
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Pose',
        r2Key: 'p.jpg',
        thumbnailKey: 'p.jpg',
        workflowTemplateId: wrongWorkflow.id,
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `outputs/${job.id}-mannequin/result.png`,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
    });

    for (const key of [`outputs/${job.id}-mannequin/result.png`, 'f.jpg', 'b.jpg', 'p.jpg']) {
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
      // Must be a real Redis stream-entry ID format (<ms>-<seq>) — processJob's
      // final XACK rejects anything else (same convention as every other
      // integration test in this suite, e.g. saree-mannequin.test.ts's '1-1').
      '1-1',
    );

    const [completedJob] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(completedJob?.status).toBe('COMPLETED');

    // transitionJob() also inserts a job_events row per status transition
    // (GENERATING/UPLOADING/COMPLETED etc.) — filter to the COMFY_DISPATCH
    // row specifically, the only one carrying workflowTemplateId in its payload.
    const [dispatchEvent] = await env.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')),
      );
    expect((dispatchEvent?.payload as { workflowTemplateId?: string })?.workflowTemplateId).toBe(
      correctWorkflow.id,
    );

    const obj = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${job.id}/result.png` }),
    );
    expect(obj.$metadata.httpStatusCode).toBe(200);
  });

  it('applies pose_garment_configs.promptGarmentPhase, not the pose base value', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `step2-prompt-override-${Date.now()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [workflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step2-${Date.now()}`,
        label: 'Saree Step 2',
        ...baseWorkflowFields({}),
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-prompt-${Date.now()}`,
        label: 'Flat Saree',
        requiresMannequinStep: true,
        sareeStep2WorkflowTemplateId: workflow.id,
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
    // Pose's own base prompt is the generic, wrong wording — the
    // pose_garment_configs override for this garment type must win instead.
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Pose',
        r2Key: 'p.jpg',
        thumbnailKey: 'p.jpg',
        workflowTemplateId: workflow.id,
        promptGarmentPhase: 'wear image3 upper and lower and footwear',
      })
      .returning();
    await env.db.insert(schema.poseGarmentConfigs).values({
      poseAssetId: pose.id,
      subcategoryId: garmentType.id,
      promptGarmentPhase: 'wear image3 blouse and saree',
    });

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: `outputs/${job.id}-mannequin/result.png`,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
    });

    for (const key of [`outputs/${job.id}-mannequin/result.png`, 'f.jpg', 'b.jpg', 'p.jpg']) {
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
      '1-2',
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
    const promptNode = (
      dispatchEvent?.payload as { prompt?: Record<string, { inputs?: { prompt?: string } }> }
    )?.prompt?.f;
    expect(promptNode?.inputs?.prompt).toBe('wear image3 blouse and saree');
  });
});
