import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { signAccess } from '../../src/modules/auth/service';
import type { TestApp } from './api';

export async function createVerifiedUserToken(app: TestApp, email: string) {
  let [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));

  if (!user) {
    [user] = await app.db
      .insert(schema.users)
      .values({ email, displayName: 'Test', emailVerified: true })
      .returning();
  } else if (!user.emailVerified) {
    [user] = await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id))
      .returning();
  }

  if (!user) {
    throw new Error(`test user ${email} was not created`);
  }

  const token = await signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    user.id,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'admin',
  );

  return { token, userId: user.id };
}
