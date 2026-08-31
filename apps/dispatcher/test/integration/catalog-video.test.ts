import { randomUUID } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { processJob } from '../../src/job/processor.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

describe('catalog video job (PixVerse)', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedVideoJob() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `video-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    // The API has already deducted the 20 credits recorded on the queued video job.
    await env.db.insert(schema.userCredits).values({ userId: user?.id, balance: 0 });

    const [sourceJob] = await env.db
      .insert(schema.jobs)
      .values({ userId: user?.id, status: 'COMPLETED', creditsCharged: 5 })
      .returning();
    await env.db.insert(schema.jobInputs).values({ jobId: sourceJob?.id });
    await env.db.insert(schema.jobOutputs).values({
      jobId: sourceJob?.id,
      resultKey: `outputs/${sourceJob?.id}/result.png`,
    });

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user?.id, status: 'QUEUED', creditsCharged: 20 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job?.id,
      params: {
        kind: 'video',
        sourceJobId: sourceJob?.id,
        sourceImageKey: `outputs/${sourceJob?.id}/result.png`,
        sampleVideoId: randomUUID(),
        prompt: 'model turning slowly',
      },
    });

    return { jobId: job?.id as string, userId: user?.id as string };
  }

  it('processes a video job to COMPLETED - downloads PixVerse result and uploads to R2', async () => {
    const { jobId, userId } = await seedVideoJob();
    const log = createLogger('test');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/image/upload')) {
        return new Response(JSON.stringify({ ErrCode: 0, Resp: { img_id: 123 } }), { status: 200 });
      }
      if (url.includes('/video/img/generate')) {
        return new Response(JSON.stringify({ ErrCode: 0, Resp: { video_id: 456 } }), {
          status: 200,
        });
      }
      if (url.includes('/video/result/')) {
        return new Response(
          JSON.stringify({
            ErrCode: 0,
            Resp: { status: 1, url: 'https://pixverse.example/video.mp4' },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://pixverse.example/video.mp4') {
        return new Response(Buffer.from('fake-mp4-bytes'), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-0',
    );

    const [updated] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(updated.status).toBe('COMPLETED');

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output.resultKey).toBe(`outputs/${jobId}/result.mp4`);

    const stored = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: output.resultKey! }),
    );
    const bodyText = await stored.Body?.transformToString();
    expect(bodyText).toBe('fake-mp4-bytes');
  });

  it('marks FAILED and refunds credits when PixVerse returns a failure status', async () => {
    const { jobId, userId } = await seedVideoJob();
    const log = createLogger('test');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/image/upload')) {
        return new Response(JSON.stringify({ ErrCode: 0, Resp: { img_id: 123 } }), { status: 200 });
      }
      if (url.includes('/video/img/generate')) {
        return new Response(JSON.stringify({ ErrCode: 0, Resp: { video_id: 456 } }), {
          status: 200,
        });
      }
      if (url.includes('/video/result/')) {
        return new Response(
          JSON.stringify({ ErrCode: 0, ErrMsg: 'content policy violation', Resp: { status: 7 } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // MAX_ATTEMPTS is 2 - run twice so the second attempt terminates instead of retrying.
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-0',
    );
    await env.db.update(schema.jobs).set({ status: 'QUEUED' }).where(eq(schema.jobs.id, jobId));
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      userId,
      'jobs:normal',
      '1-1',
    );

    const [updated] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(updated.status).toBe('FAILED');

    const [bal] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(20);
  });

  it('fails fast with PIXVERSE_NOT_CONFIGURED when the API key is missing', async () => {
    const { jobId, userId } = await seedVideoJob();
    const log = createLogger('test');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const prevKey = process.env.PIXVERSE_API_KEY;
    process.env.PIXVERSE_API_KEY = '';
    try {
      await processJob(
        { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
        jobId,
        userId,
        'jobs:video',
        '1-0',
      );
    } finally {
      process.env.PIXVERSE_API_KEY = prevKey;
    }

    const [updated] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(updated.status).toBe('FAILED');
    expect(updated.errorCode).toBe('PIXVERSE_NOT_CONFIGURED');
    // Terminal on the first pass — no retry attempt is burned against PixVerse.
    expect(fetchSpy).not.toHaveBeenCalled();

    const [bal] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(20);
  });
});
