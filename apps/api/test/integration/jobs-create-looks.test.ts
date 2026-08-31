import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('createJob — atomic multi-background looks[] form', () => {
  let c: Containers;
  let app: TestApp;
  let realHeadObject: typeof app.storage.headObject | undefined;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    realHeadObject = app.storage.headObject?.bind(app.storage);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
    // ponytail: raw-insert tests below each seed their own isWhiteBg:true row; the
    // app enforces "only one isWhiteBg row at a time" via the admin route (see
    // admin/models.routes.ts) but a direct schema insert bypasses that. Clear
    // stragglers between tests so createJob's un-ordered `LIMIT 1` lookup can't
    // pick up a previous test's row instead of the current test's.
    await app.db
      .update(schema.modelBackgrounds)
      .set({ isWhiteBg: false })
      .where(eq(schema.modelBackgrounds.isWhiteBg, true));
  });
  afterEach(() => {
    if (realHeadObject) app.storage.headObject = realHeadObject;
  });

  async function registerUser(email: string, tier = 'free') {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier })
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

  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  async function seedCreditPlan(slug: string, watermark: boolean) {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, watermark })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark } });
  }

  async function seedFaceAndTwoBackgrounds() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [bgA] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'BgA', r2Key: 'a.jpg', thumbnailKey: 'a.jpg' })
      .returning();
    const [bgB] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'BgB', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    return { faceId: face.id, bgAId: bgA.id, bgBId: bgB.id };
  }

  async function seedTwoPoses() {
    const [poseA] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PoseA', r2Key: 'pa.jpg', thumbnailKey: 'pa.jpg' })
      .returning();
    const [poseB] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'PoseB', r2Key: 'pb.jpg', thumbnailKey: 'pb.jpg' })
      .returning();
    return { poseAId: poseA.id, poseBId: poseB.id };
  }

  it('creates one job per look, each with its OWN background, in a single credit-charged batch', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-basic@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId, bgBId } = await seedFaceAndTwoBackgrounds();
    const { poseAId, poseBId } = await seedTwoPoses();
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
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseBId, backgroundId: bgBId },
          ],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        params: {
          catalogueTemplateMappingId: '00000000-0000-4000-8000-000000000001',
          workflowTemplateId: '00000000-0000-4000-8000-000000000002',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { catalogueId, jobIds } = res.json();
    expect(jobIds).toHaveLength(2);

    const inputsRows = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(inputsRows[0]?.backgroundId).toBe(bgAId);
    expect(inputsRows[0]?.poseId).toBe(poseAId);
    expect(inputsRows[0]?.params).not.toHaveProperty('catalogueTemplateMappingId');
    expect(inputsRows[0]?.params).not.toHaveProperty('workflowTemplateId');

    const inputsRows2 = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[1]));
    expect(inputsRows2[0]?.backgroundId).toBe(bgBId);
    expect(inputsRows2[0]?.poseId).toBe(poseBId);

    const jobRows = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.catalogueId, catalogueId));
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.source === 'catalog')).toBe(true);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100 - 35 * 2); // 2K = 35 credits each
  });

  it('validates a mapped template and snapshots its per-pose workflow into the job', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-mapped-workflow@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `mapped-shirt-${poseAId}`, label: 'Mapped shirt' })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Mapped template' })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: poseAId,
      backgroundId: bgAId,
    });
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `mapped-job-workflow-${poseAId}`,
        label: 'Mapped job workflow',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: poseAId,
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a mapped-template custom prompt',
    });
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          catalogueTemplateMappingId: mapping.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, response.json().jobIds[0]));
    expect(inputs?.params).toMatchObject({
      catalogueTemplateMappingId: mapping.id,
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a mapped-template custom prompt',
    });
  });

  it('omits promptGarmentPhase from the snapshot when no override is configured', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-mapped-no-prompt@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `mapped-shirt-noprompt-${poseAId}`,
        label: 'Mapped shirt',
      })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Mapped template no prompt' })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: poseAId,
      backgroundId: bgAId,
    });
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `mapped-job-workflow-noprompt-${poseAId}`,
        label: 'Mapped job workflow no prompt',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: poseAId,
      workflowTemplateId: workflow.id,
    });
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          catalogueTemplateMappingId: mapping.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, response.json().jobIds[0]));
    expect(inputs?.params).not.toHaveProperty('promptGarmentPhase');
  });

  it('rejects duplicate (poseId, backgroundId) pairs within one looks[] request', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-dup@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
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
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseAId, backgroundId: bgAId },
          ],
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

  it('does NOT apply the Amazon white-bg override to the looks[] form', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-amazon@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    // A white background exists in the system (as Amazon platform requires for the legacy form).
    await app.db.insert(schema.modelBackgrounds).values({
      label: 'White',
      r2Key: 'w.jpg',
      thumbnailKey: 'w.jpg',
      isWhiteBg: true,
    });
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
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        platform: 'Amazon',
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [inputsRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    // Must stay bgAId — NOT swapped to the white background.
    expect(inputsRow?.backgroundId).toBe(bgAId);
  });

  it('legacy backgroundId+poseIds form still applies the Amazon white-bg override', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-legacy-amazon@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [whiteBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'White', r2Key: 'w.jpg', thumbnailKey: 'w.jpg', isWhiteBg: true })
      .returning();
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
          backgroundId: bgAId,
          poseIds: [poseAId],
        },
        aspectRatio: '1:1',
        resolution: '2K',
        platform: 'Amazon',
      },
    });
    expect(res.statusCode).toBe(201);
    const { jobIds } = res.json();

    const [inputsRow] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(inputsRow?.backgroundId).toBe(whiteBg.id);
  });

  it('rolls back the whole batch (no partial charge) when one background is inactive', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-rollback@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId, poseBId } = await seedTwoPoses();
    const [inactiveBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Inactive', r2Key: 'i.jpg', thumbnailKey: 'i.jpg', isActive: false })
      .returning();
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
          looks: [
            { poseId: poseAId, backgroundId: bgAId },
            { poseId: poseBId, backgroundId: inactiveBg.id },
          ],
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
    expect(bal.balance).toBe(100); // fully rolled back — no partial job/charge
    const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
    expect(jobRows).toHaveLength(0);
  });

  it('rejects a lower-only submission against a pose whose workflow requires an upper garment', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-upper-required@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `upper-required-${poseAId}`, label: 'Upper required' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `upper-required-workflow-${poseAId}`,
        label: 'Upper required workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: ['4'],
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          lowerGarmentKey: garmentKey,
          faceId,
          garmentTypeId: garmentType.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a lowerCatalogId as the sole hero for a lower-primary workflow', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-catalog-hero-rejected@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `catalog-hero-rejected-${poseAId}`,
        label: 'Catalog hero rejected',
      })
      .returning();
    const [catalogType] = await app.db
      .insert(schema.catalogTypes)
      .values({ slug: `lower-${poseAId}`, label: 'Lower' })
      .returning();
    const [category] = await app.db
      .insert(schema.catalogCategories)
      .values({ typeId: catalogType.id, slug: `pants-${poseAId}`, label: 'Pants' })
      .returning();
    const [catalogItem] = await app.db
      .insert(schema.catalogItems)
      .values({
        categoryId: category.id,
        type: 'lower',
        genderSlug: 'men',
        label: 'Test pants',
        r2Key: 'catalog/pants.jpg',
        thumbnailKey: 'catalog/pants-thumb.jpg',
      })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `lower-primary-catalog-${poseAId}`,
        label: 'Lower primary catalog test',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: [],
        lowerNodeId: '7',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          faceId,
          garmentTypeId: garmentType.id,
          lowerCatalogId: catalogItem.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('strips an irrelevant upper garment key from a lower-only job row', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-strip-upper@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId } = await seedFaceAndTwoBackgrounds();
    const { poseAId } = await seedTwoPoses();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `strip-upper-${poseAId}`, label: 'Strip upper' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `strip-upper-workflow-${poseAId}`,
        label: 'Strip upper workflow',
        jsonContent: {},
        poseNodeId: '2',
        upperNodeIds: [],
        lowerNodeId: '7',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db
      .update(schema.modelPoseAssets)
      .set({ workflowTemplateId: workflow.id })
      .where(eq(schema.modelPoseAssets.id, poseAId));
    const upperKey = `inputs/${userId}/garment.jpg`;
    const lowerKey = upperKey;
    await bindUploadKey(userId, upperKey);
    await bindUploadKey(userId, lowerKey);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: upperKey,
          lowerGarmentKey: lowerKey,
          faceId,
          garmentTypeId: garmentType.id,
          looks: [{ poseId: poseAId, backgroundId: bgAId }],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(response.statusCode).toBe(201);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, response.json().jobIds[0]));
    expect(inputs?.upperGarmentKey).toBeNull();
    expect(inputs?.lowerGarmentKey).toBe(lowerKey);
  });

  it('refunds credits and marks each job FAILED when XADD fails for every look', async () => {
    await seedCreditPlan('free', false);
    const { token, userId } = await registerUser('looks-enqfail@x.com');
    await grantCredits(userId, 100);
    const { faceId, bgAId, bgBId } = await seedFaceAndTwoBackgrounds();
    const { poseAId, poseBId } = await seedTwoPoses();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          inputs: {
            upperGarmentKey: garmentKey,
            faceId,
            looks: [
              { poseId: poseAId, backgroundId: bgAId },
              { poseId: poseBId, backgroundId: bgBId },
            ],
          },
          aspectRatio: '1:1',
          resolution: '2K',
        },
      });
      expect(res.statusCode).toBe(503);

      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(100);

      const jobRows = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
      expect(jobRows).toHaveLength(2);
      for (const job of jobRows) {
        expect(job.status).toBe('FAILED');
        expect(job.errorCode).toBe('ENQUEUE_FAIL');
      }
    } finally {
      app.redis.xadd = realXadd;
    }
  });
});
