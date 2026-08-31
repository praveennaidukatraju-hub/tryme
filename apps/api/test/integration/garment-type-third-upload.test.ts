import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('garment-type third-upload fields', () => {
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

  it('POST /admin/assets/garment-types persists requiresThirdUpload', async () => {
    const headers = await adminAuthHeader(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/garment-types',
      headers,
      payload: {
        genderSlug: 'women',
        slug: `third-upload-create-${Date.now()}`,
        label: 'Third Upload Create Test',
        requiresThirdUpload: true,
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, res.json().id));
    expect(row?.requiresThirdUpload).toBe(true);
  });

  it('PATCH /admin/assets/garment-types/:id persists requiresThirdUpload + thirdUploadLabel', async () => {
    const headers = await adminAuthHeader(app);
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `third-upload-patch-${Date.now()}`,
        label: 'Patch Test',
      })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${gt.id}`,
      headers,
      payload: { requiresThirdUpload: true, thirdUploadLabel: 'Upload Dupatta' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, gt.id));
    expect(row?.requiresThirdUpload).toBe(true);
    expect(row?.thirdUploadLabel).toBe('Upload Dupatta');
  });
});
