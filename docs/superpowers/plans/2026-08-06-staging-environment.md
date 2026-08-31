# Staging Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fully isolated staging environment on the production VPS, deployed from a new `dev` branch, without changing how production is built or deployed.

**Architecture:** A second Docker Compose project (`tryme-staging`) runs on the same host as `tryme-prod` with its own Postgres, Redis, MinIO and application containers, its own volumes, its own network, and host ports shifted by +100. The existing `ci.yml` gains `dev` as a trigger and resolves its deploy target from `github.ref`. Staging data comes from an operator-run snapshot script that dumps prod Postgres and mirrors prod MinIO minus the two user-content prefixes.

**Tech Stack:** Docker Compose v2, GitHub Actions, Grafana Alloy, PostgreSQL 16 (pgvector), MinIO + `mc`, bash, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-06-staging-environment-design.md`

## Global Constraints

- Production behaviour must not change. The only edits to production-path files are: `dev` triggers plus a ref-resolve step in `.github/workflows/ci.yml`, and one `ALLOY_CONTAINER_REGEX` line in `infra/docker-compose.prod.yml`. Nothing else in those files may be reformatted or "cleaned up".
- The `!cancelled()` guard and its comment block in the `deploy` job of `ci.yml` must survive verbatim. It exists because GitHub propagates `skipped` transitively through `needs`, which silently killed deploys on admin/web-only merges.
- Host port bindings stay on `127.0.0.1` in every environment.
- Staging host ports are production + 100: web 3100, admin 3101, shopify-admin 3103, api 4100, chatbot 4300, minio 9100, minio console 9101.
- Staging has **two** vhosts, not three. The chatbot gets no subdomain — it is served at `/chatbot/` under both `staging-app` and `staging-admin`, with the prefix stripped by NGINX so the service is unaware of it. `CHATBOT_URL` (server-side, API only) stays in-network at `http://chatbot:4200`; `NEXT_PUBLIC_CHATBOT_URL` and `VITE_CHATBOT_URL` (browser-side) carry the public path URLs, each same-origin with the app that loads it.
- The `workers` table is emptied and left empty. Staging has no GPU worker yet, so jobs enqueue and stay `QUEUED`. Nothing in this plan inserts a worker row.
- Staging container names are `tryme-staging-<service>`. Network is `tryme-staging-net`.
- The project name must be set in **two** places: `name: tryme-staging` in the compose file *and* `COMPOSE_PROJECT_NAME=tryme-staging` in `.env.staging`. Compose resolves the project name from `COMPOSE_PROJECT_NAME` above the `name:` key, and production's `.env.production` already sets that variable. A `.env.staging` copied from prod without changing it makes every staging compose command operate on the **production** project.
- The MinIO mirror excludes exactly five prefixes: `inputs/*`, `outputs/*`, `merchant-inputs/*`, `widget-outputs/*`, `shopify-inputs/*`. Every other prefix is copied — in particular `shopify-garments/*` and `shopify-catalog-garments/*` are merchant product images referenced by `catalog_items` rows and must NOT be excluded.
- No scrub of the Postgres snapshot. Isolation comes from `.env.staging` credentials plus a distinct `SHOPIFY_TOKEN_ENC_KEY`.
- `.env.staging` is never committed. Only `.env.staging.example` is.
- Never run `pnpm db:generate` or ad-hoc SQL against production. The sync script reads production only via `pg_dump`.
- No `console.log` in committed code; shell scripts use `set -euo pipefail`.

## Host facts (surveyed 2026-08-06)

Use these exact values; they were measured on the box, not assumed.

| Fact | Value |
|---|---|
| Prod clone | `/home/tryme-app/htdocs/app.tryme.com` (`.env.production` at its root) |
| Staging clone | `/home/tryme-app/htdocs/staging-app.tryme.com`, tracking `dev` |
| Prod env file, relative to staging clone | `../app.tryme.com/.env.production` |
| Prod bucket | `virtual-tryon-prod` |
| Prod MinIO volume | 61 G; excluded prefixes total 45.4 G; staging mirror ≈ 15.6 G |
| Prod Postgres | 205 MB |
| Disk | 387 G total, 79 G free (80% used), single `/dev/sda1`, shared with Docker |
| RAM / swap | 31 GiB total, 22 GiB available; swap 2 GiB **fully used** |
| Reclaimable build cache | 176.8 G |
| Other Compose projects on the host | `tryme-prod`, `propicly-prod`, `plane-app`, and a stray local `tryme` (redis + minio) |
| Staging ports | 3100, 3101, 3103, 4100, 4300, 9100, 9101 — all confirmed free |
| Reverse proxy | nginx 1.30.3 under CloudPanel 6.0.8; vhosts in `/etc/nginx/sites-enabled/`; certs via CloudPanel, **not** raw certbot |

The stray local `tryme` project's containers (`tryme-redis`, `tryme-minio`) match the current Alloy filter `/tryme-.*`, so production's Loki has been ingesting them. Task 1 stops that.

---

### Task 1: Scope Alloy to one environment

Today `infra/observability/alloy.alloy` keeps every container matching `/tryme-.*` off the shared Docker socket. Once a second stack runs on the same host, each environment's Alloy ingests the other's logs. This task makes the filter env-driven, defaulting to current behaviour so the local `docker-compose.yml` stack is unaffected.

**Files:**
- Modify: `infra/observability/alloy.alloy:20-41`
- Modify: `infra/docker-compose.prod.yml` (alloy service `environment:` block)

**Interfaces:**
- Consumes: nothing.
- Produces: environment variable `ALLOY_CONTAINER_REGEX` (string, a Go RE2 regex matched against `__meta_docker_container_name`, which is the container name with a leading `/`). Task 2's staging compose sets it to `/tryme-staging-.*`.

- [ ] **Step 1: Confirm the current behaviour that this task changes**

Run:

```bash
sed -n '17,41p' infra/observability/alloy.alloy
```

Expected: the `keep` rule has a hardcoded `regex = "/tryme-.*"`, and the `service` rule strips an optional `prod-` segment only. Both are what the next step replaces.

- [ ] **Step 2: Widen the service-label regex and make the keep filter env-driven**

Edit `infra/observability/alloy.alloy`. Replace the `discovery.relabel "tryme"` block with:

```river
// Keep only this stack's containers and derive a clean `service` label from the
// container name. Matches prod (tryme-prod-api), staging (tryme-staging-api)
// and local (tryme-api), stripping the optional environment segment so `service`
// is just `api`, `dispatcher`, …
//
// ALLOY_CONTAINER_REGEX scopes the keep rule to a single stack. Prod and staging run
// on the same host and share this Docker socket, so without it each environment's
// Alloy would ingest the other's containers. The default preserves the local
// docker-compose.yml stack, whose containers have no environment segment.
discovery.relabel "tryme" {
  targets = discovery.docker.tryme.targets

  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(tryme-.*)"
    target_label  = "container"
  }

  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/tryme-(?:prod-|staging-)?(.*)"
    target_label  = "service"
  }

  // Drop containers that are not part of this stack.
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = coalesce(sys.env("ALLOY_CONTAINER_REGEX"), "/tryme-.*")
    action        = "keep"
  }
}
```

- [ ] **Step 3: Pin production's Alloy to prod containers only**

In `infra/docker-compose.prod.yml`, inside the `alloy` service's `environment:` block, add as the first entry:

```yaml
      ALLOY_CONTAINER_REGEX: /tryme-prod-.*
```

- [ ] **Step 4: Verify the regexes match what they should**

The relabel rules are anchored by Alloy, so test them anchored. Run:

```bash
python3 - <<'PY'
import re
cases = {
  "/tryme-prod-api": "prod",
  "/tryme-prod-dispatcher": "prod",
  "/tryme-staging-api": "staging",
  "/tryme-api": "local",
}
prod_keep = re.compile(r"/tryme-prod-.*$")
stag_keep = re.compile(r"/tryme-staging-.*$")
svc = re.compile(r"/tryme-(?:prod-|staging-)?(.*)$")
for name, env in cases.items():
    kept_prod = bool(prod_keep.fullmatch(name))
    kept_stag = bool(stag_keep.fullmatch(name))
    service = svc.fullmatch(name).group(1)
    print(f"{name:32} prod_keep={kept_prod!s:5} staging_keep={kept_stag!s:5} service={service}")
    assert not (kept_prod and kept_stag), f"{name} matched both stacks"
print("OK: no container is claimed by both stacks")
PY
```

Expected output — prod containers kept only by prod, staging only by staging, `tryme-api` kept by neither scoped filter (it is a local-only name), and every `service` label reduced to the bare service name:

```
/tryme-prod-api               prod_keep=True  staging_keep=False service=api
/tryme-prod-dispatcher        prod_keep=True  staging_keep=False service=dispatcher
/tryme-staging-api            prod_keep=False staging_keep=True  service=api
/tryme-api                    prod_keep=False staging_keep=False service=api
OK: no container is claimed by both stacks
```

- [ ] **Step 5: Verify the prod compose file still parses and carries the new var**

Run:

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env.production.example config 2>/dev/null \
  | grep -A2 'ALLOY_CONTAINER_REGEX'
```

Expected: the line `ALLOY_CONTAINER_REGEX: /tryme-prod-.*` appears under the alloy service. If `docker compose config` errors on missing variables, that is expected for the example env file — in that case run `docker compose -f infra/docker-compose.prod.yml config --quiet` and confirm it reports no syntax error, then `grep -n 'ALLOY_CONTAINER_REGEX' infra/docker-compose.prod.yml` to confirm placement.

- [ ] **Step 6: Commit**

```bash
git add infra/observability/alloy.alloy infra/docker-compose.prod.yml
git commit -m "feat(observability): scope Alloy container discovery per environment

Prod and staging will share one Docker socket on the same VPS. Without a
scoped keep filter each environment's Alloy ingests the other's containers.
ALLOY_CONTAINER_REGEX defaults to the current behaviour so the local stack is
unchanged."
```

---

### Task 2: Staging compose stack and env template

**Files:**
- Create: `infra/docker-compose.staging.yml`
- Create: `.env.staging.example`
- Modify: `.gitignore` (only if `.env.staging` is not already covered)

**Interfaces:**
- Consumes: `ALLOY_CONTAINER_REGEX` from Task 1.
- Produces: compose project `tryme-staging` with services `postgres redis minio minio-bootstrap api chatbot dispatcher web admin shopify-admin alloy`; container names `tryme-staging-<service>`; the env file path `.env.staging` relative to the repo root, mounted into `api` and `chatbot` at `/app/.env`. Task 3's sync script and Task 4's guardrail both address containers by these names.

- [ ] **Step 1: Confirm `.env.staging` cannot be committed**

Run:

```bash
git check-ignore -v .env.staging || echo "NOT IGNORED"
```

Expected: a line naming the `.gitignore` rule that covers it. If it prints `NOT IGNORED`, append `.env.staging` to `.gitignore` before continuing — an unscrubbed environment's credentials must never reach the repo.

- [ ] **Step 2: Create the staging compose file**

Create `infra/docker-compose.staging.yml`. It is `docker-compose.prod.yml` with the differences listed in the Global Constraints and nothing else — same images, same healthchecks, same build contexts, same `depends_on` graph.

```yaml
name: tryme-staging

# Staging mirror of docker-compose.prod.yml. Runs on the SAME VPS as prod, so every
# host-visible identifier is namespaced: project name, container names, network, and
# host ports (prod + 100). Named volumes are Compose-namespaced by project, so
# `pgdata` here materialises as `tryme-staging_pgdata` and cannot collide with
# prod's `tryme-prod_pgdata`.
#
# Env file lives at the repo root of the STAGING clone as .env.staging (git-ignored,
# created manually on the VPS). See .env.staging.example.
#
# CloudPanel NGINX reverse proxies:
#   staging-app.tryme.com/         -> localhost:3100  (Next.js web)
#   staging-app.tryme.com/v1/      -> localhost:4100  (Fastify API)
#   staging-app.tryme.com/minio/   -> localhost:9100  (MinIO pass-through)
#   staging-admin.tryme.com/       -> localhost:3101  (Admin SPA)
#   staging-admin.tryme.com/admin/ -> localhost:4100  (Fastify API)
#   staging-admin.tryme.com/v1/    -> localhost:4100  (Fastify API)
#   staging-admin.tryme.com/shopify-admin -> localhost:3103
#   staging-app.tryme.com/chatbot/   -> localhost:4300  (prefix stripped, WS upgrade)
#   staging-admin.tryme.com/chatbot/ -> localhost:4300  (prefix stripped, WS upgrade)
# The chatbot has no subdomain of its own; it is mounted on a path under both
# vhosts so the web app and admin SPA each reach it same-origin.

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: tryme-staging-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks:
      - tryme-staging-net

  redis:
    image: redis:7-alpine
    container_name: tryme-staging-redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks:
      - tryme-staging-net

  minio:
    image: minio/minio:latest
    container_name: tryme-staging-minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    ports:
      # 9100 bound to host so CloudPanel NGINX can proxy /minio/ and so the sync
      # script can reach this MinIO from the host with a second mc alias.
      - "127.0.0.1:9100:9000"
      - "127.0.0.1:9101:9001"
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks:
      - tryme-staging-net

  minio-bootstrap:
    image: minio/mc:latest
    container_name: tryme-staging-minio-bootstrap
    restart: "no"
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 ${MINIO_ROOT_USER} ${MINIO_ROOT_PASSWORD} &&
      mc mb --ignore-existing local/${R2_BUCKET} &&
      mc admin config set local api cors_allow_origin='*' &&
      mc admin service restart local &&
      echo 'minio bucket ready: ${R2_BUCKET}'
      "
    networks:
      - tryme-staging-net

  api:
    build:
      context: ..
      dockerfile: apps/api/Dockerfile
    container_name: tryme-staging-api
    restart: unless-stopped
    ports:
      - "127.0.0.1:4100:4000"
    volumes:
      - ../.env.staging:/app/.env:ro
    command: >
      sh -c "
        cd /app/packages/db && pnpm migrate &&
        pnpm --filter @tryme/api start
      "
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - tryme-staging-net

  chatbot:
    build:
      context: ..
      dockerfile: apps/chatbot/Dockerfile
    container_name: tryme-staging-chatbot
    restart: unless-stopped
    ports:
      - "127.0.0.1:4300:4200"
    volumes:
      - ../.env.staging:/app/.env:ro
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - tryme-staging-net

  dispatcher:
    build:
      context: ..
      dockerfile: apps/dispatcher/Dockerfile
    container_name: tryme-staging-dispatcher
    restart: unless-stopped
    env_file:
      - ../.env.staging
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    networks:
      - tryme-staging-net

  web:
    build:
      context: ..
      dockerfile: apps/catalogues-web/Dockerfile
      args:
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL}
        NEXT_PUBLIC_BASE_PATH: ${NEXT_PUBLIC_BASE_PATH:-}
        NEXT_PUBLIC_CHATBOT_URL: ${NEXT_PUBLIC_CHATBOT_URL}
    container_name: tryme-staging-web
    restart: unless-stopped
    environment:
      NEXT_PUBLIC_BASE_PATH: ${NEXT_PUBLIC_BASE_PATH:-}
      NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL}
    ports:
      - "127.0.0.1:3100:3000"
    networks:
      - tryme-staging-net

  admin:
    build:
      context: ..
      dockerfile: apps/admin-web/Dockerfile
      args:
        VITE_CHATBOT_URL: ${VITE_CHATBOT_URL}
    container_name: tryme-staging-admin
    restart: unless-stopped
    ports:
      - "127.0.0.1:3101:80"
    networks:
      - tryme-staging-net

  shopify-admin:
    build:
      context: ..
      dockerfile: apps/shopify/Dockerfile
      args:
        VITE_SHOPIFY_API_KEY: ${VITE_SHOPIFY_API_KEY}
        VITE_TRYME_APP_URL: ${VITE_TRYME_APP_URL:-https://staging-app.tryme.com}
        VITE_API_BASE_URL: ${VITE_API_BASE_URL:-https://staging-app.tryme.com}
    container_name: tryme-staging-shopify-admin
    restart: unless-stopped
    ports:
      - "127.0.0.1:3103:80"
    networks:
      - tryme-staging-net

  alloy:
    image: grafana/alloy:latest
    container_name: tryme-staging-alloy
    restart: unless-stopped
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:12345
      - --storage.path=/var/lib/alloy/data
      - /etc/alloy/config.alloy
    environment:
      # Scopes log/metric discovery to this stack only. Prod's Alloy sets the
      # matching /tryme-prod-.* filter. Both read the same Docker socket.
      ALLOY_CONTAINER_REGEX: /tryme-staging-.*
      GRAFANA_CLOUD_LOKI_URL: ${GRAFANA_CLOUD_LOKI_URL}
      GRAFANA_CLOUD_LOKI_USER: ${GRAFANA_CLOUD_LOKI_USER}
      GRAFANA_CLOUD_PROM_URL: ${GRAFANA_CLOUD_PROM_URL}
      GRAFANA_CLOUD_PROM_USER: ${GRAFANA_CLOUD_PROM_USER}
      GRAFANA_CLOUD_API_KEY: ${GRAFANA_CLOUD_API_KEY}
    volumes:
      - ./observability/alloy.alloy:/etc/alloy/config.alloy:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - alloydata:/var/lib/alloy/data
    depends_on:
      - api
      - dispatcher
      - chatbot
    networks:
      - tryme-staging-net

volumes:
  pgdata:
  redisdata:
  miniodata:
  alloydata:

networks:
  tryme-staging-net:
    driver: bridge
```

- [ ] **Step 3: Create the env template**

Create `.env.staging.example` with exactly the content below. The variable set is the one production actually defines on the VPS (79 names, surveyed 2026-08-06), not the set in `.env.production.example` — the committed example has drifted from the live file. A variable production defines but staging omits surfaces as a container crash on first boot, not a config error.

```bash
# Staging environment template. Copy to .env.staging on the VPS and fill every
# change_me. This file is the ONLY isolation boundary between staging and real
# customers: the staging database is an unscrubbed production snapshot, so the
# credentials here decide whether staging can email, charge or call anyone real.
#
# Verify with: scripts/staging/check-staging-env.sh .env.staging ../app.tryme.com/.env.production

# ─── Environment identity ─────────────────────────────────────────────────────
# TRYME_ENV is read only by check-staging-env.sh; no application code reads it.
TRYME_ENV=staging
NODE_ENV=production
LOG_LEVEL=info
# CRITICAL: Compose resolves the project name from this variable ABOVE the `name:`
# key in docker-compose.staging.yml. Production's .env.production also sets it.
# If this says tryme-prod, every staging compose command operates on the
# PRODUCTION stack. check-staging-env.sh refuses to deploy unless it is exactly
# tryme-staging.
COMPOSE_PROJECT_NAME=tryme-staging

# ─── Ports (container-internal; host mapping lives in the compose file) ───────
API_PORT=4000
WEB_PORT=3000
CHATBOT_PORT=4200
DISPATCHER_HEALTH_PORT=4100

# ─── Postgres / Redis (staging containers, own credentials) ───────────────────
POSTGRES_USER=tryme_staging
POSTGRES_PASSWORD=change_me_staging_pg
POSTGRES_DB=tryon_staging
DATABASE_URL=postgres://tryme_staging:change_me_staging_pg@postgres:5432/tryon_staging
REDIS_URL=redis://redis:6379
XPENDING_CLAIM_THRESHOLD_MS=300000

# ─── Auth secrets — MUST differ from production ───────────────────────────────
JWT_SECRET=change_me_staging_jwt
COOKIE_SECRET=change_me_staging_cookie
JWT_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=30d
TRUST_PROXY_HOPS=1
NODE_TLS_REJECT_UNAUTHORIZED=1
ADMIN_BOOTSTRAP_EMAIL=admin@staging.tryme.com
ADMIN_BOOTSTRAP_PASSWORD=change_me_staging_admin

# ─── Object storage (staging MinIO) ───────────────────────────────────────────
MINIO_ROOT_USER=tryme_staging
MINIO_ROOT_PASSWORD=change_me_staging_minio
R2_ENDPOINT=http://minio:9000
R2_ACCESS_KEY_ID=tryme_staging
R2_SECRET_ACCESS_KEY=change_me_staging_minio
R2_BUCKET=virtual-tryon-staging
R2_PUBLIC_URL=https://staging-app.tryme.com/minio/virtual-tryon-staging
R2_FORCE_PATH_STYLE=true
R2_PUBLIC_PRESIGN_BASE=https://staging-app.tryme.com/minio
R2_SIGN_ENDPOINT=

# ─── Public URLs ──────────────────────────────────────────────────────────────
WEB_URL=https://staging-app.tryme.com
CORS_ORIGIN=https://staging-app.tryme.com,https://staging-admin.tryme.com
NEXT_PUBLIC_API_URL=https://staging-app.tryme.com
NEXT_PUBLIC_BASE_PATH=
# CHATBOT_URL is server-side only — the API calls /ingest and /health with it
# (apps/api/src/modules/admin/chatbot.routes.ts). Keep it in-network rather than
# hairpinning container -> NGINX -> container.
CHATBOT_URL=http://chatbot:4200
# Browser-side. The chatbot has no subdomain in staging; NGINX serves it at
# /chatbot/ under both vhosts with the prefix stripped. Consumers build
# ${CHATBOT_URL}/ws-ticket and .replace(/^http/,'ws'), so a path-carrying base
# concatenates correctly and yields wss://host/chatbot/ws. Each value is
# same-origin with the app that loads it, so no cross-origin WebSocket setup.
NEXT_PUBLIC_CHATBOT_URL=https://staging-app.tryme.com/chatbot
VITE_CHATBOT_URL=https://staging-admin.tryme.com/chatbot
VITE_TRYME_APP_URL=https://staging-app.tryme.com
VITE_API_BASE_URL=https://staging-app.tryme.com

# ─── Google OAuth (staging callback must be registered separately) ────────────
GOOGLE_CLIENT_ID=change_me
GOOGLE_CLIENT_SECRET=change_me
GOOGLE_CALLBACK_URL=https://staging-app.tryme.com/v1/auth/google/callback

# ─── Payments — test mode only ────────────────────────────────────────────────
# check-staging-env.sh rejects any rzp_live_ key outright.
RAZORPAY_KEY_ID=rzp_test_change_me
RAZORPAY_KEY_SECRET=change_me

# ─── Shopify — a SEPARATE dev app, never production's ─────────────────────────
SHOPIFY_API_KEY=change_me_staging_shopify_app
SHOPIFY_API_SECRET=change_me
VITE_SHOPIFY_API_KEY=change_me_staging_shopify_app
SHOPIFY_APP_URL=https://staging-app.tryme.com
SHOPIFY_ADMIN_URL=https://staging-admin.tryme.com/shopify-admin
SHOPIFY_SCOPES=read_products,write_products
# Deliberately different from production. The staging DB is a raw prod copy, so a
# distinct key makes the copied shopify_stores access tokens undecryptable here.
# That is the point: staging structurally cannot reach a live merchant storefront.
SHOPIFY_TOKEN_ENC_KEY=change_me_staging_shopify_enc

# ─── Outbound mail — non-production sender ────────────────────────────────────
RESEND_API_KEY=change_me
EMAIL_FROM=staging@staging.tryme.com

# ─── LLM providers (chatbot) ──────────────────────────────────────────────────
OPENAI_API_KEY=change_me
ANTHROPIC_API_KEY=change_me
GOOGLE_API_KEY=change_me
CHATBOT_SERVICE_TOKEN=change_me_staging_chatbot
CHATBOT_EMBED_MODEL=text-embedding-3-small
CHATBOT_TOP_K=5
CHATBOT_SIMILARITY_THRESHOLD=0.7
CHATBOT_FALLBACK_LIMIT=3
CHATBOT_IDLE_TIMEOUT_MIN=30
CHATBOT_MAX_TOOL_ITERATIONS=6
CHATBOT_GEN_PROVIDER=anthropic
CHATBOT_GEN_MODEL=claude-sonnet-5
CHATBOT_GEN_API_KEY=change_me
CHATBOT_GEN_BASE_URL=
CHATBOT_TOOL_PROVIDER=anthropic
CHATBOT_TOOL_MODEL=claude-sonnet-5
CHATBOT_TOOL_API_KEY=change_me
CHATBOT_TOOL_BASE_URL=

# ─── Observability: the SEPARATE staging Grafana Cloud account ────────────────
GRAFANA_CLOUD_LOKI_URL=change_me
GRAFANA_CLOUD_LOKI_USER=change_me
GRAFANA_CLOUD_PROM_URL=change_me
GRAFANA_CLOUD_PROM_USER=change_me
GRAFANA_CLOUD_API_KEY=change_me

# ─── GPU workers ──────────────────────────────────────────────────────────────
# Intentionally absent. Workers live in the `workers` table and are loaded into
# the Redis registry at dispatcher boot, not configured by env vars.
# scripts/staging/post-restore.sql empties that table after every sync, so the
# staging dispatcher can never select one of the production GPUs the snapshot
# inherited. With no worker registered, staging jobs enqueue and stay QUEUED.
# Add a staging worker later through the admin panel.

# ─── PixVerse: deferred decision, fails closed ────────────────────────────────
# Staging currently shares the production PixVerse key, so a catalog-video job
# would bill the real account. VIDEO_CONCURRENCY=0 keeps the jobs:video lane from
# dispatching at all. Raise it only once staging has its own key, or the spend is
# accepted. Production does not set this variable; the dispatcher's default is 5.
PIXVERSE_API_KEY=change_me
VIDEO_CONCURRENCY=0
```

- [ ] **Step 4: Verify the staging compose file parses and resolves**

Run:

```bash
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging.example config > /tmp/staging-config.yml \
  && echo "PARSE OK"
```

Expected: `PARSE OK` and no warnings about unset variables. Any `variable is not set` warning names a variable Step 3 omitted — add it and re-run.

- [ ] **Step 4b: Verify variable-name parity with production**

The compose parse only catches variables the compose file interpolates. Variables read at runtime by application code (chatbot models, OAuth, Razorpay) fail later, as a crash on first boot. Check the full set against production's actual variable names:

```bash
python3 - <<'PY'
import re
prod = """ADMIN_BOOTSTRAP_EMAIL ADMIN_BOOTSTRAP_PASSWORD ANTHROPIC_API_KEY API_PORT
CHATBOT_EMBED_MODEL CHATBOT_FALLBACK_LIMIT CHATBOT_GEN_API_KEY CHATBOT_GEN_BASE_URL
CHATBOT_GEN_MODEL CHATBOT_GEN_PROVIDER CHATBOT_IDLE_TIMEOUT_MIN CHATBOT_MAX_TOOL_ITERATIONS
CHATBOT_PORT CHATBOT_SERVICE_TOKEN CHATBOT_SIMILARITY_THRESHOLD CHATBOT_TOOL_API_KEY
CHATBOT_TOOL_BASE_URL CHATBOT_TOOL_MODEL CHATBOT_TOOL_PROVIDER CHATBOT_TOP_K CHATBOT_URL
COMPOSE_PROJECT_NAME COOKIE_SECRET CORS_ORIGIN DATABASE_URL DISPATCHER_HEALTH_PORT
EMAIL_FROM GOOGLE_API_KEY GOOGLE_CALLBACK_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
GRAFANA_CLOUD_API_KEY GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER GRAFANA_CLOUD_PROM_URL
GRAFANA_CLOUD_PROM_USER JWT_EXPIRY JWT_SECRET LOG_LEVEL MINIO_ROOT_PASSWORD MINIO_ROOT_USER
NEXT_PUBLIC_API_URL NEXT_PUBLIC_BASE_PATH NEXT_PUBLIC_CHATBOT_URL NODE_ENV
NODE_TLS_REJECT_UNAUTHORIZED OPENAI_API_KEY PIXVERSE_API_KEY POSTGRES_DB POSTGRES_PASSWORD
POSTGRES_USER R2_ACCESS_KEY_ID R2_BUCKET R2_ENDPOINT R2_FORCE_PATH_STYLE
R2_PUBLIC_PRESIGN_BASE R2_PUBLIC_URL R2_SECRET_ACCESS_KEY R2_SIGN_ENDPOINT RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET REDIS_URL REFRESH_TOKEN_EXPIRY RESEND_API_KEY SHOPIFY_ADMIN_URL
SHOPIFY_API_KEY SHOPIFY_API_SECRET SHOPIFY_APP_URL SHOPIFY_SCOPES SHOPIFY_TOKEN_ENC_KEY
TRUST_PROXY_HOPS VITE_TRYME_APP_URL VITE_API_BASE_URL VITE_CHATBOT_URL
VITE_SHOPIFY_API_KEY WEB_PORT WEB_URL XPENDING_CLAIM_THRESHOLD_MS""".split()

staging = set(re.findall(r'^([A-Z0-9_]+)=', open('.env.staging.example').read(), re.M))
missing = sorted(set(prod) - staging)
extra   = sorted(staging - set(prod))
print("in prod but missing from staging:", missing or "none")
print("staging-only (expected: TRYME_ENV, VIDEO_CONCURRENCY):", extra)
assert not missing, f"staging template is missing {missing}"
print("OK: variable-name parity with production")
PY
```

Expected: `in prod but missing from staging: none`, and the staging-only list is exactly `['TRYME_ENV', 'VIDEO_CONCURRENCY']`.

- [ ] **Step 4c: Verify the project name cannot be hijacked**

This is the check that prevents a staging command from operating on the production stack:

```bash
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging.example config \
  | head -3

# And prove the failure mode is real, so the guardrail's purpose is not theoretical:
COMPOSE_PROJECT_NAME=tryme-prod docker compose -f infra/docker-compose.staging.yml \
  --env-file .env.staging.example config | head -3
```

Expected: the first prints `name: tryme-staging`. The second prints `name: tryme-prod` — demonstrating that the environment variable overrides the `name:` key, which is exactly why `COMPOSE_PROJECT_NAME=tryme-staging` must be in the env file and why Task 3 checks it.

- [ ] **Step 5: Verify staging collides with prod on nothing**

This is the test that matters. Run:

```bash
python3 - <<'PY'
import re, subprocess, sys

def render(compose, envfile):
    return subprocess.run(
        ["docker", "compose", "-f", compose, "--env-file", envfile, "config"],
        capture_output=True, text=True, check=True).stdout

prod = render("infra/docker-compose.prod.yml", ".env.production.example")
stag = render("infra/docker-compose.staging.yml", ".env.staging.example")

def names(text):
    return set(re.findall(r"container_name:\s*(\S+)", text))

def ports(text):
    return set(re.findall(r"published:\s*\"?(\d+)\"?", text))

def volumes(text):
    # top-level volume keys appear under the trailing `volumes:` mapping
    return set(re.findall(r"^\s{2}(\w+):\n\s{4}name:\s*(\S+)", text, re.M))

n = names(prod) & names(stag)
p = ports(prod) & ports(stag)
print("shared container names:", n or "none")
print("shared host ports:     ", p or "none")
assert not n, f"container name collision: {n}"
assert not p, f"host port collision: {p}"
print("OK: no host-level collision between prod and staging")
PY
```

Expected:

```
shared container names: none
shared host ports:      none
OK: no host-level collision between prod and staging
```

- [ ] **Step 6: Verify volume namespacing**

Run:

```bash
grep -A1 -E '^\s{2}(pgdata|miniodata):' /tmp/staging-config.yml | grep 'name:'
```

Expected: names prefixed `tryme-staging_` (for example `name: tryme-staging_pgdata`). If they render as bare `pgdata`, the `name:` key at the top of the compose file is missing or misspelled.

- [ ] **Step 7: Commit**

```bash
git add infra/docker-compose.staging.yml .env.staging.example .gitignore
git commit -m "feat(infra): add staging compose stack and env template

Second Compose project on the prod VPS: own network, own volumes, container
names namespaced tryme-staging-*, host ports at prod+100. SHOPIFY_TOKEN_ENC_KEY
is deliberately distinct so copied merchant tokens do not decrypt in staging."
```

---

### Task 3: Deploy guardrail script

The staging Postgres snapshot is an unscrubbed copy of production, so the credentials in `.env.staging` are the only thing keeping staging from emailing real customers or calling live merchant stores. This script is the gate. It is a committed, testable file rather than an inline heredoc in the workflow so its logic can be exercised against fixtures.

**Files:**
- Create: `scripts/staging/check-staging-env.sh`
- Create: `scripts/staging/check-staging-env.test.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: executable `scripts/staging/check-staging-env.sh <staging-env-file> <prod-env-file>`; exit 0 when safe, exit 1 with a message on stderr naming the failed check. Task 5's workflow calls it on the VPS before `compose build`.

- [ ] **Step 1: Write the failing test**

Create `scripts/staging/check-staging-env.test.sh`:

```bash
#!/usr/bin/env bash
# Fixture-driven tests for check-staging-env.sh. No Docker, no network.
set -uo pipefail

SCRIPT="$(dirname "$0")/check-staging-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# A production env file to compare against.
cat > "$TMP/prod.env" <<'EOF'
COMPOSE_PROJECT_NAME=tryme-prod
SHOPIFY_API_KEY=prodshopifykey123
EMAIL_FROM=no-reply@tryme.com
RAZORPAY_KEY_ID=rzp_live_abc123
EOF

# A staging env file that should pass every check.
good_env() {
  cat > "$TMP/staging.env" <<'EOF'
TRYME_ENV=staging
COMPOSE_PROJECT_NAME=tryme-staging
SHOPIFY_API_KEY=stagingshopifykey456
EMAIL_FROM=staging@staging.tryme.com
RAZORPAY_KEY_ID=rzp_test_abc123
EOF
}

check() {
  local name="$1" expected="$2"
  "$SCRIPT" "$TMP/staging.env" "$TMP/prod.env" >/dev/null 2>"$TMP/err"
  local actual=$?
  if [ "$actual" = "$expected" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (expected exit $expected, got $actual)"
    echo "       stderr: $(cat "$TMP/err")"
    fail=$((fail + 1))
  fi
}

good_env
check "clean staging env passes" 0

good_env
sed -i '/^TRYME_ENV=/d' "$TMP/staging.env"
check "missing TRYME_ENV marker is rejected" 1

good_env
sed -i 's/^TRYME_ENV=.*/TRYME_ENV=production/' "$TMP/staging.env"
check "TRYME_ENV=production is rejected" 1

# The highest-consequence case: a COMPOSE_PROJECT_NAME left at production's value
# makes every staging compose command act on the production stack.
good_env
sed -i 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=tryme-prod/' "$TMP/staging.env"
check "COMPOSE_PROJECT_NAME pointing at prod is rejected" 1

good_env
sed -i '/^COMPOSE_PROJECT_NAME=/d' "$TMP/staging.env"
check "missing COMPOSE_PROJECT_NAME is rejected" 1

good_env
sed -i 's/^RAZORPAY_KEY_ID=.*/RAZORPAY_KEY_ID=rzp_live_abc123/' "$TMP/staging.env"
check "live Razorpay key is rejected" 1

good_env
sed -i 's/^SHOPIFY_API_KEY=.*/SHOPIFY_API_KEY=prodshopifykey123/' "$TMP/staging.env"
check "Shopify key matching prod is rejected" 1

good_env
sed -i 's|^EMAIL_FROM=.*|EMAIL_FROM=no-reply@tryme.com|' "$TMP/staging.env"
check "EMAIL_FROM matching prod is rejected" 1

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
```

Make it executable:

```bash
chmod +x scripts/staging/check-staging-env.test.sh
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bash scripts/staging/check-staging-env.test.sh
```

Expected: every case reports `FAIL` because `check-staging-env.sh` does not exist yet, and the script exits non-zero.

- [ ] **Step 3: Write the guardrail**

Create `scripts/staging/check-staging-env.sh`:

```bash
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
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
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
```

Make it executable:

```bash
chmod +x scripts/staging/check-staging-env.sh
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
bash scripts/staging/check-staging-env.test.sh
```

Expected:

```
ok   - clean staging env passes
ok   - missing TRYME_ENV marker is rejected
ok   - TRYME_ENV=production is rejected
ok   - COMPOSE_PROJECT_NAME pointing at prod is rejected
ok   - missing COMPOSE_PROJECT_NAME is rejected
ok   - live Razorpay key is rejected
ok   - Shopify key matching prod is rejected
ok   - EMAIL_FROM matching prod is rejected

passed: 8  failed: 0
```

- [ ] **Step 5: Verify the committed template passes its own guardrail**

Run:

```bash
bash scripts/staging/check-staging-env.sh .env.staging.example .env.production.example
```

Expected: `guardrail: .env.staging.example passed all checks` — proving the template that operators copy is itself compliant. If it fails, fix `.env.staging.example`, not the guardrail.

Note: `.env.production.example` does not define `COMPOSE_PROJECT_NAME`, `SHOPIFY_API_KEY` or `EMAIL_FROM` the way the live VPS file does, so this local run exercises the marker and Razorpay checks fully and the comparison checks vacuously. The comparison checks get their real exercise on the VPS, against the actual `.env.production`, and in the fixture tests above.

- [ ] **Step 6: Verify syntax under strict mode**

Run:

```bash
bash -n scripts/staging/check-staging-env.sh && bash -n scripts/staging/check-staging-env.test.sh && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 7: Commit**

```bash
git add scripts/staging/check-staging-env.sh scripts/staging/check-staging-env.test.sh
git commit -m "feat(staging): add pre-deploy env guardrail

The staging snapshot is an unscrubbed prod copy, so .env.staging credentials
are the only barrier between staging and real customers. This aborts the deploy
before any container is built when those credentials look like production's."
```

---

### Task 4: Prod → staging sync script

**Files:**
- Create: `scripts/staging/post-restore.sql`
- Create: `scripts/staging/sync-from-prod.sh`

**Interfaces:**
- Consumes: container names `tryme-prod-postgres`, `tryme-staging-postgres`, `tryme-prod-minio`, `tryme-staging-minio` and the compose project from Task 2.
- Produces: executable `scripts/staging/sync-from-prod.sh [--dry-run]`, run by an operator on the VPS from the staging clone root. Never invoked by CI.

- [ ] **Step 1: Write the post-restore SQL**

Create `scripts/staging/post-restore.sql`:

```sql
-- Applied to the staging database immediately after restoring a production dump.
--
-- The dump carries production's `workers` rows, which point at the live ComfyUI
-- GPUs behind Cloudflare tunnels. Left in place, the staging dispatcher would
-- select one and occupy a GPU a paying customer is waiting on. Emptying the table
-- is the whole point of this file.
--
-- Nothing is inserted. Staging has no GPU of its own yet, so jobs enqueue, the
-- dispatcher finds no healthy worker, and they stay QUEUED — which still exercises
-- auth, credit deduction, catalog resolution, the job row, the stream write and the
-- SSE connection. When a dedicated staging ComfyUI box exists, register it through
-- the admin panel and add an INSERT here so the row survives the next sync.
--
-- The dispatcher loads this table into the Redis worker registry at boot, so the
-- sync script restarts it after applying this.

BEGIN;

DELETE FROM workers;

COMMIT;
```

- [ ] **Step 2: Write the sync script**

Create `scripts/staging/sync-from-prod.sh`:

```bash
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
# Both clones are siblings under the same CloudPanel htdocs directory:
#   /home/tryme-app/htdocs/app.tryme.com          (prod, branch master)
#   /home/tryme-app/htdocs/staging-app.tryme.com  (staging, branch dev)
PROD_ROOT="${PROD_ROOT:-/home/tryme-app/htdocs/app.tryme.com}"
PROD_ENV="$PROD_ROOT/.env.production"
[ -r "$PROD_ENV" ] || { echo "cannot read $PROD_ENV — set PROD_ROOT to the production clone" >&2; exit 1; }

COMPOSE="docker compose -f $STAGING_ROOT/infra/docker-compose.staging.yml --env-file $STAGING_ENV"
DUMP="/tmp/tryme-prod-$(date +%Y%m%d-%H%M%S).dump"

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: $*"
  else
    "$@"
  fi
}

env_var() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2-
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

[ "$DRY_RUN" -eq 0 ] && rm -f "$DUMP"
echo "✓ staging synced from production"
```

Make it executable:

```bash
chmod +x scripts/staging/sync-from-prod.sh
```

- [ ] **Step 3: Verify syntax**

Run:

```bash
bash -n scripts/staging/sync-from-prod.sh && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 4: Verify the script never writes to production**

This is the property that matters most about this file. Run:

```bash
grep -nE 'tryme-prod' scripts/staging/sync-from-prod.sh
```

Expected: exactly one line, the `pg_dump` in section 1. Every other prod reference must be a read (`$PROD_ENV` lookups, the `prodm` mirror source). If any line combines `tryme-prod` with `dropdb`, `createdb`, `psql -f`, `mc mirror ... prodm/` as a *destination*, or `mc rm`, stop and fix it.

Also confirm the mirror direction:

```bash
grep -n 'mc mirror' scripts/staging/sync-from-prod.sh
```

Expected: `prodm/$PROD_BUCKET stagingm/$STAGING_BUCKET` — source first, destination second. Reversed, this command would delete production objects, because `--remove` is set.

And confirm the exclusion set is complete and correctly scoped:

```bash
grep -n 'MIRROR_EXCLUDES=' scripts/staging/sync-from-prod.sh
```

Expected: exactly five `--exclude` flags — `inputs/*`, `outputs/*`, `merchant-inputs/*`, `widget-outputs/*`, `shopify-inputs/*`. There must be **no** exclusion for `shopify-garments/*` or `shopify-catalog-garments/*`; those are merchant product images that `catalog_items` rows point at.

- [ ] **Step 5: Verify the post-restore SQL inserts nothing**

The single most important property of this file is that it leaves the table empty — an accidental INSERT pointing at a production tunnel URL is exactly the failure it exists to prevent.

```bash
grep -icE 'insert|update' scripts/staging/post-restore.sql
```

Expected: `0`. The file contains `BEGIN`, `DELETE FROM workers`, `COMMIT` and comments, nothing else.

- [ ] **Step 6: Commit**

```bash
git add scripts/staging/sync-from-prod.sh scripts/staging/post-restore.sql
git commit -m "feat(staging): add prod to staging sync script

Dumps prod Postgres and mirrors prod MinIO minus inputs/ and outputs/, then
empties the workers table so staging can never dispatch to a production GPU, and
re-applies dev-only migrations. Production is read-only throughout. Operator-run,
never CI."
```

---

### Task 5: Teach the pipeline about `dev`

**Files:**
- Modify: `.github/workflows/ci.yml` (triggers block, `deploy` job)

**Interfaces:**
- Consumes: `infra/docker-compose.staging.yml` (Task 2), `scripts/staging/check-staging-env.sh` (Task 3).
- Produces: a deploy job that ships `main` → production and `dev` → staging from one workflow.

- [ ] **Step 1: Record the current workflow's shape so the diff can be checked**

Run:

```bash
git show HEAD:.github/workflows/ci.yml > /tmp/ci-before.yml
python3 -c "
import yaml
d = yaml.safe_load(open('/tmp/ci-before.yml'))
print('jobs:', sorted(d['jobs']))
print('triggers:', sorted(d[True]))
"
```

Expected: `jobs: ['ci-gate', 'ci-scripts', 'deploy', 'detect', 'lint', 'test', 'typecheck']` and triggers including `push`, `pull_request`, `schedule`, `workflow_dispatch`. Keep this output; Step 5 compares against it.

- [ ] **Step 2: Add `dev` to the triggers**

In `.github/workflows/ci.yml`, change both branch filters:

```yaml
on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main, dev]
```

Leave `schedule` and `workflow_dispatch` untouched.

- [ ] **Step 3: Make the deploy job resolve its target from the ref**

In the `deploy` job, replace the `if:` condition's ref check and the `concurrency` block, then add a resolve step ahead of the existing SSH step.

The `if:` — change only the `github.ref` line, leaving every other clause and the entire comment block above it verbatim:

```yaml
    if: >-
      !cancelled() &&
      needs.detect.result == 'success' &&
      needs['ci-gate'].result == 'success' &&
      (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev') &&
      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&
      needs.detect.outputs.has_deployable == 'true'
    concurrency:
      # Prod and staging must never share a group: a staging deploy must not be
      # able to queue behind or cancel a production deploy.
      group: tryme-${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
      cancel-in-progress: false
```

Then insert this as the deploy job's first step, before `Deploy via SSH`:

```yaml
      - name: Resolve deploy target
        env:
          PROD_DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
          STAGING_DEPLOY_PATH: ${{ secrets.STAGING_DEPLOY_PATH }}
        run: |
          set -euo pipefail
          if [ "${GITHUB_REF}" = 'refs/heads/main' ]; then
            echo "TARGET_ENV=production"                             >> "$GITHUB_ENV"
            echo "TARGET_BRANCH=main"                                >> "$GITHUB_ENV"
            echo "COMPOSE_FILE=infra/docker-compose.prod.yml"        >> "$GITHUB_ENV"
            echo "ENV_FILE=.env.production"                          >> "$GITHUB_ENV"
            echo "TARGET_DEPLOY_PATH=${PROD_DEPLOY_PATH}"            >> "$GITHUB_ENV"
          else
            echo "TARGET_ENV=staging"                                >> "$GITHUB_ENV"
            echo "TARGET_BRANCH=dev"                                 >> "$GITHUB_ENV"
            echo "COMPOSE_FILE=infra/docker-compose.staging.yml"     >> "$GITHUB_ENV"
            echo "ENV_FILE=.env.staging"                             >> "$GITHUB_ENV"
            echo "TARGET_DEPLOY_PATH=${STAGING_DEPLOY_PATH}"         >> "$GITHUB_ENV"
          fi
          echo "resolved target: $(grep TARGET_ENV "$GITHUB_ENV")"
```

- [ ] **Step 4: Parameterise the SSH step**

In the `Deploy via SSH` step, change the `env:` block so `DEPLOY_PATH` comes from the resolved value rather than the secret directly, and add the three new variables:

```yaml
        env:
          SSH_KEY: ${{ secrets.VPS_SSH_KEY }}
          VPS_HOST: ${{ secrets.VPS_HOST }}
          VPS_USER: ${{ secrets.VPS_USER }}
          DEPLOY_PATH: ${{ env.TARGET_DEPLOY_PATH }}
          TARGET_ENV: ${{ env.TARGET_ENV }}
          TARGET_BRANCH: ${{ env.TARGET_BRANCH }}
          COMPOSE_FILE: ${{ env.COMPOSE_FILE }}
          ENV_FILE: ${{ env.ENV_FILE }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
          SERVICES: ${{ needs.detect.outputs.compose_services }}
          MIGRATION_CHANGED: ${{ needs.detect.outputs.migration_changed }}
          DEPLOY_SHA: ${{ github.sha }}
```

Inside the SSH heredoc, make four changes and no others:

1. Forward the new variables alongside the existing ones:

```bash
               TARGET_ENV='${TARGET_ENV}'
               TARGET_BRANCH='${TARGET_BRANCH}'
```

2. Build `COMPOSE` from the resolved files instead of the hardcoded prod pair:

```bash
               COMPOSE=\"docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE}\"
```

3. Fetch the branch being deployed rather than always `main`:

```bash
               git fetch https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git \${TARGET_BRANCH}
```

4. Run the guardrail on staging only, immediately after `git reset --hard` and before `\${COMPOSE} build`:

```bash
               if [ \"\${TARGET_ENV}\" = 'staging' ]; then
                 echo '→ verifying .env.staging is not production'
                 bash scripts/staging/check-staging-env.sh .env.staging ../app.tryme.com/.env.production
               fi
```

The second argument is the production clone's env file. The relative path works because both clones are siblings under `/home/tryme-app/htdocs/`: prod at `app.tryme.com`, staging at `staging-app.tryme.com`. If Task 6's runbook places the staging clone elsewhere, this string changes with it.

- [ ] **Step 5: Verify the workflow still parses and prod semantics are unchanged**

Run:

```bash
python3 - <<'PY'
import yaml
before = yaml.safe_load(open('/tmp/ci-before.yml'))
after  = yaml.safe_load(open('.github/workflows/ci.yml'))

assert sorted(before['jobs']) == sorted(after['jobs']), "job set changed"
assert after[True]['push']['branches'] == ['main', 'dev'], after[True]['push']['branches']
assert after[True]['pull_request']['branches'] == ['main', 'dev']

d = after['jobs']['deploy']
cond = ' '.join(d['if'].split())
for clause in ["!cancelled()",
               "needs.detect.result == 'success'",
               "needs['ci-gate'].result == 'success'",
               "needs.detect.outputs.has_deployable == 'true'"]:
    assert clause in cond, f"lost clause: {clause}"
assert "refs/heads/dev" in cond and "refs/heads/main" in cond

steps = [s.get('name') for s in d['steps']]
assert steps[0] == 'Resolve deploy target', steps
assert 'Deploy via SSH' in steps, steps
print("jobs:", sorted(after['jobs']))
print("steps:", steps)
print("OK: workflow parses, prod gating clauses intact")
PY
```

Expected: the assertions pass and the printed job list matches Step 1's exactly.

- [ ] **Step 6: Verify the `!cancelled()` comment block survived**

Run:

```bash
grep -c 'load-bearing, not decoration' .github/workflows/ci.yml
```

Expected: `1`. If it prints `0`, the comment explaining the skip-propagation bug was deleted — restore it from `/tmp/ci-before.yml` before committing.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: deploy dev branch to staging, main to production

One workflow, target resolved from github.ref. Staging deploys run the
.env.staging guardrail before any build. Prod gating clauses, including the
!cancelled() skip-propagation guard, are unchanged."
```

---

### Task 6: VPS provisioning runbook

Everything so far is in the repo. This task documents the manual steps that are not, so the environment can be rebuilt without re-deriving them.

**Files:**
- Create: `docs/staging-runbook.md`
- Modify: `CLAUDE.md` (add a short Staging section)
- Modify: `docs/progress.md` (dated entry at the top)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: the canonical description of VPS paths, vhosts and first-boot order.

- [ ] **Step 1: Write the runbook**

Create `docs/staging-runbook.md` covering, in order:

1. **Reclaim build cache first.** The box is at 80% disk (79 G free) and carries 176.8 G of reclaimable Docker build cache. Staging adds a second build pipeline to the same filesystem, so clear it before the first staging build:
   ```bash
   docker system df                # confirm the reclaimable figure
   docker builder prune -f         # frees ~176 G; next builds are slower, nothing else is lost
   df -h /
   ```
   Note the host has a single `/dev/sda1` filesystem shared by Docker, CloudPanel sites and everything else — there is no separate Docker mount to fill independently.

2. **Capacity baseline.** Record before and after: `free -h`, `df -h /`, `docker system df`. Expected staging footprint: ~15.6 G of MinIO objects plus a ~205 MB database. Flag: swap is 2 GiB and already fully consumed, so watch `free -h` after staging's first boot — three other Compose projects (`propicly-prod`, `plane-app`, the stray local `tryme`) share this host.

3. **Clone.** The staging clone is a sibling of the production clone so the guardrail's relative path resolves:
   ```bash
   git clone https://github.com/adeshboudhnicedigitals/tryme.git \
     /home/tryme-app/htdocs/staging-app.tryme.com
   cd /home/tryme-app/htdocs/staging-app.tryme.com
   git checkout dev
   ```
   Production sits at `/home/tryme-app/htdocs/app.tryme.com` with `.env.production` at its root. If the staging path differs from the above, update the `../app.tryme.com/.env.production` argument in `.github/workflows/ci.yml` to match.

4. **Env file.**
   ```bash
   cp .env.staging.example .env.staging
   chmod 600 .env.staging      # prod's is 644; staging holds an unscrubbed snapshot's keys
   # fill every change_me, then:
   bash scripts/staging/check-staging-env.sh .env.staging ../app.tryme.com/.env.production
   ```
   `COMPOSE_PROJECT_NAME=tryme-staging` is the one line that must never be copied from production — see Task 3.

5. **GitHub secret.** Add `STAGING_DEPLOY_PATH` = `/home/tryme-app/htdocs/staging-app.tryme.com`. `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` are reused unchanged.

6. **DNS + CloudPanel.** Create **two** CloudPanel sites — `staging-app.tryme.com` and `staging-admin.tryme.com` — as reverse proxies to the ports below. Certificates go through CloudPanel's Let's Encrypt integration (`clpctl` 6.0.8), **not** raw certbot: only the unrelated `rankplex.cloud` uses certbot directly on this box, and everything else including `app.tryme.com` is CloudPanel-managed. Vhost files land in `/etc/nginx/sites-enabled/`.

   | host | path | upstream |
   |---|---|---|
   | `staging-app.tryme.com` | `/` | 3100 |
   | | `/v1/` | 4100 |
   | | `/minio/` | 9100 |
   | | `/chatbot/` | 4300 |
   | `staging-admin.tryme.com` | `/` | 3101 |
   | | `/admin/`, `/v1/` | 4100 |
   | | `/shopify-admin` | 3103 |
   | | `/chatbot/` | 4300 |

   The chatbot has no subdomain. It is mounted at `/chatbot/` on both vhosts so the web app and admin SPA each reach it same-origin. The trailing slash on `proxy_pass` is what strips the prefix — without it the chatbot receives `/chatbot/ws-ticket` and 404s. Both locations need WebSocket upgrade headers:

   ```nginx
   location /chatbot/ {
       proxy_pass http://127.0.0.1:4300/;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;
   }
   ```

   `proxy_read_timeout` matters: the default 60s silently drops idle chat sockets.

7. **Staging GPU worker — deferred.** Staging ships with an empty `workers` table, so jobs enqueue and stay `QUEUED`. Nothing to configure now. When a dedicated ComfyUI box exists: provision it, install `cloudflared`, register it through the staging admin panel, restart the staging dispatcher, and add a matching INSERT to `scripts/staging/post-restore.sql` so the row survives the next sync.

8. **Grafana Cloud.** New free-tier account. Copy its Loki/Prometheus URLs, users and API key into `.env.staging`. Do not reuse production's.

9. **First boot.**
   ```bash
   docker compose -f infra/docker-compose.staging.yml --env-file .env.staging config | head -3
   # MUST print: name: tryme-staging
   docker compose -f infra/docker-compose.staging.yml --env-file .env.staging up -d --build
   docker compose -f infra/docker-compose.staging.yml --env-file .env.staging ps
   ```
   Check the `config | head -3` output before the `up`. If it prints `tryme-prod`, stop — `COMPOSE_PROJECT_NAME` is wrong and the next command would recreate production.

10. **First sync.**
    ```bash
    scripts/staging/sync-from-prod.sh --dry-run   # read every line
    scripts/staging/sync-from-prod.sh
    ```
    `PROD_ROOT` defaults to `/home/tryme-app/htdocs/app.tryme.com`; override it only if the layout changed. Expect the mirror to move ~15.6 G.

11. **Re-sync cadence.** Whenever staging data drifts too far to be useful. The environment is disposable — a broken staging database is fixed by re-running the sync, not by restoring a backup.

- [ ] **Step 2: Add the CLAUDE.md section**

Add a `## Staging Environment` section after `## Adding a GPU worker`, stating: staging runs from `dev` on the same VPS as prod under the `tryme-staging` compose project; ports are prod+100; data is an unscrubbed prod snapshot refreshed by `scripts/staging/sync-from-prod.sh`; `.env.staging` must pass `scripts/staging/check-staging-env.sh` or the deploy aborts; see `docs/staging-runbook.md`.

- [ ] **Step 3: Add the progress.md entry**

Add a dated `## 2026-08-06 — Staging environment` entry at the top of `docs/progress.md` with **Done**, **Failed / Not Done**, and **Open Questions / Decisions** subsections. The open question is PixVerse: staging shares the production key, so `VIDEO_CONCURRENCY=0` keeps the video lane closed until a second key exists or the spend is accepted.

- [ ] **Step 4: Verify the runbook's port table matches the compose file**

Run:

```bash
grep -oE '127\.0\.0\.1:[0-9]+' infra/docker-compose.staging.yml | sort -u
```

Expected: `127.0.0.1:3100`, `3101`, `3103`, `4100`, `4300`, `9100`, `9101`. Cross-check every one appears in the runbook's vhost table. A port documented but not bound is how a vhost ends up proxying to nothing.

- [ ] **Step 5: Commit**

```bash
git add docs/staging-runbook.md CLAUDE.md docs/progress.md
git commit -m "docs: add staging runbook and update project docs"
```

---

### Task 7: First deploy and end-to-end verification

Repo work is done; this task proves the environment actually holds together. Every step runs on the VPS or against the staging URLs.

**Files:** none — this is verification.

**Interfaces:**
- Consumes: every previous task, plus the manual provisioning from Task 6's runbook.
- Produces: a working staging environment.

- [ ] **Step 1: Push `dev` and watch the pipeline**

```bash
git push -u origin dev
```

Expected: the run deploys only to `STAGING_DEPLOY_PATH`, and its concurrency group reads `tryme-staging`. If the guardrail step fails, that is the guardrail working — fix `.env.staging` and push again.

- [ ] **Step 2: Prove production was untouched**

On the VPS:

```bash
docker ps --filter 'name=tryme-prod-' --format '{{.Names}}\t{{.Status}}'
```

Expected: every prod container's `Up …` duration predates the staging deploy. Any prod container showing seconds of uptime means the deploy targeted the wrong path — stop and re-check `STAGING_DEPLOY_PATH`.

- [ ] **Step 3: Prove both stacks are running side by side**

```bash
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging ps
```

Expected: all 10 long-running services `running`, `minio-bootstrap` exited 0. Then confirm the two stacks are genuinely distinct projects:

```bash
docker compose ls
```

Expected: `tryme-prod` and `tryme-staging` both listed, alongside the pre-existing `tryme`, `propicly-prod` and `plane-app`. If `tryme-staging` is absent while `tryme-prod`'s service count jumped, `COMPOSE_PROJECT_NAME` was wrong and staging containers were created inside the production project — stop and reconcile before going further.

- [ ] **Step 4: Verify the web app and login**

Open `https://staging-app.tryme.com`, log in with an account from the snapshot.

Expected: login succeeds; the studio wizard loads garment types.

- [ ] **Step 5: Verify the MinIO mirror covered the admin asset prefixes**

Open `https://staging-admin.tryme.com` → Assets. Check the Faces, Backgrounds, Poses tabs and the lower/shoe catalog.

Expected: thumbnails render in every tab. A broken image means the mirror missed that prefix — re-run the sync and re-check.

Broken images are expected and correct for anything under the five excluded prefixes: past job results in the catalogues view, user-uploaded garments, kiosk customer photos, widget results. Merchant product images under `shopify-garments/` must render — if they do not, the exclusion list wrongly caught them.

- [ ] **Step 6: Verify a job enqueues in staging and never touches production**

Submit a try-on from the staging studio. Then, on the VPS:

```bash
# staging: the job exists and is QUEUED
docker exec tryme-staging-postgres psql -U tryme_staging -d tryon_staging \
  -c "select id, status, worker_id, created_at from jobs order by created_at desc limit 3;"

# staging: no workers registered, which is why it stays QUEUED
docker exec tryme-staging-postgres psql -U tryme_staging -d tryon_staging \
  -c "select count(*) from workers;"

# production: nothing arrived
docker exec tryme-prod-postgres psql -U <prod_user> -d <prod_db> \
  -c "select count(*) from jobs where created_at > now() - interval '10 minutes';"
```

Expected: the staging job exists with `status = QUEUED` and `worker_id` null; the staging worker count is `0`; the production count is `0`. Credits were deducted and the row was written, which is the whole path under test — a job that *starts processing* would mean the `workers` table was not emptied and staging is dispatching to a production GPU. Stop immediately if that happens.

Also confirm the dispatcher is idling cleanly rather than erroring:

```bash
docker logs --tail 30 tryme-staging-dispatcher
```

Expected: it reports no healthy worker and keeps polling. Repeated crashes are a different problem.

- [ ] **Step 6b: Verify the chatbot works on its path mount**

Open the staging web app, then the admin panel, and start a chat in each.

Expected: the socket connects in both. In the browser devtools Network tab the WebSocket URL is `wss://staging-app.tryme.com/chatbot/ws?ticket=…` (and the `staging-admin` equivalent). A 404 on `/chatbot/ws-ticket` means the `proxy_pass` trailing slash is missing and the prefix is not being stripped. A connection that opens then drops after ~60s means `proxy_read_timeout` was not raised.

- [ ] **Step 7: Verify observability separation**

In the production Grafana account, query `{job="tryme"}` over the last 15 minutes and inspect the `container` label. Repeat in the staging account.

Expected: production shows only `tryme-prod-*`; staging shows only `tryme-staging-*`. Overlap means `ALLOY_CONTAINER_REGEX` is unset on one of the two Alloy containers — check with `docker exec tryme-prod-alloy env | grep ALLOY_CONTAINER_REGEX`.

- [ ] **Step 8: Verify the guardrail actually blocks a bad deploy**

On the VPS, temporarily set `SHOPIFY_API_KEY` in `.env.staging` to production's value, push a trivial commit to `dev`, and watch the run.

Expected: the deploy fails at the guardrail step with `SHOPIFY_API_KEY is identical to production's`, and `docker ps` shows no staging container rebuilt. Restore the correct value afterwards and re-push.

- [ ] **Step 9: Open the `dev` → `main` PR path**

Confirm a PR from `dev` to `main` runs CI and does not deploy (deploys are gated on `push`/`workflow_dispatch`, not `pull_request`).

Expected: checks run, no deploy job executes.

---

## Self-Review

**Spec coverage.** Spec §1 → Task 5. §2 → Task 2. §3 → Task 2 (env template) + Task 6 (vhosts, DNS, clone). §4 → Task 1. §5 → Task 4. §6 → Task 3. §7 → Tasks 1–6. §8 → Task 7. Open questions → Task 6 Step 3 (PixVerse recorded in progress.md; `VIDEO_CONCURRENCY=0` shipped in Task 2's template) and Task 6 Step 1 (capacity check).

**Naming consistency.** `check-staging-env.sh <staging-env> <prod-env>` — defined in Task 3, called with that argument order in Task 4 Step 2 and Task 5 Step 4. `ALLOY_CONTAINER_REGEX` — produced in Task 1, consumed in Task 2's alloy service. Container names `tryme-staging-*` — set in Task 2, addressed in Task 4 and Task 7. `PROD_ROOT` — required by Task 4's script, supplied in Task 6's runbook step 9.

**Verified against the codebase.** Task 4's `workers` INSERT matches `packages/db/src/schema/workers.ts` as read on 2026-08-06 (`id` text PK with no default, `label`, `url`, `api_key`, `is_active`, `allowed_job_types`). The five excluded MinIO prefixes were each traced to their writer: `keys.inputGarment` / `keys.output` in `packages/storage/src/keys.ts`, `merchant-inputs/` in `apps/api/src/modules/merchant/tryon.routes.ts:93`, `widget-outputs/` in `apps/dispatcher/src/job/processor.ts:1890`, `shopify-inputs/` in `apps/api/src/modules/shopify/customer.routes.ts:228`. Task 2's compose file mirrors `infra/docker-compose.prod.yml` service-for-service. Task 5's assertions were written against the actual `deploy` job in `.github/workflows/ci.yml`.

**Verified against the host** (surveyed 2026-08-06, see Host facts above): clone paths, bucket name and per-prefix sizes, free ports, disk and RAM headroom, CloudPanel/nginx layout, and production's live environment-variable set — which is what Task 2 Step 4b checks the template against, since `.env.production.example` in the repo has drifted from the live file.

**Highest-risk item, and why it is covered three times.** Production's `.env.production` sets `COMPOSE_PROJECT_NAME`, and Compose resolves the project name from that variable *above* the `name:` key in the compose file. A `.env.staging` copied from production without changing it silently turns every staging compose command into an operation on the production stack. Task 2 Step 3 puts `COMPOSE_PROJECT_NAME=tryme-staging` in the template, Task 2 Step 4c demonstrates the override empirically, Task 3 rejects any other value before a deploy proceeds, and Task 6 step 9 has the operator eyeball `config | head -3` before the first `up`.

**Deliberate divergences from production topology.** Two, both chosen and both recorded in the spec. (1) The chatbot is path-mounted at `/chatbot/` under both staging vhosts instead of getting its own subdomain, which additionally makes it same-origin for the web app and the admin SPA — production's `admin.` → `chatbot.` split is cross-origin. (2) `CHATBOT_URL` points in-network at `http://chatbot:4200` rather than at a public URL, since only the API reads it and only server-side.

**Open, unresolved.** PixVerse — staging shares production's key, so `VIDEO_CONCURRENCY=0` keeps the video lane shut. Swap on the host is 2 GiB and already fully consumed before staging exists; Task 6 step 2 requires recording `free -h` after first boot so the decision to raise swap is made on evidence. No staging GPU worker — jobs enqueue and stay `QUEUED`, which is the accepted end state until one is provisioned.
