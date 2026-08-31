import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('catalog video — CATALOG_VIDEO_ALLOWED_EMAILS gate', () => {
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
  afterEach(() => {
    delete app.env.CATALOG_VIDEO_ALLOWED_EMAILS;
  });

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const token = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token, userId: user.id };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function seedCompletedJob(userId: string) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: job.id });
    await app.db
      .insert(schema.jobOutputs)
      .values({ jobId: job.id, resultKey: keys.output(job.id) });
    return job.id;
  }

  async function seedActiveSampleVideo() {
    const [row] = await app.db
      .insert(schema.sampleVideos)
      .values({
        title: 'Gate test',
        videoR2Key: 'sample-videos/gate.mp4',
        thumbnailR2Key: 'sample-videos/gate.thumb.jpg',
        prompt: 'p',
      })
      .returning();
    return row.id;
  }

  it('blocks POST /v1/jobs/catalog-video, GET /v1/catalog-videos, and GET /v1/models/sample-videos for a non-allowlisted user', async () => {
    const { token, userId } = await registerUser('gate-blocked@x.com');
    await grantCredits(userId, 100);
    const sourceJobId = await seedCompletedJob(userId);
    const sampleVideoId = await seedActiveSampleVideo();
    app.env.CATALOG_VIDEO_ALLOWED_EMAILS = 'someone-else@x.com';

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId },
    });
    expect(createRes.statusCode).toBe(403);

    const historyRes = await app.inject({
      method: 'GET',
      url: '/v1/catalog-videos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(403);

    const sampleRes = await app.inject({
      method: 'GET',
      url: '/v1/models/sample-videos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sampleRes.statusCode).toBe(403);

    // No credits deducted, no job row created for the blocked attempt.
    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100);
  });

  it('allows access (case-insensitively) for an allowlisted user, and GET /v1/me reports catalogVideoEnabled accordingly', async () => {
    const { token, userId } = await registerUser('Gate-Allowed@X.com');
    await grantCredits(userId, 200);
    const sourceJobId = await seedCompletedJob(userId);
    const sampleVideoId = await seedActiveSampleVideo();
    app.env.CATALOG_VIDEO_ALLOWED_EMAILS = 'gate-allowed@x.com, other@x.com';

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().catalogVideoEnabled).toBe(true);

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId },
    });
    expect(createRes.statusCode).toBe(201);

    const historyRes = await app.inject({
      method: 'GET',
      url: '/v1/catalog-videos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
  });

  it('defaults to open access when CATALOG_VIDEO_ALLOWED_EMAILS is unset', async () => {
    const { token, userId } = await registerUser('gate-default-open@x.com');
    await grantCredits(userId, 100);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().catalogVideoEnabled).toBe(true);

    const historyRes = await app.inject({
      method: 'GET',
      url: '/v1/catalog-videos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
  });
});
