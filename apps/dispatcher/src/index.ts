import { setDefaultResultOrder } from 'node:dns';
import { hostname } from 'node:os';
import { S3Client } from '@aws-sdk/client-s3';
import * as Sentry from '@sentry/node';
import { createLogger } from '@tryme/logger';
import { Agent, setGlobalDispatcher } from 'undici';

// Node's built-in fetch (undici) ignores NODE_TLS_REJECT_UNAUTHORIZED set via dotenv
// because undici is initialised before env vars load. Override the global dispatcher
// at the earliest possible moment so all subsequent fetch() calls inherit it.
if (process.env.NODE_ENV !== 'production' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

import { schema } from '@tryme/db';
import type { WorkerPool } from '@tryme/types';
import { eq } from 'drizzle-orm';
import { loadEnv } from './env.js';
import { startHealthServer } from './health/server.js';
import { promoteSareeStep2Jobs } from './job/saree-step2-promoter.js';
import { makeDb } from './lib/db.js';
import { makeRedis } from './lib/redis.js';
import { makeStorage } from './lib/storage.js';
import { runShopifyRetention } from './shopify/retention.js';
import { runConsumer } from './stream/consumer.js';
import { recoverPendingJobs } from './stream/recovery.js';
import { runSweeper } from './stream/sweeper.js';
import { runVideoConsumer } from './stream/video-consumer.js';
import { runWebhooksConsumer } from './stream/webhooks.js';
import { startHealthMonitor } from './worker/health-monitor.js';
import { registerWorkers } from './worker/registry.js';
import { initWatermarkTile } from './workflow/watermark.js';

// Containers here have no IPv6 route, but external hosts we call (ComfyUI
// tunnels, PixVerse, R2/MinIO) can resolve AAAA. Node's Happy-Eyeballs default
// races both families with only ~250ms before falling back to IPv4 — a window
// a dead IPv6 attempt can occasionally lose outright, surfacing as a spurious
// ETIMEDOUT on an otherwise-healthy outbound call. Forcing IPv4-first removes
// the race instead of racing a leg that can never win.
setDefaultResultOrder('ipv4first');

const log = createLogger('dispatcher', { hostname: hostname() });

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
    });
  }
  log.info({ NODE_ENV: env.NODE_ENV }, 'dispatcher starting');

  if (env.ENABLE_WATERMARKING) {
    try {
      await initWatermarkTile();
      log.info('watermark tile initialized');
    } catch (err) {
      log.fatal(
        { err },
        'failed to initialize watermark tile; ENABLE_WATERMARKING is true, failing closed',
      );
      process.exit(1);
    }
  }

  if (!env.PIXVERSE_API_KEY) {
    log.warn(
      'PIXVERSE_API_KEY is not set — catalog-video jobs will fail fast with PIXVERSE_NOT_CONFIGURED',
    );
  }

  const { db, close: closeDb } = makeDb(env);
  const { main: redis, pub, close: closeRedis } = makeRedis(env);
  const storage = makeStorage(env);
  const s3 = new S3Client({
    endpoint: env.R2_ENDPOINT,
    region: 'auto',
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: env.R2_FORCE_PATH_STYLE,
    // Default NodeHttpHandler timeouts are 0 (disabled) — a stalled R2 connection would
    // otherwise hang r2Download() forever, parking the job in PREPROCESSING with no error
    // and no retry until the 15-min sweeper SLA. Mirror the bounded timeouts already used
    // for every ComfyUI HTTP call (comfyui/client.ts).
    requestHandler: {
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
      throwOnRequestTimeout: true,
      socketTimeout: 60_000,
    },
  });

  // Load workers from DB (source of truth — managed via admin panel)
  const dbWorkers = await db.select().from(schema.workers).where(eq(schema.workers.isActive, true));
  const workers = dbWorkers.map((w) => ({
    id: w.id,
    url: w.url,
    apiKey: w.apiKey,
    // schema.workers.allowedJobTypes is a raw `text[]` column (Drizzle types it as
    // string[]); values are only constrained to WorkerPool by workerPoolSchema at
    // the admin API write boundary (apps/api/src/modules/admin/workers.routes.ts),
    // not by the DB/schema layer itself. Cast here, at the one place a DB read
    // crosses into the precisely-typed dispatcher registry, rather than widening
    // WorkerEntry/registerWorkers back to string[].
    allowedJobTypes: (w.allowedJobTypes ?? []) as WorkerPool[],
  }));
  if (workers.length === 0) {
    log.warn('No active workers found in DB — add workers via admin panel');
  }
  await registerWorkers(redis, workers);
  log.info({ workerIds: workers.map((w) => w.id) }, 'workers registered from DB');

  // Startup connectivity check — verify each worker is reachable before accepting jobs
  for (const w of workers) {
    try {
      const res = await fetch(`${w.url.replace(/\/$/, '')}/system_stats`, {
        headers: { 'X-Api-Key': w.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        log.info({ workerId: w.id, url: w.url }, 'ComfyUI worker reachable ✓');
      } else {
        log.warn(
          { workerId: w.id, url: w.url, status: res.status },
          'ComfyUI worker responded with non-OK status',
        );
      }
    } catch (err) {
      log.warn(
        { workerId: w.id, url: w.url, err },
        'ComfyUI worker unreachable — health monitor will retry',
      );
    }
  }

  const processorCfg = {
    db,
    redis,
    pub,
    storage,
    s3,
    r2Bucket: env.R2_BUCKET,
    log,
  };

  // Crash recovery: reclaim stale XPENDING entries from a previous run
  await recoverPendingJobs(redis, processorCfg, env.XPENDING_CLAIM_THRESHOLD_MS, log);

  // Start subsystems
  const stopHealthMonitor = startHealthMonitor(redis, log);
  const stopConsumer = await runConsumer(redis, processorCfg, log);
  // Separate lane: PixVerse video jobs need no GPU worker, so they must not be
  // gated by the GPU consumer's registry-derived in-flight cap.
  const stopVideoConsumer = await runVideoConsumer(redis, processorCfg, log, {
    concurrency: env.VIDEO_CONCURRENCY,
  });
  const stopWebhooks = await runWebhooksConsumer(db, redis, log);
  const stopHealthServer = startHealthServer(env.DISPATCHER_HEALTH_PORT, log);

  const sweeperInterval = setInterval(
    () => {
      void runSweeper(db, pub, log);
    },
    5 * 60 * 1000,
  );

  const recoveryInterval = setInterval(() => {
    void recoverPendingJobs(redis, processorCfg, env.XPENDING_CLAIM_THRESHOLD_MS, log);
  }, 60_000);

  const sareeStep2Interval = setInterval(() => {
    void promoteSareeStep2Jobs(processorCfg);
  }, 5_000);

  // Hourly: retention is a slow-moving daily-granularity policy, so a tighter
  // cadence would just re-scan stores with nothing to do.
  const shopifyRetentionInterval = setInterval(
    () => {
      void runShopifyRetention(db, storage, log);
    },
    60 * 60 * 1000,
  );

  log.info('dispatcher ready');

  async function shutdown(signal: string): Promise<void> {
    log.info({ signal }, 'shutting down dispatcher');
    clearInterval(sweeperInterval);
    clearInterval(recoveryInterval);
    clearInterval(sareeStep2Interval);
    clearInterval(shopifyRetentionInterval);
    stopConsumer();
    stopVideoConsumer();
    stopWebhooks();
    stopHealthMonitor();
    stopHealthServer();
    await closeRedis();
    await closeDb();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => log.error({ err }, 'shutdown error'));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => log.error({ err }, 'shutdown error'));
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'unhandled rejection');
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
}

main().catch(async (err) => {
  log.error({ err }, 'dispatcher crashed');
  Sentry.captureException(err);
  await Sentry.close(2000).catch(() => {});
  process.exit(1);
});
