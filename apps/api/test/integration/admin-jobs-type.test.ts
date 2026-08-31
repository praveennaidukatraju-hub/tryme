import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('admin job type classification', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  async function seedUser() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `job-type-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Job Type Test User',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    return user;
  }

  async function seedFace() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    return face.id;
  }

  async function seedJob(userId: string, opts: { source: string | null; faceId?: string | null }) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 1, source: opts.source })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: job.id, faceId: opts.faceId ?? null });
    return job;
  }

  it('surfaces every distinct jobs.source value verbatim, not a generic bucket', async () => {
    const user = await seedUser();
    const sources = [
      'catalog',
      'tryon',
      'saree',
      'saree_mannequin',
      'shopify',
      'merchant_tryon',
      'merchant_catalog',
      'merchant_catalog_saree_mannequin',
      'api',
    ];
    const jobs = await Promise.all(sources.map((source) => seedJob(user.id, { source })));

    const res = await app.inject({
      method: 'GET',
      url: '/admin/jobs?pageSize=100',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; jobType: string }[] };

    for (const [i, source] of sources.entries()) {
      const item = body.items.find((it) => it.id === jobs[i]?.id);
      expect(item?.jobType).toBe(source);
    }
  });

  it('falls back to the legacy faceId heuristic only for pre-existing null-source rows', async () => {
    const user = await seedUser();
    const faceId = await seedFace();
    const withFace = await seedJob(user.id, { source: null, faceId });
    const withoutFace = await seedJob(user.id, { source: null, faceId: null });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/jobs?pageSize=100',
      headers: authHeader,
    });
    const body = res.json() as { items: { id: string; jobType: string }[] };
    expect(body.items.find((it) => it.id === withFace.id)?.jobType).toBe('catalog');
    expect(body.items.find((it) => it.id === withoutFace.id)?.jobType).toBe('tryon');
  });

  it('returns the same specific jobType on the job detail route', async () => {
    const user = await seedUser();
    const job = await seedJob(user.id, { source: 'merchant_catalog' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/jobs/${job.id}`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobType).toBe('merchant_catalog');
  });
});
