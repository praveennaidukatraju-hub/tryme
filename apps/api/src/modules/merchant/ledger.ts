import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../../lib/errors.js';
import { adminGrant, atomicDeduct, refund } from '../credits/ledger.js';

/**
 * A merchant is a tag on a user, not a separate financial entity: there is one
 * credit pool per human, keyed by `users.id`. These helpers keep their
 * merchantId-shaped signatures so call sites (android tryon job creation,
 * cancellation refunds, admin grants) stay unchanged, and resolve
 * the owning user here — the single place that mapping lives.
 */
export async function resolveMerchantUserId(db: DB, merchantId: string): Promise<string> {
  const [row] = await db
    .select({ userId: schema.merchants.userId })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId))
    .limit(1);
  // merchants.user_id is NOT NULL, so a missing userId means a missing merchant.
  // Throw rather than no-op: a charge that cannot be attributed must fail the
  // enclosing transaction, not silently succeed for free.
  if (!row?.userId) throw new AppError('NOT_FOUND', 404, 'merchant not found');
  return row.userId;
}

export async function atomicMerchantDeduct(
  db: DB,
  merchantId: string,
  amount: number,
  jobId: string,
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  return atomicDeduct(db, userId, amount, jobId);
}

export async function merchantRefund(
  db: DB,
  merchantId: string,
  amount: number,
  jobId: string,
  reason = 'REFUND',
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  await refund(db, userId, amount, jobId, reason);
}

export async function merchantAdminGrant(
  db: DB,
  merchantId: string,
  amount: number,
  reason: string,
  adminId: string,
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  await adminGrant(db, userId, amount, reason, adminId);
}
