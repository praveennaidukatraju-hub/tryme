#!/usr/bin/env bash
# Blocks direct `git push` to main. GitHub branch protection isn't available
# on this private repo without a paid plan (see docs/progress.md), so this is
# the local stand-in: merge into main via PR, not `git push origin main`.
set -euo pipefail

if [ "${ALLOW_DIRECT_MAIN_PUSH:-}" = "1" ]; then
  exit 0
fi

blocked=0
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    blocked=1
  fi
done

if [ "$blocked" = "1" ]; then
  echo "✖ Direct push to 'main' is blocked — open a PR instead." >&2
  echo "  Emergency override: ALLOW_DIRECT_MAIN_PUSH=1 git push ..." >&2
  exit 1
fi
