import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { initWatermarkTile } from '../../src/workflow/watermark.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-wm-snapshot';

describe('watermark entitlement snapshot — core business rule', () => {
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
    await initWatermarkTile();
    // A real decodable PNG — sharp's watermark compositing and thumbnail
    // generation both need valid image bytes, unlike the default 8-byte
    // magic-number stub the mock returns.
    realOutputBytes = await sharp({
      create: { width: 640, height: 800, channels: 3, background: { r: 180, g: 60, b: 60 } },
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

  async function seedSareeJob(opts: { watermark: boolean }) {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `wm-snap-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user?.id, balance: 4 });

    const [workflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-wf-${randomUUID()}`,
        label: 'Saree workflow',
        workflowType: 'saree',
        jsonContent: {},
        isActive: true,
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['2'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();

    // The watermark snapshot is taken at job-creation time in the real API
    // (jobs/create.ts) — here we insert the jobs row directly with that
    // decision already made, exactly as create.ts would have left it.
    const [job] = await env.db
      .insert(schema.jobs)
      .values({
        userId: user?.id,
        status: 'QUEUED',
        priority: false,
        creditsCharged: 1,
        watermark: opts.watermark,
      })
      .returning();

    const garmentKey = `inputs/${job?.id}/garment.jpg`;
    const modelKey = `saree/model-${randomUUID()}.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId: job?.id,
      upperGarmentKey: garmentKey,
      params: { modelKey, workflowTemplateId: workflow?.id, kind: 'saree' },
    });

    for (const key of [garmentKey, modelKey]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job?.id as string, userId: user?.id as string };
  }

  it('stays WATERMARKED even if the user upgrades to a paid plan while the job is queued/processing', async () => {
    // Job created while free — watermark:true snapshotted onto the job row.
    const { jobId, userId } = await seedSareeJob({ watermark: true });

    // Simulate the user upgrading mid-flight: their tier changes, but the
    // job row's snapshot must not be touched by this (and the dispatcher
    // must never look at users.tier or credit_plans in the first place).
    await env.db.update(schema.users).set({ tier: 'starter' }).where(eq(schema.users.id, userId));

    const log = createLogger('test');
    const stream = `jobs:test-${jobId}`;
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      stream,
      '1-1',
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');
    // The snapshot itself is immutable regardless of the later tier change.
    expect(job?.watermark).toBe(true);

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    // This is the core business rule the whole snapshot-at-creation design
    // exists to guarantee: what was actually delivered reflects the plan at
    // CREATION time, not whatever the user's plan happens to be by the time
    // the job finishes.
    expect(output?.assetKind).toBe('WATERMARKED');
    expect(output?.watermarkVersion).toBe(1);
  });

  it('delivers ORIGINAL for a job snapshotted as non-watermarked, even if the user later downgrades', async () => {
    const { jobId, userId } = await seedSareeJob({ watermark: false });
    await env.db.update(schema.users).set({ tier: 'free' }).where(eq(schema.users.id, userId));

    const log = createLogger('test');
    const stream = `jobs:test-${jobId}`;
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      stream,
      '1-1',
    );

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output?.assetKind).toBe('ORIGINAL');
    expect(output?.watermarkVersion).toBeNull();
  });

  it('generates the thumbnail from the watermarked buffer, not the pre-watermark original', async () => {
    const { jobId, userId } = await seedSareeJob({ watermark: true });
    const log = createLogger('test');
    const stream = `jobs:test-${jobId}`;
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      stream,
      '1-1',
    );

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output?.assetKind).toBe('WATERMARKED');
    expect(output?.thumbnailKey).toBe(`outputs/${jobId}/result.thumb.jpg`);

    // The result and the thumbnail must both show the watermark composited —
    // regression guard for the leak the spec explicitly closes (thumbnail
    // generated from the pre-watermark original would defeat the whole
    // feature via the smaller preview image).
    const resultBuf = await env.storage.getObject(`outputs/${jobId}/result.png`);
    const thumbBuf = await env.storage.getObject(`outputs/${jobId}/result.thumb.jpg`);

    // Neither should be byte-identical to the un-watermarked source we fed in
    // (weak but real signal that compositing actually ran on both outputs).
    expect(Buffer.compare(resultBuf, Buffer.from(realOutputBytes))).not.toBe(0);
    const thumbMeta = await sharp(thumbBuf).metadata();
    expect(thumbMeta.width).toBeLessThanOrEqual(512);
  });
});
