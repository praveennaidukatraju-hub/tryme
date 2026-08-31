import { setDefaultResultOrder } from 'node:dns';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { loadEnv } from './env.js';
import { hashPassword } from './modules/auth/service.js';
import { startUserLowCreditAlertScheduler } from './modules/credits/low-credit-alert-scheduler.js';
import { startAlertScheduler } from './modules/shopify/alert-scheduler.js';
import { startCollectionResyncScheduler } from './modules/shopify/collections-resync-scheduler.js';
import { startSyncConsumer } from './modules/shopify/sync-consumer.js';
import { startUploadSweeper } from './modules/uploads/sweeper.js';
import { buildServer } from './server.js';

// Containers here have no IPv6 route, but external hosts we call (Shopify's
// Fastly edge, R2/MinIO) resolve AAAA. Node's Happy-Eyeballs default races
// both families with only ~250ms before falling back to IPv4 — a window a
// dead IPv6 attempt can occasionally lose outright, surfacing as a spurious
// ETIMEDOUT on an otherwise-healthy outbound call. Forcing IPv4-first removes
// the race instead of racing a leg that can never win.
setDefaultResultOrder('ipv4first');

const env = loadEnv();
const app = await buildServer(env);
await app.listen({ port: env.API_PORT, host: '0.0.0.0' });

startSyncConsumer(app);
startCollectionResyncScheduler(app);
startUploadSweeper(app);
startAlertScheduler(app);
startUserLowCreditAlertScheduler(app);

if (env.ADMIN_BOOTSTRAP_EMAIL && env.ADMIN_BOOTSTRAP_PASSWORD) {
  const [existing] = await app.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, env.ADMIN_BOOTSTRAP_EMAIL));
  if (!existing) {
    const passwordHash = await hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD);
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: env.ADMIN_BOOTSTRAP_EMAIL,
        passwordHash,
        displayName: 'Admin',
        tier: 'free',
        emailVerified: true,
      })
      .returning();
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: user.id, role: 'SUPER_ADMIN', passwordHash });
    app.log.info({ email: env.ADMIN_BOOTSTRAP_EMAIL }, 'bootstrap admin created');
  } else {
    const [adminRow] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, existing.id));
    if (!adminRow) {
      await app.db.insert(schema.adminUsers).values({ userId: existing.id, role: 'SUPER_ADMIN' });
      app.log.info({ email: env.ADMIN_BOOTSTRAP_EMAIL }, 'bootstrap admin elevated');
    }
  }
}
