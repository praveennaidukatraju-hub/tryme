#!/usr/bin/env bash
# Refresh staging from production. Run by an operator on the VPS, never by CI.
#
# Production is touched READ-ONLY: one pg_dump and one mc mirror source. Nothing
# in this script writes to a prod container, volume or bucket.
#
# Usage:
#   scripts/staging/sync-from-prod.sh            # perform the sync
#   scripts/staging/sync-from-prod.sh --dry-run  # print what would run, change nothing
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

STAGING_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGING_ENV="$STAGING_ROOT/.env.staging"
# Prod and staging are separate CloudPanel sites with their own per-site home
# directories, not siblings under a shared parent:
#   /home/tryme-app/htdocs/app.tryme.com                  (prod, branch main)
#   /home/tryme-staging-app/htdocs/staging-app.tryme.com  (staging, branch dev)
PROD_ROOT="${PROD_ROOT:-/home/tryme-app/htdocs/app.tryme.com}"
PROD_ENV="$PROD_ROOT/.env.production"
[ -r "$PROD_ENV" ] || { echo "cannot read $PROD_ENV — set PROD_ROOT to the production clone" >&2; exit 1; }

COMPOSE="docker compose -f $STAGING_ROOT/infra/docker-compose.staging.yml --env-file $STAGING_ENV"
umask 077
DUMP="$(mktemp /tmp/tryme-prod-XXXXXX.dump)"
trap 'rm -f "$DUMP"' EXIT

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: $*"
  else
    "$@"
  fi
}

env_var() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- | tr -d '\r"'
}

echo "→ verifying staging env before touching anything"
run bash "$STAGING_ROOT/scripts/staging/check-staging-env.sh" "$STAGING_ENV" "$PROD_ENV"

PROD_PG_USER="$(env_var POSTGRES_USER "$PROD_ENV")"
PROD_PG_DB="$(env_var POSTGRES_DB "$PROD_ENV")"
STAGING_PG_USER="$(env_var POSTGRES_USER "$STAGING_ENV")"
STAGING_PG_DB="$(env_var POSTGRES_DB "$STAGING_ENV")"
PROD_MINIO_USER="$(env_var MINIO_ROOT_USER "$PROD_ENV")"
PROD_MINIO_PASS="$(env_var MINIO_ROOT_PASSWORD "$PROD_ENV")"
PROD_BUCKET="$(env_var R2_BUCKET "$PROD_ENV")"
STAGING_MINIO_USER="$(env_var MINIO_ROOT_USER "$STAGING_ENV")"
STAGING_MINIO_PASS="$(env_var MINIO_ROOT_PASSWORD "$STAGING_ENV")"
STAGING_BUCKET="$(env_var R2_BUCKET "$STAGING_ENV")"

# 1 ── dump production (read-only)
echo "→ dumping prod database $PROD_PG_DB"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: docker exec tryme-prod-postgres pg_dump -Fc -U $PROD_PG_USER $PROD_PG_DB > $DUMP"
else
  docker exec tryme-prod-postgres pg_dump -Fc -U "$PROD_PG_USER" "$PROD_PG_DB" > "$DUMP"
  echo "  dump size: $(du -h "$DUMP" | cut -f1)"
fi

# 2 ── recreate and restore the staging database
echo "→ stopping staging app containers so nothing holds a connection"
run $COMPOSE stop api dispatcher chatbot

echo "→ recreating staging database $STAGING_PG_DB"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: dropdb/createdb $STAGING_PG_DB, then pg_restore from $DUMP"
else
  docker exec tryme-staging-postgres dropdb -U "$STAGING_PG_USER" --if-exists --force "$STAGING_PG_DB"
  docker exec tryme-staging-postgres createdb -U "$STAGING_PG_USER" "$STAGING_PG_DB"
  docker exec -i tryme-staging-postgres pg_restore -U "$STAGING_PG_USER" -d "$STAGING_PG_DB" --no-owner --no-acl < "$DUMP"
fi

# 3 ── mirror objects, skipping the five regenerable user-content prefixes.
#
# Measured 2026-08-06 against virtual-tryon-prod (61G total):
#   inputs/          5.5G   user-uploaded garments
#   outputs/          38G   job results and thumbnails
#   merchant-inputs/ 1013M  kiosk/QR customer photos
#   widget-outputs/   890M  widget job results
#   shopify-inputs/   144K  Shopify customer photos
# Leaves ~15.6G, dominated by models/ (12G).
#
# NOT excluded despite the similar names: shopify-garments/ and
# shopify-catalog-garments/ hold merchant PRODUCT images referenced by catalog_items
# rows. Excluding them leaves staging merchant catalogs rendering broken thumbnails.
MIRROR_EXCLUDES="--exclude inputs/* --exclude outputs/* --exclude merchant-inputs/* --exclude widget-outputs/* --exclude shopify-inputs/*"

echo "→ mirroring MinIO objects (excluding 5 user-content prefixes, ~15.6G expected)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: mc mirror prodm/$PROD_BUCKET stagingm/$STAGING_BUCKET $MIRROR_EXCLUDES"
else
  docker run --rm --network host --entrypoint /bin/sh minio/mc:latest -c "
    mc alias set prodm    http://127.0.0.1:9000 '$PROD_MINIO_USER' '$PROD_MINIO_PASS' &&
    mc alias set stagingm http://127.0.0.1:9100 '$STAGING_MINIO_USER' '$STAGING_MINIO_PASS' &&
    mc mb --ignore-existing stagingm/$STAGING_BUCKET &&
    mc mirror --overwrite --remove $MIRROR_EXCLUDES \
      prodm/$PROD_BUCKET stagingm/$STAGING_BUCKET
  "
fi

# 4 ── empty the worker registry so staging can never dispatch to a production GPU
echo "→ emptying workers table (staging has no GPU; jobs will stay QUEUED)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: psql -f post-restore.sql"
else
  docker exec -i tryme-staging-postgres psql -U "$STAGING_PG_USER" -d "$STAGING_PG_DB" \
    -f - < "$STAGING_ROOT/scripts/staging/post-restore.sql"
  echo "  workers remaining: $(docker exec tryme-staging-postgres psql -tAU "$STAGING_PG_USER" -d "$STAGING_PG_DB" -c 'select count(*) from workers;')"
fi

# 5 ── re-apply dev-only migrations
# The restore reset staging's schema to production's, so any migration that exists
# on `dev` but not on `main` is now missing again.
echo "→ re-applying migrations"
run $COMPOSE run --rm api pnpm db:migrate:prod
run $COMPOSE run --rm api pnpm db:verify:prod

# 6 ── bring the stack back. Redis is deliberately NOT copied: the job streams,
# consumer group and worker registry are all rebuilt by the dispatcher on boot.
echo "→ restarting staging services"
run $COMPOSE up -d api dispatcher chatbot

echo "✓ staging synced from production"
