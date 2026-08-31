import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface JournalEntry {
  idx: number;
  tag: string;
}

export interface Journal {
  entries: JournalEntry[];
}

const JOURNAL_PATH = 'packages/db/src/migrations/meta/_journal.json';

export function parseJournal(raw: string): Journal {
  return JSON.parse(raw) as Journal;
}

/**
 * Server's migration index is canonical (docs/version-control.md). A branch that
 * picked the same idx as a migration already on `dev` — but for a different
 * migration — needs to renumber upward, not collide with it at merge time.
 */
export function findCollisions(local: Journal, upstream: Journal): JournalEntry[] {
  const upstreamByIdx = new Map(upstream.entries.map((e) => [e.idx, e.tag]));
  return local.entries.filter((entry) => {
    const upstreamTag = upstreamByIdx.get(entry.idx);
    return upstreamTag !== undefined && upstreamTag !== entry.tag;
  });
}

function readUpstreamJournal(ref: string): Journal | undefined {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${JOURNAL_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseJournal(raw);
  } catch {
    return undefined;
  }
}

function main(): void {
  const upstreamRef = process.env.MIGRATION_INDEX_BASE_REF ?? 'origin/dev';

  try {
    execFileSync('git', ['fetch', '--depth=50', 'origin', 'dev'], { stdio: 'ignore' });
  } catch {
    // best-effort — the ref may already be present locally (e.g. running on dev itself)
  }

  const upstream = readUpstreamJournal(upstreamRef);
  if (!upstream) {
    console.log(
      `check-migration-index: could not read ${upstreamRef}:${JOURNAL_PATH} (likely running on dev itself, or ref unavailable) — skipping`,
    );
    return;
  }

  const local = parseJournal(readFileSync(JOURNAL_PATH, 'utf8'));
  const collisions = findCollisions(local, upstream);

  if (collisions.length === 0) {
    console.log(
      `check-migration-index: no collisions against ${upstreamRef} (checked ${local.entries.length} local entries)`,
    );
    return;
  }

  console.error(
    `::error::${collisions.length} migration index collision(s) against ${upstreamRef} — same idx, different migration:`,
  );
  for (const entry of collisions) {
    console.error(`  idx ${entry.idx}: local has "${entry.tag}"`);
  }
  console.error(
    "Server's migration index is canonical. Rename your migration file(s) and _journal.json entries " +
      'to start after the highest idx on dev, then re-run `pnpm db:generate` bookkeeping if needed. ' +
      'See "Migration Index Conflicts" in docs/version-control.md.',
  );
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('check-migration-index.mts')) {
  main();
}
