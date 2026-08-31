import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

describe('GET /v1/models/catalogue-templates', () => {
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

  async function loginToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    // Signed directly rather than via /v1/auth/login — this file calls loginToken() once
    // per test (real login is 5/min rate-limited) and none of these tests exercise login itself.
    return signAccess(secret, user.id, { kind: 'access' }, '15m');
  }

  it('returns only resolvable looks, drops templates left with zero looks', async () => {
    const [activePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Active', genderSlug: 'men', r2Key: 'ap.jpg', thumbnailKey: 'ap.jpg' })
      .returning();
    const [inactivePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Inactive',
        genderSlug: 'men',
        r2Key: 'ip.jpg',
        thumbnailKey: 'ip.jpg',
        isActive: false,
      })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();

    const [templateWithSurvivingLook] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Has Looks', sortOrder: 0 })
      .returning();
    const [templateFullyFiltered] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'All Filtered', sortOrder: 1 })
      .returning();

    await app.db.insert(schema.catalogueTemplateLooks).values([
      {
        templateId: templateWithSurvivingLook.id,
        poseAssetId: activePose.id,
        backgroundId: bg.id,
        sortOrder: 0,
      },
      {
        templateId: templateWithSurvivingLook.id,
        poseAssetId: inactivePose.id,
        backgroundId: bg.id,
        sortOrder: 1,
      },
      {
        templateId: templateFullyFiltered.id,
        poseAssetId: inactivePose.id,
        backgroundId: bg.id,
        sortOrder: 0,
      },
    ]);

    // Both templates mapped to the same garment type, so the ONLY reason
    // templateFullyFiltered disappears from results is the zero-surviving-looks
    // rule under test here — not the garment-type mapping requirement.
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-looks-${activePose.id}`, label: 'GT' })
      .returning();
    const mappings = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values([
        { templateId: templateWithSurvivingLook.id, subcategoryId: garmentType.id },
        { templateId: templateFullyFiltered.id, subcategoryId: garmentType.id },
      ])
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `resolvable-look-${activePose.id}`,
        label: 'Resolvable look workflow',
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
      mappingId: mappings[0]?.id ?? '',
      poseAssetId: activePose.id,
      workflowTemplateId: workflow.id,
    });

    const token = await loginToken('templates-public@x.com');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=men&garmentTypeId=${garmentType.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    const surviving = items.find((t: { id: string }) => t.id === templateWithSurvivingLook.id);
    expect(surviving).toBeTruthy();
    expect(surviving.looks).toHaveLength(1);
    expect(surviving.looks[0].poseId).toBe(activePose.id);

    // Template whose only look references an inactive pose is dropped entirely.
    expect(items.find((t: { id: string }) => t.id === templateFullyFiltered.id)).toBeUndefined();
  });

  it('uses mapping workflows instead of generic per-garment-type pose overrides', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', genderSlug: 'women', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-override-${pose.id}`,
        label: 'WF',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['1'],
        lowerNodeId: '2',
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [workflowWithoutLower] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-no-lower-${pose.id}`,
        label: 'WF without lower',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '1',
        bgNodeId: '1',
        upperNodeIds: ['1'],
        facePhasePromptNode: '1',
        garmentPhasePromptNode: '1',
      })
      .returning();
    const [subcatWithOverride] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-override-${pose.id}`, label: 'SC' })
      .returning();
    const [subcatNoOverride] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-no-override-${pose.id}`, label: 'SC2' })
      .returning();
    await app.db.insert(schema.poseGarmentConfigs).values({
      poseAssetId: pose.id,
      subcategoryId: subcatWithOverride.id,
      workflowTemplateId: workflow.id,
    });
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'T', sortOrder: 0 })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: bg.id,
      sortOrder: 0,
    });
    // Template mapped to BOTH garment types — one with a pose override, one without —
    // so both branches below are testing the override overlay, not the mapping gate.
    const mappings = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values([
        { templateId: template.id, subcategoryId: subcatWithOverride.id },
        { templateId: template.id, subcategoryId: subcatNoOverride.id },
      ])
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values([
      {
        mappingId: mappings[0]?.id ?? '',
        poseAssetId: pose.id,
        workflowTemplateId: workflow.id,
      },
      {
        mappingId: mappings[1]?.id ?? '',
        poseAssetId: pose.id,
        workflowTemplateId: workflowWithoutLower.id,
      },
    ]);

    const token = await loginToken('templates-override@x.com');

    // Garment type with no pose override — pose has no default workflow → hasLower false.
    const resWithout = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${subcatNoOverride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const withoutLook = resWithout.json().items[0].looks[0];
    expect(withoutLook.hasLower).toBe(false);

    // Garment type with a pose override — hasLower true (workflow has lowerNodeId).
    const resWith = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${subcatWithOverride.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const withLook = resWith.json().items[0].looks[0];
    expect(withLook.hasLower).toBe(true);
  });

  it('excludes a template that has no garment-type mapping at all', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', genderSlug: 'men', r2Key: 'p2.jpg', thumbnailKey: 'p2.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b2.jpg', thumbnailKey: 'b2.jpg' })
      .returning();
    const [unmappedTemplate] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Unmapped', sortOrder: 0 })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: unmappedTemplate.id,
      poseAssetId: pose.id,
      backgroundId: bg.id,
      sortOrder: 0,
    });
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-unmapped-${pose.id}`, label: 'GT' })
      .returning();
    // Deliberately no catalogueTemplateSubcategories row inserted for this template.

    const token = await loginToken('templates-unmapped@x.com');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/models/catalogue-templates?gender=men&garmentTypeId=${garmentType.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.find((t: { id: string }) => t.id === unmappedTemplate.id),
    ).toBeUndefined();
  });

  it('resolves look requirements from the workflow configured on each template mapping', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Shared pose',
        genderSlug: 'men',
        r2Key: 'mapping-pose.jpg',
        thumbnailKey: 'mapping-pose.jpg',
        scope: 'template',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Mapping background',
        r2Key: 'mapping-bg.jpg',
        thumbnailKey: 'mapping-bg.jpg',
        scope: 'template',
      })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Shared template' })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const [shirt, suit] = await app.db
      .insert(schema.garmentSubcategories)
      .values([
        { genderSlug: 'men', slug: `shirt-map-${pose.id}`, label: 'Shirt' },
        { genderSlug: 'men', slug: `suit-map-${pose.id}`, label: 'Suit' },
      ])
      .returning();
    const mappings = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values([
        { templateId: template.id, subcategoryId: shirt?.id ?? '' },
        { templateId: template.id, subcategoryId: suit?.id ?? '' },
      ])
      .returning();
    const workflows = await app.db
      .insert(schema.workflowTemplates)
      .values([
        {
          slug: `shirt-map-workflow-${pose.id}`,
          label: 'Shirt mapping workflow',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
        },
        {
          slug: `suit-map-workflow-${pose.id}`,
          label: 'Suit mapping workflow',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          lowerNodeId: '7',
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
        },
      ])
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values([
      {
        mappingId: mappings[0]?.id ?? '',
        poseAssetId: pose.id,
        workflowTemplateId: workflows[0]?.id ?? '',
      },
      {
        mappingId: mappings[1]?.id ?? '',
        poseAssetId: pose.id,
        workflowTemplateId: workflows[1]?.id ?? '',
      },
    ]);

    const token = await loginToken('templates-mapping-workflows@x.com');
    const getTemplate = async (garmentTypeId: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/models/catalogue-templates?gender=men&garmentTypeId=${garmentTypeId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json().items[0];
    };

    const shirtTemplate = await getTemplate(shirt?.id ?? '');
    const suitTemplate = await getTemplate(suit?.id ?? '');
    expect(shirtTemplate.mappingId).toBe(mappings[0]?.id);
    expect(suitTemplate.mappingId).toBe(mappings[1]?.id);
    expect(shirtTemplate.looks[0].hasLower).toBe(false);
    expect(suitTemplate.looks[0].hasLower).toBe(true);
  });

  it('hides an excluded look only for its mapped garment type', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Shared pose',
        genderSlug: 'women',
        r2Key: 'shared-pose.jpg',
        thumbnailKey: 'shared-pose.jpg',
      })
      .returning();
    const backgrounds = await app.db
      .insert(schema.modelBackgrounds)
      .values([
        { label: 'Standing background', r2Key: 'standing.jpg', thumbnailKey: 'standing.jpg' },
        { label: 'Sitting background', r2Key: 'sitting.jpg', thumbnailKey: 'sitting.jpg' },
      ])
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Visibility template' })
      .returning();
    const looks = await app.db
      .insert(schema.catalogueTemplateLooks)
      .values([
        {
          templateId: template.id,
          poseAssetId: pose.id,
          backgroundId: backgrounds[0]?.id ?? '',
          sortOrder: 0,
        },
        {
          templateId: template.id,
          poseAssetId: pose.id,
          backgroundId: backgrounds[1]?.id ?? '',
          sortOrder: 1,
        },
      ])
      .returning();
    const [saree, dress] = await app.db
      .insert(schema.garmentSubcategories)
      .values([
        { genderSlug: 'women', slug: `saree-visible-${pose.id}`, label: 'Saree' },
        { genderSlug: 'women', slug: `dress-visible-${pose.id}`, label: 'Dress' },
      ])
      .returning();
    const mappings = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values([
        { templateId: template.id, subcategoryId: saree?.id ?? '' },
        { templateId: template.id, subcategoryId: dress?.id ?? '' },
      ])
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `visibility-workflow-${pose.id}`,
        label: 'Visibility workflow',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values([
      { mappingId: mappings[0]?.id ?? '', poseAssetId: pose.id, workflowTemplateId: workflow.id },
      { mappingId: mappings[1]?.id ?? '', poseAssetId: pose.id, workflowTemplateId: workflow.id },
    ]);
    await app.db.insert(schema.catalogueTemplateLookExclusions).values({
      mappingId: mappings[0]?.id ?? '',
      lookId: looks[1]?.id ?? '',
    });

    const token = await loginToken('templates-look-visibility@x.com');
    const getLooks = async (garmentTypeId: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/models/catalogue-templates?gender=women&garmentTypeId=${garmentTypeId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      return response.json().items.find((item: { id: string }) => item.id === template.id).looks;
    };

    const sareeLooks = await getLooks(saree?.id ?? '');
    const dressLooks = await getLooks(dress?.id ?? '');
    expect(sareeLooks.map((look: { id: string }) => look.id)).toEqual([looks[0]?.id]);
    expect(dressLooks.map((look: { id: string }) => look.id)).toEqual(looks.map((look) => look.id));
  });
  it('returns an empty list when garmentTypeId is omitted', async () => {
    const token = await loginToken('templates-no-gt@x.com');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/catalogue-templates?gender=men',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
