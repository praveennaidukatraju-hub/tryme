import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { createSessionTokens } from '../../src/modules/auth/tokens.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('/v1/me email completion', () => {
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

  async function seedUsernameOnlyUser(username: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        username,
        passwordHash,
        displayName: 'Test',
        email: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    let refreshPlain = '';
    const reply = {
      setCookie(name: string, value: string) {
        if (name === 'refresh') refreshPlain = value;
      },
      code() {
        return reply;
      },
    } as const;
    const { accessToken } = await createSessionTokens(app, user.id, reply as never, 200);
    return { userId: user.id, accessToken, refreshPlain };
  }

  it('accepts email on PATCH /v1/me and rejects a duplicate', async () => {
    const { accessToken } = await seedUsernameOnlyUser(`emailtest${Date.now()}`);
    const email = `newemail${Date.now()}@example.com`;

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(email);

    const { accessToken: token2 } = await seedUsernameOnlyUser(`emailtest2${Date.now()}`);
    const dupeRes = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token2}` },
      payload: { email },
    });
    expect(dupeRes.statusCode).toBe(409);
  });

  it('only grants free credits once both phone and email are set', async () => {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug: 'free', name: 'free', credits: 50, basePaise: 0 })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { credits: 50 } });

    const { userId, accessToken } = await seedUsernameOnlyUser(`credittest${Date.now()}`);

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543210' },
    });
    let [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(0);

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: `credittest${Date.now()}@example.com` },
    });
    [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(50);
  });
});
