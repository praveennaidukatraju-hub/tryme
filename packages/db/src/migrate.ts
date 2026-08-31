/**
 * Hash-based migration runner — replaces Drizzle's built-in migrate().
 *
 * WHY: Drizzle's built-in algorithm records only the LAST applied migration's
 * created_at timestamp and skips any migration whose `when` ≤ that value.
 * This silently drops migrations pulled from a branch with an older timestamp
 * than the last locally-applied migration (e.g. a hotfix branch merging after
 * a feature branch already moved the timestamp forward).
 *
 * This implementation compares ALL applied hashes against every journal entry,
 * so timestamp order never matters.
 *
 * IDEMPOTENT DDL: If a migration's SQL fails with a Postgres "already exists"
 * error (42P07 duplicate table, 42701 duplicate column, etc.) the hash is still
 * recorded. This handles environments where migrations were applied manually or
 * by the old timestamp-based runner but were never tracked.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// Postgres schema-mismatch codes — the migration was already applied or has
// been superseded by a later migration. Record the hash and move on.
//
// "already exists" — object was created by a prior run or manual apply.
// "does not exist"  — object was created by this migration then dropped by a
//                     later one; the net effect is already in the DB.
const ALREADY_EXISTS_CODES = new Set([
  '42P07', // duplicate_table
  '42701', // duplicate_column
  '42710', // duplicate_object (e.g. duplicate index)
  '42P04', // duplicate_database
  '42723', // duplicate_function
  '42P06', // duplicate_schema
  '42P01', // undefined_table  — table no longer exists (dropped by later migration)
  '42703', // undefined_column — column no longer exists (dropped by later migration)
  '42704', // undefined_object (e.g. index already dropped)
]);

const url = process.env.DATABASE_URL ?? '';
const client = postgres(url, { max: 1 });

const migrationsDir = join(import.meta.dirname, './migrations');

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}
const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};

// Ensure tracking table exists (idempotent — same DDL as Drizzle uses)
await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
await client`
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )
`;

// Fetch ALL applied hashes — not just the last one
const rows = await client<{ hash: string }[]>`
  SELECT hash FROM drizzle.__drizzle_migrations
`;
const appliedHashes = new Set(rows.map((r) => r.hash));

let applied = 0;
let skipped = 0;

for (const entry of journal.entries) {
  const sqlContent = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
  const hash = createHash('sha256').update(sqlContent).digest('hex');

  if (appliedHashes.has(hash)) continue;

  const statements = entry.breakpoints
    ? sqlContent.split('--> statement-breakpoint')
    : [sqlContent];

  try {
    await client.begin(async (tx) => {
      for (const stmt of statements) {
        const s = stmt.trim();
        if (s) await tx.unsafe(s);
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
    });
    console.log(`Applied  ${entry.tag}`);
    applied++;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (ALREADY_EXISTS_CODES.has(code ?? '')) {
      // Schema change was already applied (manually or by prior run that crashed
      // before recording). Record the hash so future runs skip it cleanly.
      await client`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      console.log(
        `Recorded ${entry.tag} (schema mismatch — already applied or superseded, hash was missing)`,
      );
      skipped++;
    } else {
      await client.end();
      throw err;
    }
  }

  appliedHashes.add(hash);
}

await client.end();

const total = applied + skipped;
if (total === 0) {
  console.log('No pending migrations — database is up to date.');
} else {
  console.log(`Done: ${applied} applied, ${skipped} reconciled.`);
}
