import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-tryon-direct-webp';
const PERSON_NODE_ID = '20';
const GARMENT_NODE_ID = '21';
// comfy-mock's /history handler hardcodes output images under node '10'.
const OUTPUT_NODE_ID = '10';

describe('tryon-direct job (source=tryon / api_tryon) — result uploaded as WebP q90', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;
  let realOutputBytes: Uint8Array;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    await registerWorkers(redis, [{ id: WORKER_ID, url: comfy.url, apiKey: 'test-key' }]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');

    // A real decodable PNG — sharp's webp re-encode needs valid image bytes,
    // unlike the default 8-byte magic-number stub the mock returns.
    realOutputBytes = await sharp({
      create: { width: 640, height: 800, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .png()
      .toBuffer();
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({ outputBytes: realOutputBytes });
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  async function seedTryonDirectJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `tryon-direct-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    if (!user) throw new Error('failed to seed user');
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 10 });

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `tryon-direct-tpl-${randomUUID()}`,
        label: 'Tryon direct test template',
        jsonContent: {
          [PERSON_NODE_ID]: { inputs: { image: '' } },
          [GARMENT_NODE_ID]: { inputs: { image: '' } },
          [OUTPUT_NODE_ID]: { class_type: 'SaveImage', inputs: {} },
        },
        faceNodeId: 'x',
        poseNodeId: 'x',
        bgNodeId: 'x',
        upperNodeIds: ['x'],
        facePhasePromptNode: 'x',
        garmentPhasePromptNode: 'x',
        workflowType: 'tryon',
        tryonPersonNodeId: PERSON_NODE_ID,
        tryonGarmentNodeId: GARMENT_NODE_ID,
        tryonOutputNodeId: OUTPUT_NODE_ID,
      })
      .returning();
    if (!template) throw new Error('failed to seed workflow template');

    const [job] = await env.db
      .insert(schema.jobs)
      .values({
        userId: user.id,
        status: 'QUEUED',
        creditsCharged: 2,
        source: 'tryon',
      })
      .returning();
    if (!job) throw new Error('failed to seed job');

    const personKey = `dev/${user.id}/${randomUUID()}.jpg`;
    const garmentKey = `dev/${user.id}/${randomUUID()}.jpg`;

    // Tryon-direct jobs are identified by shape: no faceId/backgroundId/poseId,
    // and params.personKey set (see processor.ts's top-level routing).
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: garmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { personKey, workflowTemplateId: template.id },
    });

    for (const key of [personKey, garmentKey]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job.id as string, userId: user.id as string };
  }

  it('uploads the result as image/webp at outputs/{jobId}/result.webp', async () => {
    const { jobId, userId } = await seedTryonDirectJob();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output?.resultKey).toBe(`outputs/${jobId}/result.webp`);

    const obj = await env.s3.send(
      new GetObjectCommand({
        Bucket: env.r2Bucket,
        Key: `outputs/${jobId}/result.webp`,
      }),
    );
    expect(obj.$metadata.httpStatusCode).toBe(200);
    expect(obj.ContentType).toBe('image/webp');

    const bytes = await obj.Body?.transformToByteArray();
    expect(bytes).toBeDefined();
    const meta = await sharp(Buffer.from(bytes as Uint8Array)).metadata();
    expect(meta.format).toBe('webp');
  });
});
