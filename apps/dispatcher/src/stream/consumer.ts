import { hostname } from 'node:os';
import type { Logger } from '@tryme/logger';
import type { Redis } from 'ioredis';
import type { ProcessorConfig } from '../job/processor.js';
import { getWorkers } from '../worker/registry.js';
import {
  DISPATCHER_GROUP,
  parseMessage,
  runStreamLoop,
  type StreamMessage,
  type XReadGroupResult,
} from './loop.js';

const GROUP = DISPATCHER_GROUP;
const CONSUMER = hostname();

// How often the consumer re-reads the worker registry to recompute its in-flight
// cap. Short enough that adding/removing a worker via the admin panel takes effect
// within seconds (no dispatcher restart), long enough to avoid hammering Redis.
const CONCURRENCY_REFRESH_MS = 5_000;

async function ensureGroups(redis: Redis, log: Logger): Promise<void> {
  for (const stream of ['jobs:priority', 'jobs:normal', 'jobs:low']) {
    try {
      await redis.xgroup('CREATE', stream, GROUP, '$', 'MKSTREAM');
      log.info({ stream }, 'consumer group created');
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, safe to ignore
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  }
}

async function readOne(redis: Redis): Promise<StreamMessage | null> {
  // 1. Check priority queue — instant, no block
  const priority = (await redis.xreadgroup(
    'GROUP',
    GROUP,
    CONSUMER,
    'COUNT',
    '1',
    'STREAMS',
    'jobs:priority',
    '>',
  )) as XReadGroupResult;
  const pMsg = parseMessage('jobs:priority', priority);
  if (pMsg) return pMsg;

  // 2. Check normal queue — instant, no block
  const normal = (await redis.xreadgroup(
    'GROUP',
    GROUP,
    CONSUMER,
    'COUNT',
    '1',
    'STREAMS',
    'jobs:normal',
    '>',
  )) as XReadGroupResult;
  const nMsg = parseMessage('jobs:normal', normal);
  if (nMsg) return nMsg;

  // 3. Block up to 2s on low queue
  const low = (await redis.xreadgroup(
    'GROUP',
    GROUP,
    CONSUMER,
    'COUNT',
    '1',
    'BLOCK',
    '2000',
    'STREAMS',
    'jobs:low',
    '>',
  )) as XReadGroupResult;
  return parseMessage('jobs:low', low);
}

/**
 * GPU lane consumer: reads jobs:priority → jobs:normal → jobs:low and caps in-flight
 * jobs to the number of registered ComfyUI workers. Catalog-video jobs do NOT ride
 * this lane — see runVideoConsumer in ./video-consumer.ts.
 */
export async function runConsumer(
  redis: Redis,
  cfg: ProcessorConfig,
  log: Logger,
): Promise<() => void> {
  await ensureGroups(redis, log);

  // In-flight cap = number of registered workers, read live from the registry so
  // scaling GPUs up/down via the admin panel takes effect without a restart.
  // Cached for CONCURRENCY_REFRESH_MS to avoid an HGETALL on every slot check.
  let concurrency = 0;
  let lastConcurrencyRefresh = 0;

  async function getConcurrency(): Promise<number> {
    const now = Date.now();
    if (now - lastConcurrencyRefresh >= CONCURRENCY_REFRESH_MS) {
      lastConcurrencyRefresh = now;
      try {
        const next = (await getWorkers(redis)).size;
        if (next !== concurrency) {
          log.info({ from: concurrency, to: next }, 'consumer concurrency updated from registry');
          concurrency = next;
        }
      } catch (err) {
        log.warn({ err }, 'failed to refresh concurrency from registry — keeping current');
      }
    }
    return concurrency;
  }

  return runStreamLoop(cfg, log, {
    name: 'gpu',
    read: () => readOne(redis),
    getConcurrency,
  });
}
