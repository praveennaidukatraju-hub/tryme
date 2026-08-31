import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

const PASSWORD = 'Passw0rdTest';

async function createPasswordUser() {
  const email = `dev-${randomUUID()}@example.com`;
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email,
      displayName: 'Device User',
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { email, userId: user.id };
}

async function login(email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/device-login',
    payload: { email, password: PASSWORD, deviceId: randomUUID(), platform: 'mobile' },
  });
}

describe('device-login merchantStatus', () => {
  it('reports ONBOARDING_REQUIRED for a user with no merchant profile', async () => {
    const { email } = await createPasswordUser();
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('ONBOARDING_REQUIRED');
  });

  it('reports ACTIVE for an active merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const email = `active-${randomUUID()}@example.com`;
    await app.db
      .update(schema.users)
      .set({ email, passwordHash: await hashPassword(PASSWORD) })
      .where(eq(schema.users.id, merchant.userId));

    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('ACTIVE');
  });

  it('reports PENDING_ACTIVATION for an inactive merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: false });
    const email = `pending-${randomUUID()}@example.com`;
    await app.db
      .update(schema.users)
      .set({ email, passwordHash: await hashPassword(PASSWORD) })
      .where(eq(schema.users.id, merchant.userId));

    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('PENDING_ACTIVATION');
  });
});
