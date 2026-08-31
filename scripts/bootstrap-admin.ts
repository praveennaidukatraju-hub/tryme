import { createDb, schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../apps/api/src/modules/auth/service';

const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
if (!email || !password) {
  console.log('no bootstrap admin env; skipping');
  process.exit(0);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('no DATABASE_URL; skipping');
  process.exit(0);
}
const { db, close } = createDb(databaseUrl);

const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
let userId = existing?.id;
if (!existing) {
  const [u] = await db
    .insert(schema.users)
    .values({ email, passwordHash: await hashPassword(password) })
    .returning();
  if (!u) throw new Error('user insert returned no row');
  await db.insert(schema.userCredits).values({ userId: u.id, balance: 0 });
  userId = u.id;
}
if (!userId) throw new Error('unreachable: userId must be set by now');
const [adm] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.userId, userId));
if (!adm) await db.insert(schema.adminUsers).values({ userId, role: 'SUPER_ADMIN' });
await close();
console.log('admin bootstrap complete:', email);
