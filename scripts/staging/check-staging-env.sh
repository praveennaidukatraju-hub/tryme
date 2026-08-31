#!/usr/bin/env bash
# Refuse to deploy staging unless its env file is demonstrably not production's.
#
# The staging database is an unscrubbed copy of production: real customer emails,
# real merchant records, real payment history. Nothing in the DATA stops staging
# from acting on it — the outbound credentials are the only barrier. So the deploy
# stops here, before any container is built, if those credentials look like prod's.
#
# Usage: check-staging-env.sh <staging-env-file> <prod-env-file>
set -euo pipefail

staging_file="${1:?usage: check-staging-env.sh <staging-env-file> <prod-env-file>}"
prod_file="${2:?usage: check-staging-env.sh <staging-env-file> <prod-env-file>}"

for f in "$staging_file" "$prod_file"; do
  [ -r "$f" ] || { echo "guardrail: cannot read $f" >&2; exit 1; }
done

# Read a KEY=value from an env file, last occurrence wins (dotenv semantics).
# Prints nothing when the key is absent.
read_var() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- | tr -d '\r"' || true
}

failed=0
reject() { echo "guardrail: $1" >&2; failed=1; }

# 1. Explicit staging marker. Cheapest possible check against a file copied
#    wholesale from production.
[ "$(read_var TRYME_ENV "$staging_file")" = "staging" ] \
  || reject "TRYME_ENV must be exactly 'staging' in $staging_file"

# 2. Compose project name. This is the highest-consequence check in the file.
#    Compose resolves the project name from COMPOSE_PROJECT_NAME above the `name:`
#    key in the YAML, so a value left at production's turns every staging compose
#    command — build, up, down, run — into an operation on the production stack.
[ "$(read_var COMPOSE_PROJECT_NAME "$staging_file")" = "tryme-staging" ] \
  || reject "COMPOSE_PROJECT_NAME must be exactly 'tryme-staging' in $staging_file; anything else points the staging deploy at another Compose project"

# 3. Razorpay must be test mode. A live key here charges real cards.
if grep -q 'rzp_live_' "$staging_file"; then
  reject "found a live Razorpay key (rzp_live_) in $staging_file; staging must use test keys"
fi

# 4. Shopify must be a separate dev app. Sharing prod's app means staging OAuth
#    callbacks and webhooks target real merchant installs.
staging_shopify="$(read_var SHOPIFY_API_KEY "$staging_file")"
prod_shopify="$(read_var SHOPIFY_API_KEY "$prod_file")"
if [ -n "$prod_shopify" ] && [ "$staging_shopify" = "$prod_shopify" ]; then
  reject "SHOPIFY_API_KEY is identical to production's; staging needs its own Shopify dev app"
fi

# 5. Outbound mail must not use the production sender. The snapshot is full of
#    real customer addresses.
staging_from="$(read_var EMAIL_FROM "$staging_file")"
prod_from="$(read_var EMAIL_FROM "$prod_file")"
if [ -n "$prod_from" ] && [ "$staging_from" = "$prod_from" ]; then
  reject "EMAIL_FROM is identical to production's; staging must send from a non-production address"
fi

if [ "$failed" -ne 0 ]; then
  echo "guardrail: staging deploy aborted; no container was touched" >&2
  exit 1
fi

echo "guardrail: .env.staging passed all checks"
