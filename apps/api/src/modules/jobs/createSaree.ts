import { randomUUID } from 'node:crypto';
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateSareeJobRequest, JOB_SOURCE } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicDeduct, refundAndMarkFailed } from '../credits/ledger.js';
import { getSareeSettings } from '../saree/settings.js';
import { assertOwnsUploadKey, resolveQueueRouting } from './create.js';

export async function createSareeJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeJobRequest>,
  opts?: {
    /** Set only by regenerateJob within today's free allowance — see createJob's
     *  matching option for why this is a genuine zero, not charge-then-refund. */
    waiveCost?: boolean;
  },
) {
  const { garmentKey } = body;
  const COST = opts?.waiveCost ? 0 : await getTryonCreditCost(app);

  // 1. Ownership + existence + size check on the user-uploaded saree.
  await assertOwnsUploadKey(app, userId, garmentKey);

  // 2. Saree must be configured (admin uploaded a model image).
  const settings = await getSareeSettings(app.db);
  if (!settings?.modelImageKey) {
    throw new AppError('NOT_CONFIGURED', 400, 'saree try-on is not configured by admin');
  }

  // 3. Must be an active saree workflow.
  const [wf] = await app.db
    .select({
      id: schema.workflowTemplates.id,
      version: schema.workflowTemplates.version,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.workflowType, 'saree'),
        eq(schema.workflowTemplates.isActive, true),
      ),
    )
    .limit(1);
  if (!wf) {
    throw new AppError('CONFIG', 400, 'no active saree workflow template configured');
  }

  // 4. User must exist and not be banned.
  const [[user], routing] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    resolveQueueRouting(app, userId),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  await assertQueueCapacity(app, 1);

  const { queueStream, priority, watermark } = routing;

  // 5. Deduct + insert in a single txn (mirrors createSimpleTryonJob).
  const catalogueId = randomUUID();
  const job = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
        source: JOB_SOURCE.SAREE,
      })
      .returning();
    if (COST > 0) await atomicDeduct(tx as unknown as DB, userId, COST, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      upperGarmentKey: garmentKey,
      params: {
        modelKey: settings.modelImageKey,
        workflowTemplateId: wf.id,
        dispatchTemplateVersion: wf.version,
        kind: 'saree',
      },
    });
    return newJob;
  });

  // 6. XADD to the right stream. Refund on failure.
  const stream = `jobs:${queueStream}`;
  try {
    await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', job.id, 'userId', userId);
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.SAREE });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed — saree job will be refunded');
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open.
    await refundAndMarkFailed(app.db, userId, COST, job.id, 'REFUND_ENQUEUE_FAIL', 'ENQUEUE_FAIL');
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id, catalogueId };
}
