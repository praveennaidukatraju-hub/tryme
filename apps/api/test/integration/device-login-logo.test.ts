import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('device-login logoUrl', () => {
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

  async function setPassword(userId: string, password: string) {
    const passwordHash = await hashPassword(password);
    await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  it('returns the merchant logo URL when one is configured', async () => {
    const { merchantId, userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    await app.db
      .update(schema.merchants)
      .set({ logoKey: `merchant-logo/${merchantId}/logo.jpg` })
      .where(eq(schema.merchants.id, merchantId));
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login',
      payload: {
        email: user?.email,
        password: 'password123',
        deviceId: 'device-1',
        deviceName: 'Test Device',
        platform: 'mobile',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBeTruthy();
  });

  it('returns null when the merchant has no logo configured', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login',
      payload: {
        email: user?.email,
        password: 'password123',
        deviceId: 'device-2',
        deviceName: 'Test Device',
        platform: 'mobile',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBeNull();
  });
});
