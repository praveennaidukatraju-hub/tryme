import { schema } from '@tryme/db';
import { inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

// SEC-H4: presignPut cannot enforce contentLength (see packages/storage/src/r2.ts),
// so a caller can PUT an arbitrarily large file to a key that never becomes a job.
// The upload:owner:<key> Redis binding already expires after 24h, so 24h is the
// natural cutoff for treating an unreferenced object as abandoned rather than
// "job creation just hasn't happened yet".
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const INPUT_GARMENT_PREFIX = 'inputs/';

/**
 * Deletes objects under inputs/ that are older than 24h and are not referenced
 * by any job_inputs row (upper/lower/third garment key). All three columns can
 * hold an inputs/ key — each garment slot gets its own /v1/uploads/presign call
 * and therefore its own inputs/<token>/garment.jpg key.
 */
export async function runUploadSweepTick(
  app: FastifyInstance,
  opts: { maxAgeMs?: number } = {},
): Promise<{ scanned: number; deleted: number }> {
  const objects = await app.storage.listObjects(INPUT_GARMENT_PREFIX);
  const cutoff = Date.now() - (opts.maxAgeMs ?? ORPHAN_AGE_MS);
  const candidates = objects.filter((o) => (o.lastModified?.getTime() ?? 0) < cutoff);
  if (candidates.length === 0) {
    return { scanned: objects.length, deleted: 0 };
  }

  const keys = candidates.map((c) => c.key);
  const referenced = await app.db
    .select({
      upperGarmentKey: schema.jobInputs.upperGarmentKey,
      lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
      thirdGarmentKey: schema.jobInputs.thirdGarmentKey,
    })
    .from(schema.jobInputs)
    .where(
      or(
        inArray(schema.jobInputs.upperGarmentKey, keys),
        inArray(schema.jobInputs.lowerGarmentKey, keys),
        inArray(schema.jobInputs.thirdGarmentKey, keys),
      ),
    );
  const referencedKeys = new Set(
    referenced.flatMap((r) => [r.upperGarmentKey, r.lowerGarmentKey, r.thirdGarmentKey]),
  );

  let deleted = 0;
  for (const key of keys) {
    if (referencedKeys.has(key)) continue;
    try {
      await app.storage.deleteObject(key);
      deleted++;
    } catch (err) {
      app.log.error({ err, key }, 'upload sweeper: failed to delete orphaned object');
    }
  }
  app.log.info(
    { scanned: objects.length, candidates: candidates.length, deleted },
    'upload sweeper tick complete',
  );
  return { scanned: objects.length, deleted };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Call once after `app.listen(...)`. Returns a stop function so tests can
 *  tear the interval down. */
export function startUploadSweeper(
  app: FastifyInstance,
  intervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      app.log.warn('upload sweeper tick still running — skipping this interval');
      return;
    }
    running = true;
    void runUploadSweepTick(app)
      .catch((err) => {
        app.log.error({ err }, 'upload sweeper tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
