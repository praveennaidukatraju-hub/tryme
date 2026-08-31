import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinnedFetch } from '../../src/lib/pinned-fetch.js';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

vi.mock('../../src/lib/pinned-fetch.js', () => ({ pinnedFetch: vi.fn() }));

describe('POST /v1/backgrounds/mine/from-url', () => {
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
  afterEach(() => {
    vi.mocked(pinnedFetch).mockReset();
  });

  async function getToken(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    return signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
  }

  it('fetches a public-IP image URL, stores it as scope=user, and returns the item', async () => {
    const token = await getToken('bgfromurl1@x.com');
    const fixture = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    vi.mocked(pinnedFetch).mockResolvedValue(
      new Response(fixture, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(fixture.length) },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/photo.jpg' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.thumbnailUrl).toContain('http');

    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, body.id));
    expect(row?.scope).toBe('user');
  });

  it('rejects a URL resolving to a private/loopback address without calling fetch', async () => {
    const token = await getToken('bgfromurl2@x.com');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://127.0.0.1/x.jpg' },
    });
    expect(res.statusCode).toBe(400);
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-image content-type', async () => {
    const token = await getToken('bgfromurl3@x.com');
    vi.mocked(pinnedFetch).mockResolvedValue(
      new Response('not an image', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/notanimage' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized image via content-length', async () => {
    const token = await getToken('bgfromurl4@x.com');
    vi.mocked(pinnedFetch).mockResolvedValue(
      new Response(new Uint8Array(10), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(20 * 1024 * 1024),
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/big.jpg' },
    });
    expect(res.statusCode).toBe(413);
  });
});
