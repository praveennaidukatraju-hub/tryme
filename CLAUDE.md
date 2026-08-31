# CLAUDE.md

Guidance for AI coding agents working in this repo. Canonical — `AGENTS.md` is a
short digest of this file for agents that only read that filename.

This file holds **durable** guidance: how to behave, how the system is shaped,
and what must not break. It deliberately does not track status or progress —
those live in `docs/progress.md`, which is append-only and always more current
than any prose here.

---

## How to work here

**Verify, don't infer.** Every expensive mistake in this repo's history came from
reasoning about a value instead of reading it. Before acting on a claim about
config, versions, deployed state, or a file's contents, read the authoritative
source. Some traps that have actually bitten:

| Question | Authoritative source | Not this |
|---|---|---|
| A Shopify app's handle | the store admin URL `admin.shopify.com/store/<store>/apps/<HANDLE>/…` | the `shopify app deploy` release name (it slugs the app *name*) |
| What a container is running | the served asset hash / `docker inspect` | the branch you're on |
| Which env file is live | `docker compose config` (grep the exact line) | the file you happened to open |
| Whether tests cover something | run them | the presence of a test file |
| Applied migrations | `drizzle.__drizzle_migrations` | the journal alone |

**State that lives outside the repo.** A large share of this system's behaviour
is configured in dashboards no deploy touches: Shopify Partner Dashboard (app
handle, per-plan prices, trial days, welcome/redirect URLs, plan descriptions per
language), Cloudflare (cache TTLs, rules), CloudPanel vhosts, and the `.env`
files on the VPS. When you change or discover any of it, record it in
`docs/progress.md` — otherwise the next session rediscovers it the hard way.

**Secrets discipline.** Never print a credential value; report name, set/unset,
and length. When grepping output that interleaves variables — `docker compose
config`, any `.env` file — match the exact line and **never** use `-A`/`-B`/`-C`
context flags. A context flag on a compose-config grep once leaked
`SHOPIFY_API_SECRET` into a transcript and forced a rotation. Note that
`SHOPIFY_API_KEY` / `VITE_SHOPIFY_API_KEY` are the public `client_id` and are not
secrets.

**Build-time vs runtime config.** `VITE_*` and `NEXT_PUBLIC_*` vars are baked
into bundles at build time (see the `args:` blocks in
`infra/docker-compose.*.yml`). Changing one requires a **rebuild** — a restart
cannot help, and a cached layer can silently keep the old value, so confirm the
output asset hash changed. Everything else is read at process start, where a
restart suffices.

**Production safety.** Never run schema or migration work (`pnpm db:generate`,
`drizzle-kit` snapshot surgery, one-off `psql`/`tsx` data fixes) against the
production VPS or `tryon_prod`. Do it locally or on staging and ship it through
push → CI/CD → `db:migrate:prod`. An incident on 2026-07-27 wiped
`garment_subcategories` default catalog IDs for ~89 of 90 rows during exactly
such an ad-hoc live session, and was never root-caused because there was no audit
trail. Reads against production are fine; writes are not.

**Destructive operations.** Before a `DROP`, a `CASCADE`, a delete, or an
overwrite, look at the target and state what will be lost. Prefer the reversible
form — an `UPDATE` that marks a row inactive beats a `DELETE` that cascades
through `shopify_stores` into credits, ledgers, shoppers and events.

**Commits and pushes.** Do not commit or push unless asked. When you do, commit
only complete units of work — a feature that works end to end, a verified bug
fix, a migration together with its API/UI changes. Not single CSS properties,
copy tweaks, or one-liners belonging to a larger task in progress. Branch policy
and migration-conflict resolution: `docs/version-control.md`.

**Match the code you're editing.** Comment density, naming, and idiom should look
like the surrounding file. This codebase comments the *why* — especially the
non-obvious constraint that motivated a line — and that convention is worth
continuing.

**Report honestly.** If tests fail, show the output. If you skipped a step, say
so. Don't claim something works because the code looks right; claim it when you
ran it. Correct a wrong earlier statement plainly and move on.

**Decisions get a tradeoff, not just an answer.** When a task forks into more
than one valid approach — not "how do I do X" but "which of several ways should
we do X" — lay it out like a systems-design review: name each real option, and
for each one state the cost/benefit **separately for developers** (implementation
complexity, ops burden, maintenance surface, blast radius if it breaks) **and for
users** (latency, reliability, UX friction, cost passed through). Keep it
scannable — a short table or bullet pairs beats an essay — then end with a
recommendation, not just a list. This applies especially to `docs/audits/open-findings.md`
items marked as needing a product decision, but to any genuine fork in approach,
including ones the user didn't flag as a "decision."

---

## Current state

There is no status snapshot in this file — it went stale every time. Instead:

- `docs/progress.md` — dated log, newest first: Done / Failed-Not-Done / Open
  Questions. Read the top few entries before starting work.
- `docs/audits/open-findings.md` — known unresolved findings.
- `docs/PHASES.md`, `docs/virtual-tryon-system-design.md` — original plan and
  architecture. Read the design doc before changing architecture.

**Admin mobile is paused.** Treat `apps/admin-mobile` as out of scope: don't
update, test, typecheck, or parity-check it against `apps/admin-web` unless a task
explicitly reactivates it.

---

## Stack

- **Package manager:** pnpm workspaces (`apps/*`, `packages/*`). Never introduce
  npm/yarn lockfiles.
- **Runtime:** Node ≥20.11, TypeScript 5.6, ESM only (`"type": "module"`
  everywhere). Exact versions: `package.json`.
- **API:** Fastify 5 + `fastify-type-provider-zod`. All routes wired in
  `apps/api/src/server.ts`.
- **DB:** PostgreSQL 16 via Drizzle ORM. Schema `packages/db/src/schema/`,
  migrations `packages/db/src/migrations/`.
- **Cache/Queue:** Redis 7 Streams — `jobs:priority`, `jobs:normal`, `jobs:low`,
  `jobs:video`. Consumer group `dispatcher-cg`. The three GPU streams are capped
  by worker-registry size; `jobs:video` is a separate lane capped by
  `VIDEO_CONCURRENCY` (PixVerse needs no GPU).
- **Storage:** S3-compatible — self-hosted MinIO in prod (`tryme-prod-minio`,
  `minio:9000` internal, proxied via `app.tryme.com/minio/`) and locally.
  `R2_*` env var names are used for both; don't infer the backend from the var
  name. `StorageProvider` interface in `packages/storage`.
- **Logging:** pino via `@tryme/logger` (`createLogger(service)`). No
  `console.log` in committed code. Use child loggers bound with `jobId`/`userId`.
- **Tests:** Vitest. No testcontainers — see Testing below.

---

## Monorepo layout

```
apps/api               Fastify REST API — auth, credits, catalog, jobs, admin
apps/dispatcher        Redis Stream consumer — the only process that talks to GPU workers
apps/chatbot           Fastify + WS support chatbot — LangGraph, HITL, pgvector RAG
apps/catalogues-web    Next.js 15 — user-facing UI (pkg name @tryme/web)
apps/admin-web         Vite + React SPA — internal admin panel (pkg name @tryme/admin)
apps/shopify           Vite + React + Polaris — embedded Shopify admin SPA
apps/shopify-extension Shopify app config + theme app extension (Liquid/JS/CSS)
packages/db            Drizzle schema + migrations + createDb() factory
packages/types         Zod schemas only — single source of truth for request/response shapes
packages/storage       StorageProvider interface + R2/MinIO impl + key builders
packages/logger        pino wrapper
packages/observability Prometheus registry shared by api + dispatcher
infra/                 docker-compose (dev/staging/prod), cloudflared, Grafana Alloy
scripts/               Ops scripts, CI helpers, staging sync
docs/                  Design doc, phases, progress log, runbooks, audits
```

Package names don't all match directory names — `apps/catalogues-web` is
`@tryme/web`, `apps/admin-web` is `@tryme/admin`. Use the package name with
`--filter`.

| Package | Key exports |
|---|---|
| `@tryme/db` | `createDb(url)`, `* as schema`, drizzle operators (`and`, `eq`, `inArray`, `or`, `sql`, …) |
| `@tryme/types` | Pure Zod schemas — `auth.ts`, `catalog.ts`, `jobs.ts`, `admin.ts`, `widget.ts` |
| `@tryme/storage` | `StorageProvider` (`presignPut`, `presignGet`, `deleteObject`, `putObject`, `getObject`, `headObject`, `publicUrl`), `createR2Provider(cfg)`, `keys` builders |
| `@tryme/logger` | `createLogger(service, extra?)` — redacts passwords, tokens, secrets, auth headers, cookies, R2 keys |
| `@tryme/observability` | Single Prometheus registry; job/credit/comfy/queue/worker metrics |

---

## Commands

```bash
cp .env.example .env     # fill in secrets
pnpm install
pnpm docker:up           # postgres + redis + minio, bound to 127.0.0.1
pnpm db:migrate          # apply migrations to DATABASE_URL
```

| Command | What |
|---|---|
| `pnpm dev` | all services in parallel (turbo) |
| `pnpm --filter @tryme/<pkg> dev` | one service (`api`, `dispatcher`, `chatbot`, `web`, `admin`) |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` | across all packages |
| `pnpm --filter @tryme/api test` | **unit tests only** — `vitest.config.ts` excludes `test/integration/**` |
| `pnpm --filter @tryme/api test:integration` | integration suite (`vitest.integration.config.ts`) |
| `pnpm --filter @tryme/api test:unit` | explicit unit-only |
| `npx vitest run --config vitest.integration.config.ts <pattern>` | one integration file (run from `apps/api`) |
| `pnpm docker:up` / `docker:down` / `docker:reset` | infra lifecycle (`reset` deletes volumes) |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit generate / apply |
| `pnpm db:seed`, `pnpm seed:model-images`, `pnpm seed:garment-types`, `pnpm seed:contacts` | seed helpers — check `package.json` for the current set |
| `make shopify-deploy` / `make shopify-deploy-staging` | publish app config + theme extension to Partner Dashboard |

`pnpm --filter @tryme/api test` does **not** run integration tests — a
"No test files found" result for an integration pattern means you used the wrong
command, not that the test is missing. Makefile targets mirror the pnpm scripts.

CI never runs `shopify app deploy`. The theme extension and app config reach
Partner Dashboard **only** via the `make` targets, publishing from your working
tree — so deploy from a checkout that contains the commit you intend to ship.

---

## Architecture

Three services with a hard boundary at the Redis Stream:

1. **api** — auth, credits, catalog reads, job creation. Validates catalog IDs →
   atomic credit deduct (`UPDATE WHERE balance > 0`) → writes `jobs` row → `XADD`.
   Never talks to ComfyUI.
2. **dispatcher** — the only process that talks to GPU workers. `XREADGROUP` →
   selects a healthy IDLE worker → clones and patches the versioned workflow
   template with R2 keys → posts to ComfyUI `/prompt` over Cloudflare Tunnel →
   listens on the ComfyUI websocket for progress → uploads the result to R2 →
   updates Postgres + publishes SSE → `XACK`. Refunds credits in the same
   Postgres transaction on terminal failure (max 2 attempts).
3. **web / admin / shopify** — browsers upload garments **direct to R2 via
   presigned URL** (bypassing api), then POST job metadata and open SSE for
   progress.

Worker connectivity: each ComfyUI VPS runs `cloudflared`; no inbound ports. The
health monitor probes `/system_stats` every 15s and sets `worker:health:{id}`
with a 30s TTL — expired means unhealthy means no routing.

Job input model: 1 user-uploaded garment + `faceId` + `backgroundId` + `poseId`
(all admin-curated) + optional `lowerCatalogId` / `shoeCatalogId`. Every ID must
resolve to an active row before credits are deducted.

### Adding a GPU worker

Workers live in `schema.workers` (Postgres), loaded into the Redis registry at
dispatcher startup. No env changes.

1. Admin panel → **Workers** → **Add worker**: Cloudflare tunnel URL, API key,
   allowed job types, mark active.
2. Restart the dispatcher. It re-reads `schema.workers` on boot and the health
   monitor starts probing immediately.
3. Consumer concurrency refreshes from the registry within ~5s.

To remove one: mark inactive in admin, then restart the dispatcher.

### Dispatcher modules (`apps/dispatcher/src/`)

| Module | Purpose |
|---|---|
| `stream/` | `runStreamLoop` shared read→dispatch loop; GPU consumer over the three job streams; separate video consumer; startup `XPENDING` recovery; stuck-job sweeper |
| `job/` | `processor.ts` (`processTryonJob`, `processSareeJob`, `processWidgetJob`), status transitions |
| `workflow/` | template clone + patch, aspect-ratio sizing, dual-size groups |
| `comfyui/` | HTTP client, WebSocket progress, `/history` polling |
| `worker/` | Redis registry, IDLE selection, health probes |
| `pixverse/` | image-to-video provider client for the `jobs:video` lane |
| `health/` | HTTP health endpoint on `DISPATCHER_HEALTH_PORT` |

---

## Web app (`apps/catalogues-web`)

**Auth is a BFF.** Next.js API routes in `src/app/api/auth/` receive browser auth
requests, call the Fastify API, then set httpOnly cookies via
`src/lib/auth-cookies.ts`. The browser never calls Fastify directly for auth.
`src/lib/api.ts` holds the access token in a module-level in-memory variable —
never a JS-readable cookie (see SEC-H2 in `docs/progress.md`) — seeded by
`initToken()` at login and auto-refreshed on 401 through the httpOnly refresh
cookie.

**Route groups:** `(auth)` — login, register, forgot/reset, verify email;
`(app)` — studio, catalogs, pricing, settings, my-products (protected).
`src/middleware.ts` guards non-public routes on the `access_token` cookie;
`next.config.ts`'s `redirects()` sends old paths on (`/dashboard`, `/jobs`,
`/catalogues` → `/catalogs`; `/credits` → `/pricing`; `/account` → `/settings`;
`/assets` → `/my-products`).

**Studio wizard** (`src/app/(app)/studio/page.tsx`) — 4 steps: gender + garment
type + platform/aspect ratio + garment upload (direct to R2 via
`/v1/uploads/presign`); face; background; pose (+ optional lower/shoes, shown
only when the pose has `hasLower`/`hasShoes`). Submits to `/v1/jobs/tryon`.

**Design tokens:** always use `C` from `src/components/tokens.ts` (e.g. `C.pink`,
`C.text`, `C.border`; gradient `grad`). Never raw hex.

**`NEXT_PUBLIC_BASE_PATH`** supports subdirectory deployment; all internal asset
references and redirects must account for it, and the middleware strips it before
route matching.

---

## Shopify surface

**Embedded admin** (`apps/shopify`) — Vite + React + Polaris, served under
`/shopify-admin` (Vite `base` and the router `basename` in `src/main.tsx` both
depend on this). Auth is App Bridge session tokens: `app-bridge.js` must remain
the first script in `index.html`, and `window.shopify.idToken()` only works
inside the Shopify admin iframe. `src/lib/api.ts` calls the API cross-origin with
a Bearer token — no cookies.

**Managed installation.** Shopify installs the app without calling us; the first
verified session token for an unknown shop is the *expected* first contact and is
exchanged for an offline access token (`exchangeSessionToken`). There is no OAuth
`code` flow. A reinstall arrives the same way — `uninstalledAt` set means
reprovision (`apps/api/src/plugins/shopify-auth.ts`).

**Tokens at rest** are AES-256-GCM encrypted (`iv:authTag:ciphertext`) under
`SHOPIFY_TOKEN_ENC_KEY`. A wrong key surfaces as `SHOPIFY_REAUTH_REQUIRED`,
which the SPA turns into one-click reauth that repairs the row. Rotating that key
puts every store into that state at once.

**Billing is Shopify App Pricing** (formerly Managed Pricing): Shopify hosts the
plan picker and sends **no webhooks**, so subscription state must be polled via
Admin GraphQL `currentAppInstallation.activeSubscriptions` — by the hourly
scheduler and by the post-approval redirect. Grants are idempotent on
`external_ref`. Two traps: the Admin API exposes only the plan's display `name`
(no handle), so the strings in `billing-plans.ts` must match Partner Dashboard
exactly; and `AppSubscription.test` is `true` for every development store, gated
by `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` (off in production).

**Theme extension** (`apps/shopify-extension/extensions/tryon-theme-extension`)
ships one **app block** (`blocks/tryon-button.liquid`, `target: "section"`) that
the merchant drags into their product template. It is not an app embed — an
earlier version was, and it relocated itself via guessed CSS selectors, breaking
on every theme switch. App blocks need an Online Store 2.0 (JSON) template;
vintage themes are unsupported. Theme-check requires `width`/`height` on `<img>`
tags, so placeholder attributes are present and CSS must set the real size.

**Widget config:** modal copy, accent color and result actions come from the
`tryme.widget_config` shop metafield, written by
`PATCH /v1/shopify/widget-config`. Postgres (`shopify_stores.settings.widget`) is
authoritative; the metafield is a cache, and a failed mirror surfaces as
`synced: false`.

---

## Staging

Staging runs from the `dev` branch on the same VPS as production under the
`tryme-staging` Compose project, with host ports at production + 100 (web
3100, admin 3101, shopify-admin 3103, api 4100, chatbot 4300, minio 9100/9101).
Data is an unscrubbed production snapshot refreshed via
`scripts/staging/sync-from-prod.sh`, which means **tokens encrypted under
production's key** — `scripts/staging/post-restore.sql` marks stores uninstalled
so they reprovision under staging's key.

Staging spans two hostnames: `staging-app` (catalogues-web) and `staging-admin`
(admin, shopify-admin, `/v1`). Production serves both from one host, so any
absolute URL configured per-environment differs between them.

`.env.staging` must pass `scripts/staging/check-staging-env.sh` or the build
aborts. Full provisioning guide: `docs/staging-runbook.md`.

---

## Database schema

`packages/db/src/schema/*.ts` is the source of truth; this is a map, not a spec.

**Auth & users** — `users` (email/password or Google OAuth, tier, ban, email
verification), `refresh_tokens` (family rotation: `familyId`, `generation`,
`usedAt`, `revokedAt`; partial unique index for one active token per family),
`oauth_accounts`, `admin_users` (roles), `permissions` & `role_permissions` (capability
matrices), `audit_logs` (immutable append-only audit trail), `api_keys` (sha256 hash + display
prefix).

**Credits & payments** — `user_credits` (one balance row per user),
`credit_ledger` (immutable deltas), `credit_requests`, `credit_plans`,
`payments` (Razorpay).

**Jobs** — `jobs`, `job_inputs` (garment keys, face/bg/pose IDs, lower/shoe
catalogs, `params` JSONB), `job_outputs`, `job_events`.

**Models (admin-curated)** — `model_faces`, `model_backgrounds`, `model_poses`,
`model_pose_assets`, `pose_garment_configs`, `garment_subcategories`,
`workflow_templates` (ComfyUI JSON + node-ID mappings, `workflowType`).

**Catalog (user-selectable)** — `catalog_types` (`lower`, `shoe`),
`catalog_categories`, `catalog_items`, `catalog_item_subcategories`.

**Merchant & widget** — `merchants` (one per user; no balance of its own —
merchant spend draws from `user_credits`), `merchant_payments`, `kiosk_devices`.

**Shopify** — `shopify_stores` (encrypted tokens, plan/subscription state),
`shopify_store_credits` + `shopify_credit_ledger` (stores bill themselves; not
the linked user), `shopify_shoppers`, `shopify_catalog_jobs`,
`shopify_widget_events` (append-only storefront interaction log, advisory only —
never read by a credit, limit, or authorization decision; swept at 400 days).

### Models vs catalog — do not conflate

| Module | What it is | Tables |
|---|---|---|
| **models** (`/v1/models/*`) | admin-curated face/pose/background inputs to ComfyUI | `model_faces`, `model_backgrounds`, `model_poses`, `garment_subcategories`, `workflow_templates` |
| **catalog** (`/v1/catalog/*`) | user-selectable lower garments and shoes | `catalog_types`, `catalog_categories`, `catalog_items` |

Each `model_poses` row has an optional `workflowTemplateId`; the template stores
the ComfyUI node IDs (`lowerNodeId`, `shoeNodeId`, `sizeNodeId`, …) the dispatcher
patches at runtime, and the pose's `hasLower`/`hasShoes` flags derive from whether
those node IDs are non-null. A new pose must be linked to a template — the
template determines which inputs that pose supports.

---

## API route modules (`apps/api/src/modules/`)

| Module | Key routes |
|---|---|
| `auth/` | `/v1/auth/register`, `/login`, `/refresh`, `/logout`, `/verify-email`, `/forgot-password`, `/reset-password`, `/request-admin`, plus mobile variants and Google device login |
| `credits/` | `/v1/credits` balance + ledger; helpers `atomicDeduct`, `refund`, `adminGrant`; store-scoped `shopify-ledger.ts` |
| `jobs/` | `/v1/jobs/tryon`, `/jobs/batch`, `/v1/batches/:id`, `/v1/catalogues`, `/v1/assets`, SSE streams |
| `catalog/` | `/v1/catalog/:type` category tree + items |
| `models/` | `/v1/models/faces`, `/backgrounds`, `/poses`, `/garment-types` |
| `uploads/` | `/v1/uploads/presign` — records `upload:owner:{key}` in Redis (24h) for ownership binding |
| `results/` | `/v1/results/:id` public result access |
| `payments/` | Razorpay order creation + webhook |
| `merchant/` | merchant self-serve (API key regen, webhook config, credits) |
| `kiosk/` | `/v1/kiosk/*` — device-authed customer-facing tryon |
| `support/`, `backgrounds/`, `dev/` | contact form; user-uploaded backgrounds; public API-key-authed developer API |
| `shopify/` | install/token exchange, merchant `/me` + `/settings` + `/shoppers`, catalog generate/publish, widget-config + republish, onboarding (theme-editor deep link), product sync, customer job creation, billing confirm + scheduler, GDPR webhooks, `/customer/event`, `/analytics` |
| `admin/` | full CRUD under `/admin/*` — users, credits, catalog, assets, jobs, workers, config, workflows, merchants, kiosk devices, saree + Shopify settings |

---

## Testing

**No testcontainers.** Integration tests reuse the docker-compose
Postgres/Redis/MinIO on localhost, so `pnpm docker:up` must be running first.

Each integration test file (harness `apps/api/test/helpers/containers.ts`):

1. creates a fresh Postgres database via `CREATE DATABASE` with a random name
2. runs Drizzle migrations against it
3. creates a fresh MinIO bucket with a random name
4. drops both in `afterAll`

API harness `buildTestApp()` (`apps/api/test/helpers/api.ts`) calls
`app.listen({ port: 0 })` and reads the ephemeral port from
`app.server.address()`. Use raw `node:http` for SSE tests — Fastify `inject()`
hangs on streaming responses.

**Gotchas**
- Don't reintroduce `testcontainers`; it was abandoned over MinIO startup issues
  on Windows and is no longer a dependency.
- Integration tests share a Postgres process, so use unique slugs — e.g.
  `test/integration/catalog.test.ts` seeds `catalog_types` with `slug: 'models'`.
- The harness keeps rate limiting active. Tests that would collide on a limiter
  bucket use distinct RFC 5737 test IPs.
- Tests construct `Env` objects directly and cast them, so a new env flag is
  `undefined` there — gates guarding money or access must compare `=== true`
  rather than rely on truthiness.

---

## Invariants (do not break)

- Credit deduct + job insert are one Postgres transaction. Refund on terminal
  failure is transactional too.
- Catalog ID → R2 key resolution happens in api before enqueue. The dispatcher
  trusts the resolved keys on the `job_inputs` row.
- ComfyUI workflow templates live in `workflow_templates.jsonContent`. Never
  inline-mutate — always `structuredClone` then patch.
- Postgres and Redis bind to `127.0.0.1` only, never `0.0.0.0`.
- Every `/admin/*` route resolves the caller through `requirePermission`/
  `requireAnyPermission` (`apps/api/src/modules/admin/guard.ts`): JWT claim,
  `admin_users` row + `status === 'active'`, then a `role_permissions` capability
  check. `/results` shares the same `resolveAdminAccess` resolution as `/admin/*`,
  though it currently only requires an active admin of any role, not a specific
  permission — see the code comment at its login handler.
- Admin mutations that write `audit_logs` do so via `recordAudit(tx, ...)` inside
  the same Postgres transaction as the mutation, after the write, before commit —
  fail-closed: if the audit insert throws, the mutation rolls back and
  `audit_log_write_failures_total` (Prometheus) increments. This makes `audit_logs`
  a hard dependency for every admin write it's wired into.
- `audit_logs` is append-only via a `BEFORE UPDATE OR DELETE` trigger
  (`audit_logs_prevent_mutation`, migration `0159`), **not** a `REVOKE`-based ACL —
  `POSTGRES_USER=tryon` is a Postgres superuser in every environment including
  production (no second, restricted DB role exists yet), so a `REVOKE` would be
  inert. The trigger stops accidental `UPDATE`/`DELETE` but a superuser can still
  `ALTER TABLE ... DISABLE TRIGGER` first — genuine ACL enforcement is a separate,
  not-yet-scheduled infra task (non-superuser runtime role + a distinct migration
  credential, since `tryon` also runs `db:migrate:prod`).
- The user hint field (300 char max) goes through sanitization before reaching a
  workflow prompt.
- `packages/db/src/index.ts` exports `* as schema` — never add a duplicate
  `schema` re-export. Import `@tryme/db` as `workspace:*`, never by relative
  path into `packages/`.
- Shopify credit grants are idempotent on `external_ref`, and the stored cycle
  marker advances only when a grant was actually possible — otherwise an unbilled
  cycle is silently marked seen and the merchant never receives those credits.
- `shopify_widget_events` is advisory only. Never read it for a credit, limit, or
  authorization decision.
- No schema or data changes against production. See "Production safety" above.

---

## Environment variables

`.env.production.example` is the full annotated list. Notable:

| Var | Used by |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | api, dispatcher, db package |
| `JWT_SECRET`, `COOKIE_SECRET`, `TRUST_PROXY_HOPS` | api |
| `R2_*` (`ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `BUCKET`, `PUBLIC_URL`, `SIGN_ENDPOINT`, `PUBLIC_PRESIGN_BASE`, `FORCE_PATH_STYLE`) | api, dispatcher |
| `RESEND_API_KEY`, `EMAIL_FROM` | api (transactional email) |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_CALLBACK_URL` | api (optional OAuth) |
| `WORKER_API_KEY` | dispatcher |
| `PIXVERSE_*`, `VIDEO_CONCURRENCY` | dispatcher (catalog video lane) |
| `SHOPIFY_API_KEY` / `_SECRET` / `_APP_URL` / `_SCOPES` / `_TOKEN_ENC_KEY` | api |
| `SHOPIFY_APP_HANDLE` + `VITE_SHOPIFY_APP_HANDLE` | builds the hosted plan-picker URL; the `VITE_` one is the functional half (build arg) |
| `SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS` | api — grants credits for Shopify *test* charges. Accepts only the literal `'true'` (deliberately not `z.coerce.boolean()`, which turns `'false'` into `true`). Off in production |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BASE_PATH` | catalogues-web (build time) |
| `VITE_API_BASE_URL`, `VITE_SHOPIFY_API_KEY`, `VITE_CHATBOT_URL` | SPAs (build time) |

In dev, `R2_*` point at MinIO on `http://127.0.0.1:9000`. Prod also runs
self-hosted MinIO, not Cloudflare R2 — see Stack above.

---

## Key files

| Area | File |
|---|---|
| API wiring | `apps/api/src/server.ts` |
| API env schema | `apps/api/src/env.ts` |
| Job creation (credit + enqueue) | `apps/api/src/modules/jobs/create.ts` |
| Auth routes / service / plugin | `apps/api/src/modules/auth/routes.ts`, `service.ts`, `apps/api/src/plugins/auth.ts` |
| Shopify session + provisioning | `apps/api/src/plugins/shopify-auth.ts`, `modules/shopify/token.ts` |
| Shopify billing | `modules/shopify/billing.ts`, `billing-plans.ts`, `billing-scheduler.ts`, `subscription-client.ts` |
| DB factory + schema re-export | `packages/db/src/index.ts` |
| Shared Zod types | `packages/types/src/*.ts` |
| Storage provider + keys | `packages/storage/src/r2.ts`, `keys.ts` |
| Dispatcher entry / processor / consumer / patcher | `apps/dispatcher/src/index.ts`, `job/processor.ts`, `stream/consumer.ts`, `workflow/patcher.ts` |
| Web middleware / API client | `apps/catalogues-web/src/middleware.ts`, `src/lib/api.ts` |
| Admin app root | `apps/admin-web/src/App.tsx` |
| Shopify SPA root + router basename | `apps/shopify/src/App.tsx`, `src/main.tsx` |
| Shopify app config | `apps/shopify-extension/shopify.app.toml` (+ `.staging.toml`, `.dev.toml`) |
| CI / deploy | `.github/workflows/ci.yml`, `scripts/ci/detect-affected.mts` |
| Design doc | `docs/virtual-tryon-system-design.md` |
| Version control rules | `docs/version-control.md` |
| Open findings | `docs/audits/open-findings.md` |

Design doc sections worth rereading before related work: §2 Tunnel, §3 Catalog
model, §4 Dispatcher routing, §5 Admin surface, §6 DB schema, §11 Security
layers.
