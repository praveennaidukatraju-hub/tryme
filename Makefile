# Tryme — Makefile shortcuts
# Requires: pnpm, docker, node >=20

.PHONY: setup sync dev dev-api dev-web dev-dispatcher dev-admin build test typecheck lint docker-up docker-down docker-reset db-generate db-migrate seed-catalog health prod-up prod-down prod-restart prod-bootstrap prod-logs prod-ps shopify-deploy shopify-deploy-dev shopify-deploy-staging shopify-dev shopify-dev-dev

setup:
	cp .env.example .env
	pnpm install
	$(MAKE) docker-up
	$(MAKE) db-generate
	$(MAKE) db-migrate

# Bring an existing (possibly stale/other-dev's) checkout up to date:
# pull latest master, reinstall deps, regenerate + apply any new migrations.
# Does NOT touch .env or docker volumes -- run docker-up separately if infra is down.
sync:
	git pull
	pnpm install
	$(MAKE) db-generate
	$(MAKE) db-migrate

dev:
	pnpm dev

dev-api:
	pnpm --filter @tryme/api dev

dev-web:
	pnpm --filter @tryme/web dev

dev-dispatcher:
	pnpm --filter @tryme/dispatcher dev

dev-admin:
	pnpm --filter @tryme/admin dev

health:
	curl -s http://localhost:4000/health

build:
	pnpm build

test:
	pnpm -r run test

test-api:
	pnpm --filter @tryme/api test

test-api-pattern:
	pnpm --filter @tryme/api test -- $(pattern)

typecheck:
	pnpm typecheck

lint:
	pnpm lint

docker-up:
	docker compose -f infra/docker-compose.yml --env-file .env --profile apps --profile observability up -d

docker-down:
	docker compose -f infra/docker-compose.yml --env-file .env --profile apps --profile observability down

docker-reset:
	docker compose -f infra/docker-compose.yml --env-file .env --profile apps --profile observability down -v

db-generate:
	pnpm --filter @tryme/db run generate

db-migrate:
	pnpm --filter @tryme/db run migrate

seed-catalog:
	pnpm seed:catalog

shopify-deploy:
	cd apps/shopify-extension && npx shopify app deploy --allow-updates

# Deploys shopify.app.dev.toml (separate Partner Dashboard app, ngrok-tunneled)
# instead of the prod app's shopify.app.toml -- never omit --config here.
shopify-deploy-dev:
	cd apps/shopify-extension && npx shopify app deploy --config dev --allow-updates

# Deploys shopify.app.staging.toml (separate Partner Dashboard app, pinned to
# staging-app.tryme.com) -- never omit --config here.
shopify-deploy-staging:
	cd apps/shopify-extension && npx shopify app deploy --config staging --allow-updates

# Runs `shopify app dev` against shopify.app.toml (prod "TryMe" app, org Nice
# Interactive). app_home resolves to the already-registered prod URL
# (app.tryme.com) -- this hits the PRODUCTION backend/DB, not local, even
# though it installs on a dev store. Use for real end-to-end billing tests
# against prod-registered Managed Pricing plans.
shopify-dev:
	cd apps/shopify-extension && npx shopify app dev

# Runs `shopify app dev` against shopify.app.dev.toml (separate "TryMe Dev"
# Partner Dashboard app). Needs the local API running (pnpm --filter
# @tryme/api dev, port 4000) and an ngrok tunnel on the reserved domain
# (ngrok http 4000 --domain=wispy-plaza-mullets.ngrok-free.dev) live first, or
# auth/billing callbacks will fail. Needs its own Starter/Growth/Pro Managed
# Pricing plans set up on the TryMe Dev app in Partner Dashboard.
shopify-dev-dev:
	cd apps/shopify-extension && npx shopify app dev --config dev

# ── Production (VPS only) ──────────────────────────────────────────────────
# Always pass --env-file .env.production so Compose var-substitution (${VAR}
# in docker-compose.prod.yml, e.g. minio's MINIO_ROOT_USER) reads the same
# file as each service's `env_file:` directive. Without it, Compose silently
# falls back to a stray root .env and services boot with mismatched creds.
PROD_COMPOSE = docker compose --env-file .env.production -f infra/docker-compose.prod.yml

prod-up:
	$(PROD_COMPOSE) up -d

prod-down:
	$(PROD_COMPOSE) down

prod-restart:
	$(PROD_COMPOSE) up -d --force-recreate $(service)

prod-bootstrap:
	$(PROD_COMPOSE) run --rm minio-bootstrap

prod-logs:
	$(PROD_COMPOSE) logs -f $(service)

prod-ps:
	$(PROD_COMPOSE) ps
