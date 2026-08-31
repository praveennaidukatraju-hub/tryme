import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export interface Containers {
  pgUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}

export async function startContainers(): Promise<Containers> {
  const dbName = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const adminUrl = 'postgres://tryon:tryon_dev_pw@127.0.0.1:5432/tryon_dev';
  const adminClient = postgres(adminUrl, { max: 1 });
  await adminClient.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  const pgUrl = `postgres://tryon:tryon_dev_pw@127.0.0.1:5432/${dbName}`;
  const client = postgres(pgUrl, { max: 1 });
  await migrate(drizzle(client), {
    migrationsFolder: './node_modules/@tryme/db/src/migrations',
  });
  await client.end();

  return {
    pgUrl,
    redisUrl: 'redis://127.0.0.1:6379',
    stop: async () => {
      const cleanup = postgres(adminUrl, { max: 1 });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
