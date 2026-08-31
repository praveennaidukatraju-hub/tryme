import { resolve } from 'node:path';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Vitest's globalSetup runs once in the main process, before setupFiles/workers exist.
config({ path: resolve(process.cwd(), '../../.env') });

export const TEST_TEMPLATE_DB = 'tryon_test_template';

function adminUrl(): string {
  const pgPort = process.env.POSTGRES_PORT ?? '5432';
  const pgUser = process.env.POSTGRES_USER ?? 'tryon';
  const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tryon_dev_pw';
  const pgDb = process.env.POSTGRES_DB ?? 'tryon_dev';
  return `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${pgDb}`;
}

// Runs the full migration chain exactly once per test run into a template
// database; per-file setup (test/helpers/containers.ts) then clones it via
// `CREATE DATABASE ... TEMPLATE`, which Postgres does as a file copy instead
// of replaying 150+ migrations. That replay-per-file was the actual cost
// behind test-api's multi-minute runtime, not test execution itself.
export async function setup(): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_TEMPLATE_DB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${TEST_TEMPLATE_DB}"`);
  await admin.end();

  const pgPort = process.env.POSTGRES_PORT ?? '5432';
  const pgUser = process.env.POSTGRES_USER ?? 'tryon';
  const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tryon_dev_pw';
  const templateUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${TEST_TEMPLATE_DB}`;
  const client = postgres(templateUrl, { max: 1 });
  await migrate(drizzle(client), {
    migrationsFolder: './node_modules/@tryme/db/src/migrations',
  });
  await client.end();
}

export async function teardown(): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_TEMPLATE_DB}" WITH (FORCE)`);
  await admin.end();
}
