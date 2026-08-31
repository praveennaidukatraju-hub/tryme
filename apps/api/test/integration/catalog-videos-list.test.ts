import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('GET /v1/catalog-videos', () => {
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
  async function user(email: string) {
    const [u] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true })
      .returning();
    return {
      userId: u.id,
      token: await signAccess(
        new TextEncoder().encode(app.env.JWT_SECRET),
        u.id,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
      ),
    };
  }
  it("lists only the caller's own video jobs, newest first, with presigned result URLs", async () => {
    const mine = await user('cvlist@x.com');
    const other = await user('cvlist-other@x.com');
    const [completed] = await app.db
      .insert(schema.jobs)
      .values({ userId: mine.userId, status: 'COMPLETED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: completed.id,
      params: { kind: 'video', sourceJobId: 'x', sampleVideoId: 'y', prompt: 'p' },
    });
    await app.db
      .insert(schema.jobOutputs)
      .values({ jobId: completed.id, resultKey: `outputs/${completed.id}/result.mp4` });
    const [queued] = await app.db
      .insert(schema.jobs)
      .values({ userId: mine.userId, status: 'QUEUED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: queued.id,
      params: { kind: 'video', sourceJobId: 'x', sampleVideoId: 'y', prompt: 'p' },
    });
    const [foreign] = await app.db
      .insert(schema.jobs)
      .values({ userId: other.userId, status: 'COMPLETED', creditsCharged: 20 })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: foreign.id, params: { kind: 'video' } });
    const [regular] = await app.db
      .insert(schema.jobs)
      .values({ userId: mine.userId, status: 'COMPLETED', creditsCharged: 5 })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: regular.id });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalog-videos',
      headers: { authorization: `Bearer ${mine.token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; videoUrl: string | null }>;
    expect(items.map((i) => i.id)).toEqual([queued.id, completed.id]);
    expect(items.find((i) => i.id === completed.id)?.videoUrl).toContain(
      `outputs/${completed.id}/result.mp4`,
    );
    expect(items.find((i) => i.id === queued.id)?.videoUrl).toBeNull();
  });
});
