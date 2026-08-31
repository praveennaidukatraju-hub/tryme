# Staging Environment VPS Provisioning Runbook

This document describes the manual, one-time VPS provisioning steps needed to set up the staging environment. The staging clone resides on the same VPS as production (`app.tryme.com`), under a separate `tryme-staging` Compose project, so the environment can be rebuilt without re-deriving these steps from scratch.

## 1. Reclaim build cache first

The box is at 80% disk (79 G free) and carries 176.8 G of reclaimable Docker build cache. Staging adds a second build pipeline to the same filesystem, so clear it before the first staging build:

```bash
docker system df                # confirm the reclaimable figure
docker builder prune -f         # frees ~176 G; next builds are slower, nothing else is lost
df -h /
```

**Note:** The host has a single `/dev/sda1` filesystem shared by Docker, CloudPanel sites and everything else — there is no separate Docker mount to fill independently.

## 2. Capacity baseline

Record before and after: `free -h`, `df -h /`, `docker system df`. Expected staging footprint: ~15.6 G of MinIO objects plus a ~205 MB database.

**Flag:** Swap is 2 GiB and already fully consumed, so watch `free -h` after staging's first boot — three other Compose projects (`propicly-prod`, `plane-app`, the stray local `tryme`) share this host.

## 3. Clone

CloudPanel gives every site its own Linux user and home directory — staging is
**not** a sibling of production. Confirmed layout on this VPS:

| site | user | path |
|---|---|---|
| `app.tryme.com` (prod) | `tryme-app` | `/home/tryme-app/htdocs/app.tryme.com` |
| `staging-app.tryme.com` | `tryme-staging-app` | `/home/tryme-staging-app/htdocs/staging-app.tryme.com` |
| `staging-admin.tryme.com` | `tryme-staging-admin` | `/home/tryme-staging-admin/htdocs/staging-admin.tryme.com` |

Only **one** clone is needed — `docker-compose.staging.yml` runs every staging
service (web, admin, api, chatbot, dispatcher, shopify-admin) as one Compose
project regardless of which vhost's directory holds it. Clone into the
`staging-app.tryme.com` site directory; the `staging-admin.tryme.com`
site directory stays empty (nginx-only, reverse-proxies into the same
container ports — same pattern as prod's own unused docroot):

```bash
git clone https://github.com/adeshboudhnicedigitals/tryme.git \
  /home/tryme-staging-app/htdocs/staging-app.tryme.com
cd /home/tryme-staging-app/htdocs/staging-app.tryme.com
git checkout dev
```

`.github/workflows/ci.yml` passes the guardrail an **absolute** path to
`.env.production` (`/home/tryme-app/htdocs/app.tryme.com/.env.production`)
for this reason — a relative `../app.tryme.com/...` cannot cross separate
per-site home directories. If any of the three paths above ever change,
update that line and the `STAGING_DEPLOY_PATH` GitHub secret to match.

## 4. Env file

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging      # prod's is 644; staging holds an unscrubbed snapshot's keys
# fill every change_me, then:
bash scripts/staging/check-staging-env.sh .env.staging /home/tryme-app/htdocs/app.tryme.com/.env.production
```

`COMPOSE_PROJECT_NAME=tryme-staging` is the one line that must never be copied from production — see Task 3. The script `scripts/staging/check-staging-env.sh` must pass before any deploy, or the build aborts.

## 5. GitHub secret

Add `STAGING_DEPLOY_PATH` = `/home/tryme-staging-app/htdocs/staging-app.tryme.com` (the `staging-app` CloudPanel site's own directory — see Step 3 for why this isn't a sibling of production's path). `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` are reused unchanged.

## 6. DNS + CloudPanel

Create **two** CloudPanel sites — `staging-app.tryme.com` and `staging-admin.tryme.com` — as reverse proxies to the ports below. Certificates go through CloudPanel's Let's Encrypt integration (`clpctl` 6.0.8), **not** raw certbot: only the unrelated `rankplex.cloud` uses certbot directly on this box, and everything else including `app.tryme.com` is CloudPanel-managed. Vhost files land in `/etc/nginx/sites-enabled/`.

### Vhost port routing

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

**Note:** Port 9101 (MinIO console) has no public vhost. It is bound to `127.0.0.1:9101` (see `infra/docker-compose.staging.yml`) for SSH-tunnel-only access, same as production's MinIO console on 9001 — neither is proxied through CloudPanel/nginx.

### Complete vhost location blocks

Nginx matches the most specific `location` first, so every block below must sit **above** the catch-all `location /` in each site's server block. CloudPanel scaffolds the catch-all automatically when the site is created — merge these into the existing server block rather than replacing the file.

**`staging-app.tryme.com`** — full set:

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /minio/ {
    # Trailing slash on proxy_pass is required — it tells nginx to strip the
    # matched /minio/ prefix before forwarding. The bucket lives at MinIO's
    # root, not under a /minio/ path; without the trailing slash nginx
    # forwards the full /minio/<bucket>/<key> URI and MinIO 403s.
    proxy_pass http://127.0.0.1:9100/;
    proxy_set_header Host $host;
}

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

location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**`staging-admin.tryme.com`** — full set:

```nginx
location /admin/ {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /v1/ {
    proxy_pass http://127.0.0.1:4100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /shopify-admin/ {
    proxy_pass http://127.0.0.1:3103/;
    proxy_set_header Host $host;
}

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

location / {
    proxy_pass http://127.0.0.1:3101;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

After merging both files: `nginx -t`, then reload/save through CloudPanel, then issue Let's Encrypt certs for both sites via `clpctl`.

### ChatBot WebSocket configuration

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

**Critical:** `proxy_read_timeout` matters — the default 60s silently drops idle chat sockets.

## 7. Staging GPU worker — deferred

Staging ships with an empty `workers` table, so jobs enqueue and stay `QUEUED`. Nothing to configure now. When a dedicated ComfyUI box exists: provision it, install `cloudflared`, register it through the staging admin panel, restart the staging dispatcher, and add a matching INSERT to `scripts/staging/post-restore.sql` so the row survives the next sync.

## 8. Grafana Cloud

New free-tier account. Copy its Loki/Prometheus URLs, users and API key into `.env.staging`. Do not reuse production's.

## 9. First boot

```bash
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging config | head -3
# MUST print: name: tryme-staging
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging up -d --build
docker compose -f infra/docker-compose.staging.yml --env-file .env.staging ps
```

**Critical:** Check the `config | head -3` output before the `up`. If it prints `tryme-prod`, stop — `COMPOSE_PROJECT_NAME` is wrong and the next command would recreate production.

## 10. First sync

```bash
bash scripts/staging/sync-from-prod.sh --dry-run   # read every line
bash scripts/staging/sync-from-prod.sh
```

`PROD_ROOT` defaults to `/home/tryme-app/htdocs/app.tryme.com`; override it only if the layout changed. Expect the mirror to move ~15.6 G.

## 11. Re-sync cadence

Whenever staging data drifts too far to be useful. The environment is disposable — a broken staging database is fixed by re-running the sync, not by restoring a backup.
