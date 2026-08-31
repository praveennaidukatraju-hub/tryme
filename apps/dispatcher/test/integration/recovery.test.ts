import { PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoverPendingJobs } from '../../src/stream/recovery.js';
import { deregisterWorker, registerWorkers } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-recovery';
// Use a unique stream per test file to avoid cross-test interference
const STREAM = `jobs:recovery-test-${Date.now()}`;
const GROUP = 'dispatcher-cg';

describe('dispatcher crash recovery', () => {
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

    // Create consumer group on our isolated test stream
    try {
      await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    } catch (err: unknown) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await redis.del(STREAM);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  it('claims stale XPENDING entry and processes job to COMPLETED', async () => {
    // Seed a job in DB
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `rec-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user?.id, balance: 5 });

    const [ct] = await env.db
      .insert(schema.catalogTypes)
      .values({ slug: `rec-${Date.now()}`, label: 'T' })
      .returning();
    const [cc] = await env.db
      .insert(schema.catalogCategories)
      .values({ typeId: ct?.id, slug: 'c', label: 'C' })
      .returning();
    const [workflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `rec-wf-${Date.now()}`,
        label: 'Recovery test workflow',
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
      })
      .returning();

    const [[face], [background], [pose], [l]] = await Promise.all([
      env.db
        .insert(schema.modelFaces)
        .values({
          gender: 'women',
          label: 'Model',
          r2Key: 'r/m.jpg',
          thumbnailKey: 'r/m.jpg',
          faceSideR2Key: 'r/m.jpg',
        })
        .returning(),
      env.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'Bg', r2Key: 'r/b.jpg', thumbnailKey: 'r/b.jpg' })
        .returning(),
      env.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Pose',
          r2Key: 'r/p.jpg',
          thumbnailKey: 'r/p.jpg',
          workflowTemplateId: workflow?.id,
        })
        .returning(),
      env.db
        .insert(schema.catalogItems)
        .values({
          categoryId: cc?.id,
          type: 'lower',
          label: 'I',
          r2Key: 'r/l.jpg',
          thumbnailKey: 'r/l.jpg',
        })
        .returning(),
    ]);

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user?.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job?.id,
      upperGarmentKey: `inputs/${job?.id}/garment.jpg`,
      faceId: face?.id,
      poseId: pose?.id,
      backgroundId: background?.id,
      lowerCatalogId: l?.id,
    });
    for (const key of [
      `inputs/${job?.id}/garment.jpg`,
      'r/m.jpg',
      'r/p.jpg',
      'r/b.jpg',
      'r/l.jpg',
    ]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('s'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    // Simulate a "ghost" consumer reading the message without ACKing it
    await redis.xadd(STREAM, '*', 'jobId', job?.id, 'userId', user?.id);
    await redis.xreadgroup(
      'GROUP',
      GROUP,
      'ghost-consumer',
      'COUNT',
      '1',
      'BLOCK',
      '0',
      'STREAMS',
      STREAM,
      '>',
    );

    // Verify message is pending
    const pending = await redis.xpending(STREAM, GROUP, '-', '+', 10);
    expect((pending as unknown[]).length).toBeGreaterThan(0);

    // Run recovery with threshold=0 (claim everything regardless of idle time)
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

    await recoverPendingJobs(redis, cfg, 0, log, [STREAM]);

    const [completed] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, job?.id));
    expect(completed?.status).toBe('COMPLETED');
  });
});
