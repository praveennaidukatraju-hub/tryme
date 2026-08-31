import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('POST /v1/jobs/catalog-video', () => {
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
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    await app.redis.del('jobs:video');
  });
  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true })
      .returning();
    const token = await signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      user.id,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
    );
    return { token, userId: user.id };
  }
  async function grantCredits(userId: string, balance: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance } });
  }
  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }
  async function sourceJob(userId: string, resultKey?: string) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: job.id });
    await app.db
      .insert(schema.jobOutputs)
      .values({ jobId: job.id, resultKey: resultKey ?? keys.output(job.id) });
    return job.id;
  }
  async function activeSample() {
    const [row] = await app.db
      .insert(schema.sampleVideos)
      .values({
        title: 'Turn',
        videoR2Key: 'sample-videos/x.mp4',
        thumbnailR2Key: 'sample-videos/x.thumb.jpg',
        prompt: 'model turns slowly',
      })
      .returning();
    return row.id;
  }
  it('happy path: deducts default 150 credits, sets params.kind=video, enqueues', async () => {
    const { token, userId } = await registerUser('cv-happy@x.com');
    await grantCredits(userId, 200);
    const sourceJobId = await sourceJob(userId);
    const sampleVideoId = await activeSample();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(150);
    expect(job.source).toBe('catalog_video');
    // Video jobs get their own lane — they need no GPU worker, so they must not be
    // gated by the dispatcher's worker-registry concurrency cap.
    expect(job.queueStream).toBe('video');
    expect(job.priority).toBe(false);
    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(50);
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    const params = inputs.params as Record<string, unknown>;
    expect(params).toMatchObject({
      kind: 'video',
      sourceJobId,
      sampleVideoId,
      sourceImageKey: keys.output(sourceJobId),
      prompt: 'model turns slowly',
    });
    expect(await app.redis.xlen('jobs:video')).toBeGreaterThanOrEqual(1);
    expect(await app.redis.xlen('jobs:normal')).toBe(0);
  });
  // Tryon-direct results (source='tryon'/'api_tryon') are stored WebP-encoded
  // (see apps/dispatcher/src/workflow/finalize.ts) — sourceImageKey must come
  // from the source job's actual job_outputs.resultKey, not a reconstructed
  // keys.output(sourceJobId), or PixVerse would be pointed at a .png key that
  // was never uploaded.
  it('uses the source job stored resultKey as sourceImageKey — not a reconstructed .png key', async () => {
    const { token, userId } = await registerUser('cv-webp-source@x.com');
    await grantCredits(userId, 200);
    const webpResultKey = 'outputs/some-prior-tryon-job/result.webp';
    const sourceJobId = await sourceJob(userId, webpResultKey);
    const sampleVideoId = await activeSample();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    const params = inputs.params as Record<string, unknown>;
    expect(params.sourceImageKey).toBe(webpResultKey);
    expect(params.sourceImageKey).not.toBe(keys.output(sourceJobId));
  });
  it('rejects with FORBIDDEN when sourceJobId belongs to another user', async () => {
    const { userId: owner } = await registerUser('cv-owner@x.com');
    const sourceJobId = await sourceJob(owner);
    const sampleVideoId = await activeSample();
    const { token, userId } = await registerUser('cv-thief@x.com');
    await grantCredits(userId, 100);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId },
    });
    expect(res.statusCode).toBe(403);
  });
  it('rejects with VALIDATION when the source job is not COMPLETED', async () => {
    const { token, userId } = await registerUser('cv-notdone@x.com');
    await grantCredits(userId, 100);
    const sourceJobId = await sourceJob(userId);
    await app.db
      .update(schema.jobs)
      .set({ status: 'QUEUED' })
      .where(eq(schema.jobs.id, sourceJobId));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
  });
  it('rejects with VALIDATION when the sample video is inactive', async () => {
    const { token, userId } = await registerUser('cv-inactive@x.com');
    await grantCredits(userId, 100);
    const [sample] = await app.db
      .insert(schema.sampleVideos)
      .values({
        title: 'Off',
        videoR2Key: 'sample-videos/y.mp4',
        thumbnailR2Key: 'sample-videos/y.thumb.jpg',
        prompt: 'p',
        isActive: false,
      })
      .returning();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId: await sourceJob(userId), sampleVideoId: sample.id },
    });
    expect(res.statusCode).toBe(400);
  });
  it('refunds credits and marks FAILED on enqueue failure', async () => {
    const { token, userId } = await registerUser('cv-enqfail@x.com');
    await grantCredits(userId, 200);
    const sourceJobId = await sourceJob(userId);
    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/catalog-video',
        headers: { authorization: `Bearer ${token}` },
        payload: { sourceJobId, sampleVideoId: await activeSample() },
      });
      expect(res.statusCode).toBe(503);
      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(200);
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.userId, userId), ne(schema.jobs.id, sourceJobId)));
      expect(job.status).toBe('FAILED');
      expect(job.errorCode).toBe('ENQUEUE_FAIL');
    } finally {
      app.redis.xadd = realXadd;
    }
  });
  it('creates a job from an uploaded sourceImageKey, with no sourceJobId', async () => {
    const { token, userId } = await registerUser('cv-upload-happy@x.com');
    await grantCredits(userId, 200);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    await app.storage.putObject(sourceImageKey, Buffer.from('uploaded-bytes'), 'image/jpeg');
    const sampleVideoId = await activeSample();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    const params = inputs.params as Record<string, unknown>;
    expect(params.sourceImageKey).toBe(sourceImageKey);
    expect(params).not.toHaveProperty('sourceJobId');
    expect(params.kind).toBe('video');
  });
  it('rejects with FORBIDDEN when sourceImageKey was never issued to this user', async () => {
    const { token, userId } = await registerUser('cv-upload-notowned@x.com');
    await grantCredits(userId, 100);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    // deliberately not bound via bindUploadKey
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(403);
  });
  it('rejects with BAD_UPLOAD when the sourceImageKey object does not exist in R2', async () => {
    const { token, userId } = await registerUser('cv-upload-missing@x.com');
    await grantCredits(userId, 100);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    // deliberately not put to R2
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
    // Asserting the error code (not just the status) matters here: before the
    // schema change, this same payload also 400s — but for a different reason
    // (sourceJobId missing → zod VALIDATION), not the object-missing check
    // this test is actually targeting. BAD_UPLOAD only appears once the schema
    // accepts sourceImageKey and assertGarmentObjectValid's headObject fails.
    expect(res.json().error.code).toBe('BAD_UPLOAD');
  });
  it('rejects with 400 when both sourceJobId and sourceImageKey are provided', async () => {
    const { token, userId } = await registerUser('cv-both@x.com');
    await grantCredits(userId, 100);
    const sourceJobId = await sourceJob(userId);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    await app.storage.putObject(sourceImageKey, Buffer.from('x'), 'image/jpeg');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
  });
  it('rejects with 400 when neither sourceJobId nor sourceImageKey are provided', async () => {
    const { token, userId } = await registerUser('cv-neither@x.com');
    await grantCredits(userId, 100);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
  });
});
