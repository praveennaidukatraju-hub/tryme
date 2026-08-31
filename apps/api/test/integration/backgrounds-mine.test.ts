import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('/v1/backgrounds/mine', () => {
  let c: Containers;
  let app: TestApp;
  let validJpeg: Buffer;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    validJpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg()
      .toBuffer();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function getToken(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  it('presign -> confirm creates a scope=user row visible only via /mine', async () => {
    const { token, userId } = await getToken('bgmine1@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(presign.statusCode).toBe(200);
    const { r2Key } = presign.json() as { r2Key: string };
    expect(r2Key).toBe(`user-backgrounds/${userId}/${r2Key.split('/')[2]}`);
    await app.storage.putObject(r2Key, validJpeg, 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { r2Key, label: 'Beach' },
    });
    expect(confirm.statusCode).toBe(200);
    const created = confirm.json();
    expect(created.id).toBeTruthy();
    expect(created.thumbnailUrl).toContain('http');

    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, created.id));
    expect(row?.scope).toBe('user');
    expect(row?.userId).toBe(userId);
    expect(row?.label).toBe('Beach');

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/backgrounds/mine',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mine.json().items.map((i: { id: string }) => i.id)).toContain(created.id);

    const general = await app.inject({
      method: 'GET',
      url: '/v1/models/backgrounds?gender=women',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(general.json().items.map((i: { id: string }) => i.id)).not.toContain(created.id);
  });

  it('confirm rejects an r2Key not owned by the caller', async () => {
    const { token: tokenA } = await getToken('bgmine2a@x.com');
    const { token: tokenB } = await getToken('bgmine2b@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    await app.storage.putObject(r2Key, validJpeg, 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { r2Key },
    });
    expect(confirm.statusCode).toBe(403);
  });

  it('owner can delete; a different user gets 404; deleted row disappears from /mine', async () => {
    const { token: tokenA } = await getToken('bgmine3a@x.com');
    const { token: tokenB } = await getToken('bgmine3b@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    await app.storage.putObject(r2Key, validJpeg, 'image/jpeg');
    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { r2Key },
    });
    const { id } = confirm.json();

    const deleteAsB = await app.inject({
      method: 'DELETE',
      url: `/v1/backgrounds/mine/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(deleteAsB.statusCode).toBe(404);

    const deleteAsA = await app.inject({
      method: 'DELETE',
      url: `/v1/backgrounds/mine/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(deleteAsA.statusCode).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/backgrounds/mine',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(mine.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
  });

  it('confirm rejects an uploaded object larger than the 10MB cap', async () => {
    const { token, userId } = await getToken('bgmine4@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    expect(r2Key).toBe(`user-backgrounds/${userId}/${r2Key.split('/')[2]}`);

    // The presigned PUT never enforces contentLength at R2 (see r2.ts presignPut), so a caller
    // can upload far more than they declared. Simulate that by putting an object over the 10MB
    // cap directly, then confirming it should be rejected before ever being buffered by getObject.
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
    await app.storage.putObject(r2Key, oversized, 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { r2Key },
    });
    expect(confirm.statusCode).toBe(400);
  });

  it('confirm normalizes a non-JPEG upload (real PNG bytes presigned as image/jpeg) to real JPEG', async () => {
    const { token, userId } = await getToken('bgmine5@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    expect(r2Key).toBe(`user-backgrounds/${userId}/${r2Key.split('/')[2]}`);

    // A presigned PUT signs the Content-Type header, not the payload bytes, so the caller can
    // upload real PNG bytes under a key that presigned as image/jpeg. `confirm` must sniff the
    // actual format and normalize it to real JPEG, matching what `from-url` already does.
    const pngBuf = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await app.storage.putObject(r2Key, pngBuf, 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { r2Key, label: 'Normalized PNG' },
    });
    expect(confirm.statusCode).toBe(200);
    const created = confirm.json();

    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, created.id));
    if (!row) throw new Error('background row not found');
    expect(row.r2Key).toBe(r2Key);

    const stored = await app.storage.getObject(row.r2Key);
    const storedMeta = await sharp(stored).metadata();
    expect(storedMeta.format).toBe('jpeg');
  });
});
