import { schema } from '@tryme/db';
import { hashPassword, signAccess } from '../../src/modules/auth/service.js';
import type { TestApp } from './api.js';

let counter = 0;

/**
 * Creates a verified user + admin_users row directly in the DB (mirroring the real
 * shapes `/v1/auth/register` and the admin-request approval flow produce in
 * src/modules/admin/users.routes.ts), then mints an admin-audience access token via
 * `signAccess` directly — the same call `/admin/auth/login`
 * (src/modules/admin/auth.routes.ts) makes internally.
 *
 * Deliberately bypasses both HTTP endpoints rather than calling them via app.inject:
 * this helper is used across dozens of admin test calls in the same suite run, and
 * both routes carry tight per-route rate limits (register: 10/min, admin login:
 * 5/min) backed by the same Redis instance shared across every test file with no
 * reset in between — enough admin tests clustering in one rolling minute trips a
 * 429, which surfaced as "registered user not found" once the register call itself
 * got rate-limited. Direct DB/JWT construction has no such ceiling.
 */
export async function adminAuthHeader(
  app: TestApp,
  role: 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT' | 'ADMIN' = 'SUPER_ADMIN',
): Promise<Record<string, string>> {
  const email = `admin-auth-${Date.now()}-${counter++}@x.com`;
  const passwordHash = await hashPassword('password123');

  const [user] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash, displayName: 'Test Admin', emailVerified: true })
    .returning();
  if (!user) throw new Error('adminAuthHeader: failed to create test user');

  await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });

  await app.db.insert(schema.adminUsers).values({
    userId: user.id,
    role,
    status: 'active',
    passwordHash,
  });

  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const accessToken = await signAccess(
    secret,
    user.id,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'admin',
  );

  return { authorization: `Bearer ${accessToken}` };
}
