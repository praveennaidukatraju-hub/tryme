import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('createJob — mannequinJobId branch', () => {
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

  async function seedCreditPlan(slug: string) {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, watermark: false })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark: false } });
  }

  async function seedFlatSareeGarmentType() {
    const [step2] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step2-${Date.now()}`,
        label: 'Step2',
        jsonContent: {},
        workflowType: 'regular',
        faceNodeId: 'f',
        poseNodeId: 'p',
        bgNodeId: 'b',
        upperNodeIds: ['g'],
        facePhasePromptNode: 'np',
        garmentPhasePromptNode: 'pp',
      })
      .returning();
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `flat-saree-${Date.now()}`,
        label: 'Flat Saree',
        requiresMannequinStep: true,
        sareeStep2WorkflowTemplateId: step2.id,
      })
      .returning();
    return gt.id;
  }

  async function seedFaceAndBgAndPose() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    return { faceId: face.id, bgId: bg.id, poseId: pose.id };
  }

  async function seedCompletedMannequinJob(userId: string) {
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

  it('uses the mannequin output as upperGarmentKey for every look', async () => {
    await seedCreditPlan('free');
    const { token, userId } = await registerUser('mannequin-branch@x.com');
    await grantCredits(userId, 100);
    const garmentTypeId = await seedFlatSareeGarmentType();
    const { faceId, bgId, poseId } = await seedFaceAndBgAndPose();
    const mannequinJobId = await seedCompletedMannequinJob(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          mannequinJobId,
          faceId,
          garmentTypeId,
          looks: [{ poseId, backgroundId: bgId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [inputsRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(inputsRow?.upperGarmentKey).toBe(`outputs/${mannequinJobId}/result.png`);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100 - 35); // standard 2K cost, charged normally
  });

  it('rejects mannequinJobId for a garment type that does not require it', async () => {
    await seedCreditPlan('free');
    const { token, userId } = await registerUser('mannequin-not-required@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgId, poseId } = await seedFaceAndBgAndPose();
    const mannequinJobId = await seedCompletedMannequinJob(userId);
    const [plainGt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `plain-${Date.now()}`, label: 'Plain' })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          mannequinJobId,
          faceId,
          garmentTypeId: plainGt.id,
          looks: [{ poseId, backgroundId: bgId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects upperGarmentKey when the garment type requires a mannequin step', async () => {
    await seedCreditPlan('free');
    const { token, userId } = await registerUser('mannequin-missing@x.com');
    await grantCredits(userId, 100);
    const garmentTypeId = await seedFlatSareeGarmentType();
    const { faceId, bgId, poseId } = await seedFaceAndBgAndPose();
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
          garmentTypeId,
          looks: [{ poseId, backgroundId: bgId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
