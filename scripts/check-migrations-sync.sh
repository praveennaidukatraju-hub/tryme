#!/usr/bin/env bash
#
# Pre-push guard: warn when origin has migration files this branch is missing.
#
# Scenario this protects against: a teammate pushed a DB migration, your local
# branch (and local DB) hasn't caught up. If you push/deploy on top without
# pulling + applying it, you get the schema/drizzle hash drift that crashes the
# API on `pnpm migrate`. This nudges you to `git pull --rebase` and re-run
# `pnpm db:migrate` before continuing.
#
# Non-blocking: prints a loud warning and exits 0. (A push that's behind origin
# will fail on non-fast-forward anyway.)

set -euo pipefail

MIG_DIR="packages/db/src/migrations"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Best-effort fetch of just this branch; skip silently if offline / no remote.
git fetch origin "$BRANCH" --quiet 2>/dev/null || exit 0

UPSTREAM="origin/$BRANCH"
git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1 || exit 0

# Nothing to do if we're not behind origin.
behind="$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)"
[ "$behind" -eq 0 ] && exit 0

# Migration .sql files present on origin but not on this branch.
new_migs="$(git diff --name-only --diff-filter=A "HEAD..$UPSTREAM" -- "$MIG_DIR" \
  | grep '\.sql$' || true)"

[ -z "$new_migs" ] && exit 0

yellow="\033[33m"; bold="\033[1m"; reset="\033[0m"
printf "${yellow}${bold}\n"
printf "  ⚠  origin/%s is ahead and has new DB migration(s) you don't have:\n\n" "$BRANCH"
printf '%s\n' "$new_migs" | sed 's/^/        /'
printf "\n  Pull and apply them before continuing so your local DB stays in sync:\n\n"
printf "        git pull --rebase\n"
printf "        pnpm db:migrate\n"
printf "${reset}\n"

exit 0
