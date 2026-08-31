import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { createVerifiedUserToken } from '../helpers/auth.js';
import { type Containers, startContainers } from '../helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  // The garment key is only Redis-bound in these tests, not actually uploaded
  // to MinIO — stub headObject so assertGarmentObjectValid's existence/size
  // check passes, same as jobs-create-looks.test.ts does.
  app.storage.headObject = (async () => ({
    contentLength: 1024,
  })) as typeof app.storage.headObject;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

afterEach(async () => {
  await app.redis.del('config:system');
});

async function grantCredits(userId: string, amount: number) {
  await app.db
    .insert(schema.userCredits)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
}

async function seedFaceBackgroundPose() {
  const [face] = await app.db
    .insert(schema.modelFaces)
    .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
    .returning();
  const [bg] = await app.db
    .insert(schema.modelBackgrounds)
    .values({ label: 'Bg', r2Key: 'a.jpg', thumbnailKey: 'a.jpg' })
    .returning();
  const [pose] = await app.db
    .insert(schema.modelPoseAssets)
    .values({ label: 'Pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
    .returning();
  return { faceId: face.id, backgroundId: bg.id, poseId: pose.id };
}

describe('queue-depth admission control', () => {
  it('rejects a submission that would push QUEUED count past the admin ceiling with 503, charging nothing', async () => {
    const { token, userId } = await createVerifiedUserToken(app, 'queue-cap-busy@x.com');
    await grantCredits(userId, 100);
    const { faceId, backgroundId, poseId } = await seedFaceBackgroundPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);

    // Admin's PATCH /admin/config route enforces maxQueueDepth >= 1 (see
    // packages/types/src/admin.ts), and getMaxQueueDepth mirrors that floor by
    // falling back to the default on anything <= 0 — so a ceiling of 0 isn't a
    // reachable admin state. Instead: set the ceiling to the minimum legal value
    // (1) and pre-seed one already-QUEUED catalog-source job so `current` is
    // already at the ceiling; the incoming single-look submission (1 more job)
    // then pushes it over.
    await app.db.insert(schema.jobs).values({
      userId,
      status: 'QUEUED',
      source: 'catalog',
    });
    await app.redis.set('config:system', JSON.stringify({ maxQueueDepth: 1 }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [{ poseId, backgroundId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVER_BUSY');

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged for the rejected request

    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(1); // only the pre-seeded row — nothing added for the rejection
  });

  it('allows the submission when under the default ceiling (config:system unset)', async () => {
    const { token, userId } = await createVerifiedUserToken(app, 'queue-cap-ok@x.com');
    await grantCredits(userId, 100);
    const { faceId, backgroundId, poseId } = await seedFaceBackgroundPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          looks: [{ poseId, backgroundId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
  });
});
