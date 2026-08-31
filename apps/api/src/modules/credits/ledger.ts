import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { creditsDeductedTotal, creditsRefundedTotal } from '@tryme/observability';
import { and, eq, gte, sql } from 'drizzle-orm';
import { AppError } from '../../lib/errors.js';

export async function atomicDeduct(db: DB, userId: string, amount: number, jobId: string) {
  const balance = await db.transaction(async (tx) => {
    const res = await tx
      .update(schema.userCredits)
      .set({ balance: sql`${schema.userCredits.balance} - ${amount}`, updatedAt: new Date() })
      .where(and(eq(schema.userCredits.userId, userId), gte(schema.userCredits.balance, amount)))
      .returning({ balance: schema.userCredits.balance });
    if (!res.length) throw new AppError('INSUFFICIENT_CREDITS', 402, 'insufficient credits');
    await tx
      .insert(schema.creditLedger)
      .values({ userId, delta: -amount, reason: 'JOB_DISPATCH', jobId });
    return res[0]?.balance;
  });
  creditsDeductedTotal.inc(amount);
  return balance;
}

export async function refund(
  db: DB,
  userId: string,
  amount: number,
  jobId: string,
  reason = 'REFUND',
) {
  const refunded = await db.transaction(async (tx) => {
    // Insert ledger row first — unique index on (job_id, reason) WHERE job_id IS NOT NULL
    // guarantees at-most-once without a racy SELECT check.
    const inserted = await tx
      .insert(schema.creditLedger)
      .values({ userId, delta: amount, reason, jobId })
      .onConflictDoNothing()
      .returning({ id: schema.creditLedger.id });
    if (!inserted.length) return false; // already refunded
    await tx
      .update(schema.userCredits)
      .set({ balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() })
      .where(eq(schema.userCredits.userId, userId));
    return true;
  });
  if (refunded) creditsRefundedTotal.inc(amount);
}

/**
 * Refund and terminally fail a job in one atomic, idempotent transaction.
 *
 * Previously the refund (its own transaction) and the job's `FAILED`
 * transition (a separate update) were two independent round trips. A crash
 * between them left a partially-compensated job: refunded but still
 * `QUEUED`, or `FAILED` but never refunded. Wrapping both in one transaction
 * makes the pair all-or-nothing.
 *
 * Guarded on `status = 'QUEUED'` — the status a job holds between its insert
 * transaction committing and the Redis XADD succeeding, which is the only
 * window this compensation is for. XADD is ambiguous on a timeout: the message
 * may well have landed server-side while the client's ack was lost, in which
 * case the dispatcher is already running the job. Without the guard, the
 * caller's error path would overwrite a `RUNNING`/`COMPLETED` job to `FAILED`
 * and refund a generation the shopper actually received — they keep the image
 * AND get their credits back. Losing the compensation in that case is correct:
 * the job really did run, so the credit really was spent.
 *
 * Idempotent: the ledger insert is additionally guarded by the same
 * (job_id, reason)-scoped unique index `refund()` relies on, so a replay for a
 * job already compensated (now `FAILED`, so also filtered by the status guard)
 * is a no-op either way.
 *
 * Returns whether the compensation was applied; `false` means the job had
 * already moved past `QUEUED` and was deliberately left alone.
 */
export async function refundAndMarkFailed(
  db: DB,
  userId: string,
  amount: number,
  jobId: string,
  refundReason: string,
  jobErrorCode: string,
): Promise<{ compensated: boolean }> {
  const result = await db.transaction(async (tx) => {
    // Claim the transition first: if this matches nothing, the job is no
    // longer compensable and the refund must not happen either.
    const claimed = await tx
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: jobErrorCode })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, 'QUEUED')))
      .returning({ id: schema.jobs.id });
    if (!claimed.length) return { compensated: false, refunded: false };

    // Unique index on (job_id, reason) WHERE job_id IS NOT NULL guarantees
    // at-most-once without a racy SELECT check.
    const inserted = await tx
      .insert(schema.creditLedger)
      .values({ userId, delta: amount, reason: refundReason, jobId })
      .onConflictDoNothing()
      .returning({ id: schema.creditLedger.id });
    if (inserted.length) {
      await tx
        .update(schema.userCredits)
        .set({ balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() })
        .where(eq(schema.userCredits.userId, userId));
    }
    return { compensated: true, refunded: inserted.length > 0 };
  });
  if (result.refunded) creditsRefundedTotal.inc(amount);
  return { compensated: result.compensated };
}

export async function adminGrant(
  db: DB,
  userId: string,
  amount: number,
  reason: string,
  adminId: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({
        target: schema.userCredits.userId,
        set: { balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() },
      });
    await tx.insert(schema.creditLedger).values({ userId, delta: amount, reason, adminId });
  });
}
