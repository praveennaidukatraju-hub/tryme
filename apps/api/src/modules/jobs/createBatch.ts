import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateBatchJobBody, countBatchJobs, JOB_SOURCE } from '@tryme/types';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getMaxBatchJobs } from '../../lib/batch-config.js';
import { AppError, withRowIndex } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
import { atomicDeduct, refundAndMarkFailed } from '../credits/ledger.js';
import {
  createTryonPlanCache,
  resolveQueueRouting,
  resolveTryonPlan,
  type TryonPlan,
  verifyGarmentKey,
} from './create.js';
import { promptGuard } from './sanitize.js';

export interface BatchCreateResult {
  batchId: string;
  totalJobs: number;
  creditsCharged: number;
  catalogues: Array<{ rowIndex: number; catalogueId: string; jobIds: string[] }>;
  failedJobIds: string[];
}

/**
 * Creates every job in a batch, or none of them.
 *
 * A row is exactly one Studio submission — one garment, one face, one
 * background, N poses — so each row is validated by the same resolveTryonPlan()
 * the single-job path uses, and each row's jobs share their own catalogueId. The
 * whole batch shares a batchId; there is no batches table, and progress is
 * derived by GROUP BY batch_id.
 */
export async function createBatchJobs(
  app: FastifyInstance,
  userId: string,
  body: CreateBatchJobBody,
): Promise<BatchCreateResult> {
  const { rows } = body;

  const [[user], routing, [garmentType]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    resolveQueueRouting(app, userId),
    app.db
      .select({ requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, body.garmentTypeId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  // Batch rows only ever carry a fresh upperGarmentKey upload — never a
  // mannequinJobId — so opts.resolvedUpperGarmentKey passed to resolveTryonPlan
  // below is always a string, never `undefined`. That means resolveTryonPlan's
  // own defensive mannequin check (which only fires on `undefined`) can never
  // catch this here. createJob rejects requiresMannequinStep garment types
  // without a mannequinJobId explicitly (see create.ts) — mirror that guard so
  // the batch path can't silently charge+route a flat upload through a
  // workflow that expects a mannequin render, which would complete "successfully"
  // and never trigger a refund.
  if (garmentType?.requiresMannequinStep) {
    throw new AppError(
      'VALIDATION',
      400,
      'batch does not support garment types that require the mannequin two-pass flow',
    );
  }

  // Cap on total jobs, not rows: 50 rows of 10 poses is 500 jobs regardless of
  // how few rows that is.
  const requestedJobs = countBatchJobs(rows);
  const maxBatchJobs = await getMaxBatchJobs(app);
  if (requestedJobs > maxBatchJobs) {
    throw new AppError(
      'VALIDATION',
      400,
      `batch of ${requestedJobs} images exceeds the limit of ${maxBatchJobs}`,
      { totalJobs: requestedJobs, maxBatchJobs },
    );
  }

  const { queueStream, priority, watermark } = routing;

  // H2 ownership: each DISTINCT key is verified once, not once per row — a
  // garment reused across five rows is one Redis lookup. The map remembers the
  // first row using each key so a failure can be attributed to a row.
  const keyFirstRow = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!keyFirstRow.has(row.upperGarmentKey)) keyFirstRow.set(row.upperGarmentKey, index);
    if (row.lowerGarmentKey && !keyFirstRow.has(row.lowerGarmentKey)) {
      keyFirstRow.set(row.lowerGarmentKey, index);
    }
  });
  // The garment tray's "Past uploads" tab offers every key from this user's own
  // job history (GET /v1/assets), which is arbitrarily old — far older than the
  // 24h `upload:owner:{key}` Redis binding assertOwnsUploadKey checks. Resolve
  // which of the requested keys already sit on this caller's own job_inputs rows
  // and trust those, exactly as regenerate.ts does: ownership is proven by the
  // job row, so the expired binding is not evidence of anything. Keys that are
  // not in the caller's history still go through the full Redis check.
  const requestedKeys = [...keyFirstRow.keys()];
  const ownedKeyRows = await app.db
    .select({
      upperGarmentKey: schema.jobInputs.upperGarmentKey,
      lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
    })
    .from(schema.jobInputs)
    .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(
      and(
        eq(schema.jobs.userId, userId),
        or(
          inArray(schema.jobInputs.upperGarmentKey, requestedKeys),
          inArray(schema.jobInputs.lowerGarmentKey, requestedKeys),
        ),
      ),
    );
  const trustedGarmentKeys = new Set<string>();
  for (const owned of ownedKeyRows) {
    if (owned.upperGarmentKey && keyFirstRow.has(owned.upperGarmentKey)) {
      trustedGarmentKeys.add(owned.upperGarmentKey);
    }
    if (owned.lowerGarmentKey && keyFirstRow.has(owned.lowerGarmentKey)) {
      trustedGarmentKeys.add(owned.lowerGarmentKey);
    }
  }

  for (const [key, rowIndex] of keyFirstRow) {
    try {
      await verifyGarmentKey(app, userId, key, trustedGarmentKeys);
    } catch (err) {
      throw withRowIndex(err, rowIndex);
    }
  }

  // Plan every row before touching credits or inserting anything. resolveTryonPlan
  // is read-only by contract, so a mid-loop rejection leaves no residue.
  const plans: TryonPlan[] = [];
  const cache = createTryonPlanCache();
  for (const [rowIndex, row] of rows.entries()) {
    try {
      plans.push(
        await resolveTryonPlan(
          app,
          userId,
          {
            inputs: {
              upperGarmentKey: row.upperGarmentKey,
              faceId: row.faceId,
              backgroundId: row.backgroundId,
              poseIds: row.poseIds,
              garmentTypeId: body.garmentTypeId,
              lowerCatalogId: row.lowerCatalogId,
              lowerGarmentKey: row.lowerGarmentKey,
              shoeCatalogId: row.shoeCatalogId,
            },
            params: body.params,
            userHint: body.userHint,
            aspectRatio: body.aspectRatio,
            resolution: body.resolution,
            platform: body.platform,
          },
          { resolvedUpperGarmentKey: row.upperGarmentKey, trustedGarmentKeys, cache },
        ),
      );
    } catch (err) {
      throw withRowIndex(err, rowIndex);
    }
  }

  const totalJobs = plans.reduce((n, plan) => n + plan.looks.length, 0);
  const creditsCharged = plans.reduce((n, plan) => n + plan.cost * plan.looks.length, 0);

  await assertQueueCapacity(app, totalJobs);

  // Preflight so an unaffordable batch is rejected with a useful message instead
  // of surfacing as an opaque mid-transaction atomicDeduct failure. This is not
  // the safety net — atomicDeduct inside the transaction below still is, and
  // still rolls the whole batch back if a concurrent spend races past this read.
  const [balanceRow] = await app.db
    .select({ balance: schema.userCredits.balance })
    .from(schema.userCredits)
    .where(eq(schema.userCredits.userId, userId));
  const available = balanceRow?.balance ?? 0;
  if (available < creditsCharged) {
    throw new AppError(
      'INSUFFICIENT_CREDITS',
      402,
      `batch needs ${creditsCharged} credits, balance is ${available}`,
      { required: creditsCharged, available },
    );
  }

  const batchId = randomUUID();

  // One transaction for the whole batch. atomicDeduct throwing part-way through
  // (a concurrent spend draining the balance) propagates out of the callback and
  // rolls back every insert, so all-or-nothing survives without a lock.
  const catalogues = await app.db.transaction(async (tx) => {
    const created: BatchCreateResult['catalogues'] = [];
    for (const [rowIndex, plan] of plans.entries()) {
      const row = rows[rowIndex];
      const jobIds: string[] = [];
      for (const look of plan.looks) {
        const [job] = await tx
          .insert(schema.jobs)
          .values({
            userId,
            batchId,
            catalogueId: plan.catalogueId,
            status: 'QUEUED',
            priority,
            queueStream,
            watermark,
            creditsCharged: plan.cost,
            source: JOB_SOURCE.CATALOG,
          })
          .returning();
        await atomicDeduct(tx as unknown as DB, userId, plan.cost, job.id);
        await tx.insert(schema.jobInputs).values({
          jobId: job.id,
          upperGarmentKey: look.upperGarmentKey,
          faceId: row.faceId,
          backgroundId: look.backgroundId,
          poseId: look.poseId,
          garmentTypeId: body.garmentTypeId,
          lowerCatalogId: look.lowerCatalogId,
          lowerGarmentKey: look.lowerGarmentKey,
          shoeCatalogId: look.shoeCatalogId,
          userHint: promptGuard(body.userHint),
          params: look.params,
        });
        jobIds.push(job.id);
      }
      created.push({ rowIndex, catalogueId: plan.catalogueId, jobIds });
    }
    return created;
  });

  const stream = `jobs:${queueStream}`;
  const failedJobIds: string[] = [];
  const costByJobId = new Map<string, number>();
  catalogues.forEach((group, i) => {
    for (const jobId of group.jobIds) costByJobId.set(jobId, plans[i].cost);
  });

  for (const group of catalogues) {
    for (const jobId of group.jobIds) {
      try {
        await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'userId', userId);
        jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.CATALOG });
      } catch (err) {
        app.log.error({ err, jobId, batchId }, 'batch xadd failed — job will be refunded');
        failedJobIds.push(jobId);
      }
    }
  }

  if (failedJobIds.length > 0) {
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open, and
    // is a no-op if the dispatcher already claimed the job past QUEUED.
    await Promise.all(
      failedJobIds.map((jobId) =>
        refundAndMarkFailed(
          app.db,
          userId,
          costByJobId.get(jobId) ?? 0,
          jobId,
          'REFUND_ENQUEUE_FAIL',
          'ENQUEUE_FAIL',
        ),
      ),
    );
    if (failedJobIds.length === totalJobs) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  return { batchId, totalJobs, creditsCharged, catalogues, failedJobIds };
}
