import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('GET /v1/models/faces', () => {
  let containers: Containers;
  let app: TestApp;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  // Register + verify + login, returning an access token — same pattern as
  // apps/api/test/integration/catalogue-templates-public.test.ts's loginToken helper.
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

  it('includes tags in the response', async () => {
    await app.db.insert(schema.modelFaces).values({
      gender: 'men',
      label: 'Tagged Face',
      r2Key: 'test/face.jpg',
      thumbnailKey: 'test/face.thumb.jpg',
      tags: ['warm tone', 'closeup'],
    });

    const accessToken = await loginToken(`face-tags-${Date.now()}@x.com`);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/faces?gender=men',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { label: string; tags: string[] }[];
    const found = items.find((i) => i.label === 'Tagged Face');
    expect(found?.tags).toEqual(['warm tone', 'closeup']);
  });
});
