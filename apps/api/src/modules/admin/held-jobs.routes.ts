import { schema } from '@tryme/db';
import { AdminHeldJobsReleaseResponse, AdminHeldJobsResponse } from '@tryme/types';
import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from './guard.js';

/**
 * Bulk-flat catalogue jobs are parked at status HELD at upload time (credits
 * already deducted) and only enter the Redis stream when an admin decides GPU
 * capacity is free. Release is deliberately global: one button drains every
 * merchant's backlog at once, rather than per-merchant scheduling.
 */
export async function adminHeldJobsRoutes(app: FastifyInstance) {
  const GUARD = requirePermission('held_jobs.manage');

  app.get(
    '/admin/held-jobs',
    {
      preHandler: GUARD,
      schema: { response: { 200: AdminHeldJobsResponse } },
    },
    async () => {
      const rows = await app.db
        .select({
          userId: schema.jobs.userId,
          email: schema.users.email,
          count: count(),
          oldestCreatedAt: sql<string>`min(${schema.jobs.createdAt})`,
        })
        .from(schema.jobs)
        .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
        .where(eq(schema.jobs.status, 'HELD'))
        .groupBy(schema.jobs.userId, schema.users.email);

      return {
        total: rows.reduce((sum, row) => sum + row.count, 0),
        byUser: rows.map((row) => ({
          ...row,
          // Postgres returns a Date for min(timestamp), not a string — stringify
          // here rather than trust the SQL template's type annotation, which
          // does nothing to the actual runtime value.
          oldestCreatedAt:
            (row.oldestCreatedAt as unknown) instanceof Date
              ? (row.oldestCreatedAt as unknown as Date).toISOString()
              : row.oldestCreatedAt,
        })),
      };
    },
  );

  app.post(
    '/admin/held-jobs/release',
    {
      preHandler: GUARD,
      schema: { response: { 200: AdminHeldJobsReleaseResponse } },
    },
    async (req) => {
      const RELEASE_BATCH_LIMIT = 200;
      const held = await app.db
        .select({ id: schema.jobs.id, userId: schema.jobs.userId })
        .from(schema.jobs)
        .where(eq(schema.jobs.status, 'HELD'))
        .orderBy(schema.jobs.createdAt)
        .limit(RELEASE_BATCH_LIMIT + 1);
      const hasMore = held.length > RELEASE_BATCH_LIMIT;
      if (hasMore) held.pop();

      const now = new Date();
      let released = 0;
      for (const job of held) {
        // Status-guarded so two admins releasing at the same moment cannot
        // enqueue the same job twice — the loser's UPDATE matches no rows.
        const [claimed] = await app.db
          .update(schema.jobs)
          .set({ status: 'QUEUED', queuedAt: now })
          .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'HELD')))
          .returning({ id: schema.jobs.id });
        if (!claimed) continue;

        try {
          await app.redis.xadd(
            'jobs:low',
            'MAXLEN',
            '~',
            10000,
            '*',
            'jobId',
            job.id,
            'userId',
            job.userId ?? '',
          );
          released++;
        } catch (err) {
          // XADD failed after the DB flip already committed. Revert to HELD
          // rather than leaving this a permanently stranded, un-enqueued
          // QUEUED row with credits already spent and no way for an admin to
          // rediscover it (it would no longer appear in GET /admin/held-jobs).
          // The next release attempt will pick it back up.
          req.log.error(
            { err, jobId: job.id },
            'held-job release: XADD failed, reverting job to HELD',
          );
          try {
            await app.db
              .update(schema.jobs)
              .set({ status: 'HELD', queuedAt: null })
              .where(eq(schema.jobs.id, job.id));
          } catch (revertErr) {
            req.log.error(
              { err: revertErr, jobId: job.id },
              'held-job release: revert-to-HELD also failed; job is stranded as QUEUED with no stream entry',
            );
          }
        }
      }

      const [{ remaining }] = await app.db
        .select({ remaining: count() })
        .from(schema.jobs)
        .where(eq(schema.jobs.status, 'HELD'));

      req.log.info({ released, remaining }, 'released held bulk-flat jobs');
      return { released, remaining };
    },
  );
}
