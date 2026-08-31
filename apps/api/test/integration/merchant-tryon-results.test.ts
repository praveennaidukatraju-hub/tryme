import { randomUUID } from 'node:crypto';
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

async function seedJob(app: TestApp, merchantId: string, userId: string) {
  const [job] = await app.db
    .insert(schema.jobs)
    .values({ id: randomUUID(), userId, merchantId, status: 'COMPLETED', creditsCharged: 0 })
    .returning();
  return job;
}

describe('merchant try-on result like/cart', () => {
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

  it('likes and unlikes a job, is idempotent, and is scoped to the owning merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'like-a@example.com');
    const auth = await authHeader(merchantUser.id);
    const job = await seedJob(app, merchant.id, merchantUser.id);

    const liked = await app.inject({
      method: 'PUT',
      url: `/v1/merchant/tryon/jobs/${job.id}/like`,
      headers: auth,
    });
    expect(liked.statusCode).toBe(204);
    const likedAgain = await app.inject({
      method: 'PUT',
      url: `/v1/merchant/tryon/jobs/${job.id}/like`,
      headers: auth,
    });
    expect(likedAgain.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${job.id}`,
      headers: auth,
    });
    expect((status.json() as { liked: boolean }).liked).toBe(true);

    const unliked = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${job.id}/like`,
      headers: auth,
    });
    expect(unliked.statusCode).toBe(204);

    const otherAuth = await authHeader(
      (await createMerchant(app, 'like-b@example.com')).merchantUser.id,
    );
    const crossMerchant = await app.inject({
      method: 'PUT',
      url: `/v1/merchant/tryon/jobs/${job.id}/like`,
      headers: otherAuth,
    });
    expect(crossMerchant.statusCode).toBe(404);
  });

  it('adds and removes a job from cart', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'cart-a@example.com');
    const auth = await authHeader(merchantUser.id);
    const job = await seedJob(app, merchant.id, merchantUser.id);

    const added = await app.inject({
      method: 'PUT',
      url: `/v1/merchant/tryon/jobs/${job.id}/cart`,
      headers: auth,
    });
    expect(added.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${job.id}`,
      headers: auth,
    });
    expect((status.json() as { inCart: boolean }).inCart).toBe(true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${job.id}/cart`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
  });
});
