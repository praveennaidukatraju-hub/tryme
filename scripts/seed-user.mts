/**
 * Seed a regular catalogue-web user.
 * Usage:  tsx --env-file=.env scripts/seed-user.ts
 */
import { and, createDb, eq, schema } from '@tryme/db';
import { hashPassword } from '../apps/api/src/modules/auth/service.js';

const EMAIL = 'chand@gmail.com';
const PASSWORD = 'Chand@123';
const DISPLAY_NAME = 'Chand';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const { db, close } = createDb(databaseUrl);

// Check if user already exists
const [existing] = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.email, EMAIL));

if (existing) {
  console.log(`User already exists: ${EMAIL} (id: ${existing.id})`);
  console.log('Updating password...');
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD), emailVerified: true })
    .where(eq(schema.users.id, existing.id));
  console.log('Password updated.');
  await close();
  process.exit(0);
}

// Fetch free plan credits
const [freePlan] = await db
  .select({ credits: schema.creditPlans.credits })
  .from(schema.creditPlans)
  .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
const freeCredits = freePlan?.credits ?? 0;

// Insert user in a transaction
await db.transaction(async (tx) => {
  const [user] = await tx
    .insert(schema.users)
    .values({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      displayName: DISPLAY_NAME,
      companyName: null,
      emailVerified: true, // skip verification email
      tier: 'free',
    })
    .returning({ id: schema.users.id });

  if (!user) throw new Error('User insert returned no row');

  // Seed credits row
  await tx.insert(schema.userCredits).values({ userId: user.id, balance: freeCredits });

  if (freeCredits > 0) {
    await tx
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: freeCredits, reason: 'FREE_TRIAL' });
  }

  console.log(`✅  User created: ${EMAIL} (id: ${user.id}, credits: ${freeCredits})`);
});

await close();
