#!/usr/bin/env bash
#
# Pre-push guard: only run a workspace's test suite if this push actually
# touches that workspace (or a shared package it depends on). Without this,
# lefthook's pre-push hook re-ran the full apps/api unit suite (67 files,
# ~3-9 min) unconditionally on every single push to a branch — including
# pushes that only changed a doc file — which is exactly the kind of dead
# weight CI already covers on every PR regardless of what this hook does
# locally. This only trims the local pre-push loop; it does not touch
# .github/workflows/ci.yml, which still runs everything on every PR.
#
# Usage: run-tests-if-changed.sh <pnpm-workspace-filter> <path-prefix> [<path-prefix> ...]
# Example: run-tests-if-changed.sh @tryme/api apps/api/ packages/db/

set -euo pipefail

FILTER="$1"
shift
PREFIXES=("$@")

if git rev-parse --verify "@{u}" >/dev/null 2>&1; then
  RANGE="@{u}..HEAD"
else
  # No upstream yet (first push of a brand-new branch) — compare against dev,
  # the common base for feature branches in this repo.
  git fetch origin dev --quiet 2>/dev/null || true
  if git rev-parse --verify origin/dev >/dev/null 2>&1; then
    BASE="$(git merge-base origin/dev HEAD)"
    RANGE="$BASE..HEAD"
  else
    RANGE=""
  fi
fi

if [ -z "$RANGE" ]; then
  echo "run-tests-if-changed: no comparison base found — running $FILTER tests to be safe"
  exec pnpm --filter "$FILTER" test:unit
fi

CHANGED="$(git diff --name-only $RANGE)"
if [ -z "$CHANGED" ]; then
  echo "run-tests-if-changed: nothing new to push — skipping $FILTER tests"
  exit 0
fi

for prefix in "${PREFIXES[@]}"; do
  if echo "$CHANGED" | grep -q "^$prefix"; then
    exec pnpm --filter "$FILTER" test:unit
  fi
done

echo "run-tests-if-changed: no changes under [${PREFIXES[*]}] in this push — skipping $FILTER tests"
exit 0
