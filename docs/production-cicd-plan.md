# Production CI/CD Scalability and Zero-Downtime Deployment Plan

**Status:** Approved implementation plan

**Created:** 2026-07-21

**Repository:** `tryme` pnpm monorepo

**Production model:** Single VPS, Docker Compose, CloudPanel NGINX, GitHub Actions

**Deployment policy:** Automatic deployment from `main` after required checks pass

## 1. Purpose

This document defines the production CI/CD architecture that replaces the current
full-repository, build-on-VPS deployment process. It is intended to be sufficiently
specific that an engineer can implement it without making additional architectural
decisions.

The design addresses two separate problems:

1. **Scalability:** a change to one application, or even a documentation-only change,
   must not test, build, transfer, and restart every production service.
2. **Availability:** deploying a release must not create a user-visible `502 Bad
   Gateway`, connection refusal, or blank application while a container is replaced.

The selected design is:

- dependency-aware affected-service detection;
- immutable service images built in GitHub Actions and stored in GHCR;
- per-service blue/green release slots on the existing VPS;
- a stable NGINX deployment gateway behind CloudPanel;
- health- and smoke-test-gated traffic switching;
- automatic application rollback;
- forward-only, expand-contract database migrations;
- graceful connection and job draining.

## 2. Goals and Non-Goals

### 2.1 Goals

- Documentation-only changes perform no application build and no production deploy.
- An isolated frontend change builds and deploys only that frontend.
- An isolated backend change builds and deploys only that backend and any services
  affected through workspace dependencies.
- Shared-package changes rebuild all recursive consumers and no unrelated services.
- Images are reproducible, immutable, traceable to a Git commit, and reusable for
  rollback.
- Production does not compile source code or run `pnpm install` during a normal deploy.
- Existing production containers continue serving while candidate containers start.
- Traffic changes only after the candidate passes readiness and smoke tests.
- A failed candidate leaves the active release untouched.
- A failed post-cutover release switches back to the previous release automatically.
- API SSE connections, chatbot WebSockets, and dispatcher GPU jobs have an explicit
  drain strategy.
- Database changes remain compatible with both the old and new application versions
  throughout the rollback window.
- Concurrent pushes cannot run overlapping production deployments.
- The release log states exactly what changed, what was deployed, how long each phase
  took, and whether rollback occurred.

### 2.2 Non-goals

- Moving production to Kubernetes.
- Replacing CloudPanel as the public TLS and virtual-host manager.
- Moving PostgreSQL, Redis, or object storage off the current VPS as part of this work.
- Reworking business APIs or application features.
- Automatically publishing the Shopify theme extension or mobile applications. They
  remain separate release surfaces.
- Providing zero interruption for an individual indefinitely open connection. The
  requirement is zero gateway outage; long-lived connections may reconnect after the
  configured drain window.
- Automatically reversing database schema migrations. Database rollback remains a
  forward-fix operation.

## 3. Current State and Failure Analysis

### 3.1 Current GitHub Actions behavior

`.github/workflows/ci.yml` currently triggers for every push to `main` and every pull
request targeting `main`. It has no `paths` or `paths-ignore` rules.

Every matching change, including a Markdown-only change, currently runs:

- a full dependency installation in the lint job;
- a second full dependency installation and all shared builds/typechecks;
- a third full dependency installation, Docker test infrastructure, dispatcher tests,
  and API tests;
- the production deployment after all three jobs pass on a `main` push.

The jobs run in parallel, but each repeats setup work and the slowest one gates deploy.
The configured pnpm cache stores the pnpm package store; it does not cache all compiled
workspace output or eliminate repeated installations.

### 3.2 Current VPS deployment behavior

The deployment SSH command currently:

1. fetches `main`;
2. resets the VPS worktree to `FETCH_HEAD`;
3. pulls PostgreSQL and Redis base images;
4. runs unscoped `docker compose build`;
5. force-recreates PostgreSQL;
6. starts an API container to run migrations and migration verification;
7. runs unscoped `docker compose up -d --force-recreate`;
8. prunes old images.

Because the production Compose file contains build definitions for all application
services, the unscoped build considers every application image. The final unscoped
`up --force-recreate` replaces the entire application and infrastructure stack even if
only one file changed.

### 3.3 Why build time has increased

Each application Dockerfile copies the whole repository before `pnpm install`:

```dockerfile
COPY . .
RUN pnpm install --no-frozen-lockfile
```

Although `.dockerignore` already excludes `docs`, `node_modules`, `.next`, and `dist`,
any non-excluded source change modifies the broad `COPY . .` layer and can invalidate
the dependency-install layer. Each service then independently installs the monorepo
and builds its own subset of shared packages.

The runtime images for Node services also copy the complete build-stage `/app`
directory, including substantially more source and development material than the
service requires.

### 3.4 Availability gaps

- Application services have `/health` endpoints, but production Compose does not use
  application health checks to gate replacement.
- The API `/health` endpoint proves only that Fastify can answer; it does not prove that
  required PostgreSQL and Redis connections are usable.
- The API process does not currently register explicit SIGTERM/SIGINT shutdown logic.
- Chatbot has graceful Fastify shutdown, but its existing health route performs
  database queries and does not explicitly represent a draining state.
- Dispatcher handles SIGTERM, but `stopConsumer()` only stops future loop iterations.
  Shutdown immediately closes Redis and PostgreSQL without awaiting current GPU jobs.
- Customer and admin SSE clients already reconnect with backoff. The customer chatbot
  WebSocket and admin agent WebSocket do not currently provide equivalent reconnect
  behavior.
- `docker compose up --force-recreate` removes the only active instance before the new
  instance is proven ready, allowing CloudPanel to reach an unavailable upstream.
- Stateful dependencies are unnecessarily placed in the ordinary application restart
  path.

## 4. Production Inventory and Dependency Graph

### 4.1 Deployable services

| Deployment target | Source directory | Workspace package | Current public role | Internal port | Shared workspace dependencies |
|---|---|---|---|---:|---|
| `web` | `apps/catalogues-web` | `@tryme/web` | Main Next.js application | 3000 | `types` |
| `admin` | `apps/admin-web` | `@tryme/admin` | Admin Vite SPA | 80 | None |
| `shopify-admin` | `apps/shopify` | `@tryme/shopify-admin` | Embedded Shopify Vite SPA | 80 | None |
| `api` | `apps/api` | `@tryme/api` | Fastify API | 4000 | `db`, `logger`, `observability`, `storage`, `types` |
| `chatbot` | `apps/chatbot` | `@tryme/chatbot` | Chatbot HTTP/WebSocket service | 4200 | `db`, `logger`, `observability`, `types` |
| `dispatcher` | `apps/dispatcher` | `@tryme/dispatcher` | Redis Stream/GPU job dispatcher | health port from env | `db`, `logger`, `observability`, `storage`, `types` |

**The source directory name is not the deployment target name and is not the workspace
package name.** Three of the six differ (`catalogues-web` → `web`, `admin-web` →
`admin`, `shopify` → `shopify-admin`). The detector must never derive a target from a
directory path segment. `config/ci-targets.json` carries an explicit `dir` field per
target, and the detector resolves `dir` → `package.json` `name` → target. A directory
under `apps/` with no target entry is an unmapped production path and falls back to all
services per §5.2.

PostgreSQL, Redis, MinIO, MinIO bootstrap, Alloy, and the new deployment gateway are
stable infrastructure, not ordinary application release targets.

### 4.2 Shared-package impact

The detector must read package manifests and compute recursive consumers. The current
expected result is:

| Changed shared package | Production images affected |
|---|---|
| `@tryme/types` | `web`, `api`, `chatbot`, `dispatcher` |
| `@tryme/db` | `api`, `chatbot`, `dispatcher` |
| `@tryme/storage` | `api`, `dispatcher` |
| `@tryme/logger` | `api`, `chatbot`, `dispatcher` |
| `@tryme/observability` | `api`, `chatbot`, `dispatcher` |

This table documents the current result, but the implementation must derive package
edges from `package.json` workspace dependencies rather than duplicating this table as
the only source of truth.

### 4.3 Other application surfaces

- `apps/shopify-extension` is not the `shopify-admin` image. Changes there require its
  own validation and later Shopify CLI publication workflow; they must not silently
  trigger or masquerade as a container deployment.
- `apps/virtual-tryon-mobile&kiosk_latest` is tracked in Git and is a separate release
  surface. Its directory name contains an `&`; every shell path expansion in CI and in
  the deployment scripts must be quoted, and ShellCheck validation must cover this case.
- `apps/saree_catalogue_android` is a native Gradle/Kotlin Android project with no
  `package.json`. It is not a pnpm workspace member, has no Dockerfile, and is a separate
  release surface published through its own Android build, not this pipeline.
- `apps/admin-mobile` is Git-ignored (`.gitignore`), is not present in CI checkouts, and
  is not in `pnpm-lock.yaml`. Repository policy also places it out of active scope. It is
  never a target, never a test surface, and never an image. See §22 for the
  `.dockerignore` consequence.
- Android/mobile projects are separate release surfaces and do not enter the Docker
  image matrix.
- Scripts and database tooling that run only operationally must be classified through
  the target manifest rather than assumed to affect every HTTP service.

### 4.4 Untracked working-tree directories

Several developer machines carry stale, untracked `apps/` directories that contain only
build residue (`node_modules`, `dist`, `*.tsbuildinfo`) and no `package.json`: currently
`apps/web`, `apps/admin`, and `apps/merchant-web`. They are not in Git and are not
pnpm workspace members.

The detector must derive its file universe from Git (`git diff`, `git ls-files`), never
from a filesystem walk. Otherwise a local detector run disagrees with the CI run and the
fixture tests become unreproducible. §17.1 asserts this explicitly.

## 5. Affected-Target Detection

### 5.1 Implementation

Add these version-controlled components:

- `config/ci-targets.json`: deployable targets, workspace package names, Dockerfiles,
  Compose service names, smoke checks, and global path rules.
- `scripts/ci/detect-affected.mts`: deterministic detector used locally and in CI.
- `scripts/ci/detect-affected.test.ts`: fixture-based detector tests.

The detector must use `git diff --name-status -z` so paths containing spaces are safe.
It must understand added, modified, renamed, copied, and deleted files.

### 5.2 Diff range

For a pull request:

- fetch complete base-branch history;
- calculate the merge base between the PR head and the target branch;
- compare merge base to PR head.

For a push to `main`:

- compare `github.event.before` with `github.sha`;
- handle all commits in the push, not only `HEAD^`.

Select every production service if:

- the previous SHA is the all-zero initial-push value;
- the base SHA is unavailable locally after fetch;
- the push was force-updated and a safe merge base cannot be established;
- target configuration cannot be parsed;
- a changed path is classified as production-relevant but has no target mapping;
- the detector exits unexpectedly.

Failure must be safe: uncertainty causes more validation/building, never less.

### 5.3 Path classification

Rules are keyed on the `dir` values declared in `config/ci-targets.json`, not on a
`apps/<name>` pattern where `<name>` is assumed to be the target. See §4.1.

| Change | Result |
|---|---|
| `docs/**`, Markdown-only root docs | Documentation validation only; no image and no deploy |
| `apps/catalogues-web/**` | `web` |
| `apps/admin-web/**` | `admin` |
| `apps/shopify/**` | `shopify-admin` |
| `apps/api/**` | `api` |
| `apps/chatbot/**` | `chatbot` |
| `apps/dispatcher/**` | `dispatcher` |
| `apps/shopify-extension/**`, `apps/virtual-tryon-mobile&kiosk_latest/**`, `apps/saree_catalogue_android/**` | Separate release surface; no image and no deploy |
| Any other tracked `apps/*` path | Unmapped production path; fall back to all services |
| `packages/<pkg>/**` | The package plus recursive workspace consumers |
| Service Dockerfile or service NGINX config | That service image |
| `packages/db/src/migrations/**` or migration journal | `migration_changed=true` plus all `db` consumers |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json` | All workspace checks and all service images |
| Shared base TypeScript/Biome configuration | All affected code checks; all images if runtime compilation may differ |
| `.dockerignore` or shared Docker build tooling | All service images |
| Release Compose or deploy scripts | Deployment-bundle validation; all services only when image/runtime definitions changed |
| Stable gateway configuration | Infrastructure change; no automatic stateful-service restart |
| PostgreSQL/Redis/MinIO/Alloy definitions | Manual infrastructure workflow |
| `.env.production.example` only | Configuration-contract validation; no secret mutation and no image by itself |
| `.github/workflows/**` or CI detector code | Full CI validation; deploy only if the application graph also changed |

Deleted paths retain their historical classification. A deleted service directory must
not result in a false docs-only release.

### 5.4 Detector output contract

The detector writes a JSON artifact and compact values to `$GITHUB_OUTPUT`:

```json
{
  schemaVersion: 1,
  baseSha: <40-char-sha>,
  headSha: <40-char-sha>,
  changedFiles: [apps/catalogues-web/src/app/page.tsx],
  changedPackages: [@tryme/web],
  affectedPackages: [@tryme/web],
  services: [web],
  testTargets: [@tryme/web],
  migrationChanged: false,
  deploymentBundleChanged: false,
  infrastructureChanged: false,
  docsOnly: false,
  fallbackToAll: false,
  reasons: {
    web: [apps/catalogues-web/**]
  }
}
```

The `reasons` field is required. It makes unexpected builds explainable in the Actions
summary and prevents the detector from becoming an opaque source of CI behavior.

### 5.5 Required-check behavior

Do not put `paths-ignore` on the complete workflow. GitHub can leave a required check
missing when an entire workflow is skipped.

Instead:

- always run checkout, detection, documentation whitespace validation, and final
  `ci-gate`;
- conditionally run expensive jobs using detector outputs;
- make `ci-gate` depend on every conditional job with `if: always()`;
- make `ci-gate` fail if any required, non-skipped dependency failed or was cancelled;
- configure branch protection to require only stable aggregate checks such as
  `ci-gate`, not dynamic matrix child names.

## 6. GitHub Actions Pipeline

### 6.1 Events

| Event | Checks | Push images | Deploy production |
|---|---|---|---|
| Pull request to `main` | Affected checks and image build validation | No | No |
| Push to `main` | Affected checks | Yes, affected images only | Yes, unless no deployable target changed |
| `workflow_dispatch` rollback | Release-state validation | No | Roll back selected services to a recorded release |
| `workflow_dispatch` infrastructure | Infrastructure validation | As needed | Manual approval required |
| `workflow_dispatch` override | All checks; detector forced to all services or an operator-named subset | Yes, for the forced set | Yes — the escape hatch when detection is wrong |
| `schedule` nightly | Full monorepo validation regardless of diff | No | **No** — the nightly validates, it never deploys |
| Documentation-only push | Detector, whitespace/docs checks, `ci-gate` | No | No |

The override accepts either a `force_all` boolean or a comma-separated service subset,
never both; supplying both is an error rather than a guess. An unknown service name is
rejected rather than silently deploying nothing.

### 6.2 Job graph

```text
detect
  |-- changed-file-quality
  |-- typecheck-matrix
  |-- test-matrix
  |-- migration-policy
  |-- docker-build-validation (PR)
  +-------------------------------> ci-gate
                                      |
                                      v
                              image-build-push (main)
                                      |
                                      v
                               release-manifest
                                      |
                                      v
                             deploy-production
                                      |
                                      v
                              post-deploy-report
```

### 6.3 Detect job

- Use `fetch-depth: 0` so merge-base and multi-commit comparisons are reliable.
- Install Node/pnpm only if required to run the detector; execute it through the
  repository's pinned `tsx` version.
- Upload the JSON detector result as an artifact.
- Render changed services and their reasons in the job summary.
- For docs-only changes, the remaining expensive jobs are skipped and `ci-gate`
  succeeds.

### 6.4 Changed-file quality job

- Run `git diff --check` for every change.
- Run Biome against changed supported code/configuration files, not `biome check .`.
- If shared Biome configuration changes, run the full Biome check.
- Do not pass deleted paths to Biome.
- Fail if a code path is outside the target manifest and not explicitly ignored.

### 6.5 Typecheck/build matrix

- Generate the package matrix from `affectedPackages`.
- Build prerequisite workspace libraries before checking a consumer.
- Use pnpm recursive filters rather than handwritten sequences of package builds.
- Ensure an affected package with no `typecheck` script still executes its production
  build if that build includes TypeScript validation, as admin-web currently does.
- Cache the pnpm store keyed by OS, Node version, pnpm version, and lockfile hash.
- Cache safe compiler outputs per package only when the key includes source and
  dependency hashes; never restore an unqualified shared `dist` directory.

### 6.6 Test matrix

Scope note on which suites exist today. CI currently runs exactly two commands:
`pnpm --filter @tryme/dispatcher test:unit` and `pnpm --filter @tryme/api
test:unit`. The API `test:unit` script is `vitest run --exclude 'test/integration/**'`,
and despite the name it still provisions real PostgreSQL, Redis, and MinIO through
`apps/api/test/helpers/containers.ts`. `test:integration` is not wired into CI at all.

Affected-target scoping in this document applies to those two existing `test:unit`
commands. Introducing an `test:integration` CI stage is separate work and is not a
prerequisite for this pipeline.

- Dispatcher `test:unit` runs only when dispatcher or one of its workspace dependencies
  is affected.
- API `test:unit` runs only when API or one of its workspace dependencies is affected.
- Start Compose PostgreSQL/Redis/MinIO for any test job using
  `apps/api/test/helpers/containers.ts`, which includes the API `test:unit` suite.
- Continue using random database and bucket names as required by the existing test
  architecture.
- Package-level tests run for affected packages that define a test script.
- A full scheduled nightly CI run validates the complete monorepo to catch mistakes in
  affected-target classification without slowing every push.

### 6.7 Docker build validation and publishing

For pull requests:

- build affected images with Buildx;
- do not push them;
- verify the final image's configured user, entrypoint, health command, and architecture;
- run a container smoke test when the service can start against CI infrastructure.

For `main`:

- build affected images in parallel;
- push each to GHCR;
- export the exact digest from each matrix child;
- never rebuild the same commit on the VPS.

### 6.8 Concurrency and stale releases

Configure production concurrency as:

```yaml
concurrency:
  group: tryme-production
  cancel-in-progress: false
```

Deployments are serialized because cancelling midway through a gateway switch or
migration is unsafe. Immediately after acquiring the deployment lock, compare the
release SHA with the current remote `main` SHA. If a newer successful release is
queued, mark the older release superseded before it changes production.

## 7. Container Image Strategy

### 7.1 Registry naming and identity

Use one GHCR repository per deployment target:

```text
ghcr.io/<owner>/tryme-web
ghcr.io/<owner>/tryme-admin
ghcr.io/<owner>/tryme-shopify-admin
ghcr.io/<owner>/tryme-api
ghcr.io/<owner>/tryme-chatbot
ghcr.io/<owner>/tryme-dispatcher
```

Publish convenience tags such as `sha-<full-sha>` and `main`, but Compose must deploy
the immutable digest:

```text
ghcr.io/<owner>/tryme-api@sha256:<digest>
```

Rollback therefore does not depend on a mutable tag retaining its historical value.

### 7.2 Dockerfile layering

Each Dockerfile must follow this order:

1. pin the Node Alpine image to a reviewed major/minor or digest policy;
2. enable the repository's exact pnpm version;
3. copy root/workspace package manifests and `pnpm-lock.yaml`;
4. run `pnpm fetch --frozen-lockfile` using a BuildKit pnpm-store cache;
5. copy only the source directories needed by the target and its workspace
   dependencies;
6. install offline with the frozen lockfile;
7. build dependencies and target through pnpm filters;
8. construct a pruned production runtime stage;
9. run as a non-root user;
10. include a health command that exercises the actual service listener.

Do not use `--no-frozen-lockfile` in production image builds.

**Prerequisite before switching to `--frozen-lockfile`.** All six Dockerfiles currently
begin with `COPY . .`, and `.dockerignore` does not read `.gitignore`. `apps/admin-mobile`
is Git-ignored and absent from `pnpm-lock.yaml`, so it is invisible to CI checkouts but
present in any developer's build context. A frozen install would therefore succeed in
Actions and fail locally with a specifier mismatch. Before §7.2 lands, add to
`.dockerignore`:

```text
apps/admin-mobile
apps/web
apps/admin
apps/merchant-web
```

The last three are stale untracked build residue described in §4.4.

**The API runtime image must ship database migrations.** §11.4 runs migrations and
`db:verify:prod` from the candidate API image. The current runtime stage copies the whole
build tree (`COPY --from=build /app /app`), so `packages/db/src/migrations/**` and the
migration journal are present incidentally. Runtime pruning must preserve them
deliberately. An image test in §17.3 asserts the migration directory and journal exist in
the final `api` image and that their hash matches the release manifest's `journalHash`.

The first implementation may retain the existing working runtime layout while layer
ordering is corrected. Runtime pruning is complete only after every service has a
start-up smoke test proving workspace package resolution still works.

### 7.3 Build cache

Use service-scoped Buildx cache keys so one service cannot evict another service's hot
cache:

```text
type=gha,scope=web
type=gha,scope=api
...
```

The cache is an optimization only. A cold-cache build of every affected image must
remain correct.

### 7.4 Build-time and runtime configuration

The following frontend values are compile-time inputs and must be configured as
GitHub production environment variables:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_BASE_PATH`
- `NEXT_PUBLIC_CHATBOT_URL`
- `VITE_CHATBOT_URL`
- `VITE_SHOPIFY_API_KEY`
- `VITE_TRYME_APP_URL`
- `VITE_API_BASE_URL`

The build job fails before compilation if a required value is missing. These public
values are included in the release manifest as a hash, not as a substitute for secret
management.

Because these values are compiled in, a `web`, `admin`, or `shopify-admin` digest is
bound to the environment it was built for and cannot be promoted across environments.
That is acceptable under the current single-production model, but the constraint must be
recorded so a future staging environment is not assumed to reuse production digests.

Database credentials, Redis credentials, object-storage credentials, JWT secrets,
provider API keys, and other runtime secrets are never passed as Docker build args.
They stay in a root-owned VPS environment file.

### 7.5 Supply-chain controls

- Use GitHub's short-lived `GITHUB_TOKEN` to publish packages.
- Give the VPS a read-only GHCR credential; it must not be able to publish or delete
  images.
- Generate an SBOM and GitHub build provenance for every pushed digest.
- Scan affected images for known vulnerabilities. Block fixable critical findings;
  report high findings with an explicit remediation record.
- Pin third-party GitHub Actions to reviewed commit SHAs, with automated update PRs.
- Deploy by digest and verify the digest exists in the release manifest before pull.

### 7.6 Runtime environment contract change

This is a breaking change that the image work cannot avoid, so it is specified here
rather than discovered during rollout.

All three Node services currently start with an explicit dotenv path:

```json
"start": "node --env-file=../../.env dist/main.js"
```

`infra/docker-compose.prod.yml` satisfies that by bind-mounting `.env.production` to
`/app/.env` inside each container. Two parts of this plan break that arrangement:

- §7.2 runtime pruning changes the image layout, so `../../.env` relative to the service
  directory is no longer a stable path;
- §9.5 moves the authoritative secret file to `/etc/tryme/production.env`, outside any
  release bundle or worktree.

**Decision:** drop `--env-file` from the `start` script of `@tryme/api`,
`@tryme/chatbot`, and `@tryme/dispatcher`, and supply configuration through the
Compose `env_file:` directive pointing at `/etc/tryme/production.env`. Environment
variables then arrive in the process environment directly, which is also what the
blue/green slot rendering in §11.3 already assumes.

Consequences to handle in the same change:

- `apps/api/src/env.ts` validation must still pass with no dotenv file present;
- local development keeps working through the existing root `.env` plus whatever loader
  `pnpm dev` uses; do not couple local development to the production path;
- the one-shot migration container in §11.4 receives the same `env_file:`, so
  `db:migrate:prod` and `db:verify:prod` need no `--env-file` either;
- the release-slot Compose file must not bind-mount any `.env` into application
  containers.

Land this in Phase 2 alongside the image work. Shipping pruned images without it produces
containers that start and then fail environment validation.

## 8. Release Manifest

The image jobs feed a single release manifest. It must contain no secrets.

```json
{
  schemaVersion: 1,
  releaseSha: <40-char-git-sha>,
  createdAt: 2026-07-21T12:00:00Z,
  repository: <owner>/<repository>,
  affectedServices: [api, web],
  images: {
    api: {
      reference: ghcr.io/<owner>/tryme-api@sha256:<digest>,
      digest: sha256:<digest>
    },
    web: {
      reference: ghcr.io/<owner>/tryme-web@sha256:<digest>,
      digest: sha256:<digest>
    }
  },
  migration: {
    required: true,
    journalHash: sha256:<hash>,
    mode: expand
  },
  buildConfigurationHash: sha256:<hash>
}
```

The manifest is checksummed, uploaded as a GitHub artifact, included in the deployment
bundle, and copied into the VPS release history. Missing digests or an unexpected
service name fail closed.

## 9. Target VPS Topology

### 9.1 Stable and release stacks

Split the current production Compose responsibilities into:

- `infra/docker-compose.infra.yml`: PostgreSQL, Redis, MinIO, MinIO bootstrap, Alloy,
  and stable deployment gateway;
- `infra/docker-compose.release.yml`: parameterized application services for one
  release slot.

Keep `infra/docker-compose.prod.yml` temporarily during migration, then remove or turn
it into a documented compatibility wrapper after the new pipeline is proven.

The infrastructure stack is not touched by an ordinary application deployment.

### 9.2 Shared Docker network

Create one external network during bootstrap:

```text
tryme-prod-net
```

Infrastructure services keep stable aliases such as `postgres`, `redis`, and `minio`.
Release services receive slot-specific aliases:

```text
api-blue        api-green
web-blue        web-green
admin-blue      admin-green
shopify-blue    shopify-green
chatbot-blue    chatbot-green
dispatcher-blue dispatcher-green
```

Remove fixed application `container_name` values and host port bindings. Compose
project names and network aliases provide isolation without naming collisions.

### 9.3 Stable deployment gateway

CloudPanel remains the public TLS edge. A dedicated, stable NGINX gateway becomes the
only upstream CloudPanel uses for application traffic.

To bootstrap without conflicting with existing production listeners, bind the gateway
to new loopback-only ports:

| Route role | Permanent gateway listener |
|---|---:|
| Main web | `127.0.0.1:13000` |
| Admin web | `127.0.0.1:13001` |
| Shopify admin | `127.0.0.1:13003` |
| API | `127.0.0.1:14000` |
| Chatbot HTTP/WebSocket | `127.0.0.1:14200` |

MinIO remains on its existing explicitly managed listener and is not routed through
the release gateway as part of this change.

CloudPanel's domain/path behavior remains logically unchanged; only its local upstream
ports change once during bootstrap. Relevant routes include:

- main application root to web gateway;
- `/v1/` and applicable API/admin prefixes to API gateway;
- admin root to admin gateway;
- Shopify admin prefix to Shopify gateway;
- chatbot domain to chatbot gateway with WebSocket upgrade headers.

The gateway runs `restart: unless-stopped`, has its own health check, and is never
recreated during a normal application release.

### 9.4 Gateway configuration

The active configuration is generated from deployment state, not edited with string
replacement in place. For each HTTP service it contains:

- candidate/active slot as primary;
- previous slot as a temporary `backup` during the observation window;
- `proxy_next_upstream` for connection error, timeout, `502`, `503`, and `504` where
  retrying is safe;
- correct `Host`, forwarding, WebSocket upgrade, and HTTP/1.1 headers;
- timeouts appropriate for API, SSE, and WebSocket routes;
- internal-only listeners used by readiness and candidate smoke tests.

Traffic switch procedure:

1. render a complete candidate NGINX configuration to a temporary file;
2. run `nginx -t` against it;
3. atomically rename it over the active configuration;
4. run `nginx -s reload`;
5. verify the gateway reports the intended release SHA;
6. retain the previous configuration until the release is committed successful.

NGINX reload preserves established connections handled by old workers. Old application
containers remain available during the drain window.

### 9.5 VPS filesystem layout

Use fixed, non-worktree state paths:

```text
/etc/tryme/production.env                  root-owned runtime environment
/opt/tryme/releases/<release-sha>/         immutable deployment bundles
/opt/tryme/current                         symlink to latest successful bundle
/var/lib/tryme-deploy/state.json           active slots and release state
/var/lib/tryme-deploy/releases/            successful/failed release records
/var/lib/tryme-deploy/gateway/             generated and previous gateway config
/var/lock/tryme-deploy.lock                deployment lock
```

`state.json` is written to a temporary file, flushed, and atomically renamed. It records
the active slot, digest, and release SHA independently for each service.

The deployment user owns release/state directories, can invoke the narrowly scoped
deployment scripts, and can use Docker. The environment file remains readable only by
the deployment runtime and authorized administrators.

## 10. Readiness and Graceful Shutdown Contracts

### 10.1 Readiness response

API, chatbot, and dispatcher add an internal readiness contract.

Successful response:

```json
{
  status: ready,
  service: api,
  releaseSha: <git-sha>,
  slot: green
}
```

Unavailable response with HTTP `503`:

```json
{
  status: not_ready,
  service: api,
  releaseSha: <git-sha>,
  slot: green
}
```

Do not expose credentials, connection strings, internal hostnames, exception text, or
detailed dependency state publicly. Detailed failure reasons belong in structured
logs.

`/health` remains a lightweight liveness endpoint for compatibility. `/ready` is used
for traffic and deployment decisions.

### 10.2 API

The API is ready only after:

- environment validation succeeds;
- Fastify registration completes;
- PostgreSQL answers a bounded probe;
- Redis answers a bounded `PING`;
- required background consumers have started.

On SIGTERM/SIGINT:

1. set readiness false;
2. stop accepting new background work;
3. call `app.close()` to stop new HTTP connections and drain active requests;
4. close Redis, PostgreSQL, and other clients;
5. exit zero before Compose's `stop_grace_period` expires.

### 10.3 Chatbot

The chatbot is ready only after Fastify/WebSocket registration, PostgreSQL, Redis, and
required model configuration are available. Keep its current graceful shutdown and
add readiness state before closing Fastify.

The customer chatbot and admin agent clients must gain bounded exponential WebSocket
reconnection. Reconnection obtains a fresh one-time ticket rather than reusing an old
ticket.

### 10.4 Dispatcher

Change `runConsumer()` to return a lifecycle controller rather than only a stop
callback:

```ts
interface ConsumerLifecycle {
  stopAccepting(): void;
  awaitIdle(timeoutMs: number): Promise<boolean>;
  inFlight(): number;
}
```

On SIGTERM/SIGINT:

1. set readiness false;
2. call `stopAccepting()`;
3. continue the currently executing `processJob()` promises;
4. call `awaitIdle(DISPATCHER_DRAIN_TIMEOUT_MS)`;
5. stop monitor, webhook, sweeper, recovery, and health subsystems;
6. close Redis/PostgreSQL clients;
7. exit cleanly.

The new dispatcher slot may start before the old slot has fully drained. Redis Stream
consumer-group semantics and existing worker reservation must prevent double final
processing. The deployment acceptance test must verify this with a real in-flight job.

### 10.5 Frontends

- NGINX SPA images are healthy only when `/index.html` is served successfully.
- The Next.js image is healthy only when its listener serves the configured root/base
  path.
- Candidate smoke tests parse the returned HTML and request at least one referenced
  hashed JS or CSS asset, catching incomplete image copies that a simple `200` misses.

### 10.6 Compose health settings

Default application health policy:

- interval: 10 seconds;
- timeout: 3 seconds;
- retries: 6;
- start period: 30 seconds for frontends/API, 60 seconds for chatbot/dispatcher;
- `stop_grace_period`: 60 seconds for HTTP services and a configurable dispatcher
  value long enough for the supported GPU-job drain policy.

Health commands must be present in the final image and must not depend on tools absent
from that image. Node images may use a small Node probe; NGINX images may use Alpine's
available HTTP client.

## 11. Deployment Algorithm

Implement the algorithm in a checked-in Linux deployment script rather than a large
quoted SSH command inside YAML. Validate it with ShellCheck in CI.

### 11.1 Phase A: receive and validate

1. GitHub Actions creates a release bundle containing deployment scripts, Compose
   files, gateway templates, and release manifest.
2. Copy it to `/opt/tryme/releases/<sha>.incoming` using pinned SSH host keys.
3. Verify bundle checksum, manifest schema, release SHA, service allowlist, and image
   digests.
4. Atomically rename the directory to `/opt/tryme/releases/<sha>`.
5. Acquire `/var/lock/tryme-deploy.lock` with `flock`; never wait indefinitely.
6. Check whether the SHA is already successfully deployed; if so, exit idempotently.
7. Check whether a newer successful `main` SHA supersedes this release; if so, record
   `superseded` and exit without changing production.

### 11.2 Phase B: preflight

Abort before changing traffic if any check fails:

- Docker daemon and Compose are usable;
- stable gateway is healthy and its current config validates;
- PostgreSQL, Redis, and MinIO are healthy;
- current deployment state parses and every active service is reachable;
- GHCR authentication can read required image manifests;
- system clock is synchronized sufficiently for TLS and signed metadata;
- no unresolved previous deployment operation exists;
- no detached drain unit from a previous release still owns a slot this release needs
  (§11.8); wait a bounded time, then abort rather than reusing a draining slot;
- free disk is at least the greater of 10 GB or twice the total candidate image size;
- available RAM is at least 125% of current memory used by affected containers plus a
  1 GB host reserve;
- recent load is below the configured safe rollout threshold;
- for migration releases, the latest off-host database backup is no older than 24
  hours.

Capacity failure is not permission to fall back automatically to an outage-producing
replacement. It aborts the release while the current version continues serving.

### 11.3 Phase C: pull and prepare

1. Determine the inactive slot independently for every affected service.
2. Pull only manifest image digests for affected services.
3. Render the inactive-slot Compose environment using the immutable digests and
   `/etc/tryme/production.env`.
4. Run `docker compose config --quiet` and validate no candidate publishes a host port.
5. Confirm the candidate connects only to the intended production network and volumes.

### 11.4 Phase D: migrations

If `migration.required` is true:

1. validate the manifest journal hash against the candidate API image;
2. verify the migration policy result is `expand`;
3. acquire a PostgreSQL advisory lock dedicated to schema migrations;
4. run the migration using the candidate API image as a one-shot container;
5. run `db:verify:prod` using the same image;
6. release the advisory lock;
7. abort before starting/switching candidates if either command fails.

The old application remains live during additive migrations. Because migrations must
be backward compatible, application rollback remains possible without schema rollback.

### 11.5 Phase E: candidate startup

1. Start all affected candidate slots without touching active slots.
2. Wait for Docker health with a bounded timeout.
3. Call each candidate directly on the internal network and verify `/ready` plus the
   expected release SHA and slot.
4. Run service smoke tests.
5. For a multi-service release, start and validate every candidate before switching
   any public HTTP route.

#### Candidate concurrency modes

Step 5 is the memory worst case: production is a single VPS, and a change to
`@tryme/types` selects `web`, `api`, `chatbot`, and `dispatcher`, so four additional
containers — including Next.js and the LangGraph chatbot — must be resident alongside
the four they replace. If the §11.2 headroom check cannot be satisfied, that release
aborts, and it aborts every time, which turns the capacity gate into a permanent block
on exactly the shared-package changes that matter most.

The deployment script therefore supports two modes, selected by a deployment
configuration value and recorded in the release report:

- `parallel` (default): as written above. One gateway reload, one release boundary,
  strongest atomicity.
- `sequential`: process affected services one at a time in the §16 Phase 5 risk order —
  start candidate, verify, switch that service's upstream, drain and stop the old slot,
  then move to the next. Peak additional memory is one service rather than all affected
  services.

`sequential` gives up cross-service atomicity: for a bounded window, `web` may be on the
new release while `api` is still on the old one. That is only acceptable because §12
already requires backward-compatible schema, and it must additionally require that the
same release's frontend and API be compatible in both orderings. Releases that cannot
satisfy that must declare `parallel` and fail closed on capacity rather than switch
partially.

Phase 0 measures per-container peak memory against actual VPS free RAM and that
measurement selects the default mode. Do not assume `parallel` fits before it is
measured.

Default smoke tests:

- API: `/health`, `/ready`, and read-only unauthenticated `/v1/payments/plans`;
- web: application root plus one hashed asset referenced by returned HTML;
- admin: SPA root plus one hashed asset;
- Shopify admin: internal root plus one hashed asset;
- chatbot: `/health`, `/ready`, and an unauthenticated WebSocket upgrade that reaches
  the service and returns the expected authentication rejection;
- dispatcher: `/health`, `/ready`, and readiness metadata matching the release.

No smoke test may create a billable job, mutate production data, send a message, or
depend on a specific customer account.

### 11.6 Phase F: atomic traffic switch

1. Render a gateway configuration that points every affected HTTP service to its
   candidate slot and retains the former slot as backup.
2. Leave unaffected service upstreams byte-for-byte unchanged.
3. Validate the complete configuration with `nginx -t`.
4. Atomically replace the active config.
5. Reload NGINX once, switching all affected HTTP routes as one release boundary.
6. Confirm gateway-local routes return candidate release metadata.

Dispatcher has no public gateway route. Its candidate starts accepting work only after
readiness; the old dispatcher enters drain after the candidate is healthy.

### 11.7 Phase G: post-switch verification

Run checks from both perspectives:

- internal gateway listeners on the VPS;
- public HTTPS domains through CloudPanel/Cloudflare.

Verify:

- expected release SHA where exposed;
- API health/readiness and read-only DB-backed response;
- main/admin/Shopify HTML and assets;
- chatbot HTTP and WebSocket routing;
- no elevated `502`, `503`, `504`, or process-error rate;
- all affected containers remain healthy.

Observe for five minutes. Probe at least every ten seconds. Any hard failure triggers
automatic rollback; a transient probe must be retried according to a small bounded
policy before rollback to avoid reacting to one network packet loss.

### 11.8 Phase H: commit and drain

After the observation window:

1. atomically record new active slots/digests in `state.json`;
2. mark the release successful in release history;
3. update `/opt/tryme/current`;
4. remove the previous slot as gateway backup through another validated NGINX reload;
5. hand the old slots to the detached drain unit described below;
6. upload the deployment report to GitHub Actions and release the deployment lock.

#### Drain runs detached from the Actions job

The naive reading of this phase holds one serialized workflow job open for the five-minute
observation plus a ten-minute HTTP drain plus the dispatcher's GPU-job drain. With
`cancel-in-progress: false`, that caps production throughput at roughly one merge per
fifteen to twenty minutes, which is worse than the pipeline being replaced.

Split the two:

- the **five-minute observation stays in the job**. It is the rollback gate; §13.1
  automatic rollback is only possible while the job still holds the lock and the previous
  gateway configuration.
- the **drain does not**. Once state is committed and the release is marked successful,
  rollback is no longer automatic, so nothing about the drain needs to block CI. Step 5
  invokes a detached VPS-side unit — a systemd transient unit via `systemd-run`, or an
  equivalent supervised background command — which:
  1. marks old HTTP slots unready;
  2. waits up to the configured HTTP drain window (default ten minutes) for connections
     to close;
  3. gracefully drains the old dispatcher according to its configured job timeout;
  4. stops old affected containers without deleting their images;
  5. writes its outcome into the release record under
     `/var/lib/tryme-deploy/releases/`.

The deployment lock is released after step 6, not after the drain. The drain unit takes a
separate, narrower lock so a subsequent release cannot start a slot that the drain unit is
still stopping.

The next release must tolerate finding a previous drain still in progress: §11.2 preflight
checks for an unresolved drain and either waits a bounded time or aborts, and it never
reuses a slot whose drain has not completed. Drain outcome, including timeout, is reported
asynchronously through the §15 alerting path rather than by failing an already-successful
release.

### 11.9 Retention and cleanup

- Retain the five most recent successful release manifests and image digests.
- Keep the immediately previous release locally available for fast rollback.
- Remove only images not referenced by active slots or retained releases.
- Replace unconditional `docker image prune -f` with an explicit allowlisted cleanup.
- Never prune volumes or stable infrastructure data from the application pipeline.
- Run cleanup only after successful state commit; cleanup failure warns but does not
  roll back a healthy release.

## 12. Database Migration Policy

### 12.1 Expand-contract rule

Automatic `main` deployments may include only changes that are compatible with both
old and new application versions.

Allowed expand examples:

- add a nullable column;
- add a table or index without removing an old object;
- add a column with a safe default that does not rewrite/block the table beyond the
  approved operational threshold;
- add new enum/data values while old readers tolerate them;
- backfill in bounded, resumable batches after schema addition.

Disallowed in the automatic workflow:

- drop a table, column, index required by the old release, or enum value;
- rename a live table/column without a compatibility layer;
- make an existing nullable column immediately `NOT NULL`;
- narrow a type or change semantics in place;
- combine an irreversible backfill and removal in one release;
- deploy code that requires a schema change before the migration is verified.

### 12.2 Migration metadata and validation

New migrations must declare mode metadata understood by
`scripts/ci/validate-migrations.mts`. The validator examines changed SQL and fails the
automatic pipeline on destructive patterns. It is a guardrail, not a replacement for
review.

Destructive contract cleanup runs later through a separate manually dispatched
maintenance workflow after:

- the compatibility version has been live for the defined window;
- the previous incompatible images are no longer rollback candidates;
- a current off-host backup is verified;
- the cleanup migration and forward-recovery plan are reviewed.

### 12.3 Migration locking and backup

- Extend the migration runner with a PostgreSQL advisory lock so concurrent/manual
  runners cannot apply the same journal simultaneously.
- Maintain automated off-host PostgreSQL backups independently of the VPS data volume.
- Record successful backup time in a machine-readable location checked by deployment.
- Migration releases fail closed when the latest backup is older than 24 hours.
- The pipeline never claims that an application rollback reverted schema. Schema
  correction is always a new forward migration.

## 13. Rollback and Failure Handling

### 13.1 Automatic rollback

Automatic rollback is permitted only after candidate images and migrations are known.
It performs:

1. validate the saved previous gateway configuration;
2. ensure previous containers are still healthy, restarting by retained digest if
   necessary;
3. atomically restore previous upstreams;
4. reload and probe the gateway;
5. stop accepting traffic on failed candidates;
6. retain failed containers/logs long enough for diagnosis;
7. mark the release failed and upload evidence.

Database changes are not reversed. Expand-contract compatibility is what makes the old
application safe after rollback.

### 13.2 Failure matrix

| Failure point | Required behavior |
|---|---|
| CI lint/type/test failure | No image publication and no deploy |
| Image build/scan failure | No release manifest and no deploy |
| Bundle or manifest validation failure | No VPS state change |
| Deployment lock busy | Queue/fail cleanly; never overlap |
| Capacity or infrastructure preflight failure | Abort; current release remains active |
| Image pull failure | Abort; current release remains active |
| Migration failure | Abort before candidate switch; flag operator review |
| Candidate crash/readiness timeout | Stop candidate; current release remains active |
| Candidate smoke failure | Stop candidate; current release remains active |
| Gateway config validation failure | Do not reload; current release remains active |
| Public post-switch smoke failure | Restore previous config and reload automatically |
| Old-slot drain timeout | Preserve job/connection evidence; escalate without taking new slot offline if healthy |
| Cleanup failure | Warn and retry later; release remains successful |
| Gateway container failure | Docker restarts stable gateway from last valid config |
| Corrupt deployment state | Fail closed and reconstruct only through documented operator recovery |

### 13.3 Manual rollback

Provide a `workflow_dispatch` input containing:

- target successful release SHA;
- optional service subset;
- mandatory operator reason.

The workflow validates that every requested service digest exists and that its release
is compatible with the current schema. It then uses the normal candidate/start/smoke/
switch path; it does not directly edit state or tags.

Target operational objective: restore a retained previous application release within
60 seconds after rollback initiation, excluding an image re-pull when the operator has
allowed local retention to lapse.

## 14. Security Controls

- Use a dedicated production GitHub Environment even though deployment is automatic.
  Store production SSH and host-key material only there.
- Remove `StrictHostKeyChecking=no`. Store and verify the VPS host key.
- Use a dedicated deployment account rather than root SSH.
- Restrict the SSH key to the intended account and audit its use. Docker access is
  effectively privileged and must be treated accordingly.
- Write the temporary SSH private key with mode `0600` and remove it with a shell trap
  on success, failure, or cancellation.
- Do not embed GitHub tokens in remote Git URLs. Normal deploys transfer a release
  bundle and pull registry images; they do not `git reset --hard` a source checkout.
- Keep runtime secrets out of GitHub artifacts, release manifests, images, job
  summaries, and command-line arguments.
- Bind gateway and storage administrative ports to loopback only.
- Run application containers as non-root where compatible, set `no-new-privileges`,
  drop unnecessary Linux capabilities, and use read-only filesystems/tmpfs where the
  service permits.
- Add bounded CPU/memory/log-size controls after measuring production peaks; do not set
  arbitrary limits that could kill active GPU orchestration jobs.
- Never expose API `/metrics`, dispatcher health/metrics, or deployment-control
  surfaces publicly.

## 15. Observability and Release Evidence

Every deployment produces structured events containing:

- release SHA and manifest checksum;
- affected services and detector reasons;
- old/new slot and digest per service;
- migration journal hash and result;
- preflight capacity figures;
- image pull duration;
- candidate startup/readiness duration;
- smoke-test results;
- gateway switch timestamp;
- observation error counts;
- drain duration and timeout status;
- final success, rollback, failure, or superseded state.

Expose the release SHA as a log field and runtime environment value. Continue shipping
container logs through Alloy. Add deployment annotations to the operational dashboard
so errors can be correlated with cutovers.

Minimum release alerts:

- deployment failed or rolled back;
- active gateway upstream unavailable;
- candidate readiness timeout;
- public `502/503/504` increase during observation;
- migration or backup-freshness failure;
- dispatcher drain timeout;
- disk below cleanup threshold.

The five-minute deployment observation is a release gate, not the only production
monitor. Normal error-rate and availability alerts continue afterward.

## 16. Live-System Rollout Plan

The repository is already in production, so the new pipeline must be adopted in
reversible phases.

### Phase 0: baseline and freeze unsafe expansion

- Record current CI duration per job, VPS build duration, restart duration, image size,
  container memory, and observed gateway errors.
- Record current CloudPanel upstream configuration and export a restorable copy.
- Verify an off-host PostgreSQL backup and restore procedure.
- Stop adding new services to the legacy unscoped deploy sequence.

**Exit criteria:** baseline captured, CloudPanel backup available, database recovery
verified, and VPS capacity data available.

### Phase 1: immediate CI/deploy safeguards

- Add affected detection and stable `ci-gate`.
- Make docs-only pushes skip expensive work and deployment.
- Serialize production deployments.
- Scope legacy VPS builds/restarts to affected application services.
- Remove stateful services from `--force-recreate` and remove unconditional base-image
  pulls from ordinary releases.
- Add a nightly full-monorepo validation run and a `workflow_dispatch` override
  (`force_all`, service subset). Affected-target detection introduces a silent failure
  mode — a misclassified change simply does not deploy, with no error. These two guards
  are what make that recoverable, so they belong in the phase that creates the risk, not
  a later one.
- Keep the existing deployment mechanism as rollback while later phases are built.

**Exit criteria:** docs-only push touches no containers; web-only push leaves backend
and stateful container IDs unchanged.

**Implementation plan:** `docs/superpowers/plans/2026-07-21-phase1-ci-affected-detection.md`.

### Phase 1.1: post-Phase-1 gate before Phase 2 planning

Phase 1 changes what production deploys and when. Phase 2 then changes where images come
from. Doing the second before the first has been observed under load produces a pipeline
where a failure cannot be attributed to either change.

This gate is a soak and a measurement window, not a build phase. Nothing here writes
application code. Work it in four tracks; they are independent and can run concurrently.

#### 1.1.1 Soak the new pipeline

Run Phase 1 through normal team activity for at least ten merged pull requests or two
calendar weeks, whichever comes later. Over that window collect, per release:

- detector-selected services and reasons, from the `affected-targets` artifact;
- CI wall-clock duration, split docs-only / single-service / shared-package / fallback;
- deploy duration and the Compose services actually recreated;
- every nightly full-run result.

Compare against the Phase 0 baseline. The claim being tested is that scoped releases are
both faster and no less correct — not merely faster.

#### 1.1.2 Confirm the detector is telling the truth

The nightly run is the oracle. Any nightly failure on a commit whose per-push CI passed
is a classification defect, and it must be treated as one:

1. reproduce it as a fixture case in `scripts/ci/classify.test.ts`;
2. fix `config/ci-targets.json` or the classifier;
3. only then re-run the nightly.

Separately, audit by hand at least three releases where the detector selected a strict
subset. For each, confirm no unselected service actually depended on the change. A
detector that is quietly wrong in the safe direction is tolerable; one that is wrong in
the unsafe direction ends this gate immediately.

Track how often `fallbackToAll` fires. Frequent fallback means the manifest is missing
path rules and Phase 2's image matrix will inherit the same over-building.

#### 1.1.3 Finish the Phase 0 measurements that Phase 1 did not need

Phase 1 only required the CI-duration baseline. The remaining Phase 0 items gate Phases
4 and 5, and they take calendar time to gather, so start them here rather than
discovering them missing later:

- per-container peak RSS and disk under real production load, for all six application
  services — this selects the §11.5 default candidate concurrency mode, and it is the
  single measurement most likely to invalidate the blue/green design;
- VPS free RAM and free disk at peak;
- current CloudPanel upstream configuration, exported and stored restorably;
- an off-host PostgreSQL backup **restored into a scratch database and verified**, not
  merely observed to exist.

Record all of it in `docs/progress.md`. If peak memory shows that `parallel` candidate
startup cannot fit, say so explicitly at this point; that decision changes Phase 5 and it
is cheaper to know now.

#### 1.1.4 De-risk the two known Phase 2 landmines

Both are cheap to test in isolation and expensive to discover mid-phase. Do them on a
throwaway branch, not on `main`:

1. **Frozen lockfile builds.** Add the `.dockerignore` entries from §7.2, then build one
   image with `pnpm install --frozen-lockfile` substituted for `--no-frozen-lockfile`.
   Confirm it succeeds both in CI and on a developer machine that has `apps/admin-mobile`
   present. This is the difference between Phase 2 starting cleanly and Phase 2 starting
   with a lockfile investigation.
2. **Environment without a dotenv file.** Per §7.6, run `@tryme/api` with `--env-file`
   removed and all configuration supplied through the process environment. Confirm
   `apps/api/src/env.ts` validation passes and the service reaches its listener. Repeat
   for chatbot and dispatcher.

Also resolve the §22 external prerequisites that Phase 2 cannot proceed without: the GHCR
owner namespace, a read-only GHCR credential for the VPS, and a pinned VPS SSH host key
replacing `StrictHostKeyChecking=no`.

**Exit criteria:** the soak window is complete with no unsafe misclassification; every
nightly in the final week is green or has a fixture-backed fix; per-container peak memory
is recorded and the §11.5 default mode is chosen; a PostgreSQL backup has been restored
and verified; a frozen-lockfile image build and a dotenv-free service start have both
succeeded; and the GHCR namespace, VPS read-only credential, and pinned SSH host key
exist.

Write the Phase 2 implementation plan only after this gate passes. Planning Phase 2
earlier means planning against a detector output contract and a set of capacity facts
that are still assumptions.

### Phase 2: CI-built immutable images

- Optimize Dockerfile layers and enforce frozen installs.
- Add affected Buildx matrices, GHCR publishing, scanning, attestations, and release
  manifests.
- Deploy images by digest to a non-public candidate Compose project on the VPS.
- Stop building source on the VPS, but do not switch public traffic through the new
  gateway yet.

**Exit criteria:** every production service can start from its GHCR digest and pass
internal smoke tests; a digest can be redeployed without rebuilding.

### Phase 3: readiness and draining

- Add `/ready`, release metadata, Compose health checks, and API graceful shutdown.
- Add dispatcher lifecycle/drain support and tests.
- Add WebSocket reconnect behavior.
- Verify SSE reconnect behavior remains correct.

**Exit criteria:** forced SIGTERM tests do not create failed HTTP requests outside the
drain contract, and an in-flight dispatcher job completes exactly once.

### Phase 3.5: interim availability without slot machinery

Phases 4 and 5 are the largest and riskiest part of this plan. Phase 3.5 banks most of
the availability benefit before they land, using only what Phase 3 already delivered, and
it doubles as the fallback if VPS capacity (§11.5) or schedule prevents blue/green from
being adopted.

Against the existing CloudPanel upstreams and the existing Compose file:

- add Compose `healthcheck` blocks for all six application services using the §10.6
  defaults;
- set `stop_grace_period` per §10.6 so SIGTERM handlers from Phase 3 actually get their
  drain window;
- add `proxy_next_upstream` for connection error, timeout, `502`, `503`, and `504` on
  the CloudPanel-managed upstreams where retrying is safe;
- replace the deployment's unscoped `up -d --force-recreate` with per-service
  `up -d --no-deps --wait <service>` limited to affected services.

This does not achieve zero downtime. One instance still stops before its replacement
serves, so the outage window per service shrinks from roughly the full container start
time to roughly the health-check confirmation time. It removes the multi-service
simultaneous restart, removes stateful services from the restart path, and makes every
later phase easier to reason about because health is already authoritative.

**Exit criteria:** a single-service release restarts only that service, the container is
not routed until its health check passes, and measured `502`/`503` volume during a
release is materially below the Phase 0 baseline.

If Phases 4 and 5 are deferred, this phase is the supported production state and the
zero-downtime acceptance criteria in §19 are explicitly not yet claimed.

### Phase 4: stable gateway bootstrap

- Start the gateway on the new loopback ports while legacy public containers remain
  active.
- Point gateway upstreams at the currently active legacy services and validate every
  route internally.
- Change CloudPanel upstream ports and perform one atomic host-NGINX reload.
- Run continuous external probes during the change.
- Keep the old CloudPanel configuration ready for immediate restoration.

**Exit criteria:** CloudPanel serves all domains through the stable gateway with zero
observed gateway errors, while application containers remain unchanged.

### Phase 5: blue/green adoption by risk

Enable service switching in this order:

1. admin frontend;
2. Shopify admin frontend;
3. main web frontend;
4. chatbot;
5. API;
6. dispatcher.

For each target, complete one successful deployment and one forced rollback exercise
before enabling the next target.

**Exit criteria:** every target passes continuous-traffic cutover and rollback tests.

### Phase 6: retire legacy deployment

- Remove the VPS source build and `git reset --hard` deployment path.
- Remove unscoped Compose rebuild/recreate commands.
- Remove obsolete fixed application host ports and container names.
- Enable retention cleanup. (The scheduled full-monorepo run already exists from Phase 1;
  here it is extended to cover the image matrix.)
- Update operational documentation and `docs/progress.md`.

**Exit criteria:** two complete successful production release cycles plus one manual
rollback drill use only the new pipeline.

## 17. Test Plan

### 17.1 Detector unit tests

- docs-only addition, modification, rename, and deletion;
- isolated change in every deployable app;
- every shared package and its recursive consumers;
- root lockfile/workspace/toolchain changes;
- service-specific Dockerfile and NGINX changes;
- migration SQL and journal changes;
- stable infrastructure changes;
- Shopify extension/mobile changes remain separate release surfaces;
- multi-commit push where an earlier commit touches a service and the last does not;
- renamed file crossing target boundaries;
- deleted service path;
- missing base SHA and force-push fallback to all;
- unmapped production path fails safe;
- reason output is stable and deterministic;
- directory names that differ from their target name resolve correctly
  (`apps/catalogues-web` → `web`, `apps/admin-web` → `admin`, `apps/shopify` →
  `shopify-admin`), and no target is ever inferred from a path segment;
- a path under `apps/` with no `ci-targets.json` entry falls back to all services;
- results are identical whether or not untracked directories such as `apps/web`,
  `apps/admin`, `apps/merchant-web`, or `apps/admin-mobile` exist in the working tree
  (§4.4);
- paths containing `&`, spaces, and other shell metacharacters survive the detector and
  every script that consumes its output.

### 17.2 CI integration scenarios

| Scenario | Expected jobs |
|---|---|
| `docs/readme.md` only | detect, docs/whitespace check, `ci-gate` |
| `apps/admin-web/**` | admin quality/build, admin image only |
| `apps/catalogues-web/**` | web checks/image only |
| `apps/shopify/**` | shopify-admin checks/image only |
| `apps/shopify-extension/**` | separate release surface; no image, no deploy |
| `apps/api/**` | API checks/`test:unit`/image only |
| `packages/types/**` | types plus web/API/chatbot/dispatcher dependents |
| `packages/db/src/migrations/**` | DB/API/chatbot/dispatcher validation, migration policy, affected images |
| `pnpm-lock.yaml` | full check and full image matrix |
| infra stateful definition | infrastructure validation, no automatic app deployment |

Assert skipped jobs do not download Docker images, start service containers, publish
packages, or connect to the VPS.

### 17.3 Image tests

- Cold-cache and warm-cache builds produce working images.
- Warm source-only changes reuse dependency layers.
- `pnpm-lock.yaml` changes invalidate dependency layers.
- Final images start without workspace source directories that are not intentionally
  included.
- Images run as the expected non-root user.
- Health commands exist and transition unhealthy on process/dependency failure.
- Release metadata matches the image's source SHA.
- Frontend build-time configuration hash matches the release manifest.
- The `api` image contains `packages/db/src/migrations/**` and the migration journal, and
  the journal hash matches the release manifest `journalHash` (§7.2).
- Node service images start with configuration supplied only through the process
  environment, with no `.env` file mounted and no `--env-file` argument (§7.6).
- A build from a working tree containing `apps/admin-mobile` succeeds with
  `--frozen-lockfile`, proving `.dockerignore` excludes it (§7.2).

### 17.4 Deployment integration tests

- Candidate health failure never changes gateway configuration.
- Candidate smoke failure never changes gateway configuration.
- Invalid generated NGINX config fails before reload.
- Successful switch changes only affected service upstreams.
- Post-switch public failure restores previous upstreams automatically.
- Deployment script is idempotent when the same SHA is retried.
- Two simultaneous deployment attempts result in exactly one lock holder.
- A queued stale SHA is marked superseded.
- State-file interruption cannot leave a partially written JSON document.
- Cleanup never removes active or retained digests.
- Infrastructure containers retain their IDs throughout application deployments.

### 17.5 Zero-downtime tests

Run continuous requests through the real proxy chain during cutover:

- web HTML and hashed asset requests;
- admin HTML and hashed asset requests;
- API `/health`, `/ready`, and `/v1/payments/plans`;
- authenticated API request using a dedicated non-customer smoke account where a
  read-only authenticated route is necessary;
- SSE stream with reconnection observation;
- chatbot WebSocket session and reconnection;
- combined API/web release switched in one gateway reload.

Acceptance requires no deployment-generated `502`, `503`, connection refusal, or
invalid partial asset response. A deliberate old-slot termination after the drain
window may cause one long-lived client reconnect, which must recover automatically.

### 17.6 Dispatcher tests

- SIGTERM while idle exits cleanly.
- SIGTERM while a job is active stops new reads and waits for the active job.
- Drain timeout is reported and does not silently acknowledge unfinished work.
- Old and candidate dispatchers overlapping during handoff do not complete or refund a
  job twice.
- Redis pending-entry recovery still works after forced termination.
- A release while a real GPU job runs produces exactly one terminal job state and one
  output set.

### 17.7 Migration tests

- Additive migration passes policy, migrate, and verify.
- Destructive SQL fails the automatic policy check.
- Two migration runners serialize on the advisory lock.
- Migration failure leaves old application traffic active.
- Previous application image operates after an additive schema migration.
- Stale backup status blocks a migration release but not a no-migration application
  release.

### 17.8 Rollback drill

- Deploy a known-good candidate.
- Force the next candidate's post-switch smoke check to fail.
- Verify automatic return to the prior public release.
- Trigger manual rollback to another retained release.
- Confirm state, gateway config, running containers, logs, and GitHub deployment status
  all agree afterward.
- Measure and record rollback time; target is at most 60 seconds when retained images
  are local.

## 18. Operational Runbooks

### 18.1 Normal release

1. Merge reviewed changes to `main`.
2. Watch `detect` summary for expected services and reasons.
3. Confirm required checks and affected image builds pass.
4. Observe production deployment phases and public smoke checks.
5. Confirm successful release SHA in deployment summary and service health metadata.
6. Review five-minute observation and old-slot drain outcome.

No operator SSH is required for a normal release.

### 18.2 Docs-only release

1. Detector classifies the push `docsOnly=true`.
2. Documentation/whitespace validation and `ci-gate` pass.
3. Confirm image, manifest, and deploy jobs show intentional skip.

Any VPS connection for this scenario is a pipeline defect.

### 18.3 Failed candidate before switch

1. Confirm production remains on the recorded active slots.
2. Download candidate logs and smoke-test evidence from the workflow.
3. Fix forward in a new commit.
4. Do not manually switch the failed slot into service.

### 18.4 Automatic rollback after switch

1. Confirm the workflow restored the prior gateway config and public probes are green.
2. Confirm failed candidate containers are unready and no longer primary.
3. Preserve logs/images until incident review completes.
4. If schema changed, verify the prior application remains compatible; do not run an
   ad hoc down migration.
5. Fix forward with a new release.

### 18.5 Stuck deployment lock

1. Inspect the recorded PID, workflow run, and current deploy phase.
2. Verify no Compose, migration, or gateway reload process is active.
3. Verify gateway config and `state.json` agree.
4. Remove a stale lock only through the recovery command in the deploy tooling.
5. Re-run the same release idempotently before attempting a newer one.

### 18.6 Capacity failure

1. Leave current production untouched.
2. Remove only images outside the retention set through the safe cleanup command.
3. Recheck disk/RAM and current container health.
4. Increase VPS capacity if the preflight threshold still fails.
5. Never bypass the capacity gate by forcing an in-place replacement during normal
   operation.

### 18.7 Gateway recovery

1. Validate the last-known-good generated config stored in deployment state.
2. Restart only the stable gateway container.
3. Probe loopback listeners, then public domains.
4. If the new gateway path is unavailable during initial rollout, restore the saved
   CloudPanel upstream configuration and reload host NGINX.

### 18.8 Migration failure

1. Keep old application slots serving.
2. Capture the failed statement, PostgreSQL error, advisory-lock state, and migration
   journal state.
3. Restore data only when actual data loss/corruption occurred and the reviewed restore
   runbook requires it.
4. Otherwise create a forward corrective migration.
5. Never mark a failed hash applied manually without reconciling the real schema.

## 19. Acceptance Criteria

The migration to the new pipeline is complete only when all of the following are true:

- A docs-only push runs no application test infrastructure, image build, registry push,
  SSH command, migration, or container operation.
- A frontend-only push builds, publishes, and deploys only that frontend.
- A backend-only push leaves unrelated frontend and backend container IDs unchanged.
- Every shared-package fixture selects all and only its recursive production consumers.
- No normal deployment compiles source or installs npm dependencies on the VPS.
- Production images are selected by digest and traceable to Git commit and CI run.
- Stateful service containers are not recreated by application deployments.
- Candidate failures before switch produce no user-visible traffic change.
- Forced failures after switch roll back automatically.
- Continuous cutover tests observe zero deployment-generated `502/503/504` responses.
- SSE reconnects and chatbot/admin WebSocket reconnects recover after drain.
- Dispatcher deployment during an active GPU job creates no lost, duplicated, or
  double-refunded job.
- Migration releases enforce expand-contract and backup freshness.
- Concurrent production runs serialize and stale releases do not overwrite newer ones.
- A retained manual rollback completes within 60 seconds in the rollback drill.
- Release state, gateway configuration, running digests, GitHub deployment status, and
  logs identify the same active release.
- Two full production release cycles and one rollback drill complete before the legacy
  VPS build pipeline is removed.

## 20. Planned Repository Changes

Expected implementation areas include:

- GitHub workflow restructuring and reusable CI/deploy steps;
- affected-target configuration and detector/tests;
- Dockerfile caching, frozen installs, runtime pruning, health, and non-root execution;
- stable/release Compose split and gateway templates;
- checked-in deploy, smoke, rollback, and migration-policy scripts;
- API/chatbot/dispatcher readiness and shutdown behavior;
- customer/admin chatbot WebSocket reconnection;
- CI fixtures and deployment integration tests;
- production deployment and recovery documentation;
- dated `docs/progress.md` entries after every executed phase.

Do not combine every phase into one unreviewable production change. Each phase must be
a meaningful, verified unit and follow the repository's commit policy.

## 21. Fixed Decisions and Defaults

The following decisions are locked for implementation:

- Images build in GitHub Actions, not on the production VPS.
- GHCR stores immutable images.
- Production deployment remains automatic after successful `main` CI.
- Blue/green is per service, not an all-or-nothing duplicate stack.
- CloudPanel remains the TLS/public edge.
- A stable repository-managed NGINX gateway performs release switching.
- Gateway bootstrap uses non-conflicting loopback ports and one atomic CloudPanel
  upstream change.
- Health plus functional smoke tests gate traffic.
- Failed candidates roll back automatically.
- Migrations use expand-contract; destructive cleanup is manual and separate.
- Default post-switch observation is five minutes and stays inside the deployment job.
- Default old HTTP connection drain is ten minutes and runs detached from the deployment
  job (§11.8).
- Deployment targets are resolved through explicit `dir` entries in
  `config/ci-targets.json`; target names are never inferred from directory paths (§4.1).
- Node services receive configuration through the process environment, not a mounted
  dotenv file (§7.6).
- Candidate startup supports `parallel` and `sequential` modes; the default is chosen
  from measured VPS memory headroom in Phase 0 (§11.5).
- The five latest successful releases are retained.
- Capacity failure aborts; it never silently degrades to an in-place outage.
- Unknown change classification falls back to all affected services.
- Docs-only changes retain a successful required CI check but perform no deploy.

## 22. External Prerequisites to Verify During Rollout

These are operational facts to measure, not unresolved architecture choices:

- actual VPS free RAM/disk and per-container peak usage, sufficient to choose the §11.5
  default candidate concurrency mode;
- permission to add the stable gateway and update CloudPanel local upstream ports;
- a pinned VPS SSH host key and dedicated deployment user;
- read-only GHCR authentication from the VPS;
- an off-host PostgreSQL backup with a tested restore path;
- GitHub branch protection and production Environment permissions;
- public smoke-test DNS/Cloudflare reachability from the VPS and GitHub runner.

If a prerequisite is absent, the corresponding rollout phase stops while the current
production pipeline remains available. It does not change the selected architecture.
