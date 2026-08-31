import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('GET /v1/catalogues surfaces garmentType', () => {
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

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  it('returns the garment subcategory label when job_inputs.garmentTypeId is set', async () => {
    const { token, userId } = await registerUser('garment-type-catalogues@x.com');

    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: 'kurta-test', label: 'Kurta' })
      .returning();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', priority: false, creditsCharged: 0 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/x/garment.jpg',
      garmentTypeId: garmentType.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ catalogueId: string; garmentType: string | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.garmentType).toBe('Kurta');
  });

  it('returns null garmentType when job_inputs.garmentTypeId is not set', async () => {
    const { token, userId } = await registerUser('garment-type-null-catalogues@x.com');

    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', priority: false, creditsCharged: 0 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/x/garment.jpg',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ catalogueId: string; garmentType: string | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.garmentType).toBeNull();
  });
});
