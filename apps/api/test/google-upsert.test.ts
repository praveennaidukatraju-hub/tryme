import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFreeCredits, upsertGoogleUser } from '../src/modules/auth/google-upsert.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

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

function identity(over: Partial<{ sub: string; email: string; name: string }> = {}) {
  return {
    sub: over.sub ?? randomUUID(),
    email: over.email ?? `g-${randomUUID()}@example.com`,
    name: over.name ?? 'Google Person',
    picture: 'https://example.com/p.jpg',
  };
}

describe('upsertGoogleUser', () => {
  it('creates a passwordless verified user with a credits row, flagged as new', async () => {
    const g = identity();
    const { userId, isNewUser } = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));
    expect(isNewUser).toBe(true);

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.email).toBe(g.email);
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerified).toBe(true);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(0);
  });

  it('grants the free plan credits and writes a FREE_TRIAL ledger row', async () => {
    const { userId } = await app.db.transaction((tx) => upsertGoogleUser(tx, identity(), 25));
    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(25);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.reason).toBe('FREE_TRIAL');
  });

  it('returns the same user for a repeat login with the same provider id, no longer flagged as new', async () => {
    const g = identity();
    const first = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));
    expect(first.isNewUser).toBe(true);
    const second = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));
    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);

    const links = await app.db
      .select()
      .from(schema.oauthAccounts)
      .where(eq(schema.oauthAccounts.userId, first.userId));
    expect(links).toHaveLength(1);
  });

  it('links Google onto an existing password account with the same email, not flagged as new', async () => {
    const email = `existing-${randomUUID()}@example.com`;
    const [existing] = await app.db
      .insert(schema.users)
      .values({ email, displayName: 'Password User', passwordHash: 'x', emailVerified: false })
      .returning();

    const { userId, isNewUser } = await app.db.transaction((tx) =>
      upsertGoogleUser(tx, identity({ email }), 0),
    );

    expect(userId).toBe(existing?.id);
    expect(isNewUser).toBe(false);
    const [after] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(after?.emailVerified).toBe(true);
    expect(after?.passwordHash).toBe('x');
  });

  it('rejects a banned account', async () => {
    const email = `banned-${randomUUID()}@example.com`;
    await app.db
      .insert(schema.users)
      .values({ email, displayName: 'Banned', emailVerified: true, isBanned: true });

    await expect(
      app.db.transaction((tx) => upsertGoogleUser(tx, identity({ email }), 0)),
    ).rejects.toMatchObject({ code: 'BANNED', statusCode: 403 });
  });
});

describe('resolveFreeCredits', () => {
  it('returns 0 when no active free plan exists', async () => {
    await app.db
      .update(schema.creditPlans)
      .set({ isActive: false })
      .where(eq(schema.creditPlans.slug, 'free'));
    await expect(resolveFreeCredits(app.db)).resolves.toBe(0);
  });

  it('returns the active free plan credits', async () => {
    await app.db
      .insert(schema.creditPlans)
      .values({
        slug: 'free',
        name: 'Free',
        credits: 40,
        basePaise: 0,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: schema.creditPlans.slug,
        set: { credits: 40, isActive: true },
      });
    await expect(resolveFreeCredits(app.db)).resolves.toBe(40);
  });
});
