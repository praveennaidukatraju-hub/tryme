import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('createJob — user-scoped background ownership', () => {
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
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
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

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function seedCreditPlan() {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug: 'free', name: 'free', credits: 1000, basePaise: 0, watermark: false })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark: false } });
  }

  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  async function seedFaceAndPose() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    return { faceId: face.id, poseId: pose.id };
  }

  it("accepts a job that references the caller's own scope=user background", async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('bgown-self@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const [myBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Mine', r2Key: 'mine.jpg', thumbnailKey: 'mine.jpg', scope: 'user', userId })
      .returning();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: { upperGarmentKey: garmentKey, faceId, backgroundId: myBg.id, poseIds: [poseId] },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a job that references another user's scope=user background", async () => {
    await seedCreditPlan();
    const { userId: ownerId } = await registerUser('bgown-owner@x.com');
    const [otherBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Not yours',
        r2Key: 'notyours.jpg',
        thumbnailKey: 'notyours.jpg',
        scope: 'user',
        userId: ownerId,
      })
      .returning();

    const { token, userId } = await registerUser('bgown-attacker@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId: otherBg.id,
          poseIds: [poseId],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged
  });

  it('accepts a job that references a scope=template background from any user', async () => {
    await seedCreditPlan();
    const [templateBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Template',
        r2Key: 'template.jpg',
        thumbnailKey: 'template.jpg',
        scope: 'template',
      })
      .returning();

    const { token, userId } = await registerUser('bgown-template@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId: templateBg.id,
          poseIds: [poseId],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects a job that references the caller's own soft-deleted scope=user background", async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('bgown-softdeleted@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const [myBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Deleted mine',
        r2Key: 'deletedmine.jpg',
        thumbnailKey: 'deletedmine.jpg',
        scope: 'user',
        userId,
      })
      .returning();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    // Simulate what DELETE /v1/backgrounds/mine/:id does — soft-delete via
    // deletedAt, not a hard delete. The row still exists and is still isActive.
    await app.db
      .update(schema.modelBackgrounds)
      .set({ deletedAt: new Date() })
      .where(eq(schema.modelBackgrounds.id, myBg.id));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: { upperGarmentKey: garmentKey, faceId, backgroundId: myBg.id, poseIds: [poseId] },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged
  });
});
