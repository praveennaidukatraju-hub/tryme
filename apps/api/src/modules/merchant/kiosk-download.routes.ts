import { schema } from '@tryme/db';
import { KioskDownloadBatchQuery } from '@tryme/types';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const MAX_JOB_IDS = 30;
// Matches the presign TTL merchant/tryon.routes.ts already hands a single result's
// shareUrl for — a job past this window is treated as expired here too, so a QR code
// scanned and reused later doesn't grant indefinitely-lived access to the image.
const RESULT_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const PRESIGN_TTL_SECONDS = 24 * 60 * 60;

export async function kioskDownloadRoutes(app: FastifyInstance) {
  // Public: the "download all" QR from the kiosk android app encodes job IDs
  // directly, with no session/token indirection — same trust model as the
  // single-image QR, which already hands out a bare presigned URL to anyone
  // who scans it.
  app.get(
    '/v1/kiosk-download/batch',
    {
      schema: { querystring: KioskDownloadBatchQuery },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { jobIds: raw } = req.query as z.infer<typeof KioskDownloadBatchQuery>;
      const ids = [...new Set(raw.split(',').map((id) => id.trim()))]
        .filter((id) => z.string().uuid().safeParse(id).success)
        .slice(0, MAX_JOB_IDS);

      if (ids.length === 0) return { items: [] };

      const rows = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          completedAt: schema.jobs.completedAt,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(inArray(schema.jobs.id, ids));

      const now = Date.now();
      const eligible = rows.filter(
        (r) =>
          r.status === 'COMPLETED' &&
          r.resultKey &&
          r.completedAt &&
          now - r.completedAt.getTime() < RESULT_FRESHNESS_MS,
      );

      const items = await Promise.all(
        eligible.map(async (r) => {
          const url = await app.storage
            .presignGet(r.resultKey as string, PRESIGN_TTL_SECONDS)
            .then((result) => result.url)
            .catch(() => null);
          return url ? { jobId: r.id, url } : null;
        }),
      );

      return {
        items: items.filter((item): item is { jobId: string; url: string } => item !== null),
      };
    },
  );
}
