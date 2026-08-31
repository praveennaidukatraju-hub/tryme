import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

// Regression test: /v1/models/garment-types is used by both the regular Studio
// wizard (requireUser) and the Try On Library mini-app's Add Subcategory modal
// (catalog-app token). It was briefly guarded by plain requireUser only, which
// rejects catalog-app tokens (see apps/api/src/plugins/auth.ts), silently
// breaking the mini-app's garment-type dropdown. Kept in its own file so its
// login call doesn't push catalog-app-auth.test.ts over the login rate limit.
describe('garment-types — catalog-app access', () => {
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

  it('a catalog-app token can load garment types (shared reference data, no per-user filtering)', async () => {
    const { userId } = await createTestMerchant(app);
    const passwordHash = await hashPassword('password123');
    await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    const { accessToken } = loginRes.json() as { accessToken: string };

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/garment-types?gender=men',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
