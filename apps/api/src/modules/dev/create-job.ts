import { randomUUID } from 'node:crypto';
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { JOB_SOURCE, type JobSource } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertMerchantJobRateLimit } from '../../lib/job-rate-limit.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicDeduct, refundAndMarkFailed } from '../credits/ledger.js';

/**
 * Shared insert/deduct/enqueue/refund-on-fail core for every dev-API job kind.
 * Deliberately NOT part of jobs/create.ts — see createDevTryonJob's original
 * comment for why the dev API needs its own creation path.
 */
export async function createDevJobCore(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    cost: number;
    watermark: boolean;
    source: JobSource;
    buildJobInputs: () => Omit<typeof schema.jobInputs.$inferInsert, 'jobId'>;
  },
): Promise<{ jobId: string }> {
  await assertMerchantJobRateLimit(app, params.merchantUserId);

  const catalogueId = randomUUID();
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId: params.merchantUserId,
        apiKeyId: params.apiKeyId,
        catalogueId,
        status: 'QUEUED',
        priority: false,
        queueStream: 'normal',
        watermark: params.watermark,
        creditsCharged: params.cost,
        source: params.source,
      })
      .returning();
    if (!newJob) throw new AppError('INTERNAL', 500, 'failed to create job');

    await atomicDeduct(tx as unknown as DB, params.merchantUserId, params.cost, newJob.id);

    // buildJobInputs()'s return shape is routing-significant: the dispatcher
    // (apps/dispatcher/src/job/processor.ts) decides which processing path a
    // job takes based on which of faceId/backgroundId/poseId/params.kind are
    // present. Callers must get this shape right for their job kind.
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      ...params.buildJobInputs(),
    });
    return [newJob];
  });
  if (!job) throw new AppError('INTERNAL', 500, 'failed to create job');

  try {
    await app.redis.xadd(
      'jobs:normal',
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      job.id,
      'userId',
      params.merchantUserId,
    );
    jobsCreatedTotal.inc({ priority: 'normal', kind: params.source });
  } catch (err) {
    app.log.error(
      { err, jobId: job.id },
      `redis xadd failed — dev ${params.source} job will be refunded`,
    );
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open.
    await refundAndMarkFailed(
      app.db,
      params.merchantUserId,
      params.cost,
      job.id,
      'REFUND_ENQUEUE_FAIL',
      'ENQUEUE_FAIL',
    );
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id };
}

/**
 * Creates a developer-API try-on job from a raw person image + raw garment image
 * + category slug.
 *
 * Deliberately NOT part of jobs/create.ts::createSimpleTryonJob. That function
 * requires the garment to be a prior COMPLETED job of the caller (sourceJobId)
 * and resolves the workflow through a garment-type → tryon-category chain. A
 * third-party developer has neither, so this resolves the workflow straight off
 * dev_tryon_categories.slug — a dedicated table decoupled from the internal
 * tryon_categories table used by Studio/kiosk/merchant flows. Same reasoning
 * merchant/create-job.ts documents at its top.
 *
 * The job row is userId-owned (the merchant's user) so the dispatcher's existing
 * transactional refund-on-terminal-failure path applies with no changes.
 */
export async function createDevTryonJob(
  app: FastifyInstance,
  params: {
    merchantId: string;
    merchantUserId: string;
    apiKeyId: string;
    integration: 'generic' | 'wordpress';
    categorySlug: string;
    personKey: string;
    garmentKey: string;
  },
): Promise<{ jobId: string }> {
  const cost = await getTryonCreditCost(app);

  // Resolve off the DEDICATED dev table, not tryon_categories — the public API
  // surface is controlled independent of the internal Studio catalog. Kill-switch
  // parity: an inactive dev category, or one whose workflow template is inactive,
  // must not resolve. Runs before any credit movement, so a rejected request is free.
  const [category] = await app.db
    .select({
      workflowTemplateId: schema.devTryonCategories.workflowTemplateId,
      templateVersion: schema.workflowTemplates.version,
      templateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.devTryonCategories)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.devTryonCategories.workflowTemplateId),
    )
    .where(
      and(
        eq(schema.devTryonCategories.slug, params.categorySlug),
        eq(schema.devTryonCategories.isActive, true),
      ),
    )
    .limit(1);

  if (!category) throw new AppError('BAD_CATEGORY', 400, 'unknown or inactive category');
  if (!category.workflowTemplateId || !category.templateIsActive) {
    throw new AppError('BAD_CATEGORY', 400, 'category has no active workflow configured');
  }

  const [user] = await app.db
    .select({ isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.id, params.merchantUserId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'account suspended');

  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    // Never trust a client-supplied field for this — integration is resolved
    // server-side by dev-api-auth.ts from the authenticated key row, the same
    // place merchantId/merchantUserId are already resolved.
    source: params.integration === 'wordpress' ? JOB_SOURCE.WORDPRESS_TRYON : JOB_SOURCE.API_TRYON,
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      params: {
        personKey: params.personKey,
        workflowTemplateId: category.workflowTemplateId,
        dispatchTemplateVersion: category.templateVersion ?? null,
      },
    }),
  });
}
