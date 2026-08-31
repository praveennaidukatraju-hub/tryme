import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import postgres from 'postgres';
import { TEST_TEMPLATE_DB } from '../global-setup.js';

const REDIS_POOL_SIZE = 14;
// Comfortably above any single integration file's observed runtime (seconds, not
// minutes) — a lease outliving its file only matters if that file's own stop()
// never runs at all, in which case this is how long the index stays wasted.
const LEASE_TTL_SECONDS = 180;

function leaseKey(index: number): string {
  return `__vitest_redis_lease__:${index}`;
}

// TTL leases rather than an explicit claim/release list: a prior explicit-list
// design leaked slots permanently whenever a file's own afterAll threw before
// reaching stop() (e.g. `await app.close()` on a never-built app, from a
// beforeAll that failed after claiming an index) — one such file was enough to
// starve every later file in the run. A `SET ... NX EX` lease self-expires, so
// a leaked claim is merely wasted for LEASE_TTL_SECONDS, never permanently.
async function claimRedisIndex(): Promise<number> {
  const coordinator = new Redis('redis://127.0.0.1:6379/15', { maxRetriesPerRequest: 1 });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (let index = 1; index <= REDIS_POOL_SIZE; index++) {
        const claimed = await coordinator.set(leaseKey(index), '1', 'EX', LEASE_TTL_SECONDS, 'NX');
        if (claimed === 'OK') {
          return index;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for a free test Redis DB index');
  } finally {
    coordinator.disconnect();
  }
}

async function releaseRedisIndex(index: number): Promise<void> {
  const coordinator = new Redis('redis://127.0.0.1:6379/15', { maxRetriesPerRequest: 1 });
  try {
    await coordinator.del(leaseKey(index));
  } finally {
    coordinator.disconnect();
  }
}

export interface Containers {
  pgUrl: string;
  redisUrl: string;
  r2Endpoint: string;
  r2Key: string;
  r2Secret: string;
  r2Bucket: string;
  stop: () => Promise<void>;
}

export async function startContainers(): Promise<Containers> {
  const dbName = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Postgres host port is configurable via .env (POSTGRES_PORT) — defaults to the
  // docker-compose default of 5432, but local setups sometimes remap it (e.g. 5433)
  // to avoid colliding with a system-wide Postgres install.
  const pgPort = process.env.POSTGRES_PORT ?? '5432';
  const pgUser = process.env.POSTGRES_USER ?? 'tryon';
  const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tryon_dev_pw';
  const pgDb = process.env.POSTGRES_DB ?? 'tryon_dev';

  // Create fresh test database in existing Postgres
  const adminUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${pgDb}`;
  const adminClient = postgres(adminUrl, { max: 1 });
  // Clones the pre-migrated template (test/global-setup.ts) via Postgres's file-copy
  // CREATE DATABASE, instead of replaying the full migration chain per file.
  await adminClient.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEST_TEMPLATE_DB}"`);
  await adminClient.end();

  const pgUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${dbName}`;

  const r2Endpoint = 'http://127.0.0.1:9000';
  const s3 = new S3Client({
    endpoint: r2Endpoint,
    region: 'auto',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin_dev_pw' },
    forcePathStyle: true,
  });

  const bucket = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  // Dedicated DB index, never 0 (dev/prod default) or 15 (coordinator pool,
  // above) — tests do destructive redis.del('jobs:normal'/'jobs:priority')
  // as setup, which previously wiped out a live dev dispatcher's consumer group
  // running against the same Redis. Claimed atomically from a shared pool
  // (rather than derived from VITEST_POOL_ID) so two files can never hold the
  // same index while both are active, regardless of how Vitest schedules them —
  // an assumption that a worker only ever runs one file at a time turned out not
  // to hold, and files sharing an index raced on jobs:*/config:system keys.
  const redisIndex = await claimRedisIndex();

  return {
    pgUrl,
    redisUrl: `redis://127.0.0.1:6379/${redisIndex}`,
    r2Endpoint,
    r2Key: 'minioadmin',
    r2Secret: 'minioadmin_dev_pw',
    r2Bucket: bucket,
    stop: async () => {
      try {
        const cleanupClient = postgres(adminUrl, { max: 1 });
        await cleanupClient.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await cleanupClient.end();
        try {
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        } catch {
          /* ignore */
        }
      } finally {
        // Always release, even if DB/bucket cleanup above threw — an unreleased
        // lease only self-heals after LEASE_TTL_SECONDS (see claimRedisIndex).
        await releaseRedisIndex(redisIndex);
      }
    },
  };
}
