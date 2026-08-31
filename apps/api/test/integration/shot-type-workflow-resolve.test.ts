import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveForGarmentTypeShotType,
  resolveForMapping,
  resolveForTemplate,
} from '../../src/modules/admin/shot-type-resolve.js';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('shot-type workflow resolve', () => {
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

  async function seedWorkflow(label: string) {
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `${label.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()}`,
        label,
        jsonContent: {},
        faceNodeId: '1',
        poseNodeId: '2',
        bgNodeId: '3',
        upperNodeIds: ['4'],
        lowerNodeId: '7',
        facePhasePromptNode: '5',
        garmentPhasePromptNode: '6',
      })
      .returning();
    return wf;
  }

  async function seedMappedPose(opts: { shotType: string | null }) {
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-${Date.now()}-${Math.random()}`, label: 'Shirt' })
      .returning();
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Template', sortOrder: 0 })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Pose',
        genderSlug: 'women',
        r2Key: `pose-${Date.now()}-${Math.random()}.jpg`,
        thumbnailKey: 'pose-thumb.jpg',
        scope: 'template',
        shotType: opts.shotType,
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Background',
        r2Key: `bg-${Date.now()}-${Math.random()}.jpg`,
        thumbnailKey: 'bg-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: background.id,
    });
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    return { garmentType, template, pose, background, mapping };
  }

  it('resolveForGarmentTypeShotType fills a gap from the configured default', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Full default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflow.id);
    expect(row.source).toBe('auto');
  });

  it('resolveForGarmentTypeShotType never touches a manually-set row', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const defaultWorkflow = await seedWorkflow('Default (should be ignored)');
    const manualWorkflow = await seedWorkflow('Manual pick');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: defaultWorkflow.id,
    });
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: pose.id,
      workflowTemplateId: manualWorkflow.id,
      source: 'manual',
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(manualWorkflow.id);
    expect(row.source).toBe('manual');
  });

  it('resolveForGarmentTypeShotType refreshes a previously-auto row when the default changes', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const oldDefault = await seedWorkflow('Old default');
    const newDefault = await seedWorkflow('New default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: oldDefault.id,
    });
    await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');

    await app.db
      .update(schema.garmentShotTypeWorkflows)
      .set({ workflowTemplateId: newDefault.id })
      .where(eq(schema.garmentShotTypeWorkflows.garmentTypeId, garmentType.id));
    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(newDefault.id);
    expect(row.source).toBe('auto');
  });

  it('resolveForMapping resolves every shot type for one mapping in a single call', async () => {
    const { garmentType, mapping, pose: fullPose } = await seedMappedPose({ shotType: 'full' });
    const [halfPose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Half pose',
        genderSlug: 'women',
        r2Key: `half-${Date.now()}.jpg`,
        thumbnailKey: 'half-thumb.jpg',
        scope: 'template',
        shotType: 'half',
      })
      .returning();
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Background 2',
        r2Key: `bg2-${Date.now()}.jpg`,
        thumbnailKey: 'bg2-thumb.jpg',
        scope: 'template',
      })
      .returning();
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: mapping.templateId,
      poseAssetId: halfPose.id,
      backgroundId: background.id,
    });
    const fullWorkflow = await seedWorkflow('Full');
    const halfWorkflow = await seedWorkflow('Half');
    await app.db.insert(schema.garmentShotTypeWorkflows).values([
      { garmentTypeId: garmentType.id, shotType: 'full', workflowTemplateId: fullWorkflow.id },
      { garmentTypeId: garmentType.id, shotType: 'half', workflowTemplateId: halfWorkflow.id },
    ]);

    const resolvedCount = await resolveForMapping(app.db, mapping.id);
    expect(resolvedCount).toBe(2);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows.find((r) => r.poseAssetId === fullPose.id)?.workflowTemplateId).toBe(
      fullWorkflow.id,
    );
    expect(rows.find((r) => r.poseAssetId === halfPose.id)?.workflowTemplateId).toBe(
      halfWorkflow.id,
    );
  });

  it('resolveForTemplate resolves across every garment type the template is mapped to', async () => {
    const { template, pose } = await seedMappedPose({ shotType: 'full' });
    const [garmentTypeB] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `sc-b-${Date.now()}`, label: 'Suit' })
      .returning();
    const [mappingB] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentTypeB.id })
      .returning();
    const workflowB = await seedWorkflow('Garment type B default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentTypeB.id,
      shotType: 'full',
      workflowTemplateId: workflowB.id,
    });

    const resolvedCount = await resolveForTemplate(app.db, template.id);
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingB.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflowB.id);
  });

  it('resolve is a no-op when the pose has no shot type or no matching default exists', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: null });
    const workflow = await seedWorkflow('Unused default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForMapping(app.db, mapping.id);
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('resolveForGarmentTypeShotType ignores a deactivated pose', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    await app.db
      .update(schema.modelPoseAssets)
      .set({ isActive: false })
      .where(eq(schema.modelPoseAssets.id, pose.id));
    const workflow = await seedWorkflow('Ignored — pose inactive');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows).toHaveLength(0);
  });

  it('resolveForGarmentTypeShotType ignores a soft-deleted template', async () => {
    const { garmentType, template, mapping } = await seedMappedPose({ shotType: 'full' });
    await app.db
      .update(schema.catalogueTemplates)
      .set({ deletedAt: new Date() })
      .where(eq(schema.catalogueTemplates.id, template.id));
    const workflow = await seedWorkflow('Ignored — template deleted');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(resolvedCount).toBe(0);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id));
    expect(rows).toHaveLength(0);
  });

  it('resolve does not rewrite a row already at the correct value', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Stable default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });
    const firstRun = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(firstRun).toBe(1);

    const [before] = await app.db
      .select({ updatedAt: schema.catalogueTemplatePoseWorkflows.updatedAt })
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );

    const secondRun = await resolveForGarmentTypeShotType(app.db, garmentType.id, 'full');
    expect(secondRun).toBe(0);

    const [after] = await app.db
      .select({ updatedAt: schema.catalogueTemplatePoseWorkflows.updatedAt })
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('resolve functions accept a transaction handle', async () => {
    const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const workflow = await seedWorkflow('Resolved inside a transaction');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await app.db.transaction(async (tx) => {
      return resolveForGarmentTypeShotType(tx, garmentType.id, 'full');
    });
    expect(resolvedCount).toBe(1);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(row.workflowTemplateId).toBe(workflow.id);
  });

  it('resolves to one row when the same pose appears in two looks with different backgrounds', async () => {
    const { garmentType, template, mapping, pose } = await seedMappedPose({ shotType: 'full' });
    const [secondBackground] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Second background',
        r2Key: `second-bg-${Date.now()}.jpg`,
        thumbnailKey: 'second-bg-thumb.jpg',
        scope: 'template',
      })
      .returning();
    // Same pose as the one seedMappedPose already put in a look — the template's
    // dedupe check only rejects duplicate (poseAssetId, backgroundId) pairs, so this
    // (same pose, different background) combination is a valid second look.
    await app.db.insert(schema.catalogueTemplateLooks).values({
      templateId: template.id,
      poseAssetId: pose.id,
      backgroundId: secondBackground.id,
    });
    const workflow = await seedWorkflow('Reused-pose default');
    await app.db.insert(schema.garmentShotTypeWorkflows).values({
      garmentTypeId: garmentType.id,
      shotType: 'full',
      workflowTemplateId: workflow.id,
    });

    const resolvedCount = await resolveForTemplate(app.db, template.id);
    expect(resolvedCount).toBe(1);

    const rows = await app.db
      .select()
      .from(schema.catalogueTemplatePoseWorkflows)
      .where(
        and(
          eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
          eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowTemplateId).toBe(workflow.id);
  });

  describe('routes', () => {
    it('GET shot-type-workflows always returns all three slots', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `route-get-${Date.now()}`, label: 'Shirt' })
        .returning();

      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items).toHaveLength(3);
      expect(items.map((i: { shotType: string }) => i.shotType).sort()).toEqual([
        'closeup',
        'full',
        'half',
      ]);
      expect(items.every((i: { workflowTemplateId: null }) => i.workflowTemplateId === null)).toBe(
        true,
      );
    });

    it('GET shot-type-workflows 404s for a nonexistent garment type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${crypto.randomUUID()}/shot-type-workflows`,
        headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH shot-type-workflows upserts the default and cascades to existing poses', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Route default');

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({ ok: true, action: 'upserted', resolvedCount: 1 });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);

      const getRes = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      const full = getRes.json().items.find((i: { shotType: string }) => i.shotType === 'full');
      expect(full.workflowTemplateId).toBe(workflow.id);
    });

    it('PATCH shot-type-workflows with null clears the default without touching resolved poses', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Cleared default');
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });

      const clearRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json()).toMatchObject({ ok: true, action: 'cleared' });

      const getRes = await app.inject({
        method: 'GET',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows`,
        headers,
      });
      const full = getRes.json().items.find((i: { shotType: string }) => i.shotType === 'full');
      expect(full.workflowTemplateId).toBeNull();

      // Already-resolved poses stay exactly as they are.
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
    });

    it('PATCH shot-type-workflows rejects an inactive or non-regular workflow', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `route-invalid-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [inactiveWorkflow] = await app.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `inactive-${Date.now()}`,
          label: 'Inactive',
          jsonContent: {},
          faceNodeId: '1',
          poseNodeId: '2',
          bgNodeId: '3',
          upperNodeIds: ['4'],
          facePhasePromptNode: '5',
          garmentPhasePromptNode: '6',
          isActive: false,
        })
        .returning();

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: inactiveWorkflow.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH shot-type-workflows 404s for a nonexistent garment type', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${crypto.randomUUID()}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PUT template looks resolves the new look across every garment type the template is mapped to', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `looks-put-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [template] = await app.db
        .insert(schema.catalogueTemplates)
        .values({ genderSlug: 'women', label: 'Looks PUT template', sortOrder: 0 })
        .returning();
      await app.db
        .insert(schema.catalogueTemplateSubcategories)
        .values({ templateId: template.id, subcategoryId: garmentType.id });
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Fresh pose',
          genderSlug: 'women',
          r2Key: `fresh-${Date.now()}.jpg`,
          thumbnailKey: 'fresh-thumb.jpg',
          scope: 'template',
          shotType: 'closeup',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'Fresh background',
          r2Key: `fresh-bg-${Date.now()}.jpg`,
          thumbnailKey: 'fresh-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();
      const workflow = await seedWorkflow('Closeup default');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'closeup',
        workflowTemplateId: workflow.id,
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/admin/assets/catalogue-templates/${template.id}/looks`,
        headers,
        payload: { looks: [{ poseAssetId: pose.id, backgroundId: background.id }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, count: 1, resolvedCount: 1 });

      const [mapping] = await app.db
        .select({ id: schema.catalogueTemplateSubcategories.id })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.templateId, template.id));
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
      expect(row.source).toBe('auto');
    });

    it('PUT template looks deletes stale workflow rows for poses no longer in the template', async () => {
      const {
        garmentType,
        template,
        mapping,
        pose: oldPose,
      } = await seedMappedPose({
        shotType: 'full',
      });
      const workflow = await seedWorkflow('Stale-row cleanup default');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: workflow.id,
      });
      // Resolve once so the old pose has a real row to clean up.
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });
      const [beforeRow] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, oldPose.id),
          ),
        );
      expect(beforeRow).toBeDefined();

      // Simulate "correct a mis-tagged pose by re-uploading it" — a brand-new pose
      // asset replaces the old one in this template's only look.
      const [newPose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'Replacement pose',
          genderSlug: 'women',
          r2Key: `replacement-${Date.now()}.jpg`,
          thumbnailKey: 'replacement-thumb.jpg',
          scope: 'template',
          shotType: 'full',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'Replacement background',
          r2Key: `replacement-bg-${Date.now()}.jpg`,
          thumbnailKey: 'replacement-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();

      await app.inject({
        method: 'PUT',
        url: `/admin/assets/catalogue-templates/${template.id}/looks`,
        headers,
        payload: { looks: [{ poseAssetId: newPose.id, backgroundId: background.id }] },
      });

      const oldRows = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, oldPose.id),
          ),
        );
      expect(oldRows).toHaveLength(0);

      const [newRow] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, newPose.id),
          ),
        );
      expect(newRow.workflowTemplateId).toBe(workflow.id);
    });

    it('PUT template looks persists shotType on an existing pose and cascades resolve', async () => {
      const { garmentType, template, mapping, pose, background } = await seedMappedPose({
        shotType: null,
      });
      const workflow = await seedWorkflow('Retag default');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'closeup',
        workflowTemplateId: workflow.id,
      });

      // Admin retags the existing look's shot type without re-uploading the pose
      // image — this must persist on model_pose_assets and immediately resolve
      // against the live category default, not silently no-op.
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/assets/catalogue-templates/${template.id}/looks`,
        headers,
        payload: {
          looks: [{ poseAssetId: pose.id, backgroundId: background.id, shotType: 'closeup' }],
        },
      });
      expect(res.statusCode).toBe(200);

      const [updatedPose] = await app.db
        .select({ shotType: schema.modelPoseAssets.shotType })
        .from(schema.modelPoseAssets)
        .where(eq(schema.modelPoseAssets.id, pose.id));
      expect(updatedPose.shotType).toBe('closeup');

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
      expect(row.source).toBe('auto');
    });

    it('PATCH templates mapped:true resolves the new mapping against existing defaults', async () => {
      const [garmentType] = await app.db
        .insert(schema.garmentSubcategories)
        .values({ genderSlug: 'women', slug: `new-mapping-${Date.now()}`, label: 'Shirt' })
        .returning();
      const [template] = await app.db
        .insert(schema.catalogueTemplates)
        .values({ genderSlug: 'women', label: 'New mapping template', sortOrder: 0 })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({
          label: 'New mapping pose',
          genderSlug: 'women',
          r2Key: `new-mapping-${Date.now()}.jpg`,
          thumbnailKey: 'new-mapping-thumb.jpg',
          scope: 'template',
          shotType: 'half',
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: 'New mapping background',
          r2Key: `new-mapping-bg-${Date.now()}.jpg`,
          thumbnailKey: 'new-mapping-bg-thumb.jpg',
          scope: 'template',
        })
        .returning();
      await app.db.insert(schema.catalogueTemplateLooks).values({
        templateId: template.id,
        poseAssetId: pose.id,
        backgroundId: background.id,
      });
      const workflow = await seedWorkflow('Half default for new mapping');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'half',
        workflowTemplateId: workflow.id,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/templates/${template.id}`,
        headers,
        payload: { mapped: true },
      });
      expect(res.statusCode).toBe(200);
      const { mappingId, resolvedCount } = res.json();
      expect(resolvedCount).toBe(1);

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(workflow.id);
    });

    it('PATCH per-pose workflow sets source to manual, protecting it from later auto-resolve', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const defaultWorkflow = await seedWorkflow('Should be ignored');
      const manualWorkflow = await seedWorkflow('Manual pick via route');

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: manualWorkflow.id },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json()).toMatchObject({
        workflowTemplateId: manualWorkflow.id,
        source: 'manual',
      });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.source).toBe('manual');

      // Setting the garment type's default afterwards must not override the manual pick.
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: defaultWorkflow.id,
      });
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/garment-types/${garmentType.id}/shot-type-workflows/full`,
        headers,
        payload: { workflowTemplateId: defaultWorkflow.id },
      });

      const [rowAfter] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(rowAfter.workflowTemplateId).toBe(manualWorkflow.id);
      expect(rowAfter.source).toBe('manual');
    });

    it('clearing a manual override falls back to the live category default', async () => {
      const { garmentType, mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const defaultWorkflow = await seedWorkflow('Fallback default');
      const manualWorkflow = await seedWorkflow('To be cleared');
      await app.db.insert(schema.garmentShotTypeWorkflows).values({
        garmentTypeId: garmentType.id,
        shotType: 'full',
        workflowTemplateId: defaultWorkflow.id,
      });
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: manualWorkflow.id },
      });

      const clearRes = await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: null },
      });
      expect(clearRes.statusCode).toBe(200);
      // The response reflects the row's actual resulting state (the live default it
      // just fell back to), not a blind echo of "cleared" — the admin UI depends on
      // this to avoid showing a stale "Workflow required" after a clear that instantly
      // repopulated a real workflow.
      expect(clearRes.json()).toMatchObject({
        workflowTemplateId: defaultWorkflow.id,
        source: 'auto',
      });

      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplatePoseWorkflows)
        .where(
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mapping.id),
            eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, pose.id),
          ),
        );
      expect(row.workflowTemplateId).toBe(defaultWorkflow.id);
      expect(row.source).toBe('auto');
    });

    it('GET poses-in-mapping surfaces source', async () => {
      const { mapping, pose } = await seedMappedPose({ shotType: 'full' });
      const workflow = await seedWorkflow('Source visibility check');
      await app.inject({
        method: 'PATCH',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses/${pose.id}`,
        headers,
        payload: { workflowTemplateId: workflow.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/admin/assets/catalogue-template-mappings/${mapping.id}/poses`,
        headers,
      });
      expect(res.json().items[0].source).toBe('manual');
    });
  });

  it('POST pose-assets persists shotType', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/pose-assets',
      headers,
      payload: {
        label: 'Shot type creation test',
        r2Key: `shot-type-create-${Date.now()}.jpg`,
        thumbnailKey: `shot-type-create-thumb-${Date.now()}.jpg`,
        genderSlug: 'women',
        scope: 'template',
        shotType: 'closeup',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shotType).toBe('closeup');

    const [row] = await app.db
      .select({ shotType: schema.modelPoseAssets.shotType })
      .from(schema.modelPoseAssets)
      .where(eq(schema.modelPoseAssets.id, res.json().id));
    expect(row.shotType).toBe('closeup');
  });

  it('GET pose-assets returns shotType for an already-tagged pose', async () => {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Already tagged pose',
        genderSlug: 'women',
        r2Key: `already-tagged-${Date.now()}.jpg`,
        thumbnailKey: 'already-tagged-thumb.jpg',
        scope: 'template',
        shotType: 'half',
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: '/admin/assets/pose-assets?scope=all',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const found = res.json().items.find((i: { id: string }) => i.id === pose.id);
    expect(found.shotType).toBe('half');
  });
});
