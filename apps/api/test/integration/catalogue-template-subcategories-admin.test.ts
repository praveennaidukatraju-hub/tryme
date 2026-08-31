import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin garment-type <-> catalogue-template mapping', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedGarmentTypeAndTemplates() {
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `sc-${Date.now()}`, label: 'Shirt' })
      .returning();
    const [templateA] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Template A', sortOrder: 0 })
      .returning();
    const [templateB] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'men', label: 'Template B', sortOrder: 1 })
      .returning();
    // A different-gender template must never appear in this garment type's list.
    const [templateWomen] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Template Women', sortOrder: 0 })
      .returning();
    return { garmentType, templateA, templateB, templateWomen };
  }

  it('GET lists every same-gender template with mapped:false when unmapped', async () => {
    const { garmentType, templateA, templateB, templateWomen } =
      await seedGarmentTypeAndTemplates();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/templates`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    const a = items.find((t: { id: string }) => t.id === templateA.id);
    const b = items.find((t: { id: string }) => t.id === templateB.id);
    expect(a.mapped).toBe(false);
    expect(b.mapped).toBe(false);
    expect(items.find((t: { id: string }) => t.id === templateWomen.id)).toBeUndefined();
  });

  it('GET includes the pose IDs used by each template', async () => {
    const { garmentType, templateA, templateB } = await seedGarmentTypeAndTemplates();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Template pose',
        genderSlug: 'men',
        r2Key: 'template-pose.jpg',
        thumbnailKey: 'template-pose-thumb.jpg',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Template background',
        r2Key: 'template-background.jpg',
        thumbnailKey: 'template-background-thumb.jpg',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: templateA.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/templates`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    expect(items.find((t: { id: string }) => t.id === templateA.id).poseAssetIds).toEqual([
      pose.id,
    ]);
    expect(items.find((t: { id: string }) => t.id === templateB.id).poseAssetIds).toEqual([]);
  });

  it('PATCH mapped:true inserts a mapping row, mapped:false removes it', async () => {
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();

    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    expect(enableRes.statusCode).toBe(200);

    const rowsAfterEnable = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rowsAfterEnable).toHaveLength(1);

    const listRes = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/templates`,
      headers,
    });
    expect(listRes.json().items.find((t: { id: string }) => t.id === templateA.id).mapped).toBe(
      true,
    );

    const disableRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: false },
    });
    expect(disableRes.statusCode).toBe(200);

    const rowsAfterDisable = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rowsAfterDisable).toHaveLength(0);
  });

  it('PATCH mapped:true twice is idempotent (no duplicate row, no error)', async () => {
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();

    await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    expect(second.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplateSubcategories)
      .where(eq(schema.catalogueTemplateSubcategories.templateId, templateA.id));
    expect(rows).toHaveLength(1);
  });

  it('configures a separate workflow per pose for each garment-template mapping', async () => {
    const { garmentType: shirt, templateA } = await seedGarmentTypeAndTemplates();
    const [suit] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `suit-${Date.now()}`, label: 'Suit' })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Shared template pose',
        genderSlug: 'men',
        r2Key: 'shared-template-pose.jpg',
        thumbnailKey: 'shared-template-pose-thumb.jpg',
        scope: 'template',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Shared template background',
        r2Key: 'shared-template-background.jpg',
        thumbnailKey: 'shared-template-background-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: templateA.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const workflows = await app.db
      .insert(schema.workflowTemplates)
      .values([
        {
          slug: `shirt-workflow-${Date.now()}`,
          label: 'Shirt workflow',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
        },
        {
          slug: `suit-workflow-${Date.now()}`,
          label: 'Suit workflow',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
        },
      ])
      .returning();

    const mapTemplate = async (garmentTypeId: string) => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentTypeId}/templates/${templateA.id}`,
        headers,
        payload: { mapped: true },
      });
      expect(response.statusCode).toBe(200);
      return response.json().mappingId as string;
    };

    const shirtMappingId = await mapTemplate(shirt.id);
    const suitMappingId = await mapTemplate(suit.id);
    expect(shirtMappingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(suitMappingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(shirtMappingId).not.toBe(suitMappingId);

    for (const [mappingId, workflowTemplateId] of [
      [shirtMappingId, workflows[0]?.id],
      [suitMappingId, workflows[1]?.id],
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId },
      });
      expect(response.statusCode).toBe(200);
    }

    const [shirtResponse, suitResponse] = await Promise.all(
      [shirtMappingId, suitMappingId].map((mappingId) =>
        app.inject({
          method: 'GET',
          url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
          headers,
        }),
      ),
    );
    expect(shirtResponse.statusCode).toBe(200);
    expect(suitResponse.statusCode).toBe(200);
    expect(shirtResponse.json().items[0].workflowTemplateId).toBe(workflows[0]?.id);
    expect(suitResponse.json().items[0].workflowTemplateId).toBe(workflows[1]?.id);
  });

  it('PATCH sets, preserves, and clears the prompt override independently of the workflow', async () => {
    const { garmentType, templateA } = await seedGarmentTypeAndTemplates();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Prompt override pose',
        genderSlug: 'men',
        r2Key: 'prompt-override-pose.jpg',
        thumbnailKey: 'prompt-override-pose-thumb.jpg',
        scope: 'template',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Prompt override background',
        r2Key: 'prompt-override-background.jpg',
        thumbnailKey: 'prompt-override-background-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: templateA.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `prompt-override-workflow-${Date.now()}`,
        label: 'Prompt override workflow',
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();

    const mapResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${garmentType.id}/templates/${templateA.id}`,
      headers,
      payload: { mapped: true },
    });
    const mappingId = mapResponse.json().mappingId as string;

    // Set workflow + prompt together.
    const setResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id, promptGarmentPhase: 'a custom prompt' },
    });
    expect(setResponse.statusCode).toBe(200);

    let getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0]).toMatchObject({
      workflowTemplateId: workflow.id,
      promptGarmentPhase: 'a custom prompt',
    });

    // A workflow-only PATCH (promptGarmentPhase omitted) must NOT clobber the saved prompt.
    const workflowOnlyResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id },
    });
    expect(workflowOnlyResponse.statusCode).toBe(200);

    getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0].promptGarmentPhase).toBe('a custom prompt');

    // Explicit null clears it.
    const clearResponse = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses/${pose.id}`,
      headers,
      payload: { workflowTemplateId: workflow.id, promptGarmentPhase: null },
    });
    expect(clearResponse.statusCode).toBe(200);

    getResponse = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-template-mappings/${mappingId}/poses`,
      headers,
    });
    expect(getResponse.json().items[0].promptGarmentPhase).toBeNull();
  });

  it('GET pose-configs excludes template-scoped poses, keeps general-scope poses', async () => {
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: `pose-configs-${Date.now()}`, label: 'Shirt' })
      .returning();
    const [generalPose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'General pose',
        genderSlug: 'men',
        r2Key: `general-${Date.now()}.jpg`,
        thumbnailKey: 'general-thumb.jpg',
        scope: 'general',
      })
      .returning();
    const [templatePose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Template-scoped pose',
        genderSlug: 'men',
        r2Key: `template-scoped-${Date.now()}.jpg`,
        thumbnailKey: 'template-scoped-thumb.jpg',
        scope: 'template',
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/assets/garment-types/${garmentType.id}/pose-configs`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();

    expect(items.find((p: { id: string }) => p.id === generalPose.id)).toBeTruthy();
    expect(items.find((p: { id: string }) => p.id === templatePose.id)).toBeUndefined();
  });
});
