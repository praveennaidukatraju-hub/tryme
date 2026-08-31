import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('catalog', () => {
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

  async function getToken() {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Catalog User', email: 'catalog@x.com', password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'catalog@x.com'));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'catalog@x.com', password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('GET /v1/catalog/lower returns items for a pose whose lower role comes only from catalogue_template_pose_workflows', async () => {
    const token = await getToken();

    // A template-scoped pose with NO default workflowTemplateId of its own — its
    // only workflow role comes from the per-mapping assignment below, matching how
    // real catalogue-template poses work.
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Template-only pose',
        genderSlug: 'women',
        r2Key: 'template-pose.jpg',
        thumbnailKey: 'template-pose-thumb.jpg',
        scope: 'template',
      })
      .returning();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `catalog-lower-fix-${Date.now()}`,
        label: 'Catalog lower fix test workflow',
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
    const [template] = await app.db
      .insert(schema.catalogueTemplates)
      .values({ genderSlug: 'women', label: 'Catalog lower fix template' })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `catalog-lower-fix-${Date.now()}`,
        label: 'Catalog lower fix type',
      })
      .returning();
    const [mapping] = await app.db
      .insert(schema.catalogueTemplateSubcategories)
      .values({ templateId: template.id, subcategoryId: garmentType.id })
      .returning();
    await app.db.insert(schema.catalogueTemplatePoseWorkflows).values({
      mappingId: mapping.id,
      poseAssetId: pose.id,
      workflowTemplateId: workflow.id,
    });
    await app.db.insert(schema.catalogItems).values({
      type: 'lower',
      genderSlug: 'women',
      label: 'Template lower item',
      r2Key: 'lower-item.jpg',
      thumbnailKey: 'lower-item-thumb.jpg',
      isActive: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/catalog/lower?gender=women&poseIds=${pose.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tree: Array<{ items?: unknown[]; children?: { items?: unknown[] }[] }>;
    };
    const allItems = body.tree.flatMap((node) => [
      ...(node.items ?? []),
      ...(node.children ?? []).flatMap((c) => c.items ?? []),
    ]);
    expect(allItems.length).toBeGreaterThan(0);
  });
  it('GET /v1/catalog/lower keeps all active same-gender choices available after choosing a garment type', async () => {
    const token = await getToken();
    const unique = Date.now();
    const [workflow] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `catalog-all-options-${unique}`,
        label: 'Catalog all-options workflow',
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
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'All options pose',
        genderSlug: 'women',
        r2Key: `all-options-pose-${unique}.jpg`,
        thumbnailKey: `all-options-pose-${unique}-thumb.jpg`,
        workflowTemplateId: workflow.id,
      })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `catalog-all-options-${unique}`,
        label: 'All options garment type',
      })
      .returning();
    const [mappedItem, unlinkedItem] = await app.db
      .insert(schema.catalogItems)
      .values([
        {
          type: 'lower',
          genderSlug: 'women',
          label: `Mapped lower ${unique}`,
          r2Key: `mapped-lower-${unique}.jpg`,
          thumbnailKey: `mapped-lower-${unique}-thumb.jpg`,
          isActive: true,
        },
        {
          type: 'lower',
          genderSlug: 'women',
          label: `Unlinked lower ${unique}`,
          r2Key: `unlinked-lower-${unique}.jpg`,
          thumbnailKey: `unlinked-lower-${unique}-thumb.jpg`,
          isActive: true,
        },
      ])
      .returning();
    await app.db.insert(schema.catalogItemSubcategories).values({
      catalogItemId: mappedItem.id,
      subcategoryId: garmentType.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/catalog/lower?gender=women&poseIds=${pose.id}&garmentTypeId=${garmentType.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const serializedTree = JSON.stringify(res.json().tree);
    expect(serializedTree).toContain(mappedItem.label);
    expect(serializedTree).toContain(unlinkedItem.label);
  });
});
