import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { syncOneTask } from './products.sync.js';
import type { SyncTask } from './service.js';

const STREAM = 'shopify:sync';
// Consumer group — mirrors the established Redis Streams idiom already used by
// apps/dispatcher/src/stream/consumer.ts ('dispatcher-cg') for the exact same
// problem (multiple process replicas must not double-process the same stream
// entry). A consumer group hands each entry to exactly one member and requires
// an explicit XACK, which is a stronger guarantee than a SET NX lease lock would
// give (a lease makes only one replica active at a time; a group lets every
// replica share the work while still processing each task once).
const GROUP = 'shopify-sync-cg';

type XReadGroupResult = Array<[string, Array<[string, string[]]>]> | null;

async function ensureGroup(app: FastifyInstance): Promise<void> {
  try {
    await app.redisBlocking.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    app.log.info({ stream: STREAM, group: GROUP }, 'shopify:sync consumer group created');
  } catch (err: unknown) {
    // BUSYGROUP = group already exists, safe to ignore
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }
}

/**
 * Starts a blocking consumer loop that reads `shopify:sync` tasks (enqueued by
 * `enqueueSync` — see ./service.ts) and runs them through `syncOneTask`
 * (Task 8's tested sync logic). Call once after `app.listen(...)`.
 *
 * Kept intentionally simple: infrastructure to shuttle tasks to already-tested
 * business logic, not the business logic itself. No XPENDING-based crash
 * recovery (unlike the dispatcher's jobs:* streams) — a stuck/crashed task is
 * low-stakes here: the next webhook or storefront request re-enqueues a sync
 * for the same product/store, so silent staleness self-heals rather than
 * silently failing forever.
 *
 * Returns a stop function for graceful shutdown (currently unused by the caller
 * but provided for symmetry with the dispatcher's `runConsumer`).
 */
export function startSyncConsumer(app: FastifyInstance): () => void {
  const consumer = `${hostname()}-${process.pid}`;
  let running = true;

  async function loop(): Promise<void> {
    await ensureGroup(app);
    while (running) {
      try {
        const result = (await app.redisBlocking.xreadgroup(
          'GROUP',
          GROUP,
          consumer,
          'COUNT',
          '1',
          'BLOCK',
          '5000',
          'STREAMS',
          STREAM,
          '>',
        )) as XReadGroupResult;

        const entry = result?.[0]?.[1]?.[0];
        if (!entry) continue;
        const [messageId, fields] = entry;

        const taskIdx = fields.indexOf('task');
        const raw = taskIdx !== -1 ? fields[taskIdx + 1] : undefined;
        if (!raw) {
          app.log.warn({ messageId }, 'shopify:sync message missing task field — acking, skipping');
          await app.redisBlocking.xack(STREAM, GROUP, messageId);
          continue;
        }

        try {
          const task = JSON.parse(raw) as SyncTask;
          await syncOneTask(app, task);
        } catch (err) {
          // Log and move on — one bad/failed task must not stall the loop.
          // syncOneTask/syncProduct already record per-product failure state in
          // shopify_product_garments, so this is best-effort observability only.
          app.log.error({ err, messageId, raw }, 'shopify:sync task failed');
        }

        await app.redisBlocking.xack(STREAM, GROUP, messageId);
      } catch (err) {
        app.log.error({ err }, 'shopify:sync consumer loop error — resuming');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  loop().catch((err) => app.log.error({ err }, 'shopify:sync consumer loop crashed'));

  return () => {
    running = false;
  };
}
