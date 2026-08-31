# Tryme — Phased Development Plan

Two-developer team. Split below is **Dev A (Backend/Infra)** and **Dev B (Frontend/Admin UI)**. Phases are sequential at the macro level but most tasks within a phase run in parallel once the shared contracts (DB schema + Zod types) are locked at the start of each phase.

**Legend:**  
`[A]` = Dev A | `[B]` = Dev B | `[AB]` = both pair or sequential dependency | `[?]` = open decision needed before task starts

---

## Phase 0 — Foundations (Day 1–2)

Goal: One command boots the full dev environment. Contracts are locked. No app code yet.

| Task | Owner | Status |
|---|---|---|
| pnpm monorepo root config | A | done |
| `tsconfig.base.json`, `.prettierrc`, `.gitignore`, `.npmrc` | A | done |
| `infra/docker-compose.yml` (Postgres 16, Redis 7, MinIO) | A | done |
| `infra/postgres/init/01-extensions.sql` | A | done |
| `.env.example` with all variables | A | done |
| `CLAUDE.md` | AB | done |
| `@tryme/logger` package (pino) | A | done |
| `@tryme/db` — Drizzle schema + migrations | A | done |
| `@tryme/types` — Zod schemas (auth, credits, catalog, jobs, admin) | A | done |
| `@tryme/storage` — R2/MinIO presign + key helpers | A | done |
| Cloudflare Tunnel config templates (`infra/cloudflared/`) | A | done |
| Catalog taxonomy seed manifest JSON | B | pending |

**Open decisions needed before Phase 0 closes:**

> **[?] Domain name** — `WORKER_A_URL`, `WORKER_B_URL`, and `R2_PUBLIC_URL` all reference `tryon.yourdomain.com`. Decide the real domain before hardcoding any config.

> **[?] Catalog seed scope for v1** — How many models / poses / backgrounds / lower garments ship at launch? We need the actual image assets before `scripts/seed-catalog.ts` can run. Decide minimum viable catalog count.

> **[?] Git branching strategy** — mono-repo, single `main` + feature branches? Or `dev` → `staging` → `main` flow? Affects PR review triggers in CI.

---

## Phase 1 — Backend API (Week 1–2)

Goal: Full API surface behind `localhost:4000`. All user routes + full admin surface. No dispatcher, no web UI. Ends at `XADD` to Redis stream (jobs stay `QUEUED` forever until dispatcher lands in Phase 2).

**Detailed task plan:** see `docs/superpowers/plans/2026-05-18-backend-phase-1-api.md`

### 1A — Shared Infrastructure [A, Days 1–4]

- `@tryme/db` schema + drizzle-kit migrations (15 tables)
- `@tryme/types` Zod schemas
- `@tryme/storage` R2 presign provider
- `apps/api` Fastify scaffold: plugins (helmet, cors, rate-limit, cookie, zod-type-provider)
- `env.ts` — Zod-validated `process.env`
- `lib/errors.ts` — `AppError` + global error handler
- Testcontainers harness for integration tests

### 1B — Auth + Credits [A, Days 3–6]

- `POST /v1/auth/register` — Argon2id hash, create `users` + `user_credits` rows, issue JWT + refresh cookie
- `POST /v1/auth/login` — 5/min rate limit per IP, return token pair
- `POST /v1/auth/refresh` — rotate refresh (revoke old, insert new)
- `POST /v1/auth/logout` — revoke refresh cookie
- `GET /v1/credits` — balance + recent 20 ledger entries
- `requireUser` preHandler decorator
- `atomicDeduct` / `refund` / `adminGrant` ledger helpers
- Integration tests: duplicate email, wrong password, token rotation, credit deduct atomicity

**Open decisions:**

> **[?] Email verification** — Design doc is silent. Do we require email verification before first login, or skip for v1? Skipping is simpler but means anyone can register with any email. **Recommend:** skip for v1, add note in PHASES v2 section.

> **[?] Password reset flow** — Not in design doc. Requires email service. **Recommend:** defer to v2; note below.

> **[?] Email service** — If we add email verification or password reset, we need a transactional email provider (Resend, Postmark, SES). No decision yet. **Action:** decide before v2.

### 1C — Catalog + Uploads + Jobs [A, Days 5–8]

- `GET /v1/catalog/:type` — category tree + items with thumbnail presigned URLs
- `POST /v1/uploads/presign` — return presigned PUT URL for garment (5min, 10MB, JPEG/PNG/WebP only)
- `POST /v1/jobs/tryon` — validate 4 catalog IDs active → atomic credit deduct in single Postgres txn → insert `jobs` + `job_inputs` → `XADD jobs:normal|jobs:priority`
- `GET /v1/jobs` — list own jobs (50 latest)
- `GET /v1/jobs/:id` — detail
- `GET /v1/jobs/:id/result` — presigned GET (only if `COMPLETED`)
- `GET /v1/jobs/:id/events` — SSE stream (Redis pub/sub, 15s heartbeat, filter by jobId)
- `promptGuard` — strip control characters, max 300 chars on `userHint`
- Magic-byte + mime + size validation on upload presign request
- Integration tests: catalog tree shape, 402 on zero credits, 400 on inactive catalog ID, refund on XADD failure, SSE frame delivery

**Open decisions:**

> **[?] Credit cost per job** — Currently hardcoded as `1` credit in `create.ts`. Should this live in system config (Redis `config:system`)? If yes, `createJob` should read `config:system` before deducting. **Recommend:** read from Redis config with fallback to `1`, so admin can adjust live.

> **[?] Magic-byte validation on garment upload** — Design doc mentions this. We generate the presigned URL without seeing the bytes (client uploads directly to R2). Magic-byte check needs to happen either: (a) client-side before upload, (b) a post-upload webhook from R2 (R2 doesn't support this natively), or (c) dispatcher reads + validates before patching workflow. **Recommend:** dispatcher validates bytes when it fetches from R2 before sending to ComfyUI. Note this here.

> **[?] Presigned URL expiry for catalog thumbnails** — In `GET /v1/catalog/:type`, are thumbnail URLs long-lived public URLs (if R2 bucket has public access) or presigned (private)? Public is simpler and faster. **Recommend:** make catalog bucket path public via R2 custom domain in v1 (no presign per item). Decision affects `storage.publicUrl()` vs `storage.presignGet()` in `catalog/routes.ts`.

### 1D — Admin Surface [A, Days 6–10]

- `guard.ts` — `requireAdmin(roles[])` checks `admin_users` row on every request
- `scripts/bootstrap-admin.ts` — idempotent first-admin seed from env
- **Users:** `GET /admin/users`, `GET /admin/users/:id` (with balance + job history), `PATCH /admin/users/:id` (tier/ban/forceLogout), `DELETE /admin/users/:id` (soft-delete)
- **Credits:** `POST /admin/credits/grant`, `/bulk-grant`, `/deduct`, `GET /admin/credits/ledger/:userId`, `GET /admin/credits/stats`
- **Catalog:** presign + confirm item upload, patch item, delete item + R2 cleanup, create/patch/delete categories
- **Jobs:** list all jobs, detail with events, force-retry FAILED, force-cancel + refund
- **Workers:** live registry from Redis hash + health key, drain worker
- **Config:** `GET/PATCH /admin/config` (creditCostPerJob, maxJobsPerDay), `GET /admin/stats`
- Integration tests: role enforcement (SUPPORT cannot grant credits), bulk grant count, drain sets status

**Open decisions:**

> **[?] Admin panel URL prefix** — `/admin/*` is currently unauthenticated at the path level; it relies on JWT + `admin_users` check. Do we want Cloudflare Access to additionally gate the entire `/admin/*` path at the edge, so a brute-force on admin routes never reaches the origin? **Recommend:** yes, add Cloudflare Access policy for `/admin/*` in production.

> **[?] Admin audit log** — Design doc has no table for admin actions. Currently all credit changes go to `credit_ledger` with `admin_id`. But user bans, catalog deletes, config changes leave no audit trail. Should we add a generic `admin_audit_log` table? **Recommend:** add in Phase 1D or defer to v2. Decide before Phase 1D starts.

---

## Phase 2 — Dispatcher (Week 2–3)

Goal: Jobs actually get processed. ComfyUI on VPS A/B receives workflow, produces output, result lands in R2, SSE completes.

### 2A — Dispatcher Service [A, Days 9–14]

**Files:** `apps/dispatcher/`

- `env.ts` — validate all worker + tunnel env vars
- Redis Stream consumer: `XREADGROUP` on `jobs:priority` then `jobs:normal` (priority-aware: drain priority queue first)
- Worker registry: read `worker:registry` hash + `worker:health:{id}` keys
- Worker health monitor: probe `/system_stats` every 15s via CF Tunnel, set TTL-30 health key
- `selectWorker()` — iterate registry, skip BUSY/DRAINING/unhealthy, atomically claim (set BUSY)
- ComfyUI client: `POST /prompt` + WebSocket progress listener (parse `execution_complete` event)
- Workflow patcher: clone `templates/virtual-tryon-v1.json`, inject all 5 R2 image URLs
- Result uploader: fetch output from ComfyUI `/history`, upload to `outputs/{jobId}/result.png` via R2
- SSE publisher: `redis.publish('sse:events:{userId}', JSON.stringify({jobId, type, ...}))` at each stage
- Retry logic: on failure increment `attempts`; if `attempts >= 2` → FAILED + credit refund; else re-enqueue
- `XACK` only after terminal state (COMPLETED or FAILED with max retries)
- Job state transitions: `QUEUED → PREPROCESSING → GENERATING → UPLOADING → COMPLETED | FAILED`
- Integration tests: mock ComfyUI HTTP + WS, verify state machine transitions, verify refund on max retry

**Open decisions:**

> **[?] ComfyUI workflow template** — `templates/virtual-tryon-v1.json` does not exist yet. This is the actual ComfyUI workflow exported from the UI, with placeholder node IDs for the 5 image inputs, seed, steps, and output dimensions. **Blocking: Dev A cannot finish `create.ts` (workflow patcher) until this file exists.** Action: set up ComfyUI on dev VPS, build and export the workflow, save to `templates/virtual-tryon-v1.json`, document which node IDs map to which inputs.

> **[?] ComfyUI models** — Design doc lists: Qwen-Image-Edit-2509, RMBG-2.0, DWPose, ReActor. Exact HuggingFace repo paths, filenames, and ComfyUI node types for each are unknown. Need a model manifest at `infra/comfyui/model-manifest.json` specifying each model's download URL + ComfyUI model folder path. **Blocking for VPS setup.**

> **[?] Concurrency model** — Can one ComfyUI worker handle concurrent requests, or is it strictly one job at a time? If one at a time, `selectWorker()` BUSY flag is correct. If concurrent, we need a job-slot counter instead. **Assume one-at-a-time for v1 given GPU VRAM constraints.**

> **[?] `XREADGROUP` consumer group name** — Should be consistent across restarts. Propose `dispatcher-cg` with consumer name = hostname. If dispatcher crashes mid-job, pending entries need `XCLAIM` after timeout. Add `XPENDING` sweep on startup.

> **[?] Dispatcher health port** — `DISPATCHER_HEALTH_PORT=4100` is in `.env.example`. Simple HTTP `GET /health` for uptime monitoring. Include in Phase 2A.

### 2B — VPS + Tunnel Setup [A, parallel with 2A]

- Provision Hostinger VPS A + B (GPU instances)
- Install ComfyUI + models per manifest
- Install `cloudflared`, create tunnel, register DNS per `infra/cloudflared/README.md`
- Configure Cloudflare Access Zero Trust service token
- Populate `.env` with real `WORKER_A_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`
- Register workers in Redis: `HSET worker:registry worker-a '{"url":"https://...","status":"IDLE","lastSeen":0}'`
- Smoke test: `curl -H "CF-Access-Client-Id: ..." https://worker-a.tryon.yourdomain.com/system_stats`

**Open decisions:**

> **[?] Hostinger VPS specs** — Which GPU plan? A100 80GB is mentioned in design doc. Confirm actual Hostinger GPU plan availability and pricing before provisioning. Document chosen specs here.

> **[?] ComfyUI startup command** — Exact flags (`--listen 127.0.0.1 --port 8188 --disable-auto-launch`). Needs systemd unit file at `infra/comfyui/comfyui.service`. Add to Phase 2B.

---

## Phase 3 — Frontend + Admin UI (Week 2–3, parallel with Phase 2)

Goal: Users can build a try-on job through the browser. Admins can manage the platform. Real-time progress shown via SSE.

### 3A — Next.js App Setup [B, Days 9–11]

- `apps/catalogues-web/` — Next.js 15 with App Router
- Install dependencies: Tailwind CSS, `@tanstack/react-query` (server state), `zustand` (client state), `shadcn/ui` component library, `react-hook-form` + `zod` resolvers
- Auth flow: login page, register page, JWT stored in `httpOnly` cookie via server action proxy, `middleware.ts` for route protection
- API client: typed wrapper around `fetch` using `@tryme/types` Zod schemas for request/response

**Open decisions:**

> **[?] Component library** — Design doc is silent. Options: `shadcn/ui` (copy-paste, zero runtime), `Radix UI` primitives only, or `Mantine`. **Recommend: `shadcn/ui` + Tailwind CSS** — matches Next.js 15 App Router well, zero bundle overhead.

> **[?] State management** — `@tanstack/react-query` for server state (jobs list, catalog), `zustand` for ephemeral UI state (upload progress, step selection). Or just React Query + `useState`. **Recommend: React Query only** — keep it simple, add zustand only if needed.

> **[?] Image upload UX** — Direct-to-R2 presigned PUT. How do we show upload progress? `XMLHttpRequest` with `onprogress` event (fetch has no progress). Decide upfront since it affects the component design.

> **[?] Next.js API proxy vs. direct API calls** — Should the frontend call `localhost:4000` directly (CORS allowed), or proxy through Next.js `/api/` routes? Direct is simpler in dev, but Next.js proxy hides the API URL from clients in production and allows server-to-server calls. **Recommend: proxy through Next.js `/api/` for auth routes (to handle cookies server-side), direct from client for everything else with CORS.**

### 3B — Try-On Builder UI [B, Days 10–15]

6-step wizard (matches design doc §7):

1. **Category Selection** — gender dropdown, garment subcategory dropdown (lazy-loaded on gender change)
2. **Upload Garment** — drag-drop zone, presign → direct R2 PUT with progress bar, preview thumbnail
3. **Select Model** — radio card grid with thumbnail, filtered by gender
4. **Select Pose** — radio card grid
5. **Select Background** — radio card grid
6. **Select Lower Garment** — radio card grid, filtered by subcategory

- Step validation before Next button
- `POST /v1/jobs/tryon` on final step
- Redirect to job detail page
- SSE `EventSource` on job detail page: animate progress (Queued → Preprocessing → Generating → Done)
- Result image rendered full-size with download button
- Credits balance shown in navbar, updated after job create

**Open decisions:**

> **[?] Step state persistence** — If user refreshes mid-wizard, state is lost. Use `sessionStorage` to persist selections? Or just accept lost state in v1? **Recommend:** accept lost state for v1, add note.

> **[?] SSE reconnect handling** — `EventSource` auto-reconnects, but if job is already COMPLETED when user opens the page, the SSE stream will never receive the completion event. Need to poll `GET /v1/jobs/:id` once on mount and only open SSE if status is not terminal. Add to implementation.

> **[?] Thumbnail display for catalog** — Design §13 notes `catalog thumbnails` use presigned URLs in v1 (private bucket), public CDN in v2. If presigned URLs expire after 5 min, catalog cards will break. **Fix before launch:** either use 24h presign expiry for catalog thumbnails, or make the catalog R2 path public. Decide in Phase 3B.

### 3C — Job Dashboard [B, Days 13–15]

- `/dashboard` — paginated job history (50 per page), status badges, clickable rows
- `/jobs/[id]` — single job detail: inputs used (thumbnails of catalog selections), progress timeline, result + download
- Credits page: balance display + ledger table
- Basic responsive layout

### 3D — Admin Panel [B, Days 14–18] — **DONE** (as standalone Vite SPA)

> **Deviation from plan:** Admin panel built as `apps/admin-web` (Vite + React), not embedded in `apps/catalogues-web` (Next.js). Deployed separately. No migration planned.

**Completed:**
- Users page: search, filters, tier/ban/force-logout controls, credit grant/deduct
- Credits page: grant/deduct form, bulk grant by tier, stats cards
- Assets page (new — beyond original scope): Faces, Backgrounds, Subcategories + Poses with batch upload
- Catalog page: lower garments + shoes with upload, toggle active, delete
- Jobs page: all-jobs table, status filter, retry/cancel, job detail modal
- Workers page: live worker registry, drain button (10s polling)
- Config page: creditCostPerJob, maxJobsPerDay form + live stats
- Real image thumbnails via `storagePublicUrl` from `/admin/me`
- Dark mode support throughout

**Open decisions:**

> **[?] Admin auth flow** — Admin users log in through the same `/auth/login` endpoint (they're also regular users). The frontend needs to detect `adminRole` from the JWT or a separate `GET /admin/profile` endpoint. **Recommend:** add `GET /admin/profile` returning `{ role }` — no JWT claims exposed to client.

> **[?] Catalog bulk upload UI** — Design doc §5.3 mentions ZIP upload (`POST /admin/catalog/bulk-upload`). Backend endpoint not in Phase 1 plan. **Recommend:** defer ZIP upload to Phase 4 polish. Single-item upload is in Phase 1D.

---

## Phase 4 — Integration, Testing, Hardening (Week 4)

Goal: E2E with real ComfyUI workers. Load-tested at 2-worker concurrency. Ready for v1 launch.

### 4A — E2E Integration [AB, Days 21–24]

- Connect deployed dispatcher to real ComfyUI workers via Cloudflare Tunnel
- Full user flow: register → grant credits → upload garment → select catalog → create job → watch SSE progress → view result
- Fix any mismatch between workflow template node IDs and dispatcher's patcher
- Verify refund path: manually kill ComfyUI mid-job, confirm credits refunded and job marked FAILED

### 4B — Load Testing [A, Days 22–24]

- Tool: `k6` or `autocannon`
- Scenario: 10 concurrent users each creating 5 jobs; verify queue depth, worker saturation, job throughput
- Identify and fix bottlenecks (DB connection pool, Redis stream backpressure)
- Document sustained RPS capacity at 2 workers

**Open decisions:**

> **[?] Monitoring stack** — Design doc §13 defers Grafana + Prometheus to v2. For v1 launch: at minimum, ship pino logs to a service (Loki, Axiom, or Betterstack). Without this, debugging production failures is blind. **Recommend:** add Axiom or Betterstack pino transport in Phase 4 (1-day task). Decide provider before Phase 4.

> **[?] Error tracking** — Sentry deferred to v2 in design doc. Same concern. **Recommend:** add Sentry SDK in `apps/api/src/server.ts` in Phase 4. 2-hour task.

### 4C — Security Hardening [A, Days 23–25]

- Review Cloudflare WAF rule set (OWASP managed rules enabled)
- Confirm all Postgres/Redis binds are `127.0.0.1` on production VPS
- Rotate all secrets from `.env.example` placeholder values
- Confirm `Secure` cookie flag is set in production Node env
- Run `pnpm audit` — fix any critical advisories

### 4D — Deployment Scripts + CI [AB, Days 24–26]

- Dockerfile for `apps/api` (done in plan Task 16)
- Dockerfile for `apps/dispatcher`
- Dockerfile for `apps/catalogues-web` (Next.js standalone output)
- `docker-compose.prod.yml` on main VPS — no MinIO (real R2), no exposed dev ports
- GitHub Actions CI: `pnpm typecheck`, `pnpm test`, `docker build` on every PR
- Deploy script: `git pull → docker compose pull → docker compose up -d --no-deps api dispatcher web`

**Open decisions:**

> **[?] CloudPanel integration** — The main VPS runs CloudPanel. Does CloudPanel manage nginx as a reverse proxy in front of the Docker containers? Or do the containers bind directly to ports 3000/4000? Need to decide the port-to-domain routing before writing the prod compose file.

> **[?] SSL certificates** — Cloudflare handles SSL at the edge. Between Cloudflare and the origin (VPS), use Cloudflare's "Full (strict)" with an origin certificate. CloudPanel can install the origin cert. Document this setup.

> **[?] Database backups** — No backup strategy defined. For v1 with 100 users: at minimum, `pg_dump` cron job to R2 once/day. 1-day task. Add to Phase 4D.

### 4E — Polish [B, Days 24–26]

- Loading skeletons on catalog picker and job history
- Error toast messages (invalid image, insufficient credits, job failed)
- Responsive mobile layout check
- Favicon, OG tags, page titles
- Basic landing page (not in scope of this plan — add if time permits)

---

## Phase 5 — v2 Roadmap (Post-Launch)

Deferred items from design doc §13 and open decisions above:

| Item | Notes |
|---|---|
| Stripe payments | Free credits at launch; add Stripe billing, subscription tiers, credit purchase |
| Email verification + password reset | Requires transactional email service (Resend/Postmark/SES) |
| Thumbnail auto-generation | Server-side Sharp resize on catalog confirm; currently admin uploads both |
| Catalog search/filter | Full-text search across catalog items |
| Public R2 CDN for catalog thumbnails | Replace presigned thumbnail URLs with public custom domain |
| Auto-scale worker VPS | Script to provision Hostinger VPS when queue depth threshold exceeded |
| Monitoring: Grafana + Prometheus | GPU util, queue depth, job latency dashboards |
| Error tracking: Sentry | Stack traces in production |
| Native HuggingFace pipeline | Replace ComfyUI with direct HF diffusers (Qwen-Image-Edit) |
| Virus scanning | ClamAV on garment uploads |
| Admin audit log | Structured log of all admin actions |
| Catalog bulk ZIP upload | Admin multi-item upload |
| ZIP/WebP output format option | User choice of result format |
| CDN for result images | Serve result.png via CDN instead of presigned R2 URLs |

---

## Decision Log

Track answers to `[?]` items here as they are resolved.

| Decision | Answer | Date | Owner |
|---|---|---|---|
| Email verification in v1? | — | — | — |
| Domain name | — | — | — |
| Catalog item count at launch | — | — | — |
| Component library | `shadcn/ui` + Tailwind (recommended) | — | B |
| State management | React Query (recommended) | — | B |
| Upload progress UX | XHR `onprogress` | — | B |
| Next.js proxy vs. direct | Hybrid (proxy auth, direct others) | — | B |
| Credit cost per job | Read from Redis config, default 1 | — | A |
| Magic-byte validation | Dispatcher validates on fetch from R2 | — | A |
| Catalog thumbnail URLs | TBD: 24h presign or public bucket | — | AB |
| Concurrency per ComfyUI worker | One at a time (v1) | — | A |
| XREADGROUP consumer group | `dispatcher-cg`, consumer = hostname | — | A |
| Monitoring provider | — | — | A |
| Error tracking | Sentry (recommended) | — | A |
| CloudPanel routing | — | — | A |
| DB backup strategy | pg_dump to R2 daily (recommended) | — | A |

---

## Parallel Work Summary

```
Week 1          Week 2          Week 3          Week 4
Dev A ──────────────────────────────────────────────────
Ph0: infra │ Ph1: API+Admin │ Ph2: Dispatcher │ Ph4: E2E+Harden
           │                │ Ph2: VPS setup  │ Ph4: CI/CD

Dev B ──────────────────────────────────────────────────
Ph0: seed  │ Ph3: Next.js   │ Ph3: Builder UI │ Ph3: Admin panel
data prep  │ scaffold+auth  │ + Job dashboard  │ + Phase 4 polish
```

**Synchronization points** (both devs must align before proceeding):
1. **End of Phase 0** — `@tryme/types` Zod schemas locked. Both reference them; no changes after this point without a joint decision.
2. **End of Phase 1A** — DB schema + migrations stable. Frontend can start seeding test data.
3. **Mid Phase 2/3** — API running locally. Dev B can run against real API instead of mocks.
4. **Start of Phase 4A** — Both services deployed to staging VPS for joint E2E testing.
