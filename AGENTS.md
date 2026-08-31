# AGENTS.md

Guidance for AI coding agents in this repo. `CLAUDE.md` is the canonical, fuller
version — read it when you need repo detail (schema map, module tables, per-app
architecture, key files). This file is the short form for agents that only read
`AGENTS.md`, and it deliberately restates only slow-changing facts.

Status and progress are **not** tracked here. `docs/progress.md` is the log
(dated, newest first, Done / Failed-Not-Done / Open Questions); read its top
entries before starting, and add one after substantive work.

---

## How to behave

**Verify, don't infer.** Read the authoritative source before acting on a claim
about config, deployed state, or file contents. Deriving a value from an adjacent
signal — a release name, a branch, the file you happened to open — is how this
repo's worst time sinks started. If you find yourself reasoning toward a value,
go read it instead.

**Secrets.** Never print a credential value; report name, set/unset, and length.
When grepping output that interleaves variables (`docker compose config`, any
`.env`), match the exact line and never use `-A`/`-B`/`-C` — a context flag once
leaked a Shopify API secret and forced a rotation.

**Build-time vs runtime config.** `VITE_*` / `NEXT_PUBLIC_*` are baked into
bundles at build time; changing one needs a rebuild, not a restart, and a cached
layer can keep the old value — confirm the output asset hash changed. Everything
else is read at process start.

**Never touch production data or schema.** No `db:generate`, no `drizzle-kit`
surgery, no ad-hoc `psql`/`tsx` fixes against the prod VPS or `tryon_prod`. Ship
changes through push → CI/CD → `db:migrate:prod`. Reads are fine. A 2026-07-27
ad-hoc session wiped ~89 rows of catalog defaults with no audit trail.

**Destructive operations.** Before a `DROP`, `CASCADE`, delete, or overwrite,
inspect the target and say what will be lost. Prefer the reversible form.

**Commits and pushes.** Don't commit or push unless asked. Commit whole units of
work only — a working feature, a verified fix, a migration with its API/UI
changes — never single CSS properties, copy tweaks, or parts of a task still in
flight. Branch policy: `docs/version-control.md`.

**Style.** Match the surrounding file's comment density, naming, and idiom. This
codebase documents the *why* behind non-obvious constraints; keep doing that. No
`console.log` — use the pino child loggers from `@tryme/logger`.

**Honesty.** Show failing output rather than summarizing it away. Say what you
skipped. Claim something works when you ran it, not when it looks right.

**Decisions get a tradeoff.** When a task forks into more than one valid
approach, lay it out like a systems-design review: name each option, and state
the cost/benefit separately for developers (complexity, ops burden, blast
radius) and for users (latency, reliability, UX, cost). Short table or bullets,
not an essay — then recommend one. See `CLAUDE.md` for the fuller version.

**Configuration lives outside the repo too.** Shopify Partner Dashboard (app
handle, plan prices, trial days, redirect URLs, plan descriptions), Cloudflare
(cache rules), CloudPanel vhosts, and the VPS `.env` files all shape behaviour
and no deploy touches them. Record discoveries in `docs/progress.md`.

---

## Stack

pnpm workspaces (`apps/*`, `packages/*`), Node ≥20.11, TypeScript 5.6, ESM only.
Fastify 5 + `fastify-type-provider-zod` for the API; PostgreSQL 16 via Drizzle;
Redis 7 Streams (`jobs:priority|normal|low|video`, group `dispatcher-cg`);
S3-compatible storage (R2 in prod, MinIO locally); pino logging; Vitest.
Exact versions live in `package.json` — don't trust a number copied into docs.

## Layout

```
apps/api               Fastify REST API
apps/dispatcher        Redis Stream consumer — only process talking to GPU workers
apps/chatbot           support chatbot (LangGraph, pgvector RAG)
apps/catalogues-web    Next.js user UI          (package @tryme/web)
apps/admin-web         Vite/React admin SPA     (package @tryme/admin)
apps/shopify           embedded Shopify admin SPA (Polaris)
apps/shopify-extension Shopify app config + theme app extension
packages/db types storage logger observability
infra/ scripts/ docs/
```

Directory names and package names differ in places — use the package name with
`--filter`. `apps/admin-mobile` is paused: don't update, test, or parity-check it.

## Commands

```bash
pnpm docker:up                                   # postgres + redis + minio (127.0.0.1)
pnpm db:migrate
pnpm --filter @tryme/api dev
pnpm --filter @tryme/api test                 # UNIT ONLY — excludes test/integration/**
pnpm --filter @tryme/api test:integration     # integration suite
pnpm build | pnpm typecheck | pnpm lint
```

`test` does not run integration tests. "No test files found" for an integration
pattern means the wrong command, not a missing test.

CI never runs `shopify app deploy` — the theme extension and app config reach
Partner Dashboard only via `make shopify-deploy` / `make shopify-deploy-staging`,
which publish from your working tree.

## Architecture in one paragraph

api validates catalog IDs, deducts credits and inserts the job in one Postgres
transaction, then `XADD`s to a Redis Stream; it never talks to ComfyUI. dispatcher
consumes the stream, picks a healthy IDLE worker from the Redis registry, clones
and patches the versioned workflow template, drives ComfyUI over a Cloudflare
Tunnel, uploads the result to R2, updates Postgres, publishes SSE, and `XACK`s —
refunding credits transactionally on terminal failure. Browsers upload directly
to R2 via presigned URLs and never proxy binaries through the API.

## Testing

**No testcontainers** (removed; don't reintroduce). Integration tests reuse the
docker-compose services on localhost, so `pnpm docker:up` must be running. Each
file creates a fresh randomly-named Postgres database and MinIO bucket, migrates,
and drops both in `afterAll` (`apps/api/test/helpers/containers.ts`).
`buildTestApp()` listens on port 0; use raw `node:http` for SSE tests because
Fastify `inject()` hangs on streaming responses. Tests build `Env` objects
directly and cast them, so gates guarding money or access must compare
`=== true` rather than rely on truthiness.

## Invariants

- Credit deduct + job insert in one transaction; refund on terminal failure too.
- Catalog ID → R2 key resolution happens in api before enqueue; the dispatcher
  trusts `job_inputs`.
- Workflow templates: `structuredClone` then patch, never inline-mutate.
- Postgres and Redis bind `127.0.0.1` only.
- Every `/admin/*` route checks the JWT claim **and** an `admin_users` row.
- User hint text is sanitized before reaching a workflow prompt.
- `packages/db/src/index.ts` exports `* as schema` — no duplicate re-export; import
  `@tryme/db` as `workspace:*`, never by relative path.
- Shopify credit grants are idempotent on `external_ref`, and the cycle marker
  advances only when a grant was actually possible.
- `shopify_widget_events` is advisory only — never read it for a credit, limit, or
  authorization decision.
- No schema or data changes against production.
