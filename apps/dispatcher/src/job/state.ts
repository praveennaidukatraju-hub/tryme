import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { jobE2eDuration } from '@tryme/observability';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { checkAndCleanupArchiveForJob } from '../workflow/drain-cleanup.js';

export type JobStatus =
  | 'PENDING_MANNEQUIN'
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'GENERATING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface TransitionOptions {
  workerId?: string;
  errorCode?: string;
  resultKey?: string;
  thumbnailKey?: string;
  /**
   * When true, skip the job_outputs insert/upsert — the caller has already
   * written that row (e.g. finalizeOutput() writes it with assetKind/watermarkVersion).
   * The resultKey/thumbnailKey are still included in the SSE payload.
   */
  skipOutputInsert?: boolean;
  /**
   * Store-billed Shopify jobs only: SSE publishes to `sse:events:store:${shopifyStoreId}`
   * instead of `sse:events:${userId}`. Callers on this path pass userId as '' (mirrors
   * the existing kiosk-job convention of an empty userId for jobs with no real user).
   */
  shopifyStoreId?: string;
}

export async function transitionJob(
  db: DB,
  pub: Redis,
  jobId: string,
  userId: string,
  status: JobStatus,
  opts: TransitionOptions = {},
  log: Logger,
): Promise<void> {
  const now = new Date();
  const patch: Record<string, unknown> = { status };
  if (opts.workerId !== undefined) patch.workerId = opts.workerId;
  if (opts.errorCode !== undefined) patch.errorCode = opts.errorCode;
  if (status === 'GENERATING') patch.startedAt = now;
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED')
    patch.completedAt = now;

  const updated = await db
    .update(schema.jobs)
    .set(patch as Parameters<ReturnType<typeof db.update>['set']>[0])
    .where(eq(schema.jobs.id, jobId))
    .returning({ createdAt: schema.jobs.createdAt, source: schema.jobs.source });

  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
    const createdAt = updated[0]?.createdAt;
    if (createdAt) {
      const outcome = status.toLowerCase();
      const jobType = updated[0]?.source ?? 'unknown';
      jobE2eDuration.observe(
        { outcome, job_type: jobType },
        (now.getTime() - createdAt.getTime()) / 1000,
      );
    }

    await checkAndCleanupArchiveForJob(db, jobId, log);
  }

  if (opts.resultKey && status === 'COMPLETED' && !opts.skipOutputInsert) {
    await db
      .insert(schema.jobOutputs)
      .values({ jobId, resultKey: opts.resultKey, thumbnailKey: opts.thumbnailKey ?? null })
      .onConflictDoUpdate({
        target: schema.jobOutputs.jobId,
        set: { resultKey: opts.resultKey, thumbnailKey: opts.thumbnailKey ?? null },
      });
  }

  await db.insert(schema.jobEvents).values({
    jobId,
    eventType: status,
    payload: opts as Record<string, unknown>,
  });

  const channelId = opts.shopifyStoreId ? `store:${opts.shopifyStoreId}` : userId;
  const ssePayload = JSON.stringify({ jobId, userId, type: 'STATUS', status, ...opts });
  const publishes = [pub.publish('sse:events:admin', ssePayload)];
  if (channelId) publishes.push(pub.publish(`sse:events:${channelId}`, ssePayload));
  await Promise.all(publishes);
  log.info({ jobId, userId, channelId, status }, 'job state transition');
}
