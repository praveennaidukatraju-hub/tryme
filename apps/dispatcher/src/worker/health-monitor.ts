import type { Logger } from '@tryme/logger';
import { queueDepth, workersHealthy } from '@tryme/observability';
import type { Redis } from 'ioredis';
import { getWorkers, healthKey } from './registry.js';

const PROBE_INTERVAL_MS = 15_000;
const HEALTH_TTL_SEC = 30;
const JOB_STREAMS = ['jobs:priority', 'jobs:normal', 'jobs:low', 'jobs:video'] as const;

async function probeWorker(_workerId: string, workerUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/system_stats`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function startHealthMonitor(redis: Redis, log: Logger): () => void {
  let running = true;

  async function tick() {
    const workers = await getWorkers(redis);
    let healthyCount = 0;
    for (const [id, entry] of workers) {
      if (entry.status === 'DRAINING') continue;
      const healthy = await probeWorker(id, entry.url, entry.apiKey);
      if (healthy) {
        healthyCount++;
        await redis.setex(healthKey(id), HEALTH_TTL_SEC, '1');
        log.info({ workerId: id }, 'worker healthy');
      } else {
        log.warn({ workerId: id }, 'worker unhealthy — health key not renewed');
      }
    }
    workersHealthy.set(healthyCount);

    // Sample queue depth for each job stream
    for (const stream of JOB_STREAMS) {
      try {
        queueDepth.set({ stream }, await redis.xlen(stream));
      } catch (err) {
        log.warn({ err, stream }, 'failed to sample queue depth');
      }
    }
  }

  const interval = setInterval(async () => {
    if (!running) return;
    try {
      await tick();
    } catch (err) {
      log.error({ err }, 'health monitor tick error');
    }
  }, PROBE_INTERVAL_MS);

  // Run immediately on start
  tick().catch((err) => log.error({ err }, 'health monitor initial tick error'));

  return () => {
    running = false;
    clearInterval(interval);
  };
}
