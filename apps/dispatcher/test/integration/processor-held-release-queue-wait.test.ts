import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/**
 * processJob's own MAX_QUEUE_WAIT_MS (3h) "give up on this job" budget must be
 * measured from queuedAt (when a HELD job was released) when present, falling
 * back to createdAt otherwise — mirroring the sweeper's fix in sweeper.ts. A
 * released held job's createdAt can be days old, so measuring from createdAt
 * would terminate it with NO_WORKER within seconds of release, the very first
 * time selectWorker finds no free worker — defeating the point of holding a
 * batch at all. Deliberately registers NO worker at all so selectWorker always
 * returns null and every job here is forced down the "no worker" branch.
 */
describe('processor — MAX_QUEUE_WAIT_MS baseline for released held jobs', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
  }, 60_000);

  afterAll(async () => {
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  /** Seeds a fully-valid "regular" job (face + background + pose all resolve, workflow
   *  template resolves) so processJob reaches the worker-selection step rather than
   *  bailing out earlier on MISSING_MODEL_INPUTS / NO_WORKFLOW. No worker is ever
   *  registered, so selectWorker always returns null once we get there. */
  async function seedJob(overrides: {
    createdAt: Date;
    queuedAt: Date | null;
  }): Promise<{ jobId: string; userId: string }> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `qwait-${suffix}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: insert always returns the row
    const userId = user!.id;
    await env.db.insert(schema.userCredits).values({ userId, balance: 5 });

    const [workflow] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `qwait-wf-${suffix}`,
        label: 'Queue-wait test workflow',
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
    // biome-ignore lint/style/noNonNullAssertion: insert always returns the row
    const workflowId = workflow!.id;

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
      .values({
        label: 'Pose',
        r2Key: 'p.jpg',
        thumbnailKey: 'p.jpg',
        workflowTemplateId: workflowId,
      })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({
        userId,
        status: 'QUEUED',
        priority: false,
        creditsCharged: 1,
        createdAt: overrides.createdAt,
        queuedAt: overrides.queuedAt ?? undefined,
      })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: insert always returns the row
    const jobId = job!.id;

    await env.db.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: `inputs/${jobId}/garment.jpg`,
      // biome-ignore lint/style/noNonNullAssertion: inserted above
      faceId: face!.id,
      // biome-ignore lint/style/noNonNullAssertion: inserted above
      backgroundId: bg!.id,
      // biome-ignore lint/style/noNonNullAssertion: inserted above
      poseId: pose!.id,
    });

    return { jobId, userId };
  }

  it('requeues (does not terminate) a job released recently despite a 4h-old createdAt', async () => {
    const { jobId, userId } = await seedJob({
      createdAt: new Date(Date.now() - 4 * HOUR),
      queuedAt: new Date(Date.now() - 5 * MIN),
    });
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-1',
    );

    const [after] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    // requeueForNoWorker sets status back to QUEUED (and does not touch errorCode/credits).
    expect(after?.status).toBe('QUEUED');
    expect(after?.errorCode).toBeNull();

    const [balance] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    // No refund should have happened — the job was requeued, not terminated.
    expect(balance?.balance).toBe(5);
  }, 30_000);

  it('control: terminates with NO_WORKER a genuinely 4h-old job that was never released', async () => {
    const { jobId, userId } = await seedJob({
      createdAt: new Date(Date.now() - 4 * HOUR),
      queuedAt: null,
    });
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-2',
    );

    const [after] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(after?.status).toBe('FAILED');
    expect(after?.errorCode).toBe('NO_WORKER');

    const [balance] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    // Refunded the 1 charged credit on terminal failure.
    expect(balance?.balance).toBe(6);
  }, 30_000);
});
