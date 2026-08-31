import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin held jobs', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  beforeEach(async () => {
    await app.redis.del('jobs:low');
    await app.db.delete(schema.jobs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedHeldJob(email: string): Promise<{ jobId: string; userId: string }> {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, passwordHash: 'x' })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId: user.id,
        status: 'HELD',
        queueStream: 'low',
        creditsCharged: 20,
        source: 'merchant_catalog',
      })
      .returning();
    return { jobId: job.id, userId: user.id };
  }

  it('reports the global held queue grouped by owning user', async () => {
    const a = await seedHeldJob(`held-a-${randomUUID()}@test.com`);
    await seedHeldJob(`held-b-${randomUUID()}@test.com`);
    // A non-held job must not be counted.
    await app.db.insert(schema.jobs).values({ userId: a.userId, status: 'QUEUED' });

    const res = await app.inject({ method: 'GET', url: '/admin/held-jobs', headers });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      byUser: Array<{ userId: string; count: number }>;
    };
    expect(body.total).toBe(2);
    expect(body.byUser).toHaveLength(2);
  });

  it('releases every held job across all merchants into jobs:low', async () => {
    const a = await seedHeldJob(`rel-a-${randomUUID()}@test.com`);
    const b = await seedHeldJob(`rel-b-${randomUUID()}@test.com`);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { released: number; remaining: number };
    expect(body.released).toBe(2);
    // The whole backlog fit in one call, so nothing is left held.
    expect(body.remaining).toBe(0);

    for (const { jobId } of [a, b]) {
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job.status).toBe('QUEUED');
      // Stamped so the dispatcher's sweeper dates staleness from release, not creation.
      expect(job.queuedAt).toBeInstanceOf(Date);
    }

    expect(await app.redis.xlen('jobs:low')).toBe(2);
  });

  it('is idempotent — a second release enqueues nothing', async () => {
    await seedHeldJob(`idem-${randomUUID()}@test.com`);

    await app.inject({ method: 'POST', url: '/admin/held-jobs/release', headers });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers,
    });

    expect((second.json() as { released: number }).released).toBe(0);
    expect(await app.redis.xlen('jobs:low')).toBe(1);
  });

  it('reverts a job to HELD if its XADD fails, without aborting the rest of the release', async () => {
    const a = await seedHeldJob(`xadd-fail-a-${randomUUID()}@test.com`);
    const b = await seedHeldJob(`xadd-fail-b-${randomUUID()}@test.com`);

    const xaddSpy = vi
      .spyOn(app.redis, 'xadd')
      .mockRejectedValueOnce(new Error('simulated redis failure'));

    const res = await app.inject({
      method: 'POST',
      url: '/admin/held-jobs/release',
      headers,
    });

    expect(res.statusCode).toBe(200);
    // Only one of the two jobs actually made it onto the stream; the other's
    // XADD was the mocked rejection and must have been reverted to HELD.
    expect((res.json() as { released: number }).released).toBe(1);

    const [jobA] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, a.jobId));
    const [jobB] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, b.jobId));
    const held = [jobA, jobB].filter((j) => j.status === 'HELD');
    const queued = [jobA, jobB].filter((j) => j.status === 'QUEUED');

    expect(held).toHaveLength(1);
    expect(held[0].queuedAt).toBeNull();
    expect(queued).toHaveLength(1);
    expect(queued[0].queuedAt).toBeInstanceOf(Date);

    // Exactly the succeeding job's entry made it onto the stream.
    expect(await app.redis.xlen('jobs:low')).toBe(1);

    xaddSpy.mockRestore();
  });

  it('rejects unauthenticated callers', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/held-jobs/release' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated callers on the GET summary too', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/held-jobs' });
    expect(res.statusCode).toBe(401);
  });
});
