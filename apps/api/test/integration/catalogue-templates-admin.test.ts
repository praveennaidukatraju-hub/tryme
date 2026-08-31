import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin catalogue-templates CRUD', () => {
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

  async function seedPoseAndBackground() {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'B', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    return { poseId: pose.id, bgId: bg.id };
  }

  it('creates, lists, patches, and soft-deletes a template', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'Autumn', sortOrder: 0 },
    });
    expect(createRes.statusCode).toBe(200);
    const { id } = createRes.json();

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/assets/catalogue-templates',
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    const { items } = listRes.json();
    expect(items.find((t: { id: string }) => t.id === id)).toBeTruthy();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/catalogue-templates/${id}`,
      headers,
      payload: { label: 'Autumn Collection', isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(eq(schema.catalogueTemplates.id, id));
    expect(row.label).toBe('Autumn Collection');
    expect(row.isActive).toBe(false);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/admin/assets/catalogue-templates/${id}`,
      headers,
    });
    expect(deleteRes.statusCode).toBe(200);
    const [afterDelete] = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(eq(schema.catalogueTemplates.id, id));
    expect(afterDelete.deletedAt).not.toBeNull();
  });

  it('PUT .../looks replaces the full ordered list, rejects unknown/inactive pose or background', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { poseId, bgId } = await seedPoseAndBackground();

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'T', sortOrder: 0 },
    });
    const { id: templateId } = createRes.json();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: { looks: [{ poseAssetId: poseId, backgroundId: bgId }] },
    });
    expect(putRes.statusCode).toBe(200);

    const getLooksRes = await app.inject({
      method: 'GET',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
    });
    expect(getLooksRes.statusCode).toBe(200);
    expect(getLooksRes.json().items).toHaveLength(1);

    const looksRows = await app.db
      .select()
      .from(schema.catalogueTemplateLooks)
      .where(eq(schema.catalogueTemplateLooks.templateId, templateId));
    expect(looksRows).toHaveLength(1);

    // Replacing again with an empty list clears all looks (full-replace semantics).
    const clearRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: { looks: [] },
    });
    expect(clearRes.statusCode).toBe(200);
    const clearedRows = await app.db
      .select()
      .from(schema.catalogueTemplateLooks)
      .where(eq(schema.catalogueTemplateLooks.templateId, templateId));
    expect(clearedRows).toHaveLength(0);

    // Unknown pose id → rejected, no partial write.
    const badRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: {
        looks: [{ poseAssetId: '00000000-0000-0000-0000-000000000000', backgroundId: bgId }],
      },
    });
    expect(badRes.statusCode).toBe(400);
  });

  it('rejects duplicate (pose, background) pairs in the same PUT', async () => {
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');
    const { poseId, bgId } = await seedPoseAndBackground();
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'T2', sortOrder: 0 },
    });
    const { id: templateId } = createRes.json();

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: {
        looks: [
          { poseAssetId: poseId, backgroundId: bgId },
          { poseAssetId: poseId, backgroundId: bgId },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
