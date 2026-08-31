import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('uploads', () => {
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
      payload: { displayName: 'Upload User', email: 'upload@x.com', password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'upload@x.com'));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'upload@x.com', password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('POST /v1/uploads/presign returns presigned URL with 30min expiry', async () => {
    const token = await getToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploadUrl).toContain('http');
    expect(body.r2Key).toMatch(/^inputs\/[a-f0-9-]+\/garment\.jpg$/);
    expect(body.expiresIn).toBe(1800);
  });

  it('a garment upload above the admin-configured limit is rejected once ownership is checked', async () => {
    const token = await getToken();
    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { webGarmentMaxBytes: 1024 } }),
    );
    try {
      const presign = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: `Bearer ${token}` },
        payload: { contentType: 'image/jpeg', contentLength: 2048 },
      });
      expect(presign.statusCode).toBe(200);
      const { r2Key } = presign.json() as { r2Key: string };
      await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

      const { assertGarmentObjectValid } = await import('../../src/lib/upload-ownership.js');
      await expect(assertGarmentObjectValid(app, r2Key)).rejects.toThrow(/exceeds size limit/);
    } finally {
      await app.redis.del('config:system');
    }
  });
});
