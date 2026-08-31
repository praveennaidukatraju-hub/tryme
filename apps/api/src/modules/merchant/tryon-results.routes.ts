import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

async function assertOwnedJob(app: FastifyInstance, merchantId: string, jobId: string) {
  const [job] = await app.db
    .select({ id: schema.jobs.id, merchantId: schema.jobs.merchantId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  if (!job || job.merchantId !== merchantId) {
    throw new AppError('NOT_FOUND', 404, 'job not found');
  }
}

export async function merchantTryonResultsRoutes(app: FastifyInstance) {
  const paramsSchema = z.object({ jobId: z.string().uuid() });
  const noBodySchema = z.union([z.undefined(), z.null()]);

  app.put(
    '/v1/merchant/tryon/jobs/:jobId/like',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .insert(schema.kioskResultLikes)
        .values({ jobId, merchantId })
        .onConflictDoNothing();

      reply.code(204);
      return reply.send();
    },
  );

  app.delete(
    '/v1/merchant/tryon/jobs/:jobId/like',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .delete(schema.kioskResultLikes)
        .where(
          and(
            eq(schema.kioskResultLikes.jobId, jobId),
            eq(schema.kioskResultLikes.merchantId, merchantId),
          ),
        );

      reply.code(204);
      return reply.send();
    },
  );

  app.put(
    '/v1/merchant/tryon/jobs/:jobId/cart',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .insert(schema.kioskResultCartItems)
        .values({ jobId, merchantId })
        .onConflictDoNothing();

      reply.code(204);
      return reply.send();
    },
  );

  app.delete(
    '/v1/merchant/tryon/jobs/:jobId/cart',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .delete(schema.kioskResultCartItems)
        .where(
          and(
            eq(schema.kioskResultCartItems.jobId, jobId),
            eq(schema.kioskResultCartItems.merchantId, merchantId),
          ),
        );

      reply.code(204);
      return reply.send();
    },
  );
}
