import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import {
  MerchantTryonHistoryQuery,
  MerchantTryonJobCreateBody,
  MerchantTryonPresignBody,
} from '@tryme/types';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { createMerchantTryonJob } from './create-tryon-job.js';
import { merchantRefund } from './ledger.js';
import { resolveTryonGarment } from './resolve-tryon-garment.js';

async function loadOwnedJob(app: FastifyInstance, merchantId: string, id: string) {
  const [job] = await app.db
    .select({
      id: schema.jobs.id,
      status: schema.jobs.status,
      merchantId: schema.jobs.merchantId,
      creditsCharged: schema.jobs.creditsCharged,
      resultKey: schema.jobOutputs.resultKey,
      errorCode: schema.jobs.errorCode,
      createdAt: schema.jobs.createdAt,
      completedAt: schema.jobs.completedAt,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .where(eq(schema.jobs.id, id))
    .limit(1);

  if (!job || job.merchantId !== merchantId) {
    throw new AppError('NOT_FOUND', 404, 'job not found');
  }
  return job;
}

async function serializeJob(app: FastifyInstance, merchantId: string, id: string) {
  const job = await loadOwnedJob(app, merchantId, id);
  const [liked, inCart] = await Promise.all([
    app.db
      .select({ id: schema.kioskResultLikes.id })
      .from(schema.kioskResultLikes)
      .where(
        and(
          eq(schema.kioskResultLikes.jobId, id),
          eq(schema.kioskResultLikes.merchantId, merchantId),
        ),
      )
      .limit(1),
    app.db
      .select({ id: schema.kioskResultCartItems.id })
      .from(schema.kioskResultCartItems)
      .where(
        and(
          eq(schema.kioskResultCartItems.jobId, id),
          eq(schema.kioskResultCartItems.merchantId, merchantId),
        ),
      )
      .limit(1),
  ]);

  let shareUrl: string | null = null;
  if (job.status === 'COMPLETED' && job.resultKey) {
    shareUrl = await app.storage
      .presignGet(job.resultKey, 86_400)
      .then((result) => result.url)
      .catch(() => null);
  }

  return {
    id: job.id,
    status: job.status,
    merchantId: job.merchantId,
    resultKey: job.resultKey,
    shareUrl,
    errorCode: job.errorCode,
    liked: liked.length > 0,
    inCart: inCart.length > 0,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export async function merchantTryonRoutes(app: FastifyInstance) {
  app.post(
    '/v1/merchant/tryon/presign',
    { preHandler: app.requireMerchant, schema: { body: MerchantTryonPresignBody } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { contentType, contentLength } = req.body as z.infer<typeof MerchantTryonPresignBody>;
      const ext = contentType.split('/')[1] ?? 'jpg';
      const key = `merchant-inputs/${merchantId}/${randomUUID()}/photo.${ext}`;
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`upload:owner:${key}`, merchantId, 'EX', 600);

      return { uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.get(
    '/v1/merchant/tryon/photo-url',
    {
      preHandler: app.requireMerchant,
      schema: { querystring: z.object({ r2Key: z.string().min(1) }) },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { r2Key } = req.query as { r2Key: string };
      if (!r2Key.startsWith(`merchant-inputs/${merchantId}/`)) {
        throw new AppError('FORBIDDEN', 403, 'photo key does not belong to this merchant');
      }
      const { url } = await app.storage.presignGet(r2Key, 300);
      return { url };
    },
  );
  app.post(
    '/v1/merchant/tryon/jobs',
    { preHandler: app.requireMerchant, schema: { body: MerchantTryonJobCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { merchantCatalogItemId, customerPhotoKey } = req.body as z.infer<
        typeof MerchantTryonJobCreateBody
      >;

      const result = await withIdempotency(
        app,
        'merchant-tryon-jobs',
        merchantId,
        req.headers['idempotency-key'] as string | undefined,
        async () => {
          const garment = await resolveTryonGarment(app, merchantId, merchantCatalogItemId);

          if (!customerPhotoKey.startsWith(`merchant-inputs/${merchantId}/`)) {
            throw new AppError(
              'FORBIDDEN',
              403,
              'customer photo key does not belong to this merchant',
            );
          }

          const uploadOwner = await app.redis.get(`upload:owner:${customerPhotoKey}`);
          if (uploadOwner !== merchantId) {
            throw new AppError('FORBIDDEN', 403, 'upload session expired or not owned');
          }

          let photoHead: { contentLength: number };
          try {
            photoHead = await app.storage.headObject(customerPhotoKey);
          } catch {
            throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
          }
          const maxTryonBytes = await getUploadLimitBytes(app, 'merchantTryonMaxBytes');
          if (photoHead.contentLength > maxTryonBytes) {
            throw new AppError(
              'BAD_UPLOAD',
              413,
              `uploaded photo exceeds ${maxTryonBytes / (1024 * 1024)}MB limit`,
            );
          }

          const [merchant] = await app.db
            .select({ userId: schema.merchants.userId })
            .from(schema.merchants)
            .where(eq(schema.merchants.id, merchantId))
            .limit(1);
          if (!merchant) throw new AppError('NOT_FOUND', 404, 'merchant not found');

          const jobId = await createMerchantTryonJob(app, {
            merchantId,
            merchantUserId: merchant.userId,
            upperGarmentKey: garment.r2Key,
            secondGarmentKey: garment.secondR2Key,
            customerPhotoKey,
            workflowTemplateId: garment.workflowTemplateId,
            dispatchTemplateVersion: garment.workflowTemplateVersion ?? null,
          });

          return { jobId };
        },
      );

      reply.code(201);
      return result;
    },
  );
  app.get(
    '/v1/merchant/tryon/jobs/:id',
    { preHandler: app.requireMerchant, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { id } = req.params as { id: string };
      return serializeJob(app, merchantId, id);
    },
  );

  app.delete(
    '/v1/merchant/tryon/jobs/:id',
    { preHandler: app.requireMerchant, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { id } = req.params as { id: string };
      const job = await loadOwnedJob(app, merchantId, id);

      if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
        throw new AppError('NOT_CANCELLABLE', 409, 'job is already finished or cancelled');
      }
      if (job.status === 'GENERATING' || job.status === 'UPLOADING') {
        throw new AppError('NOT_CANCELLABLE', 409, 'job is already being processed');
      }

      await app.db.transaction(async (tx) => {
        await tx.update(schema.jobs).set({ status: 'CANCELLED' }).where(eq(schema.jobs.id, id));
        // biome-ignore lint/suspicious/noExplicitAny: tx type narrowing loses custom methods in the widget ledger helper.
        await merchantRefund(tx as any, merchantId, job.creditsCharged, id, 'REFUND_CANCELLED');
      });

      const evt = JSON.stringify({ type: 'STATUS', jobId: id, status: 'CANCELLED' });
      await app.redis.publish(`sse:events:widget:${merchantId}`, evt);

      reply.code(200);
      return { status: 'CANCELLED' };
    },
  );

  app.get(
    '/v1/merchant/tryon/history',
    {
      preHandler: app.requireMerchant,
      schema: { querystring: MerchantTryonHistoryQuery },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { before, limit } = req.query as z.infer<typeof MerchantTryonHistoryQuery>;

      // customer_photo_key is stored per-job, not deduplicated — a merchant can
      // reuse one uploaded photo across several jobs (same customer, different
      // garments), so job count and distinct-photo count are different things.
      // See docs/superpowers/specs/2026-08-21-merchant-tryon-history-design.md.
      const dayBucket = sql<string>`to_char((${schema.jobs.createdAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`;

      const conditions = [eq(schema.jobs.merchantId, merchantId)];
      if (before) {
        conditions.push(lt(schema.jobs.createdAt, new Date(`${before}T00:00:00.000Z`)));
      }

      const rows = await app.db
        .select({
          day: dayBucket.as('day'),
          inputCount: sql<number>`COUNT(DISTINCT ${schema.jobs.customerPhotoKey})`.as('inputCount'),
          generatedCount:
            sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')`.as(
              'generatedCount',
            ),
          failedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'FAILED')`.as(
            'failedCount',
          ),
        })
        .from(schema.jobs)
        .where(and(...conditions))
        .groupBy(dayBucket)
        .orderBy(desc(dayBucket))
        .limit(limit);

      // Raw sql`` aggregates come back from the driver as strings regardless of
      // the sql<number> annotations — those generics are TypeScript-only (same
      // caveat as GET /v1/batches/:id in modules/jobs/). day is formatted via
      // to_char() in SQL so it arrives as a plain 'YYYY-MM-DD' string, no Date
      // round-trip needed.
      const days = rows.map((r) => ({
        date: r.day,
        inputCount: Number(r.inputCount),
        generatedCount: Number(r.generatedCount),
        failedCount: Number(r.failedCount),
      }));

      const nextCursor = days.length === limit ? days[days.length - 1].date : null;

      return { days, nextCursor };
    },
  );
}
