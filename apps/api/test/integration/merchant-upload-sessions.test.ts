import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

describe('merchant upload sessions (merchant-authed side)', () => {
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

  it('creates a session, reports pending status, and 404s for a wrong merchant', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-a@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    expect(created.statusCode).toBe(201);
    const { token, qrUrl } = created.json() as { token: string; qrUrl: string };
    expect(qrUrl).toContain(`/kiosk-upload/${token}`);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { status: string; r2Key: string | null }).status).toBe('pending');
    expect((status.json() as { status: string; r2Key: string | null }).r2Key).toBeNull();

    const otherAuth = await authHeader(
      (await createMerchant(app, 'upload-b@example.com')).merchantUser.id,
    );
    const crossMerchant = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: otherAuth,
    });
    expect(crossMerchant.statusCode).toBe(404);
  });

  it('closing a session makes it unreachable afterwards', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-c@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    const { token } = created.json() as { token: string };

    const closed = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(closed.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(404);
  });
  it('supports the public presign/complete flow and verifies the object exists', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-d@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    const { token } = created.json() as { token: string };

    const presigned = await app.inject({
      method: 'POST',
      url: `/v1/kiosk-upload-sessions/${token}/presign`,
      payload: { contentType: 'image/jpeg', contentLength: 5 },
    });
    expect(presigned.statusCode).toBe(200);
    expect(typeof (presigned.json() as { uploadUrl: string }).uploadUrl).toBe('string');

    const complete = await app.inject({
      method: 'POST',
      url: `/v1/kiosk-upload-sessions/${token}/complete`,
    });
    expect(complete.statusCode).toBe(400);
    expect((complete.json() as { error: { code: string } }).error.code).toBe('BAD_UPLOAD');
  });

  it('rejects public presign and complete for an unknown token', async () => {
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/kiosk-upload-sessions/does-not-exist/presign',
      payload: { contentType: 'image/jpeg', contentLength: 5 },
    });
    expect(presigned.statusCode).toBe(404);

    const completed = await app.inject({
      method: 'POST',
      url: '/v1/kiosk-upload-sessions/does-not-exist/complete',
    });
    expect(completed.statusCode).toBe(404);
  });
});
