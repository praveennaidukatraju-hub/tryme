import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('regenerate — reuses job-creation pipeline, never a separate implementation', () => {
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

  it('404s when the job does not exist', async () => {
    const { token } = await registerUser('regen-404@x.com');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${randomUUID()}/regenerate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'test reason' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the job belongs to another user', async () => {
    const { userId: ownerId } = await registerUser('regen-owner@x.com');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId: ownerId, status: 'COMPLETED', creditsCharged: 1 })
      .returning();
    const { token } = await registerUser('regen-thief@x.com');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/regenerate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'test reason' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409s when the original job is not COMPLETED', async () => {
    const { token, userId } = await registerUser('regen-409@x.com');
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'QUEUED', creditsCharged: 1 })
      .returning();
    await app.db.insert(schema.jobInputs).values({ jobId: job.id, upperGarmentKey: 'x' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/regenerate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'test reason' },
    });
    expect(res.statusCode).toBe(409);
  });

  describe('saree job regenerate', () => {
    async function seedSareeSettings() {
      await app.db.insert(schema.workflowTemplates).values({
        slug: `saree-wf-${randomUUID()}`,
        label: 'Saree workflow',
        workflowType: 'saree',
        jsonContent: {},
        isActive: true,
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['1'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      });
      await app.db.insert(schema.sareeSettings).values({
        modelImageKey: `saree/model-${randomUUID()}.jpg`,
      });
    }

    it('resolves the CURRENT watermark entitlement, not the one baked into the original job', async () => {
      await seedSareeSettings();
      await seedCreditPlan('free', true);

      const { token, userId } = await registerUser('regen-saree@x.com', 'free');
      await grantCredits(userId, 100);
      const garmentKey = `inputs/${userId}/garment.jpg`;
      await bindUploadKey(userId, garmentKey);

      const [original] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 35, watermark: true })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: original.id,
        upperGarmentKey: garmentKey,
        params: { kind: 'saree' },
      });

      // User upgrades to a plan with watermark:false before regenerating.
      await seedCreditPlan('starter', false);
      await app.db.update(schema.users).set({ tier: 'starter' }).where(eq(schema.users.id, userId));

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${original.id}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(res.statusCode).toBe(201);
      const { jobId: newJobId } = res.json();

      const [newJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, newJobId));
      expect(newJob.parentJobId).toBe(original.id);
      // Resolved fresh from the CURRENT plan — not copied from original.watermark.
      expect(newJob.watermark).toBe(false);

      const [origAfter] = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, original.id));
      expect(origAfter.watermark).toBe(true); // untouched
    });
  });

  describe('tryon-direct (simple-tryon) regenerate', () => {
    async function seedEligibleSourceJob(userId: string) {
      const [workflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `tryon-wf-${randomUUID()}`,
          label: 'Tryon workflow',
          workflowType: 'tryon',
          jsonContent: {},
          isActive: true,
          tryonPersonNodeId: '1',
          tryonGarmentNodeId: '2',
          tryonOutputNodeId: '3',
          faceNodeId: '1',
          poseNodeId: '1',
          bgNodeId: '1',
          upperNodeIds: ['2'],
          facePhasePromptNode: '1',
          garmentPhasePromptNode: '1',
        })
        .returning();
      const [category] = await app.db
        .insert(schema.tryonCategories)
        .values({
          name: 'Upper',
          slug: `upper-${randomUUID()}`,
          workflowTemplateId: workflow.id,
          isActive: true,
        })
        .returning();
      const [subcat] = await app.db
        .insert(schema.garmentSubcategories)
        .values({
          genderSlug: 'men',
          slug: `shirt-${randomUUID()}`,
          label: 'Shirt',
          tryonCategoryId: category.id,
        })
        .returning();
      const [sourceJob] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 25 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: sourceJob.id,
        upperGarmentKey: 'inputs/seed/garment.jpg',
        garmentTypeId: subcat.id,
      });
      await app.db.insert(schema.jobOutputs).values({
        jobId: sourceJob.id,
        resultKey: keys.output(sourceJob.id),
      });
      return { sourceJobId: sourceJob.id };
    }

    it('regenerates using the stored sourceJobId, sets parentJobId to the ORIGINAL tryon-direct job', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-tryon@x.com', 'free');
      await grantCredits(userId, 100);
      const { sourceJobId } = await seedEligibleSourceJob(userId);

      const personKey = `inputs/${randomUUID()}/garment.jpg`;
      await bindUploadKey(userId, personKey);
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/jobs/simple-tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: { personKey, sourceJobId },
      });
      expect(createRes.statusCode).toBe(201);
      const { jobId: tryonDirectJobId } = createRes.json();
      await app.db
        .update(schema.jobs)
        .set({ status: 'COMPLETED' })
        .where(eq(schema.jobs.id, tryonDirectJobId));

      // personKey's presign-ownership binding must still be valid at regenerate
      // time (createSimpleTryonJob re-checks it) — re-bind as if within TTL.
      await bindUploadKey(userId, personKey);
      const regenRes = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${tryonDirectJobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(regenRes.statusCode).toBe(201);
      const { jobId: regenJobId } = regenRes.json();

      const [regenJob] = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, regenJobId));
      expect(regenJob.parentJobId).toBe(tryonDirectJobId);
      // Free regenerate: never charged, not charged-then-refunded.
      expect(regenJob.creditsCharged).toBe(0);

      const [regenInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, regenJobId));
      // Re-derived from the CURRENT output of sourceJobId, exactly like a
      // fresh simple-tryon request — not copied verbatim from the
      // tryon-direct job's own (already-resolved) upperGarmentKey.
      expect(regenInputs.upperGarmentKey).toBe(keys.output(sourceJobId));
    });
  });

  describe('studio (catalogue) job regenerate — pose-workflow parity', () => {
    it('regenerates a lower-only original job without requiring an upper garment', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-lower-only@x.com', 'free');
      await grantCredits(userId, 100);
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
        .returning();
      const [bg] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
        .returning();
      const [workflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `regen-lower-${randomUUID()}`,
          label: 'Lower only',
          jsonContent: {},
          poseNodeId: '2',
          upperNodeIds: [],
          lowerNodeId: '7',
          garmentPhasePromptNode: '6',
        })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Lower pose',
          r2Key: 'p.jpg',
          thumbnailKey: 'p.jpg',
          workflowTemplateId: workflow.id,
        })
        .returning();
      const garmentKey = `inputs/${userId}/garment.jpg`;
      await bindUploadKey(userId, garmentKey);
      const [original] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 35 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: original.id,
        upperGarmentKey: null,
        lowerGarmentKey: garmentKey,
        faceId: face.id,
        backgroundId: bg.id,
        poseId: pose.id,
        params: { aspectRatio: '1:1', resolution: '2K' },
      });
      const response = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${original.id}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(response.statusCode).toBe(201);
    });

    it('regenerates after the upload-ownership Redis binding has expired', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-expired-upload@x.com', 'free');
      await grantCredits(userId, 100);
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
        .returning();
      const [bg] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
        .returning();
      const garmentKey = `inputs/${userId}/garment.jpg`;
      await bindUploadKey(userId, garmentKey);
      const [original] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 35 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: original.id,
        upperGarmentKey: garmentKey,
        faceId: face.id,
        backgroundId: bg.id,
        poseId: pose.id,
        params: { aspectRatio: '1:1', resolution: '2K' },
      });
      await app.redis.del(`upload:owner:${garmentKey}`);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${original.id}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(response.statusCode).toBe(201);
    });

    it('preserves catalogue-template mapping context when regenerating', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-mapped-template@x.com', 'free');
      await grantCredits(userId, 100);
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
        .returning();
      const [bg] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({ label: 'Mapped pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
        .returning();
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'men', slug: `regen-shirt-${randomUUID()}`, label: 'Shirt' })
        .returning();
      const [template] = await app.db
        .insert(schema.catalogueTemplates)
        .values({ genderSlug: 'men', label: 'Mapped template' })
        .returning();
      await app.db.insert(schema.catalogueTemplateLooks).values({
        templateId: template.id,
        poseAssetId: pose.id,
        backgroundId: bg.id,
      });
      const [mapping] = await app.db
        .insert(schema.catalogueTemplateSubcategories)
        .values({ templateId: template.id, subcategoryId: garmentType.id })
        .returning();
      const [workflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `regen-mapped-${randomUUID()}`,
          label: 'Mapped workflow',
          jsonContent: {},
          poseNodeId: '2',
          upperNodeIds: ['4'],
          garmentPhasePromptNode: '6',
        })
        .returning();
      await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
        mappingId: mapping.id,
        poseAssetId: pose.id,
        workflowTemplateId: workflow.id,
      });
      const garmentKey = `inputs/${userId}/garment.jpg`;
      await bindUploadKey(userId, garmentKey);
      const [original] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 35 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: original.id,
        upperGarmentKey: garmentKey,
        faceId: face.id,
        backgroundId: bg.id,
        poseId: pose.id,
        garmentTypeId: garmentType.id,
        params: {
          aspectRatio: '1:1',
          resolution: '2K',
          catalogueTemplateMappingId: mapping.id,
          workflowTemplateId: workflow.id,
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${original.id}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(response.statusCode).toBe(201);
      const [newInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, response.json().jobId));
      expect((newInputs.params as Record<string, unknown>).catalogueTemplateMappingId).toBe(
        mapping.id,
      );
    });

    it('re-derives lower/shoe stripping from the CURRENT pose workflow, not the stale original inputs', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-studio@x.com', 'free');
      await grantCredits(userId, 100);

      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
        .returning();
      const [bg] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
        .returning();
      // Pose has NO workflow template at all → lowerNodeId/shoeNodeId resolve
      // to null → createJob will null out lowerCatalogId/shoeCatalogId
      // regardless of what's stored on the original job's inputs.
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
        .returning();
      const [lowerItem] = await app.db
        .insert(schema.catalogItems)
        .values({ type: 'lower', label: 'L', r2Key: 'l.jpg', thumbnailKey: 'l.jpg' })
        .returning();

      const garmentKey = `inputs/${userId}/garment.jpg`;
      await bindUploadKey(userId, garmentKey);

      // Original job was created with a stale lowerCatalogId set directly
      // (simulating data from before this pose's workflow was reconfigured
      // to drop lower-garment support).
      const [original] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 35 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: original.id,
        upperGarmentKey: garmentKey,
        faceId: face.id,
        backgroundId: bg.id,
        poseId: pose.id,
        lowerCatalogId: lowerItem.id,
        params: { aspectRatio: '1:1', resolution: '2K' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${original.id}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(res.statusCode).toBe(201);
      const { jobId: newJobId } = res.json();

      const [newInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, newJobId));
      // This is the exact divergence the review flagged: a hand-rolled
      // regenerate implementation copied lowerCatalogId verbatim; calling
      // through createJob strips it because the pose has no lower node.
      expect(newInputs.lowerCatalogId).toBeNull();

      const [newJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, newJobId));
      expect(newJob.parentJobId).toBe(original.id);
      expect(newJob.source).toBe('catalog');
    });
  });

  describe('free regeneration gating', () => {
    async function seedStudioJob(
      userId: string,
      opts?: { regenerationReasonPrompts?: { reason: string; prompt: string }[] },
    ) {
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
        .returning();
      const [bg] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
        .returning();
      const [workflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `regen-gate-${randomUUID()}`,
          label: 'Gate workflow',
          jsonContent: {},
          poseNodeId: '2',
          upperNodeIds: ['4'],
          garmentPhasePromptNode: '6',
          regenerationReasonPrompts: opts?.regenerationReasonPrompts ?? [],
        })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Gate pose',
          r2Key: 'p.jpg',
          thumbnailKey: 'p.jpg',
          workflowTemplateId: workflow.id,
        })
        .returning();
      const garmentKey = `inputs/${userId}/garment-${randomUUID()}.jpg`;
      await bindUploadKey(userId, garmentKey);
      const [job] = await app.db
        .insert(schema.jobs)
        .values({ userId, status: 'COMPLETED', creditsCharged: 10 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey: garmentKey,
        faceId: face.id,
        backgroundId: bg.id,
        poseId: pose.id,
        params: { aspectRatio: '1:1', resolution: '2K' },
      });
      await app.db
        .insert(schema.jobOutputs)
        .values({ jobId: job.id, resultKey: keys.output(job.id) });
      return { jobId: job.id, workflowId: workflow.id };
    }

    it('400s when no reason is provided', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-no-reason@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId } = await seedStudioJob(userId);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('409s once the result has been downloaded', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-downloaded@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId } = await seedStudioJob(userId);

      const downloadRes = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(downloadRes.statusCode).toBe(200);

      const [output] = await app.db
        .select()
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, jobId));
      expect(output.downloadedAt).not.toBeNull();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('never charges credits for each of the first 5 regenerations, then 429s on the 6th', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-quota@x.com', 'free');
      await grantCredits(userId, 1000);
      const { jobId } = await seedStudioJob(userId);

      for (let i = 0; i < 5; i++) {
        const [{ balance: before }] = await app.db
          .select({ balance: schema.userCredits.balance })
          .from(schema.userCredits)
          .where(eq(schema.userCredits.userId, userId));
        const res = await app.inject({
          method: 'POST',
          url: `/v1/jobs/${jobId}/regenerate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { reason: 'test reason' },
        });
        expect(res.statusCode).toBe(201);
        const [{ balance: after }] = await app.db
          .select({ balance: schema.userCredits.balance })
          .from(schema.userCredits)
          .where(eq(schema.userCredits.userId, userId));
        // Never charged in the first place — no deduct, no refund, no ledger row.
        expect(after).toBe(before);

        const { jobId: newJobId } = res.json();
        const [newJob] = await app.db
          .select({ creditsCharged: schema.jobs.creditsCharged })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, newJobId));
        expect(newJob.creditsCharged).toBe(0);
        const ledgerRows = await app.db
          .select()
          .from(schema.creditLedger)
          .where(eq(schema.creditLedger.jobId, newJobId));
        expect(ledgerRows.length).toBe(0);
      }

      const sixth = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.code).toBe('FREE_REGENERATE_LIMIT');
    });

    it('applies the prompt whose reason matches the one the user picked', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-prompt@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId, workflowId } = await seedStudioJob(userId, {
        regenerationReasonPrompts: [
          { reason: 'Wrong pose or background', prompt: 'a completely different outfit angle' },
          { reason: 'Artifacts or glitches', prompt: 'clean, artifact-free render' },
        ],
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'Wrong pose or background' },
      });
      expect(res.statusCode).toBe(201);
      const { jobId: newJobId } = res.json();

      const [newInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, newJobId));
      const params = newInputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(workflowId);
      expect(params.promptGarmentPhase).toBe('a completely different outfit angle');
    });

    it('falls back to the original prompt when the submitted reason matches none configured', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-prompt-mismatch@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId } = await seedStudioJob(userId, {
        regenerationReasonPrompts: [
          { reason: 'Wrong pose or background', prompt: 'a completely different outfit angle' },
        ],
      });

      // "Other" (or any free-text reason) never matches a configured label.
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'Other' },
      });
      expect(res.statusCode).toBe(201);
      const { jobId: newJobId } = res.json();

      const [newInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, newJobId));
      const params = newInputs.params as Record<string, unknown>;
      expect(params.promptGarmentPhase).toBeUndefined();
    });

    it('GET regenerate-reasons returns the configured reason labels for the job', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-reasons@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId } = await seedStudioJob(userId, {
        regenerationReasonPrompts: [
          { reason: 'Wrong pose or background', prompt: 'a completely different outfit angle' },
          { reason: 'Artifacts or glitches', prompt: 'clean, artifact-free render' },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobId}/regenerate-reasons`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reasons).toEqual(['Wrong pose or background', 'Artifacts or glitches']);
    });

    it('GET regenerate-reasons 404s for a job belonging to another user', async () => {
      await seedCreditPlan('free', false);
      const { userId } = await registerUser('regen-reasons-owner@x.com', 'free');
      const { jobId } = await seedStudioJob(userId);
      const { token: thiefToken } = await registerUser('regen-reasons-thief@x.com', 'free');

      const res = await app.inject({
        method: 'GET',
        url: `/v1/jobs/${jobId}/regenerate-reasons`,
        headers: { authorization: `Bearer ${thiefToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a repeated click (same Idempotency-Key) creates only one job, not two', async () => {
      await seedCreditPlan('free', false);
      const { token, userId } = await registerUser('regen-idempotent@x.com', 'free');
      await grantCredits(userId, 100);
      const { jobId } = await seedStudioJob(userId);

      const idempotencyKey = randomUUID();
      const first = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
        payload: { reason: 'test reason' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
        payload: { reason: 'test reason' },
      });
      expect(second.statusCode).toBe(201);

      // Both requests resolved to the SAME new job — the second was served
      // from the idempotency cache, not created fresh.
      expect(second.json().jobId).toBe(first.json().jobId);

      const childJobs = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.parentJobId, jobId));
      expect(childJobs.length).toBe(1);

      // Only ONE regenerate was actually consumed against today's free quota.
      const third = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/regenerate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'test reason' },
      });
      expect(third.statusCode).toBe(201);
    });
  });
});
