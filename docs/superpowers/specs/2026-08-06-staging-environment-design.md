# Staging Environment on the Production VPS — Design

Date: 2026-08-06
Status: approved (design), not yet implemented

## Goal

A second, fully isolated environment on the same VPS as production, so changes can be
exercised against production-shaped data before they reach customers. Production must
keep working unchanged throughout.

## Decisions

These were settled during brainstorming and are not open for re-litigation during
implementation:

| Question | Decision |
|---|---|
| Data model | Snapshot copy. Staging runs its own Postgres, Redis and MinIO. |
| Asset seeding | Mirror everything except the five user-content prefixes (see §5). |
| GPU workers | None initially. The restore empties the `workers` table, so staging jobs enqueue and stay `QUEUED`. A dedicated staging ComfyUI box gets added later. Staging never dispatches to a prod GPU. |
| Data scrubbing | None. The snapshot is a raw copy of production rows. |
| Branch flow | `feature → dev → main`. Merge to `dev` deploys staging; `dev → main` PR deploys prod. |
| Service scope | All 11 services, Alloy included, shipping to a separate Grafana Cloud account. |
| Reachability | Two subdomains — `staging-app` and `staging-admin`.tryme.com. The chatbot gets no subdomain; it is served at the `/chatbot/` path under both. |
| Pipeline shape | One workflow (`ci.yml`), deploy target parameterized by `github.ref`. |

## Host facts (surveyed 2026-08-06)

The design is sized against the real box, not assumptions:

- 8 vCPU, 31 GiB RAM (8.8 GiB used, 22 GiB available), single `/dev/sda1` filesystem:
  387 G total, 79 G free (80% used). Docker shares that filesystem — there is no separate
  mount.
- Swap is 2 GiB and **fully consumed**. The host has been under memory pressure before.
- The box already runs three other Compose projects besides `tryme-prod`:
  `propicly-prod` (10 services, sibling product), `plane-app` (12 services, unrelated),
  and a stray local `tryme` project running `tryme-redis` + `tryme-minio`.
- 176.8 G of Docker build cache is reclaimable — larger than every data volume combined,
  and the obvious release valve if disk gets tight.
- Prod clone: `/home/tryme-app/htdocs/app.tryme.com`, with `.env.production` at its
  root. Local branch is `master`; irrelevant to deploys, which `git reset --hard` to an
  explicit SHA.
- Prod data: Postgres 205 MB, Redis 2.1 MB, MinIO 61 G in bucket `virtual-tryon-prod`.
- All seven intended staging ports are free.
- nginx 1.30.3 under CloudPanel 6.0.8. Vhosts in `/etc/nginx/sites-enabled/`, sites
  rooted at `/home/<site-user>/htdocs/<domain>`. Certificates are issued through
  CloudPanel's Let's Encrypt integration, not raw certbot — only the unrelated
  `rankplex.cloud` uses certbot directly.

Verdict: a second stack fits with margin. Staging needs roughly 15.6 G of object storage
plus a ~205 MB database against 79 G free.

## Non-goals

- No change to how production is built, migrated or deployed beyond the ref-based
  branching in the deploy job and one added env var on the Alloy service.
- No automatic prod → staging sync. The sync is a script an operator runs deliberately.
- No staging data flowing back to production, ever, in any direction.

---

## 1. Branch and pipeline

`.github/workflows/ci.yml` gains `dev` in both the `push` and `pull_request` branch
filters. The `detect`, `lint`, `typecheck`, `test` and `ci-scripts` jobs need no change —
none of them are ref-specific.

The `deploy` job resolves its target from `github.ref`:

| ref | compose file | env file | deploy path secret | concurrency group |
|---|---|---|---|---|
| `refs/heads/main` | `infra/docker-compose.prod.yml` | `.env.production` | `DEPLOY_PATH` | `tryme-production` |
| `refs/heads/dev` | `infra/docker-compose.staging.yml` | `.env.staging` | `STAGING_DEPLOY_PATH` | `tryme-staging` |

Implementation notes:

- The existing `if:` gate changes from `github.ref == 'refs/heads/main'` to a check that
  the ref is either `main` or `dev`. Everything else in that condition — the
  `!cancelled()` guard, the two `needs.*.result` checks, the event-name filter, the
  `has_deployable` check — stays exactly as written. The comment block above it explains
  why `!cancelled()` is load-bearing; keep it.
- A resolve step maps ref → `{COMPOSE_FILE, ENV_FILE, DEPLOY_PATH}` and writes them to
  `$GITHUB_ENV`. `DEPLOY_PATH` is selected between the two secrets in that step, so both
  secrets are referenced but only one is used.
- Concurrency becomes an expression on the resolved target name. Prod and staging deploys
  must never share a group — a staging deploy must not be able to cancel or queue behind a
  prod deploy.
- The SSH block's `git fetch ... main` becomes `git fetch ... $BRANCH` where `$BRANCH` is
  `main` or `dev`. The `git reset --hard $DEPLOY_SHA` behaviour is unchanged and still the
  reason the deployed SHA equals the tested SHA.

New GitHub secret: `STAGING_DEPLOY_PATH`. `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` are
reused as-is — same box, same key. No GitHub Environments are introduced; moving the
existing repo-level secrets into an environment would change the production path for no
benefit.

## 2. Compose stack

New file `infra/docker-compose.staging.yml`, derived from `docker-compose.prod.yml` with
these differences and no others:

- `name: tryme-staging`, **and** `COMPOSE_PROJECT_NAME=tryme-staging` in
  `.env.staging`. Both are required. Compose resolves the project name from
  `COMPOSE_PROJECT_NAME` *above* the `name:` key, and production's `.env.production`
  already sets that variable — so a `.env.staging` copied from prod without changing it
  would make `docker compose -f docker-compose.staging.yml --env-file .env.staging up -d`
  recreate **production's** containers with staging configuration. The guardrail in §6
  checks this.
- every `container_name` becomes `tryme-staging-*`
- network renamed `tryme-staging-net`
- env-file mounts point at `../.env.staging` (both the `api`/`chatbot` volume mounts and
  the `dispatcher` `env_file:`)
- host port bindings shifted (below)
- the `alloy` service gains `ALLOY_CONTAINER_REGEX: /tryme-staging-.*`

Volume keys stay `pgdata`, `redisdata`, `miniodata`, `alloydata`. Compose namespaces
volumes by project name, so they materialise as `tryme-staging_pgdata` and cannot
collide with the prod stack's `tryme-prod_pgdata`.

Host ports are production + 100:

| service | prod | staging |
|---|---|---|
| web | 3000 | 3100 |
| admin | 3001 | 3101 |
| shopify-admin | 3003 | 3103 |
| api | 4000 | 4100 |
| chatbot | 4200 | 4300 |
| minio | 9000 | 9100 |
| minio console | 9001 | 9101 |

Staging api's host port 4100 is unrelated to the dispatcher's internal metrics port 4100;
that one is never published to the host, and the two live on different Docker networks.

All bindings stay on `127.0.0.1`, as in production. Public reach is via CloudPanel only.

## 3. Environment file and domains

`.env.staging` sits at the root of the staging clone, git-ignored and hand-created, the
same handling `.env.production` gets today. A committed `.env.staging.example` documents
it.

Values that must differ from production:

- `DATABASE_URL`, `REDIS_URL` — point at the staging containers (service names resolve
  inside `tryme-staging-net`, so the URLs are textually similar; the isolation comes
  from the network, not the string)
- `POSTGRES_*`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` — independent credentials
- `JWT_SECRET`, `COOKIE_SECRET`, `SHOPIFY_TOKEN_ENC_KEY` — independent secrets. Note that
  because the DB is a raw prod copy, a *different* `SHOPIFY_TOKEN_ENC_KEY` renders the
  copied `shopify_stores` access tokens undecryptable in staging. That is the desired
  outcome: it means staging structurally cannot call a live merchant storefront, without
  needing a scrub step to achieve it.
- `WEB_URL`, `CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`, `CHATBOT_URL`,
  `NEXT_PUBLIC_CHATBOT_URL`, `VITE_CHATBOT_URL`, `VITE_TRYME_APP_URL`,
  `VITE_API_BASE_URL`, `GOOGLE_CALLBACK_URL`, `SHOPIFY_APP_URL` — staging domains
- `RAZORPAY_*` — test-mode keys
- `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `VITE_SHOPIFY_API_KEY` — a separate Shopify
  dev app
- `RESEND_API_KEY`, `EMAIL_FROM` — non-production sender
- `GRAFANA_CLOUD_*` — the new free-tier Grafana Cloud account
- `TRYME_ENV=staging` — new marker, read only by the deploy guardrail (see §6). No
  application code reads it, so no code change is needed to introduce it.
- `COMPOSE_PROJECT_NAME=tryme-staging` — see §2. Non-negotiable.
- `VIDEO_CONCURRENCY=0` — see Open Questions

CloudPanel vhosts to create — two, not three:

| host | path | upstream | notes |
|---|---|---|---|
| `staging-app.tryme.com` | `/` | 3100 | |
| | `/v1/` | 4100 | |
| | `/minio/` | 9100 | |
| | `/chatbot/` | 4300 | prefix stripped; WebSocket upgrade |
| `staging-admin.tryme.com` | `/` | 3101 | |
| | `/admin/`, `/v1/` | 4100 | |
| | `/shopify-admin` | 3103 | |
| | `/chatbot/` | 4300 | prefix stripped; WebSocket upgrade |

The chatbot has no subdomain of its own. Every consumer builds its requests as
`${CHATBOT_URL}/ws-ticket`, `${CHATBOT_URL}/ws`, `${CHATBOT_URL}/conversations/…` and
derives the socket URL with `.replace(/^http/, 'ws')` — see
`apps/catalogues-web/src/components/chat-widget.tsx` and
`apps/admin-web/src/lib/chatws.ts` — so a base URL carrying a path prefix concatenates
correctly and `https://host/chatbot` becomes `wss://host/chatbot`. NGINX strips the
prefix (`proxy_pass http://127.0.0.1:4300/;` with the trailing slash), so the chatbot
service itself is unaware it is mounted on a path.

Mounting `/chatbot/` under *both* vhosts lets the web app and the admin SPA each reach it
same-origin. Production's `admin.` → `chatbot.` split is cross-origin and needs CORS and
cross-origin WebSocket handling; staging sidesteps that. This is a deliberate divergence
from production topology, and the one place staging is not a faithful mirror.

Server-to-server calls are a separate case. `CHATBOT_URL` is read only by the API
(`apps/api/src/modules/admin/chatbot.routes.ts`, for `/ingest` and `/health`), so staging
sets it to the in-network `http://chatbot:4200` rather than routing container→NGINX→
container. `NEXT_PUBLIC_CHATBOT_URL` and `VITE_CHATBOT_URL` are the browser-facing values
and carry the public path URLs.

The staging clone is a separate checkout tracking `dev`, at
`/home/tryme-app/htdocs/staging-app.tryme.com` — a sibling of the production clone
under the same `htdocs` directory, which is also the CloudPanel site root for the staging
web vhost. That sibling layout is what makes the guardrail's relative path to production's
env file (`../app.tryme.com/.env.production`) stable.

## 4. Observability separation

Alloy discovers containers off the Docker socket and currently keeps everything matching
`/tryme-.*`. Both stacks run on the same host and both mount the same socket, so
without a change **each environment's Alloy would ingest the other's logs and metrics**.

`infra/observability/alloy.alloy` changes in two places:

- the `keep` rule's regex becomes `coalesce(sys.env("ALLOY_CONTAINER_REGEX"), "/tryme-.*")`
- the `service` label regex widens to `/tryme-(?:prod-|staging-)?(.*)` so the label is
  still just `api`, `dispatcher`, … in both environments

`infra/docker-compose.prod.yml` sets `ALLOY_CONTAINER_REGEX: /tryme-prod-.*` on its
Alloy service; the staging compose sets `/tryme-staging-.*`. The `coalesce` default
preserves current behaviour for the local `docker-compose.yml` stack, whose containers are
named `tryme-*` with no environment segment.

Because staging Alloy writes to a different Grafana Cloud account entirely, no dashboard
or query in the production account needs an `env` filter added.

Side effect worth noting: the host already runs a stray local `tryme` Compose project
(`tryme-redis`, `tryme-minio`) whose container names match the current `/tryme-.*`
filter, so production's Loki has been ingesting those two containers all along. Pinning
prod to `/tryme-prod-.*` stops that too.

## 5. Data sync

`scripts/staging/sync-from-prod.sh`, run by an operator on the VPS. It is never invoked
from CI, and it never writes to production.

Steps:

1. `pg_dump -Fc` from `tryme-prod-postgres`, reading credentials from
   `.env.production`. Read-only against prod; this is the only prod resource the script
   touches.
2. Drop and recreate the staging database, then `pg_restore` the dump into
   `tryme-staging-postgres`.
3. `mc mirror` from the prod MinIO to the staging MinIO, excluding five prefixes that
   hold customer-supplied photos or generated results — all regenerable, and together
   45.4 G of the bucket's 61 G:

   | prefix | size | what it is |
   |---|---|---|
   | `inputs/` | 5.5 G | user-uploaded garments (`keys.inputGarment`) |
   | `outputs/` | 38 G | job results and thumbnails (`keys.output`) |
   | `merchant-inputs/` | 1013 M | kiosk/QR customer photos (`merchant/tryon.routes.ts`) |
   | `widget-outputs/` | 890 M | widget job results (`dispatcher/job/processor.ts`) |
   | `shopify-inputs/` | 144 K | Shopify customer photos (`shopify/customer.routes.ts`) |

   Everything else is copied, ~15.6 G, dominated by `models/` at 12 G. Note that
   `shopify-garments/` and `shopify-catalog-garments/` are **not** excluded despite the
   naming — they hold merchant product images referenced by `catalog_items` rows, and
   dropping them leaves staging merchant catalogs rendering broken thumbnails.
4. Apply `scripts/staging/post-restore.sql`: `DELETE FROM workers`. The snapshot inherits
   production's worker rows, which point at the live GPUs behind Cloudflare tunnels;
   emptying the table is what stops the staging dispatcher from selecting one. Nothing is
   inserted — staging has no GPU yet, so jobs enqueue, the dispatcher finds no healthy
   worker, and they remain `QUEUED`. When a dedicated staging ComfyUI box exists, it gets
   added through the admin panel like any other worker, and this file gains an INSERT so
   the row survives the next sync.
5. Re-run migrations against staging (`docker compose ... run --rm api pnpm db:migrate:prod`,
   which resolves `/app/.env` from the mounted `.env.staging`). The restore reset the
   schema to production's, so any migration that exists on `dev` but not on `main` has to
   be re-applied.
6. Restart the staging dispatcher so it re-reads the worker registry from the rewritten
   `workers` table.

Redis is deliberately not copied. Staging Redis starts empty; the job streams, consumer
group and worker registry are all rebuilt by the dispatcher on boot, and nothing durable
lives there that a snapshot would need to preserve.

Re-syncing is also the rollback story for staging: the environment is disposable, so a
broken staging database is fixed by running the script again rather than by restoring a
backup.

## 6. Deploy guardrails

The snapshot is unscrubbed, so it contains real customer emails, real merchant records and
real payment history. Nothing in the data prevents staging from acting on them; the
outbound credentials in `.env.staging` are the only barrier. The staging deploy therefore
aborts before touching any container unless `.env.staging` passes all of:

- contains a line `TRYME_ENV=staging`
- `COMPOSE_PROJECT_NAME` is exactly `tryme-staging` — the check that stops a
  copied env file from pointing the staging deploy at the production project
- contains no occurrence of `rzp_live_`
- `SHOPIFY_API_KEY` differs from the value in `.env.production`
- `EMAIL_FROM` is not the production sender address

These checks run inside the SSH block on the VPS, before `compose build`, and are fatal on
failure. They are cheap and they fail closed: a `.env.staging` accidentally copied from
production cannot deploy.

The distinct `SHOPIFY_TOKEN_ENC_KEY` described in §3 is a second, structural layer — even
if a guardrail were bypassed, copied Shopify tokens do not decrypt in staging.

## 7. Files touched

New:

- `infra/docker-compose.staging.yml`
- `scripts/staging/sync-from-prod.sh`
- `scripts/staging/post-restore.sql`
- `.env.staging.example`

Edited:

- `.github/workflows/ci.yml` — `dev` triggers, ref-based deploy target, concurrency
  expression, branch-aware fetch
- `infra/observability/alloy.alloy` — env-driven container filter, widened service regex
- `infra/docker-compose.prod.yml` — one `ALLOY_CONTAINER_REGEX` line on the Alloy service

Manual, outside the repo:

- `STAGING_DEPLOY_PATH` GitHub secret
- staging clone on the VPS, tracking `dev`
- `.env.staging` on the VPS
- two CloudPanel vhosts + DNS records + certs, each with a `/chatbot/` location
- new Grafana Cloud account

Deferred, not required for staging to be useful:

- dedicated staging ComfyUI VPS with its own cloudflared tunnel

## 8. Verification

Staging is working when, in order:

1. A push to `dev` runs the full pipeline and deploys only to `STAGING_DEPLOY_PATH`, with
   prod containers untouched (`docker ps` shows unchanged prod uptimes).
2. `staging-app.tryme.com` serves the web app and a login succeeds against
   snapshot data.
3. The admin panel at `staging-admin.tryme.com` lists faces, backgrounds, poses and
   catalog items with images rendering — proving the MinIO mirror covered the admin
   asset prefixes.
4. A try-on job submitted in staging deducts credits, writes a `jobs` row and reaches
   `QUEUED`, with no entry appearing in the production `jobs` table and no request hitting
   a production GPU. It stays `QUEUED` — that is the expected end state until a staging
   worker is registered.
5. Prod Grafana shows no `tryme-staging-*` containers; the staging Grafana account
   shows no `tryme-prod-*` containers.
6. A deliberately malformed `.env.staging` (prod Shopify key) is rejected by the deploy
   guardrail before any container is rebuilt.

## Open questions

- **PixVerse.** Deferred by decision. Staging shares the production PixVerse key, so a
  staging catalog-video job would bill the real account. Until this is resolved,
  `.env.staging.example` ships `VIDEO_CONCURRENCY=0` so the video lane never dispatches —
  the deferral fails closed rather than open. Resolving it means either a second PixVerse
  key or accepting the spend and raising the concurrency.
- **Swap exhaustion.** The host's 2 GiB swap is fully consumed before staging exists.
  22 GiB of RAM is available so the second stack should fit, but the swap figure says the
  box has been squeezed before, and three unrelated Compose projects share it. Watch
  memory after staging's first boot; raising swap is the cheap mitigation.
- **Disk at 80%.** 79 G free covers staging's ~16 G comfortably, but staging adds a second
  build pipeline on a filesystem that already holds 176.8 G of reclaimable build cache.
  `docker builder prune` before the first staging build is the recommended first move.
