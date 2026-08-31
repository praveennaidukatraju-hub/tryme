import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('GET /v1/merchant/me', () => {
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

  it("returns the merchant's display name, email, credit balance, and lifetime usage", async () => {
    const { userId } = await createTestMerchant(app, { balance: 250 });
    await app.db
      .update(schema.users)
      .set({ displayName: 'Store Owner' })
      .where(eq(schema.users.id, userId));
    // Two debits and a credit — `used` must sum only the debits (150), not net
    // against the grant, and must ignore the positive entry entirely.
    await app.db.insert(schema.creditLedger).values([
      { userId, delta: -100, reason: 'JOB_DEBIT' },
      { userId, delta: -50, reason: 'JOB_DEBIT' },
      { userId, delta: 400, reason: 'ADMIN_GRANT' },
    ]);
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const token = await signAccess(secret, userId, { kind: 'access' }, '15m');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      displayName: string | null;
      email: string | null;
      balance: number;
      used: number;
    };
    expect(body.displayName).toBe('Store Owner');
    expect(body.balance).toBe(250);
    expect(body.used).toBe(150);
  });

  it('rejects a non-merchant account', async () => {
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `plain${Date.now()}@example.com`, emailVerified: true, tier: 'free' })
      .returning();
    const token = await signAccess(secret, user?.id ?? '', { kind: 'access' }, '15m');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
