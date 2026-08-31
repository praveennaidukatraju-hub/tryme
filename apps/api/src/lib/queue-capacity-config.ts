import { schema } from '@tryme/db';
import { DEFAULT_MAX_QUEUE_DEPTH, JOB_SOURCE } from '@tryme/types';
import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

const CONFIG_KEY = 'config:system';

// Every job source competes for the same GPU worker pool EXCEPT catalog_video, which
// rides its own jobs:video lane (capped by VIDEO_CONCURRENCY, not the GPU worker
// count) — so it's excluded from the count. Not just the sources this plan's own
// job-creation functions produce, since a Shopify, merchant, kiosk, dev-catalog, or
// tryon-direct job sitting QUEUED is just as much a worker-pool consumer as a
// catalog/saree job is.
const VIDEO_SOURCE = JOB_SOURCE.CATALOG_VIDEO;

/**
 * Reads the admin-configured ceiling on concurrently QUEUED jobs (system-wide,
 * see assertQueueCapacity below for the exact scope) from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config),
 * mirroring getMaxBatchJobs() in batch-config.ts. Falls back to
 * DEFAULT_MAX_QUEUE_DEPTH when nothing is stored or the entry is malformed.
 */
export async function getMaxQueueDepth(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const max = cfg.maxQueueDepth;
    return typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_QUEUE_DEPTH;
  } catch {
    return DEFAULT_MAX_QUEUE_DEPTH;
  }
}

/**
 * Rejects a job submission before any credit/DB work if accepting it would push
 * the system-wide QUEUED count — every source except catalog_video (see VIDEO_SOURCE
 * above), not just the sources this plan's own 4 gated functions create — past the
 * admin's ceiling. This is an admission-control gate, not a correctness guard — a
 * concurrent submission can still race past it, same tradeoff createBatchJobs's
 * preflight balance check already accepts (see create.ts comment there). Note: only
 * the count widened here; the rejection gate itself still applies to just the 4
 * Studio-path functions that call this (createJob, createBatchJobs, createSareeJob,
 * createSareeMannequinJob).
 */
export async function assertQueueCapacity(
  app: FastifyInstance,
  additionalJobs: number,
): Promise<void> {
  const maxQueueDepth = await getMaxQueueDepth(app);
  const [row] = await app.db
    .select({ c: count() })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.status, 'QUEUED'),
        // jobs.source is nullable, so the negative branch must COALESCE — a bare
        // `source <> 'catalog_video'` evaluates to NULL on legacy rows and would
        // silently exclude them from the count (same trap sweeper.ts guards against).
        sql`coalesce(${schema.jobs.source}, '') <> ${VIDEO_SOURCE}`,
      ),
    );
  const current = row?.c ?? 0;

  if (current + additionalJobs > maxQueueDepth) {
    throw new AppError('SERVER_BUSY', 503, 'server is busy, please try again shortly', {
      current,
      maxQueueDepth,
    });
  }
}
