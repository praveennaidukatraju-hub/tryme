import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('garment-types sortOrder', () => {
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

  async function seedGarmentTypes(gender: string) {
    const slugPrefix = `sort-${Date.now()}`;
    const rows = await app.db
      .insert(schema.garmentSubcategories)
      .values([
        { genderSlug: gender, slug: `${slugPrefix}-c`, label: 'C Type', sortOrder: 2 },
        { genderSlug: gender, slug: `${slugPrefix}-a`, label: 'A Type', sortOrder: 0 },
        { genderSlug: gender, slug: `${slugPrefix}-b`, label: 'B Type', sortOrder: 1 },
      ])
      .returning();
    return rows;
  }

  async function loginToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'T', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('GET /v1/models/garment-types returns items ordered by sortOrder', async () => {
    const seeded = await seedGarmentTypes('men');
    const token = await loginToken(`sort-customer-${Date.now()}@x.com`);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/garment-types?gender=men',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = seeded.map((r) => r.id);
    const returned = (res.json().items as Array<{ id: string }>)
      .map((i) => i.id)
      .filter((id) => ids.includes(id));
    expect(returned).toEqual([seeded[1]!.id, seeded[2]!.id, seeded[0]!.id]);
  });

  it('GET /admin/assets/garment-types returns items ordered by sortOrder', async () => {
    const seeded = await seedGarmentTypes('women');
    const headers = await adminAuthHeader(app, 'SUPER_ADMIN');

    const res = await app.inject({
      method: 'GET',
      url: '/admin/assets/garment-types',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = seeded.map((r) => r.id);
    const returned = (res.json().items as Array<{ id: string }>)
      .map((i) => i.id)
      .filter((id) => ids.includes(id));
    expect(returned).toEqual([seeded[1]!.id, seeded[2]!.id, seeded[0]!.id]);
  });
});
