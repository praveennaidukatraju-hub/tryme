import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Derived, never stored. The Android app branches on this at login:
 * ONBOARDING_REQUIRED -> show the onboarding form (no merchants row yet),
 * PENDING_ACTIVATION  -> show a blocking "awaiting activation" screen,
 * ACTIVE              -> proceed to Home.
 * Without it a user with no merchant profile logs in fine and then 403s on
 * every single requireMerchant call with no way to explain why.
 */
export type MerchantStatus = 'ONBOARDING_REQUIRED' | 'PENDING_ACTIVATION' | 'ACTIVE';

export async function resolveMerchantStatus(
  app: FastifyInstance,
  userId: string,
): Promise<MerchantStatus> {
  const [row] = await app.db
    .select({ isActive: schema.merchants.isActive })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, userId))
    .limit(1);
  if (!row) return 'ONBOARDING_REQUIRED';
  return row.isActive ? 'ACTIVE' : 'PENDING_ACTIVATION';
}
