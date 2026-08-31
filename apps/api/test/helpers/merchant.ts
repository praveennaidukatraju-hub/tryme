import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { generateApiKey } from '../../src/modules/dev/keys.js';
import type { TestApp } from './api.js';

export async function createTestMerchant(
  app: TestApp,
  opts: {
    isActive?: boolean;
    balance?: number;
    demoData?: boolean;
    jobRateLimitPerMin?: number;
  } = {},
) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `merchant-${randomUUID()}@test.com`,
      displayName: 'Test Merchant',
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create test user');

  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Test Co',
      contactName: 'Test Person',
      phone: '0000000000',
      businessAddress: 'Test Address',
      isActive: opts.isActive ?? true,
      demoData: opts.demoData ?? true,
      userId: user.id,
      jobRateLimitPerMin: opts.jobRateLimitPerMin,
    })
    .returning();
  if (!merchant) throw new Error('failed to create test merchant');

  // One pool: merchant spend (android tryon) and personal spend
  // (studio, catalogue generation) both draw from this balance.
  await app.db.insert(schema.userCredits).values({ userId: user.id, balance: opts.balance ?? 100 });

  return {
    merchantId: merchant.id,
    userId: user.id,
    async credits(n: number) {
      await app.db
        .update(schema.userCredits)
        .set({ balance: n })
        .where(eq(schema.userCredits.userId, user.id));
    },
  };
}

export async function createTestApiKey(
  app: TestApp,
  merchantId: string,
  opts: {
    revoked?: boolean;
    label?: string;
    scope?: 'full' | 'widget';
    integration?: 'generic' | 'wordpress';
    allowedOrigin?: string;
  } = {},
) {
  const { key, keyHash, keyPrefix } = generateApiKey();
  const [row] = await app.db
    .insert(schema.apiKeys)
    .values({
      merchantId,
      label: opts.label ?? 'test',
      keyHash,
      keyPrefix,
      revokedAt: opts.revoked ? new Date() : null,
      scope: opts.scope ?? 'full',
      integration: opts.integration ?? 'generic',
      allowedOrigin: opts.allowedOrigin ?? null,
    })
    .returning();
  if (!row) throw new Error('failed to create test api key');
  return { id: row.id, key };
}

/**
 * Creates a tryon category plus the workflow template it points at.
 *
 * workflow_templates has six NOT NULL columns with no default — slug, label,
 * jsonContent, poseNodeId, upperNodeIds, garmentPhasePromptNode — so the filler
 * values below are mandatory, not decorative. Shape follows the existing inserts
 * in apps/api/test/shopify-me.test.ts:112.
 */
export async function createTestTryonCategory(
  app: TestApp,
  opts: {
    slug: string;
    name?: string;
    isActive?: boolean;
    templateIsActive?: boolean;
    sortOrder?: number;
  },
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `wf-${randomUUID()}`,
      label: 'Test Tryon WF',
      jsonContent: {},
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test workflow template');

  const [cat] = await app.db
    .insert(schema.tryonCategories)
    .values({
      name: opts.name ?? 'Test Category',
      slug: opts.slug,
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  if (!cat) throw new Error('failed to create test tryon category');

  return { categoryId: cat.id, workflowTemplateId: wf.id };
}

/**
 * Creates a garment_subcategories row with requires_mannequin_step = true, plus
 * the saree_step1 workflow template it points at. Mirrors createTestTryonCategory
 * above, adapted for the mannequin-step shape (garment + output node only —
 * no pose/upper/lower/face-node fields apply to workflowType 'saree_step1').
 */
export async function createTestSareeMannequinGarmentType(
  app: TestApp,
  opts: { isActive?: boolean; templateIsActive?: boolean; withPersonNode?: boolean } = {},
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `saree-step1-${randomUUID()}`,
      label: 'Test Saree Step1 WF',
      jsonContent: {
        '31': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '134': { class_type: 'SaveImage', inputs: {} },
      },
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'saree_step1',
      tryonPersonNodeId: opts.withPersonNode ? '1' : null,
      tryonGarmentNodeId: '31',
      tryonOutputNodeId: '134',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test saree step1 workflow template');

  const [garmentType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `flat-saree-${randomUUID()}`,
      label: 'Test Flat Saree',
      isActive: opts.isActive ?? true,
      requiresMannequinStep: true,
      mannequinWorkflowTemplateId: wf.id,
    })
    .returning();
  if (!garmentType) throw new Error('failed to create test flat-saree garment type');

  return { garmentTypeId: garmentType.id, workflowTemplateId: wf.id };
}

/**
 * Creates a dev tryon category plus the workflow template it points at.
 *
 * Mirrors createTestTryonCategory but targets the dev_tryon_categories table instead.
 */
export async function createTestDevTryonCategory(
  app: TestApp,
  opts: {
    slug: string;
    name?: string;
    isActive?: boolean;
    templateIsActive?: boolean;
    sortOrder?: number;
  },
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `wf-${randomUUID()}`,
      label: 'Test Dev Tryon WF',
      jsonContent: {},
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test workflow template');

  const [cat] = await app.db
    .insert(schema.devTryonCategories)
    .values({
      name: opts.name ?? 'Test Dev Category',
      slug: opts.slug,
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  if (!cat) throw new Error('failed to create test dev tryon category');

  return { categoryId: cat.id, workflowTemplateId: wf.id };
}

/**
 * Creates a dev_saree_mannequin_config row plus the saree_step1 workflow template it points at.
 *
 * Mirrors createTestSareeMannequinGarmentType but targets the dev_saree_mannequin_config
 * singleton config table instead of garment_subcategories.
 */
export async function createTestDevSareeMannequinConfig(
  app: TestApp,
  opts: { isActive?: boolean; templateIsActive?: boolean; withPersonNode?: boolean } = {},
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `dev-saree-step1-${randomUUID()}`,
      label: 'Test Dev Saree Step1 WF',
      jsonContent: {
        '31': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        '134': { class_type: 'SaveImage', inputs: {} },
      },
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'saree_step1',
      tryonPersonNodeId: opts.withPersonNode ? '1' : null,
      tryonGarmentNodeId: '31',
      tryonOutputNodeId: '134',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test dev saree step1 workflow template');

  await app.db
    .insert(schema.devSareeMannequinConfig)
    .values({
      id: '00000000-0000-0000-0000-000000000002',
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: schema.devSareeMannequinConfig.id,
      set: { workflowTemplateId: wf.id, isActive: opts.isActive ?? true, updatedAt: new Date() },
    });

  return { workflowTemplateId: wf.id };
}
