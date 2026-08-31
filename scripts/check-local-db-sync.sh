#!/usr/bin/env bash
#
# Pre-push guard: block push when local DB is behind local migration files.
#
# Scenario: dev pulled a teammate's migration (SQL file now exists locally)
# but forgot to run `pnpm db:migrate`. Local DB is behind local code.
# Pushing in this state means your environment is inconsistent and you may
# break things when you eventually do migrate (hash drift, missing columns, etc).
#
# Hard-blocking: exits 1 when unapplied migrations detected.
# Skips silently if DATABASE_URL is unset or DB is unreachable (e.g. CI, offline).

set -euo pipefail

MIG_DIR="packages/db/src/migrations"

# Load DATABASE_URL from .env if not already set
if [ -z "${DATABASE_URL:-}" ] && [ -f ".env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
fi

# Can't check without a DB URL — skip silently
[ -z "${DATABASE_URL:-}" ] && exit 0

# Count .sql migration files on disk
local_count="$(find "$MIG_DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
[ "$local_count" -eq 0 ] && exit 0

# Query how many migrations Drizzle has recorded in the DB.
# Silently skip if DB is unreachable (Docker not running, etc).
applied_count="$(psql "$DATABASE_URL" -t -c \
  "SELECT COUNT(*) FROM drizzle.__drizzle_migrations" 2>/dev/null \
  | tr -d ' \n')" || applied_count=""

[ -z "$applied_count" ] && exit 0

if [ "$local_count" -gt "$applied_count" ]; then
  pending=$(( local_count - applied_count ))
  red="\033[31m"; bold="\033[1m"; reset="\033[0m"
  printf "${red}${bold}\n"
  printf "  ✖  Push blocked: local DB is behind by %d migration(s).\n\n" "$pending"
  printf "  You have %d .sql file(s) but only %d applied in your local DB.\n\n" \
    "$local_count" "$applied_count"
  printf "  Apply migrations first:\n\n"
  printf "        pnpm db:migrate\n"
  printf "${reset}\n"
  exit 1
fi

exit 0
