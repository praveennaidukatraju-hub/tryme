import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin sample videos CRUD', () => {
  let c: Containers;
  let app: TestApp;
  let adminAuth: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    adminAuth = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('presign -> confirm -> list -> patch -> delete', async () => {
    const presignRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/sample-videos/presign',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        videoContentType: 'video/mp4',
        thumbnailContentType: 'image/gif',
      }),
    });
    expect(presignRes.statusCode).toBe(200);
    const presign = presignRes.json();
    expect(presign.videoUploadUrl).toBeTruthy();
    expect(presign.thumbnailUploadUrl).toBeTruthy();
    expect(presign.videoR2Key).toMatch(/^sample-videos\/.+\.mp4$/);
    expect(presign.thumbnailR2Key).toMatch(/^sample-videos\/.+\.thumb\.gif$/);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/sample-videos',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        title: 'Slow turn',
        videoR2Key: presign.videoR2Key,
        thumbnailR2Key: presign.thumbnailR2Key,
        prompt: 'model turns slowly to show the garment from all angles',
        sortOrder: 1,
      }),
    });
    expect(confirmRes.statusCode).toBe(200);
    const created = confirmRes.json();
    expect(created.id).toBeTruthy();
    expect(created.isActive).toBe(true);
    expect(created.videoUrl).toContain('X-Amz-Signature');
    expect(created.thumbnailUrl).toContain('X-Amz-Signature');

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/assets/sample-videos',
      headers: adminAuth,
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json().items as Array<{
      id: string;
      videoUrl: string;
      thumbnailUrl: string;
    }>;
    const listedCreated = listed.find((row) => row.id === created.id);
    expect(listedCreated).toBeDefined();
    expect(listedCreated?.videoUrl).toContain('X-Amz-Signature');
    expect(listedCreated?.thumbnailUrl).toContain('X-Amz-Signature');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/sample-videos/${created.id}`,
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ isActive: false }),
    });
    expect(patchRes.statusCode).toBe(200);
    const [afterPatch] = await app.db
      .select()
      .from(schema.sampleVideos)
      .where(eq(schema.sampleVideos.id, created.id));
    expect(afterPatch.isActive).toBe(false);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/admin/assets/sample-videos/${created.id}`,
      headers: adminAuth,
    });
    expect(deleteRes.statusCode).toBe(200);
    const [afterDelete] = await app.db
      .select()
      .from(schema.sampleVideos)
      .where(eq(schema.sampleVideos.id, created.id));
    expect(afterDelete.deletedAt).not.toBeNull();

    const listRes2 = await app.inject({
      method: 'GET',
      url: '/admin/assets/sample-videos',
      headers: adminAuth,
    });
    expect(listRes2.json().items.map((r: { id: string }) => r.id)).not.toContain(created.id);
  });

  it('rejects non-mp4 content type on presign', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/assets/sample-videos/presign',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        videoContentType: 'video/webm',
        thumbnailContentType: 'image/gif',
      }),
    });
    expect(res.statusCode).toBe(400);
  });
});
