import { DEFAULT_MAX_BATCH_JOBS } from '@tryme/types';
import type { FastifyInstance } from 'fastify';

const CONFIG_KEY = 'config:system';

/**
 * Reads the admin-configured ceiling on jobs per batch from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config),
 * mirroring getMaxOutputPx() in resolution-config.ts. Falls back to
 * DEFAULT_MAX_BATCH_JOBS when nothing is stored or the entry is malformed.
 */
export async function getMaxBatchJobs(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const max = cfg.maxBatchJobs;
    return typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_BATCH_JOBS;
  } catch {
    return DEFAULT_MAX_BATCH_JOBS;
  }
}
