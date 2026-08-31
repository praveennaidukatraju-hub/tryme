import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { DB } from '@tryme/db';
import { createDb } from '@tryme/db';
import type { StorageProvider } from '@tryme/storage';
import { createR2Provider } from '@tryme/storage';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface TestEnv {
  db: DB;
  closeDb: () => Promise<void>;
  redisUrl: string;
  storage: StorageProvider;
  s3: S3Client;
  r2Bucket: string;
  r2Endpoint: string;
  cleanup: () => Promise<void>;
}

export async function setupTestEnv(): Promise<TestEnv> {
  const dbName = `disp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Matches docker-compose.yml's POSTGRES_PORT override (default 5432) — some
  // local setups remap this to avoid colliding with a natively-installed
  // Postgres, so it must not be hardcoded.
  const pgPort = process.env.POSTGRES_PORT ?? '5432';
  const adminUrl = `postgres://tryon:tryon_dev_pw@127.0.0.1:${pgPort}/tryon_dev`;

  const adminClient = postgres(adminUrl, { max: 1 });
  await adminClient.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  const pgUrl = `postgres://tryon:tryon_dev_pw@127.0.0.1:${pgPort}/${dbName}`;
  const migClient = postgres(pgUrl, { max: 1 });
  await migrate(drizzle(migClient), {
    migrationsFolder: './node_modules/@tryme/db/src/migrations',
  });
  await migClient.end();

  const { db, close: closeDb } = createDb(pgUrl);

  const r2Endpoint = 'http://127.0.0.1:9000';
  const bucket = `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const s3 = new S3Client({
    endpoint: r2Endpoint,
    region: 'auto',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin_dev_pw' },
    forcePathStyle: true,
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  const storage = createR2Provider({
    endpoint: r2Endpoint,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin_dev_pw',
    bucket,
    publicUrl: `${r2Endpoint}/${bucket}`,
    forcePathStyle: true,
  });

  return {
    db,
    closeDb,
    redisUrl: 'redis://127.0.0.1:6379',
    storage,
    s3,
    r2Bucket: bucket,
    r2Endpoint,
    cleanup: async () => {
      await closeDb();
      const cl = postgres(adminUrl, { max: 1 });
      await cl.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cl.end();
      try {
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } catch {
        /* ignore */
      }
    },
  };
}
