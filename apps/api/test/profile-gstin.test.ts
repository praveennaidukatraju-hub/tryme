import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api';
import { type Containers, startContainers } from './helpers/containers';

describe('profile GSTIN', () => {
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

  async function registerAndLogin(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '127.0.0.10',
      payload: { displayName: 'GSTIN User', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '127.0.0.10',
      payload: { email, password: 'password123' },
    });
    return loginRes.json().accessToken as string;
  }

  it('saves and returns a valid GSTIN', async () => {
    const token = await registerAndLogin('gstin-valid@x.com');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '27AAPFU0939F1ZV' },
    });
    expect(patchRes.statusCode).toBe(200);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().gstin).toBe('27AAPFU0939F1ZV');
  });

  it('rejects a malformed GSTIN with 400', async () => {
    const token = await registerAndLogin('gstin-invalid@x.com');

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: 'not-a-gstin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows clearing a previously-set GSTIN with an empty string', async () => {
    const token = await registerAndLogin('gstin-clear@x.com');
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '27AAPFU0939F1ZV' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { gstin: '' },
    });
    expect(res.statusCode).toBe(200);

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.json().gstin).toBeNull();
  });
});
