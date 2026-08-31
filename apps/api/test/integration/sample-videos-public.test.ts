import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('GET /v1/models/sample-videos', () => {
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
  async function authHeader() {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `svpub-${Date.now()}@x.com`, emailVerified: true })
      .returning();
    const token = await signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      user.id,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
    );
    return { authorization: `Bearer ${token}` };
  }
  it('returns only active, non-deleted sample videos ordered by sortOrder', async () => {
    const [active1] = await app.db
      .insert(schema.sampleVideos)
      .values({
        title: 'B',
        videoR2Key: 'sample-videos/a.mp4',
        thumbnailR2Key: 'sample-videos/a.thumb.jpg',
        prompt: 'p',
        sortOrder: 2,
      })
      .returning();
    const [active2] = await app.db
      .insert(schema.sampleVideos)
      .values({
        title: 'A',
        videoR2Key: 'sample-videos/b.mp4',
        thumbnailR2Key: 'sample-videos/b.thumb.jpg',
        prompt: 'p',
        sortOrder: 1,
      })
      .returning();
    await app.db.insert(schema.sampleVideos).values({
      title: 'Inactive',
      videoR2Key: 'sample-videos/c.mp4',
      thumbnailR2Key: 'sample-videos/c.thumb.jpg',
      prompt: 'p',
      isActive: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/sample-videos',
      headers: await authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.creditCost).toBe(150);
    const items = body.items as Array<{
      id: string;
      thumbnailUrl: string;
      previewVideoUrl: string;
    }>;
    expect(items.map((i) => i.id)).toEqual([active2.id, active1.id]);
    expect(items[0].thumbnailUrl).toContain('sample-videos/b.thumb.jpg');
    expect(items[0].previewVideoUrl).toContain('sample-videos/b.mp4');
    expect(items[0].thumbnailUrl).toContain('X-Amz-Signature');
    expect(items[0].previewVideoUrl).toContain('X-Amz-Signature');
  });
});
