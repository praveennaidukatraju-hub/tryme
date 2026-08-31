/**
 * CI/CD migration verification — run after pnpm db:migrate.
 * Exits with code 1 if any journal entry's hash is not recorded in the DB.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? '';
const client = postgres(url, { max: 1 });

const migrationsDir = join(import.meta.dirname, './migrations');

const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }>;
};

const rows = await client<{ hash: string }[]>`
  SELECT hash FROM drizzle.__drizzle_migrations
`;
const appliedHashes = new Set(rows.map((r) => r.hash));

await client.end();

const missing: string[] = [];
for (const entry of journal.entries) {
  const sqlContent = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
  const hash = createHash('sha256').update(sqlContent).digest('hex');
  if (!appliedHashes.has(hash)) {
    missing.push(entry.tag);
  }
}

if (missing.length > 0) {
  console.error(`\n❌ ${missing.length} migration(s) not applied to the database:`);
  for (const m of missing) console.error(`   - ${m}`);
  console.error('\nRun pnpm db:migrate and redeploy.\n');
  process.exit(1);
}

console.log(`✓ All ${journal.entries.length} migrations verified.`);
