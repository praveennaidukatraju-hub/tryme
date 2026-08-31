import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      websiteUrl: 'https://example.com',
      companySize: '1-10',
      purpose: 'merchant tests',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, userId: merchantUser.id };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function grantUserCredits(app: TestApp, userId: string, amount: number) {
  await app.db
    .insert(schema.userCredits)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
}

async function seedWorkflowTemplate(app: TestApp) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `regular-wf-${randomUUID()}`,
      label: 'Regular workflow',
      jsonContent: {},
      faceNodeId: '1',
      poseNodeId: '1',
      bgNodeId: '1',
      upperNodeIds: ['2'],
      facePhasePromptNode: '1',
      garmentPhasePromptNode: '1',
    })
    .returning();
  return wf;
}

async function seedWorkflowTemplateWithLowerShoe(
  app: TestApp,
  lowerNodeId: string | null,
  shoeNodeId: string | null,
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `regular-wf-lowershoe-${randomUUID()}`,
      label: 'Regular workflow with lower/shoe',
      jsonContent: {},
      faceNodeId: '1',
      poseNodeId: '1',
      bgNodeId: '1',
      upperNodeIds: ['2'],
      lowerNodeId,
      shoeNodeId,
      facePhasePromptNode: '1',
      garmentPhasePromptNode: '1',
    })
    .returning();
  return wf;
}

async function seedCatalogItem(
  app: TestApp,
  type: 'lower' | 'shoe',
  genderSlug: string,
  isActive = true,
) {
  const [item] = await app.db
    .insert(schema.catalogItems)
    .values({
      type,
      genderSlug,
      label: `${type} ${randomUUID()}`,
      r2Key: `catalog/${type}/${randomUUID()}.jpg`,
      thumbnailKey: `catalog/${type}/${randomUUID()}.thumb.jpg`,
      isActive,
    })
    .returning();
  return item;
}

async function seedPose(app: TestApp, genderSlug: string, workflowTemplateId: string) {
  const [pose] = await app.db
    .insert(schema.modelPoseAssets)
    .values({
      label: `Pose ${randomUUID()}`,
      r2Key: 'poses/seed/pose.jpg',
      thumbnailKey: 'poses/seed/pose.thumb.jpg',
      genderSlug,
      workflowTemplateId,
    })
    .returning();
  return pose;
}

async function seedFace(app: TestApp, gender: string) {
  const [face] = await app.db
    .insert(schema.modelFaces)
    .values({
      gender,
      label: `Face ${randomUUID()}`,
      r2Key: 'faces/seed/face.jpg',
      thumbnailKey: 'faces/seed/face.thumb.jpg',
    })
    .returning();
  return face;
}

async function seedBackground(app: TestApp) {
  const [bg] = await app.db
    .insert(schema.modelBackgrounds)
    .values({
      label: `Background ${randomUUID()}`,
      r2Key: 'backgrounds/seed/bg.jpg',
      thumbnailKey: 'backgrounds/seed/bg.thumb.jpg',
    })
    .returning();
  return bg;
}

async function seedSareeStyle(
  app: TestApp,
  mannequinWorkflowTemplateId: string,
  isActive = true,
  mannequinTwoInputWorkflowTemplateId?: string,
) {
  const [style] = await app.db
    .insert(schema.sareeMannequinStyles)
    .values({
      label: `Style ${randomUUID()}`,
      mannequinWorkflowTemplateId,
      isActive,
      mannequinTwoInputWorkflowTemplateId: mannequinTwoInputWorkflowTemplateId ?? null,
    })
    .returning();
  return style;
}

async function seedMannequinWorkflowTemplate(app: TestApp) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `saree-step1-${randomUUID()}`,
      label: 'Saree Step1',
      jsonContent: {
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
      },
      workflowType: 'saree_step1',
      faceNodeId: '',
      poseNodeId: '',
      bgNodeId: '',
      upperNodeIds: [],
      facePhasePromptNode: '',
      garmentPhasePromptNode: '',
      tryonPersonNodeId: '1',
      tryonGarmentNodeId: '2',
      tryonOutputNodeId: '10',
    })
    .returning();
  return wf;
}

async function seedMannequinOnlyGarmentType(app: TestApp, genderSlug: string) {
  const wf = await seedMannequinWorkflowTemplate(app);
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug,
      slug: `mannequin-type-${randomUUID()}`,
      label: 'Mannequin Type',
      requiresMannequinStep: true,
      mannequinWorkflowTemplateId: wf.id,
    })
    .returning();
  return { garmentType: row, defaultWorkflowTemplate: wf };
}

async function seedTwoInputWorkflowTemplate(app: TestApp) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `saree-step1-two-input-${randomUUID()}`,
      label: 'Saree Step1 Two Input',
      jsonContent: {
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '3': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
      },
      workflowType: 'saree_step1_two_input',
      faceNodeId: '',
      poseNodeId: '',
      bgNodeId: '',
      upperNodeIds: [],
      facePhasePromptNode: '',
      garmentPhasePromptNode: '',
      tryonPersonNodeId: '1',
      tryonGarmentNodeId: '2',
      tryonGarmentNodeId2: '3',
      tryonOutputNodeId: '10',
    })
    .returning();
  return wf;
}

// mannequinWorkflowTemplateId omitted on purpose in some tests — mirrors the
// bug fixed for the web wizard where the single-input check ran unconditionally
// and blocked garment types configured for two-input mode only.
async function seedTwoInputGarmentType(
  app: TestApp,
  genderSlug: string,
  opts: { withSingleInput?: boolean } = {},
) {
  const twoInputWf = await seedTwoInputWorkflowTemplate(app);
  const singleInputWf = opts.withSingleInput ? await seedMannequinWorkflowTemplate(app) : null;
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug,
      slug: `two-input-type-${randomUUID()}`,
      label: 'Two Input Type',
      requiresMannequinStep: true,
      mannequinWorkflowTemplateId: singleInputWf?.id,
      mannequinTwoInputWorkflowTemplateId: twoInputWf.id,
    })
    .returning();
  return { garmentType: row, twoInputWorkflowTemplate: twoInputWf, singleInputWf };
}

async function presignFlat(app: TestApp, auth: Record<string, string>) {
  const presign = await app.inject({
    method: 'POST',
    url: '/v1/merchant/catalog/presign',
    headers: auth,
    payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
  });
  const { r2Key, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
  await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: Buffer.from('flat'),
  });
  return r2Key;
}

// requiresMannequinStep: true is required here for the mannequinOnly/two-step
// generate flow itself (createMerchantCatalogJob / createMerchantSareeMannequinJob),
// not for subcategory creation — the shared /v1/merchant/catalog/subcategories
// routes accept any active garment type regardless of this flag.
async function seedGarmentType(app: TestApp, genderSlug: string, defaultPoseId: string | null) {
  const [row] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug,
      slug: `type-${randomUUID()}`,
      label: 'Type',
      defaultPoseId,
      requiresMannequinStep: true,
    })
    .returning();
  return row;
}

describe('merchant catalog generate (single, Path B)', () => {
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

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  async function seedFullDefaults(genderSlug: string) {
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, genderSlug, wf.id);
    const face = await seedFace(app, genderSlug);
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, genderSlug, pose.id);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { [genderSlug]: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );
    return { garmentType, pose, face, bg, workflowTemplate: wf };
  }

  it('creates a userId-owned studio job (not merchantId-owned) with the admin-fixed inputs, and deducts user credits', async () => {
    const { merchant, userId } = await createMerchant(app, 'gen-happy@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType } = await seedFullDefaults('men');

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    expect(presign.statusCode).toBe(200);
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });
    expect(put.ok).toBe(true);

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBe(userId);
    expect(job.merchantId).toBeNull();
    expect(job.status).toBe('QUEUED');

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.faceId).toBeTruthy();
    expect(inputs.backgroundId).toBeTruthy();
    expect(inputs.poseId).toBeTruthy();
    expect(inputs.garmentTypeId).toBe(garmentType.id);
    expect(inputs.upperGarmentKey).toBe(flatImageKey);
    const params = inputs.params as Record<string, unknown>;
    expect(params.kind).toBe('merchant_catalog');
    expect(params.subcategoryId).toBe(subcategoryId);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBeLessThan(100);

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);

    void merchant; // referenced only for setup symmetry with other tests in this file
  });

  it('rejects a merchant catalogue upload above the admin-configured limit', async () => {
    const { userId } = await createMerchant(app, 'catalog-limit@example.com');
    await grantUserCredits(app, userId, 100);
    const { garmentType, face, bg } = await seedFullDefaults('women');

    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
        uploadLimits: { merchantCatalogMaxBytes: 1024 },
      }),
    );

    const auth = await authHeader(userId);
    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: {
        category: 'women',
        name: 'Sarees',
        garmentSubcategoryId: garmentType.id,
      },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 2048 },
    });
    expect(presigned.statusCode).toBe(200);
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

    const genRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: r2Key },
    });
    expect(genRes.statusCode).toBe(413);
    expect(genRes.json().error.message).toContain('MB limit');
  });

  it('rejects with 400 when the garment type has no default pose configured', async () => {
    const { userId } = await createMerchant(app, 'gen-nopose@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const garmentType = await seedGarmentType(app, 'men', null);

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
  });

  it('rejects with 400 when no merchantCatalogDefaults are configured for the category', async () => {
    const { userId } = await createMerchant(app, 'gen-nodefaults@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, 'men', wf.id);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    // deliberately do not set config:system

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
  });

  it("applies configured default lower garment and shoe when the pose's workflow needs them", async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-happy@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', '4');
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    const lowerItem = await seedCatalogItem(app, 'lower', 'men');
    const shoeItem = await seedCatalogItem(app, 'shoe', 'men');
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          men: {
            faceId: face.id,
            backgroundId: bg.id,
            lowerCatalogId: lowerItem.id,
            shoeCatalogId: shoeItem.id,
          },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.lowerCatalogId).toBe(lowerItem.id);
    expect(inputs.shoeCatalogId).toBe(shoeItem.id);
  });

  it('rejects with 400 when the pose needs a lower garment but no default lower catalog item is configured', async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-missing@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', null);
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { men: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
    expect(generate.json().error.message).toContain('default lower garment');
  });

  it("does not apply configured lower/shoe defaults when the pose's workflow does not need them", async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-unneeded@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType, face, bg } = await seedFullDefaults('women');
    const lowerItem = await seedCatalogItem(app, 'lower', 'women');
    const shoeItem = await seedCatalogItem(app, 'shoe', 'women');
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          women: {
            faceId: face.id,
            backgroundId: bg.id,
            lowerCatalogId: lowerItem.id,
            shoeCatalogId: shoeItem.id,
          },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.lowerCatalogId).toBeNull();
    expect(inputs.shoeCatalogId).toBeNull();
  });

  it('rejects with 400 when the configured default lower catalog item is inactive', async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-inactive@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', null);
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    const inactiveLower = await seedCatalogItem(app, 'lower', 'men', false);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          men: { faceId: face.id, backgroundId: bg.id, lowerCatalogId: inactiveLower.id },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
    expect(generate.json().error.message).toContain('lower garment not found or inactive');
  });

  it('marks a completed job COMPLETED via the status poll and creates a product on client confirmation', async () => {
    const { userId } = await createMerchant(app, 'gen-complete@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType } = await seedFullDefaults('women');

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    const { jobId } = generate.json() as { jobId: string };

    // Simulate the dispatcher completing the job (dispatcher is not running in
    // this integration test — write the terminal state directly, exactly as
    // simple-tryon.test.ts / regenerate.test.ts already do for the same reason).
    const resultKey = `outputs/${jobId}/result.png`;
    await app.storage.putObject(resultKey, Buffer.from('generated-catalogue-image'), 'image/png');
    await app.db.update(schema.jobs).set({ status: 'COMPLETED' }).where(eq(schema.jobs.id, jobId));
    await app.db.insert(schema.jobOutputs).values({ jobId, resultKey });

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/catalog/generate/${jobId}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as { status: string; resultUrl: string | null };
    expect(statusBody.status).toBe('COMPLETED');
    expect(statusBody.resultUrl).toBeTruthy();

    const imported = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/import',
      headers: auth,
      payload: { jobId, subcategoryId },
    });
    expect(imported.statusCode).toBe(201);
    const product = imported.json() as { sourceKind: string; sourceJobId: string };
    expect(product.sourceKind).toBe('imported');
    expect(product.sourceJobId).toBe(jobId);
  });

  describe('bulk generate', () => {
    it('creates one job per flat image, tolerates partial failure, and reports batch status', async () => {
      const { userId } = await createMerchant(app, 'gen-bulk@example.com');
      await grantUserCredits(app, userId, 1000);
      const auth = await authHeader(userId);
      const { garmentType } = await seedFullDefaults('boys');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'boys', name: 'T-Shirts', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatKeys: string[] = [];
      for (let i = 0; i < 3; i++) {
        const presign = await app.inject({
          method: 'POST',
          url: '/v1/merchant/catalog/presign',
          headers: auth,
          payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
        });
        const { r2Key, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
        await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: Buffer.from(`flat-${i}`),
        });
        flatKeys.push(r2Key);
      }

      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: flatKeys },
      });
      expect(bulk.statusCode).toBe(201);
      const { jobIds } = bulk.json() as { jobIds: string[] };
      expect(jobIds).toHaveLength(3);

      const status = await app.inject({
        method: 'GET',
        url: `/v1/merchant/catalog/generate/status?jobIds=${jobIds.join(',')}`,
        headers: auth,
      });
      expect(status.statusCode).toBe(200);
      const body = status.json() as { items: Array<{ jobId: string; status: string }> };
      expect(body.items).toHaveLength(3);
      // Bulk-flat batches are held for admin release, not enqueued immediately —
      // see Task 2 (create-job.ts's `hold` flag).
      expect(body.items.every((i) => i.status === 'HELD')).toBe(true);
    });

    it('reports failures for unowned keys while still enqueuing the valid ones', async () => {
      const { userId } = await createMerchant(app, 'gen-bulk-partial@example.com');
      await grantUserCredits(app, userId, 1000);
      const auth = await authHeader(userId);
      const { garmentType } = await seedFullDefaults('boys');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'boys', name: 'T-Shirts', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const presign = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/presign',
        headers: auth,
        payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
      });
      const { r2Key: validKey, uploadUrl } = presign.json() as { r2Key: string; uploadUrl: string };
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('flat-valid'),
      });
      const unownedKey = `merchants/${randomUUID()}/catalog/flat/${randomUUID()}.jpg`;

      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: [validKey, unownedKey] },
      });
      expect(bulk.statusCode).toBe(201);
      const { jobIds, failures } = bulk.json() as {
        jobIds: string[];
        failures: Array<{ flatImageKey: string; error: string }>;
      };
      expect(jobIds).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].flatImageKey).toBe(unownedKey);
    });

    it('returns 201 with an empty jobIds and per-item reasons when every image in the batch fails', async () => {
      const { userId } = await createMerchant(app, 'gen-bulk-allfail@example.com');
      await grantUserCredits(app, userId, 1000);
      const auth = await authHeader(userId);
      const { garmentType } = await seedFullDefaults('boys');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'boys', name: 'T-Shirts', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const unownedKeys = [
        `merchants/${randomUUID()}/catalog/flat/${randomUUID()}.jpg`,
        `merchants/${randomUUID()}/catalog/flat/${randomUUID()}.jpg`,
      ];

      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate-bulk',
        headers: auth,
        payload: { subcategoryId, flatImageKeys: unownedKeys },
      });
      expect(bulk.statusCode).toBe(201);
      const { jobIds, failures } = bulk.json() as {
        jobIds: string[];
        failures: Array<{ flatImageKey: string; error: string }>;
      };
      expect(jobIds).toHaveLength(0);
      expect(failures).toHaveLength(2);
      expect(failures.map((f) => f.flatImageKey).sort()).toEqual([...unownedKeys].sort());
    });
  });

  describe('sareeStyleId', () => {
    it('snapshots the style workflow template into job_inputs.params when provided', async () => {
      const { userId } = await createMerchant(app, 'style-happy@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, defaultWorkflowTemplate } = await seedMannequinOnlyGarmentType(
        app,
        'women',
      );
      const styleTemplate = await seedMannequinWorkflowTemplate(app);
      const style = await seedSareeStyle(app, styleTemplate.id);

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const presign = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/presign',
        headers: auth,
        payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
      });
      const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
        r2Key: string;
        uploadUrl: string;
      };
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('flat'),
      });

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, mannequinOnly: true, sareeStyleId: style.label },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(styleTemplate.id);
      expect(params.workflowTemplateId).not.toBe(defaultWorkflowTemplate.id);
    });

    it('matches the style label case-insensitively', async () => {
      const { userId } = await createMerchant(app, 'style-case@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');
      const styleTemplate = await seedMannequinWorkflowTemplate(app);
      const [style] = await app.db
        .insert(schema.sareeMannequinStyles)
        .values({ label: 'Style2', mannequinWorkflowTemplateId: styleTemplate.id })
        .returning();

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const presign = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/presign',
        headers: auth,
        payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
      });
      const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
        r2Key: string;
        uploadUrl: string;
      };
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('flat'),
      });

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey,
          mannequinOnly: true,
          sareeStyleId: 'style2',
        },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(style.mannequinWorkflowTemplateId);
    });

    it('falls back to the garment type default when sareeStyleId is omitted', async () => {
      const { userId } = await createMerchant(app, 'style-omitted@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const presign = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/presign',
        headers: auth,
        payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
      });
      const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
        r2Key: string;
        uploadUrl: string;
      };
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('flat'),
      });

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, mannequinOnly: true },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBeUndefined();
    });

    it('rejects with 400 when sareeStyleId is inactive', async () => {
      const { userId } = await createMerchant(app, 'style-inactive@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');
      const styleTemplate = await seedMannequinWorkflowTemplate(app);
      const inactiveStyle = await seedSareeStyle(app, styleTemplate.id, false);

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg',
          mannequinOnly: true,
          sareeStyleId: inactiveStyle.label,
        },
      });
      expect(generate.statusCode).toBe(400);
    });

    it('rejects with 400 when sareeStyleId does not exist', async () => {
      const { userId } = await createMerchant(app, 'style-missing@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg',
          mannequinOnly: true,
          sareeStyleId: 'label-that-does-not-exist',
        },
      });
      expect(generate.statusCode).toBe(400);
    });

    it('uses the style two-input workflow when both sareeStyleId and secondFlatImageKey are provided, in preference to the garment type default', async () => {
      const { userId } = await createMerchant(app, 'style-two-input-happy@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, twoInputWorkflowTemplate: garmentTypeTwoInputWf } =
        await seedTwoInputGarmentType(app, 'women', { withSingleInput: false });
      const styleTwoInputWf = await seedTwoInputWorkflowTemplate(app);
      const styleSingleWf = await seedMannequinWorkflowTemplate(app);
      const style = await seedSareeStyle(app, styleSingleWf.id, true, styleTwoInputWf.id);

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey,
          secondFlatImageKey,
          mannequinOnly: true,
          sareeStyleId: style.label,
        },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(styleTwoInputWf.id);
      expect(params.workflowTemplateId).not.toBe(garmentTypeTwoInputWf.id);
    });

    it('rejects with 400 when the picked style has no two-input workflow configured and secondFlatImageKey is provided, even though the garment type has one', async () => {
      const { userId } = await createMerchant(app, 'style-two-input-noconf@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedTwoInputGarmentType(app, 'women', {
        withSingleInput: false,
      });
      const styleSingleWf = await seedMannequinWorkflowTemplate(app);
      const style = await seedSareeStyle(app, styleSingleWf.id);

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: {
          subcategoryId,
          flatImageKey,
          secondFlatImageKey,
          mannequinOnly: true,
          sareeStyleId: style.label,
        },
      });
      expect(generate.statusCode).toBe(400);
    });
  });

  describe('secondFlatImageKey (two-input)', () => {
    it('creates a job with both images, snapshotting the two-input workflow and storing the pallu key', async () => {
      const { userId } = await createMerchant(app, 'two-input-happy@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, twoInputWorkflowTemplate } = await seedTwoInputGarmentType(
        app,
        'women',
        { withSingleInput: true },
      );

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey, mannequinOnly: true },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      expect(inputs.upperGarmentKey).toBe(flatImageKey);
      expect(inputs.thirdGarmentKey).toBe(secondFlatImageKey);
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(twoInputWorkflowTemplate.id);
    });

    it('creates a two-input job when the garment type has no single-input workflow configured at all', async () => {
      const { userId } = await createMerchant(app, 'two-input-only@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, twoInputWorkflowTemplate } = await seedTwoInputGarmentType(
        app,
        'women',
        { withSingleInput: false },
      );

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey, mannequinOnly: true },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      const params = inputs.params as Record<string, unknown>;
      expect(params.workflowTemplateId).toBe(twoInputWorkflowTemplate.id);
    });

    it('rejects secondFlatImageKey when the garment type has no two-input workflow configured', async () => {
      const { userId } = await createMerchant(app, 'two-input-noconf@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType } = await seedMannequinOnlyGarmentType(app, 'women');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey, mannequinOnly: true },
      });
      expect(generate.statusCode).toBe(400);
    });
  });

  describe('GET /v1/merchant/catalog/saree-styles', () => {
    it('returns only active styles, ordered by sortOrder', async () => {
      const { userId } = await createMerchant(app, 'style-list@example.com');
      const auth = await authHeader(userId);
      const wf = await seedMannequinWorkflowTemplate(app);
      const twoInputWf = await seedTwoInputWorkflowTemplate(app);
      await app.db.update(schema.sareeMannequinStyles).set({ isActive: false });
      await app.db.insert(schema.sareeMannequinStyles).values({
        label: 'Zeta Style',
        mannequinWorkflowTemplateId: wf.id,
        mannequinTwoInputWorkflowTemplateId: twoInputWf.id,
        sortOrder: 1,
      });
      await app.db
        .insert(schema.sareeMannequinStyles)
        .values({ label: 'Alpha Style', mannequinWorkflowTemplateId: wf.id, sortOrder: 0 });
      await app.db.insert(schema.sareeMannequinStyles).values({
        label: 'Hidden Style',
        mannequinWorkflowTemplateId: wf.id,
        isActive: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/merchant/catalog/saree-styles',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ label: string; supportsTwoInput: boolean }> };
      expect(body.items.map((i) => i.label)).toEqual(['Alpha Style', 'Zeta Style']);
      expect(body.items.find((i) => i.label === 'Alpha Style')?.supportsTwoInput).toBe(false);
      expect(body.items.find((i) => i.label === 'Zeta Style')?.supportsTwoInput).toBe(true);
    });
  });

  describe('secondFlatImageKey on the full-composite (non-mannequinOnly) path', () => {
    it('creates a mannequin job + a PENDING_MANNEQUIN step-2 job, deducts credits on the step-2 job, and enqueues only the mannequin job', async () => {
      const { userId } = await createMerchant(app, 'two-input-full-happy@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);

      // seedTwoInputGarmentType (not seedFullDefaults — that helper's garment type has no
      // two-input workflow) gives a garment type with both requiresMannequinStep and
      // mannequinTwoInputWorkflowTemplateId set. It has no defaultPoseId, so wire one up
      // the same way seedFullDefaults does internally, plus a face/background for the
      // merchantCatalogDefaults config the step-2 compositing needs.
      const { garmentType: sareeType, twoInputWorkflowTemplate } = await seedTwoInputGarmentType(
        app,
        'women',
        { withSingleInput: true },
      );
      const wf = await seedWorkflowTemplate(app);
      const pose = await seedPose(app, 'women', wf.id);
      const face = await seedFace(app, 'women');
      const bg = await seedBackground(app);
      await app.db
        .update(schema.garmentSubcategories)
        .set({ defaultPoseId: pose.id })
        .where(eq(schema.garmentSubcategories.id, sareeType.id));
      await app.redis.set(
        CONFIG_KEY,
        JSON.stringify({
          merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
          merchantCatalogAspectRatio: '2:3',
        }),
      );

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: sareeType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const [balBefore] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey },
      });
      expect(generate.statusCode).toBe(201);
      const { jobId } = generate.json() as { jobId: string };

      const [step2] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(step2.status).toBe('PENDING_MANNEQUIN');
      expect(step2.source).toBe('merchant_catalog');

      const [step2Inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, jobId));
      expect(step2Inputs.upperGarmentKey).toBeNull();
      const step2Params = step2Inputs.params as Record<string, unknown>;
      const mannequinJobId = step2Params.mannequinJobId as string;
      expect(mannequinJobId).toBeTruthy();
      expect(step2Params.kind).toBe('merchant_catalog');

      const [mannequinJob] = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, mannequinJobId));
      expect(mannequinJob.status).toBe('QUEUED');
      expect(mannequinJob.source).toBe('saree_mannequin');
      expect(mannequinJob.creditsCharged).toBe(0);

      const [mannequinInputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, mannequinJobId));
      expect(mannequinInputs.upperGarmentKey).toBe(flatImageKey);
      expect(mannequinInputs.thirdGarmentKey).toBe(secondFlatImageKey);
      expect(mannequinInputs.faceId).toBe(face.id);

      // Credits deducted once, on the step-2 job, at creation time — not deferred.
      const [balAfter] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(balAfter.balance).toBeLessThan(balBefore.balance);

      // Only the mannequin job is enqueued; the step-2 job is not.
      const stream = await app.redis.xrange('jobs:normal', '-', '+');
      const enqueuedJobIds = stream.map(([, fields]) => fields[fields.indexOf('jobId') + 1]);
      expect(enqueuedJobIds).toContain(mannequinJobId);
      expect(enqueuedJobIds).not.toContain(jobId);

      void twoInputWorkflowTemplate; // referenced only for setup symmetry
    });

    it('rejects with 400 when the garment type has no two-input workflow configured', async () => {
      const { userId } = await createMerchant(app, 'two-input-full-noconf@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType, face, bg } = await seedFullDefaults('women');

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;

      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey },
      });
      expect(generate.statusCode).toBe(400);
      void face;
      void bg;
    });

    it('promotes the step-2 job to QUEUED with the mannequin output as upperGarmentKey once the mannequin job completes (simulated)', async () => {
      const { userId } = await createMerchant(app, 'two-input-full-promote@example.com');
      await grantUserCredits(app, userId, 100);
      const auth = await authHeader(userId);
      const { garmentType: sareeType } = await seedTwoInputGarmentType(app, 'women', {
        withSingleInput: true,
      });
      const wf = await seedWorkflowTemplate(app);
      const pose = await seedPose(app, 'women', wf.id);
      const face = await seedFace(app, 'women');
      const bg = await seedBackground(app);
      await app.db
        .update(schema.garmentSubcategories)
        .set({ defaultPoseId: pose.id })
        .where(eq(schema.garmentSubcategories.id, sareeType.id));
      await app.redis.set(
        CONFIG_KEY,
        JSON.stringify({
          merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
          merchantCatalogAspectRatio: '2:3',
        }),
      );

      const subcatRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/subcategories',
        headers: auth,
        payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: sareeType.id },
      });
      const subcategoryId = (subcatRes.json() as { id: string }).id;
      const flatImageKey = await presignFlat(app, auth);
      const secondFlatImageKey = await presignFlat(app, auth);

      const generate = await app.inject({
        method: 'POST',
        url: '/v1/merchant/catalog/generate',
        headers: auth,
        payload: { subcategoryId, flatImageKey, secondFlatImageKey },
      });
      const { jobId: step2JobId } = generate.json() as { jobId: string };
      const [step2Inputs] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, step2JobId));
      const mannequinJobId = (step2Inputs.params as Record<string, unknown>)
        .mannequinJobId as string;

      // Simulate the dispatcher completing the mannequin job (dispatcher is not running
      // in this integration test — same convention as merchant-catalog-generate.test.ts's
      // own "marks a completed job COMPLETED" test).
      const mannequinResultKey = `outputs/${mannequinJobId}/result.png`;
      await app.storage.putObject(mannequinResultKey, Buffer.from('drape-output'), 'image/png');
      await app.db
        .update(schema.jobs)
        .set({ status: 'COMPLETED' })
        .where(eq(schema.jobs.id, mannequinJobId));

      // Run the actual promoter sweep against the real dispatcher config shape.
      const { promoteSareeStep2Jobs } = await import(
        '../../../dispatcher/src/job/saree-step2-promoter.js'
      );
      await promoteSareeStep2Jobs({
        db: app.db,
        redis: app.redis,
        pub: app.redis,
        log: app.log,
      } as never);

      const [step2] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, step2JobId));
      expect(step2.status).toBe('QUEUED');
      const [step2InputsAfter] = await app.db
        .select()
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, step2JobId));
      expect(step2InputsAfter.upperGarmentKey).toBe(mannequinResultKey);

      const stream = await app.redis.xrange('jobs:normal', '-', '+');
      const enqueuedJobIds = stream.map(([, fields]) => fields[fields.indexOf('jobId') + 1]);
      expect(enqueuedJobIds).toContain(step2JobId);
    });
  });
});
