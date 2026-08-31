# Observability

Tryme ships logs and metrics to **Grafana Cloud** (free tier) via a single **Grafana Alloy**
agent that runs as one container on the VPS. Apps stay light: they emit structured pino logs to
stdout (already the case) and expose a Prometheus `/metrics` endpoint. Nothing observability-
related is exposed to the public internet.

```
api  ──/metrics──┐
                 ├─ Alloy (scrape + docker log tail) ──► Grafana Cloud (Loki + Prometheus)
dispatcher /metrics┘
container stdout ─┘
```

Milestone 1 (this doc) = **logs + metrics + dashboards + alerts**. Distributed tracing + Sentry
error capture are Milestone 2.

## What is instrumented

**Metrics** (`packages/observability`, exposed at `GET /metrics`):

| Metric | Type | Source | Notes |
|--------|------|--------|-------|
| `http_request_duration_seconds` | histogram | api | labels `method,route,status`; `route` is the matched template |
| `jobs_created_total` | counter | api | label `priority` (priority\|normal) |
| `credits_deducted_total` / `credits_refunded_total` | counter | api | from the credit ledger |
| `jobs_processed_total` | counter | dispatcher | label `outcome` (success\|failed\|retried) |
| `job_processing_duration_seconds` | histogram | dispatcher | label `outcome`; dispatcher-only — timed from when the dispatcher claims the job off Redis, so it excludes queue wait |
| `job_e2e_duration_seconds` | histogram | dispatcher | label `outcome` (completed\|failed\|cancelled); true click-to-result time, `completedAt - createdAt`, includes queue wait. The gap between this and `job_processing_duration_seconds` is queue wait time |
| `job_attempts_total` | counter | dispatcher | one per real processing attempt |
| `comfy_request_duration_seconds` | histogram | dispatcher | submit → completion round-trip |
| `queue_depth` | gauge | dispatcher | label `stream`; sampled every 15s (XLEN) |
| `workers_healthy` | gauge | dispatcher | sampled on the health-monitor tick |
| `nodejs_*` / `process_*` | various | both | prom-client default metrics |

The api endpoint is `api:4000/metrics`; the dispatcher reuses its health server on
`dispatcher:4100/metrics` (bound `0.0.0.0` inside the container so Alloy can reach it over the
Docker network — no host port is published).

**Logs**: pino JSON on stdout. Alloy parses each line, promotes `level` to a Loki label, and
attaches `jobId` / `userId` as structured metadata. Filter in Grafana Explore with e.g.
`{job="tryme", service="dispatcher"} | jobId="..."`.

## One-time Grafana Cloud setup

1. Create a free stack at <https://grafana.com>.
2. On the stack's **Connections → Details** (or "Send Metrics/Logs") page, copy:
   - Loki: push URL + username (numeric instance ID)
   - Prometheus: remote_write URL + username (numeric instance ID)
3. Create one **Access Policy token** with `logs:write` + `metrics:write`.
4. Fill these in `.env.production` (see `.env.production.example`):
   ```
   GRAFANA_CLOUD_LOKI_URL=
   GRAFANA_CLOUD_LOKI_USER=
   GRAFANA_CLOUD_PROM_URL=
   GRAFANA_CLOUD_PROM_USER=
   GRAFANA_CLOUD_API_KEY=
   ```
5. Deploy: `docker compose -f infra/docker-compose.prod.yml up -d alloy` (rebuild api +
   dispatcher first so they expose `/metrics`).
6. Verify: `docker logs tryme-prod-alloy` shows no auth errors; in Grafana Cloud, Explore →
   Loki shows `{job="tryme"}`, and Prometheus has `queue_depth` / `http_request_duration_seconds`.

## Testing locally

**Stage A — metrics endpoints (no credentials).** Confirms instrumentation:

```bash
pnpm docker:up
pnpm --filter @tryme/api dev          # terminal 1
pnpm --filter @tryme/dispatcher dev   # terminal 2
curl -s localhost:4000/metrics | grep -E "http_request|jobs_created|credits_"
curl -s localhost:4100/metrics | grep -E "jobs_processed|queue_depth|workers_healthy"
```

**Stage B — full pipeline to Grafana Cloud (needs the 5 `GRAFANA_CLOUD_*` vars in root `.env`).**
To exercise **logs and metrics** locally, run api + dispatcher as containers (Alloy's Docker
discovery can't see host-run `pnpm dev` processes). The `apps` profile runs them as containers on
the local infra network with `NODE_ENV=production` (so logs are JSON); the `observability` profile
runs Alloy, which scrapes `api:4000` / `dispatcher:4100` and tails their container logs.

```bash
# Stop `pnpm dev` first (containers and host apps are separate).
docker compose -f infra/docker-compose.yml --profile apps --profile observability up -d --build
docker logs -f tryme-alloy            # expect no auth/remote_write errors
```

Then in Grafana Cloud:
- Explore → Prometheus: query `queue_depth`, `http_request_duration_seconds_count`.
- Explore → Loki: `{job="tryme"}` — logs from `tryme-api` / `tryme-dispatcher`, filterable
  by `service` and (structured metadata) `jobId` / `userId`.

The containers reuse your dev Postgres/Redis/MinIO by service name and read the dev root `.env`
(the three host-only URLs — `DATABASE_URL`, `REDIS_URL`, `R2_ENDPOINT` — are overridden to
container hostnames in the compose file). Tear down with
`docker compose -f infra/docker-compose.yml --profile apps --profile observability down`.

## Dashboards

Import `infra/observability/dashboards/tryme-overview.json` in Grafana
(**Dashboards → New → Import**), selecting your Prometheus data source. Panels: queue depth,
jobs by outcome, job duration p50/p95, E2E job latency p50/p95, workers healthy, HTTP request rate,
HTTP p95 latency, ComfyUI round-trip p50/p95.

## Alerts

Create these in Grafana Cloud (**Alerting → Alert rules**), wired to an email/Slack contact point:

| Alert | Condition (PromQL) |
|-------|--------------------|
| No healthy workers | `workers_healthy == 0` for 2m |
| Queue backing up | `sum(queue_depth) > 50` for 10m |
| Job failure rate high | `sum(rate(jobs_processed_total{outcome="failed"}[10m])) / sum(rate(jobs_processed_total[10m])) > 0.2` |
| API 5xx rate high | `sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) > 0.5` |
| API p95 latency high | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 2` |
| E2E latency high | `histogram_quantile(0.95, sum by (le) (rate(job_e2e_duration_seconds_bucket[10m]))) > 120` |

## Security: keep `/metrics` off the public internet

Alloy scrapes `/metrics` directly over the Docker network, so the endpoints do **not** need to be
publicly routable. The API is reverse-proxied by CloudPanel NGINX (`rankplex.cloud/v1/` →
`localhost:4000`). Add a deny rule in the API vhost so `/v1/metrics` is not exposed:

```nginx
location = /v1/metrics {
    return 403;
}
```

The dispatcher publishes no host port, so its `/metrics` is already private.
