import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the WatermarkService to fail for every job in this file — this is the
// spec's fail-closed requirement: if applying the watermark throws for a
// watermark:true job, the job must fail and NOTHING must be uploaded. A real
// tile-init failure is hard to reproduce reliably; mocking is the direct way
// to pin this behavior without depending on WatermarkService internals.
vi.mock('../../src/workflow/watermark.js', () => ({
  WATERMARK_VERSION: 1,
  initWatermarkTile: vi.fn().mockResolvedValue(undefined),
  applyWatermark: vi.fn().mockRejectedValue(new Error('mock watermark failure')),
  tileOffsetForJob: vi.fn().mockReturnValue({ x: 0, y: 0 }),
}));

import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-wm-failclosed';

describe('finalizeOutput — fail-closed on watermark failure', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();
    await registerWorkers(redis, [{ id: WORKER_ID, url: comfy.url, apiKey: 'test-key' }]);
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

  // Saree jobs are the smallest job "kind" the dispatcher supports — no
  // face/background/pose model rows needed, just a workflow template with the
  // tryon* node IDs and a garment key in R2. finalizeOutput() behaves
  // identically regardless of job kind, so this is a faithful, minimal seed
  // for exercising it.
  async function seedWatermarkedSareeJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `wm-fc-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    // Seed the post-deduction balance (job creation always deducts creditsCharged
    // before enqueueing) so a refund test can assert it returns to the
    // pre-deduction amount, not double-count.
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

    const [job] = await env.db
      .insert(schema.jobs)
      .values({
        userId: user?.id,
        status: 'QUEUED',
        priority: false,
        creditsCharged: 1,
        watermark: true,
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

  it('fails the job and uploads nothing when watermarking throws for a watermark:true job', async () => {
    const { jobId, userId } = await seedWatermarkedSareeJob();
    const log = createLogger('test');
    // A stream name unique to this test avoids colliding with a persisted
    // `jobs:normal` stream on the shared dev Redis instance. The message ID
    // must be valid Redis stream-ID syntax (<ms>-<seq>) — XACK validates this
    // strictly once the stream key exists (e.g. from the retry path's own
    // preceding XADD), unlike an arbitrary string which only slips through
    // silently against a not-yet-created stream.
    const stream = `jobs:test-${jobId}`;

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      stream,
      '1-1',
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    // First failure re-queues (attempts 1 of MAX_ATTEMPTS=2) — must not be COMPLETED.
    expect(job?.status).not.toBe('COMPLETED');
    expect(job?.attempts).toBe(1);

    // Critical assertion: no job_outputs row and no object in R2 — the
    // un-watermarked buffer must never be uploaded.
    const outputs = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(outputs).toHaveLength(0);

    await expect(
      env.s3.send(
        new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${jobId}/result.png` }),
      ),
    ).rejects.toThrow();
  });

  it('reaches terminal FAILED with a refund after MAX_ATTEMPTS, still with no upload', async () => {
    const { jobId, userId } = await seedWatermarkedSareeJob();
    const log = createLogger('test');
    const cfg = {
      db: env.db,
      redis,
      pub,
      storage: env.storage,
      s3: env.s3,
      r2Bucket: env.r2Bucket,
      log,
    };
    const stream = `jobs:test-${jobId}`;

    await processJob(cfg, jobId, userId, stream, '2-1');
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
    await processJob(cfg, jobId, userId, stream, '3-1');

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('FAILED');

    const [credits] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(5); // fully refunded back to the original balance

    const outputs = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(outputs).toHaveLength(0);
  });
});
