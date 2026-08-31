import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const CONFIG_KEY = 'config:system';

describe('GET /v1/catalogues?batchId', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  async function insertJob(userId: string, batchId: string | null, createdAt: Date) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        status: 'COMPLETED',
        priority: false,
        creditsCharged: 0,
        batchId,
        createdAt,
      })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/x/garment.jpg',
    });
    return job;
  }

  it('scopes results to the given batchId and ignores other jobs', async () => {
    const { token, userId } = await registerUser('batch-filter-scope@x.com');
    const batchId = randomUUID();

    const inBatch = await insertJob(userId, batchId, new Date());
    await insertJob(userId, null, new Date());

    const res = await app.inject({
      method: 'GET',
      url: `/v1/catalogues?batchId=${batchId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ catalogueId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.catalogueId).toBe(inBatch.catalogueId ?? inBatch.id);
  });

  it('is not truncated by the unfiltered 200-row cap', async () => {
    const { token, userId } = await registerUser('batch-filter-no-truncate@x.com');
    const batchId = randomUUID();
    const now = Date.now();

    // 205 unrelated jobs, all newer than the batch's jobs, so an unfiltered
    // query ordered by createdAt DESC with .limit(200) would push every
    // batch job out of the window.
    for (let i = 0; i < 205; i++) {
      await insertJob(userId, null, new Date(now + (205 - i) * 1000));
    }
    const batchJobIds = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const job = await insertJob(userId, batchId, new Date(now - (i + 1) * 1000));
      batchJobIds.add(job.catalogueId ?? job.id);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/catalogues?batchId=${batchId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ catalogueId: string }>;
    expect(body).toHaveLength(3);
    expect(new Set(body.map((c) => c.catalogueId))).toEqual(batchJobIds);
  });

  it('respects the admin-configured maxBatchJobs as its row cap', async () => {
    const { token, userId } = await registerUser('batch-filter-admin-cap@x.com');
    const batchId = randomUUID();
    const now = Date.now();

    await app.redis.set(CONFIG_KEY, JSON.stringify({ maxBatchJobs: 2 }));

    // 3 jobs in the batch, but the admin cap is 2 — only the 2 newest should return.
    const jobs = [];
    for (let i = 0; i < 3; i++) {
      jobs.push(await insertJob(userId, batchId, new Date(now - i * 1000)));
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/catalogues?batchId=${batchId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ catalogueId: string }>;
    expect(body).toHaveLength(2);
    const returnedIds = new Set(body.map((c) => c.catalogueId));
    expect(returnedIds.has(jobs[0].catalogueId ?? jobs[0].id)).toBe(true);
    expect(returnedIds.has(jobs[1].catalogueId ?? jobs[1].id)).toBe(true);
  });
});
