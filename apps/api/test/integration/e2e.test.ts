import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('e2e', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('full flow: register → grant via admin → presign upload → create job', async () => {
    // 1. register normal user
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'E2E User', email: 'e2e@x.com', password: 'password123' },
    });
    const [userRow] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'e2e@x.com'));
    if (!userRow) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userRow.id));
    const userLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'e2e@x.com', password: 'password123' },
    });
    expect(userLogin.statusCode).toBe(200);
    const { accessToken: userToken } = userLogin.json();
    const userId = JSON.parse(atob(userToken.split('.')[1])).sub;

    // 2. create admin and grant credits
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'E2E Admin', email: 'e2e-admin@x.com', password: 'password123' },
    });
    const [adminRow] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'e2e-admin@x.com'));
    if (!adminRow) throw new Error('admin user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, adminRow.id));
    await app.db.insert(schema.adminUsers).values({ userId: adminRow.id, role: 'SUPER_ADMIN' });
    const adminToken = await signAccess(secret, adminRow.id, { kind: 'access' }, '15m', 'admin');

    // 3. admin grants credits
    const grantRes = await app.inject({
      method: 'POST',
      url: '/admin/credits/grant',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId, amount: 100, reason: 'E2E test' },
    });
    expect(grantRes.statusCode).toBe(200);

    // 4. verify balance
    const balRes = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(balRes.json().balance).toBe(100);

    // 5. presign upload
    const presignRes = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(presignRes.statusCode).toBe(200);
    const { r2Key: garmentKey } = presignRes.json();
    // No real file was PUT to storage via the presigned URL — stub headObject like
    // jobs-create.test.ts does, since assertOwnsUploadKey checks both Redis
    // ownership (set for real by /v1/uploads/presign above) and object existence.
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;

    // 6. seed admin-curated face/pose/background assets — the current input model
    // for createJob (see jobs-create.test.ts / jobs-create-looks.test.ts). catalog_items
    // is for user-selectable lower garments/shoes only and requires a non-null `type`.
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'Face A', r2Key: 'f1.jpg', thumbnailKey: 'f1.jpg' })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg A', r2Key: 'b1.jpg', thumbnailKey: 'b1.jpg' })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose A', r2Key: 'p1.jpg', thumbnailKey: 'p1.jpg' })
      .returning();

    // 7. create job
    const jobRes = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId: face.id,
          looks: [{ poseId: pose.id, backgroundId: background.id }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        userHint: 'soft light',
      },
    });
    expect(jobRes.statusCode).toBe(201);
    const {
      jobIds: [jobId],
    } = jobRes.json();

    // 8. assert balance deducted
    const bal2 = await app.inject({
      method: 'GET',
      url: '/v1/credits',
      headers: { authorization: `Bearer ${userToken}` },
    });
    // Actual cost is admin-configurable per resolution (getResolutionCreditCost) — assert
    // a deduction happened, not an exact value (see jobs-create.test.ts for the same pattern).
    expect(bal2.json().balance).toBeLessThan(100);

    // 9. assert job queued
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');

    // 10. assert redis stream
    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);
  }, 30000);
});
