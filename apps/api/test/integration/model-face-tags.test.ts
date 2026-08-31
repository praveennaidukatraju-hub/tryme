import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('model face tags (admin)', () => {
  let containers: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
    headers = await adminAuthHeader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  it('stores tags on confirm and updates them via PATCH', async () => {
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/faces/confirm',
      headers,
      payload: {
        label: 'Tagged Face',
        gender: 'men',
        r2Key: 'test/face.jpg',
        thumbnailKey: 'test/face.thumb.jpg',
        sortOrder: 0,
        tags: ['warm tone', 'closeup'],
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    const created = confirmRes.json();
    expect(created.tags).toEqual(['warm tone', 'closeup']);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/faces/${created.id}`,
      headers,
      payload: { tags: ['studio'] },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ tags: schema.modelFaces.tags })
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, created.id));
    expect(row?.tags).toEqual(['studio']);
  });

  it('defaults tags to an empty array when omitted on confirm', async () => {
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/faces/confirm',
      headers,
      payload: {
        label: 'Untagged Face',
        gender: 'women',
        r2Key: 'test/face2.jpg',
        thumbnailKey: 'test/face2.thumb.jpg',
        sortOrder: 0,
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().tags).toEqual([]);
  });
});
