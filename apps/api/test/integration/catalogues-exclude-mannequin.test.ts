import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('catalogue listings exclude saree_mannequin jobs', () => {
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

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  async function seedMannequinJob(userId: string) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', priority: false, creditsCharged: 0 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/x/garment.jpg',
      params: { kind: 'saree_mannequin' },
    });
    return job.id;
  }

  it('GET /v1/catalogues does not include the mannequin job', async () => {
    const { token, userId } = await registerUser('excl-catalogues@x.com');
    await seedMannequinJob(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  it('GET /v1/assets does not include the mannequin garment key', async () => {
    const { token, userId } = await registerUser('excl-assets@x.com');
    await seedMannequinJob(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });

  async function seedUploadSourcedVideoJob(userId: string) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'QUEUED', priority: false, creditsCharged: 150 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      params: { kind: 'video', sourceImageKey: 'inputs/x/garment.jpg', sampleVideoId: 'y' },
    });
    return job.id;
  }

  it('GET /v1/catalogues does not include an upload-sourced catalog-video job', async () => {
    const { token, userId } = await registerUser('excl-video-catalogues@x.com');
    await seedUploadSourcedVideoJob(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });
});
