# Ai Vastra — Codebase Architecture Report

This report provides a comprehensive architectural overview of the Ai Vastra monorepo, verifying a complete mental model of the system's design, flows, and potential risks without relying on generic assumptions. 

All conclusions are backed by evidence from the codebase audit.

---

### 1. Overall System Architecture
Ai Vastra is a B2B2C SaaS platform built as a **pnpm workspaces monorepo**. The stack relies on **Node 20+, TypeScript 5.6, and ESM**. 
* **Backend:** Fastify 5 REST API + SSE, strictly typed with Zod (`fastify-type-provider-zod`).
* **Frontend:** Next.js 15 (App Router) for the merchant portal and widget. Custom Vanilla CSS for extreme aesthetic control.
* **Database:** PostgreSQL 16 managed via Drizzle ORM.
* **Queue & PubSub:** Redis 7 Streams (`jobs:priority`, `jobs:normal`) for queueing, and Redis PubSub for real-time SSE events.
* **Storage:** Cloudflare R2 (S3-compatible) for image assets, stubbed with MinIO in development.
* **Workers:** A standalone dispatcher service orchestrates GPU worker nodes running ComfyUI.

### 2. Folder and Package Responsibilities
* `apps/api`: Central backend HTTP server. Handles REST routes, BFF proxy targets, DB transactions, authentication, and SSE streams. (e.g., `apps/api/src/server.ts`).
* `apps/dispatcher`: Background worker process. Consumes Redis streams, manages ComfyUI GPU orchestration, and updates job statuses (per `AGENTS.md` and scaffolding).
* `apps/catalogues-web`: The Next.js frontend application serving the merchant dashboard (`/studio`, `/pricing`), public marketing, and the embeddable iframe widget (`/widget`).
* `packages/db`: Drizzle ORM schema definitions, relations, and migrations (`packages/db/src/schema/`).
* `packages/types`: Shared Zod schemas enforcing strict boundaries between frontend, backend, and DB (`packages/types/src/`).
* `packages/storage`: S3 client wrappers for presigned URLs and bucket management (`packages/storage/src/`).
* `packages/logger`: Pino-based structured JSON logging (`packages/logger/src/`).
* `packages/observability`: Sentry + OpenTelemetry scaffolding.

### 3. Application Startup Flow
* **API:** Starts in `apps/api/src/server.ts`. Instantiates Fastify. Registers core plugins (CORS, sensible, Zod validator). Establishes connections to Postgres (Drizzle), Redis (`ioredis`), and S3. Registers modules (`auth`, `admin`, `merchant`, `widget`, `jobs`). Listens on port `4000` (binding to `127.0.0.1` by default).
* **Web:** Standard Next.js boot. Middleware (`apps/catalogues-web/src/middleware.ts`) intercepts requests to validate JWTs in cookies before rendering protected routes.

### 4. Authentication and Authorization Flow
* **End Users/Consumers:** `users` table. Authenticate via Google OAuth or Email/Password (`apps/api/src/modules/auth`). Next.js routes use a BFF pattern (`apps/catalogues-web/src/app/api/auth/...`) to securely set `access_token` and `refresh` HTTP-only cookies.
* **Merchants:** `merchants` table. B2B login via `/v1/merchant/login` setting a `merchant_access_token` cookie. Next.js middleware guards `/merchant/*` routes checking this specific token.
* **Widget Authorization:** Widgets use public API keys (`api_keys` table) verified via headers/query params. Cross-Origin validation enforces domain restrictions (`apps/api/src/modules/widget/widget.routes.ts`).
* **RBAC:** Admin endpoints use a `requireAdmin` hook checking the `admin_users` table. 

### 5. Complete Request Lifecycle (Frontend to Backend)
*Example: Generating a Try-On in the Widget*
1. **Frontend:** User uploads image in Widget (`apps/catalogues-web/src/app/(widget)/widget/render/[key]/page.tsx`).
2. **Storage:** Widget requests a presigned URL from API, then PUTs the file directly to R2.
3. **API Request:** Widget calls `POST /api/widget/jobs` (BFF) -> proxied to Fastify `POST /v1/widget/jobs`.
4. **Validation:** Fastify validates API key and Zod payload.
5. **Transaction:** `WidgetService.createJob()` opens a Postgres transaction: validates catalog item -> deducts 1 credit from `merchant_credits` -> inserts new `jobs` row -> commits transaction.
6. **Queueing:** API pushes job payload to Redis Stream (`jobs:normal`) via `XADD`.
7. **Response:** Returns Job ID to Widget.
8. **Subscription:** Widget hooks into SSE (`/v1/widget/jobs/:id/events`) using `useJobStream` to await completion.

### 6. Database Architecture and Major Entities
Mapped via `packages/db/src/schema/`:
* `users` / `merchants` / `admin_users`: Segmented authentication domains.
* `api_keys`: Links widget instances to merchants.
* `merchant_credits`: Tracks B2B billing balances.
* `jobs`: Tracks asynchronous generation tasks (ID, status, input R2 key, result R2 key).
* `catalog_types` / `catalog_items`: Taxonomies and specific garments/assets configured by merchants.

### 7. Shared Package Dependency Graph
* `apps/api` depends on `@tryme/db`, `@tryme/types`, `@tryme/storage`, `@tryme/logger`, `@tryme/observability`.
* `apps/catalogues-web` depends on `@tryme/types`, `@tryme/logger`.
* `apps/dispatcher` depends on `@tryme/db`, `@tryme/types`, `@tryme/storage`, `@tryme/logger`.
* `@tryme/db`, `@tryme/types` are foundational and depend on no internal packages.

### 8. State Management Strategy
* **Backend:** Fully stateless HTTP nodes. State lives strictly in Postgres (persistence) and Redis (ephemeral/queue).
* **Frontend:** 
  * `React Query` (`@tanstack/react-query`) handles server state, caching, and mutation (configured in `apps/catalogues-web/src/components/providers.tsx`).
  * `useState` / `useReducer` handles local component UI state (e.g., upload wizard steps).
  * Context API manages global ephemeral connections (e.g., `JobStreamProvider` for SSE).

### 9. API Architecture and Route Organization
* Framework: Fastify 5 + `fastify-type-provider-zod`.
* Organization: Domain-driven modules (`apps/api/src/modules/`). Each domain folder contains `.routes.ts`, `.schemas.ts`, and `.service.ts`.
* Route registration happens explicitly in `server.ts`. 
* Strict Zod parsing ensures the runtime matches the type definitions exactly.

### 10. Background Workers and Job Processing Flow
1. **Enqueue:** API performs an `XADD` to a Redis stream.
2. **Dequeue:** `apps/dispatcher` runs a worker loop reading from the stream via Consumer Groups (`XREADGROUP`).
3. **Execution:** Dispatcher translates the job into a ComfyUI payload and dispatches it to the GPU node.
4. **Completion:** Dispatcher receives the result, uploads to R2, updates `jobs` status in Postgres, and publishes a `PUBLISH` message to Redis.
*(Reference: `AGENTS.md` invariants and scaffolding).*

### 11. Real-time Communication Flow (SSE)
* **API:** Provides `GET /v1/jobs/stream`. Uses Fastify's raw node response to hold the connection open and stream `text/event-stream`.
* **Redis PubSub:** API nodes subscribe to Redis PubSub. When a job completes, the dispatcher publishes a message. The API node receives it and writes it to the specific SSE client matching the Job ID or User ID (`apps/api/src/modules/jobs/sse.ts`).
* **Frontend:** Uses a custom `createSSEConnection` (`apps/catalogues-web/src/lib/sse.ts`) wrapping `fetch` and `ReadableStream` to allow passing `Authorization` headers (which native `EventSource` lacks).

### 12. Image Generation Pipeline
1. Client acquires presigned URL and PUTs source image to R2.
2. API creates `job` row in Postgres and enqueues to Redis.
3. Dispatcher pulls job, resolves R2 keys to temporary read URLs.
4. Dispatcher commands ComfyUI via REST/WebSocket.
5. ComfyUI computes result and uploads back to R2.
6. Dispatcher updates Postgres and emits PubSub event.
7. API forwards event via SSE to Frontend.
8. Frontend renders result using the new R2 key.

### 13. ComfyUI Integration
As strictly defined in `AGENTS.md`: "dispatcher is the only process that talks to GPU workers. API never talks to ComfyUI." The API is decoupled from AI specifics, treating it as a black-box queue payload.

### 14. File Upload and Storage Flow
Follows the **Direct-to-S3** pattern to avoid buffering large images in the Node API:
1. Client calls `POST /v1/assets/presign` (or similar).
2. API uses `@tryme/storage` to issue an S3 `PutObjectCommand` presigned URL.
3. Client uses `XMLHttpRequest` (`apps/catalogues-web/src/lib/api.ts -> uploadToR2WithProgress`) to PUT the file directly to Cloudflare R2, tracking upload percentage.
4. Client sends the generated `key` back to the API for database linkage.

### 15. Billing/Credits Workflow
* `merchant_credits` table stores balance.
* **Invariant:** "Credit deduct + job insert must stay in one transaction. Refund on failure too." (`AGENTS.md`).
* When a job is requested, a Postgres transaction executes an `UPDATE merchant_credits SET balance = balance - 1 WHERE id = X AND balance > 0`. If this fails, the job is rejected.

### 16. Admin Application Architecture
* Managed via `apps/api/src/modules/admin/`.
* Protected by JWT + Database lookup: "All `/admin/*` routes check `admin_users` row after JWT verify" (`AGENTS.md`).
* Used for platform-wide metrics, merchant onboarding overrides, and API key management.

### 17. Web Application Architecture
* Standard Next.js 15 App Router (`apps/catalogues-web/src/app`).
* Extensive use of BFF API Routes (`apps/catalogues-web/src/app/api/...`) to securely proxy requests to the Fastify backend without exposing internal URLs or mishandling tokens.
* Heavy use of layouts (`layout.tsx`) for sidebars/topbars and `error.tsx` / `global-error.tsx` for React error boundaries.

### 18. Shared UI/Component Architecture
* Pure Vanilla CSS (`globals.css`) + CSS Variables (`tokens.ts`) for extreme aesthetic fidelity without Tailwind clutter.
* Bespoke React components (`apps/catalogues-web/src/components/ui/`) featuring micro-animations (e.g., `.av-spin`, `.av-shimmer`, gradient hovers).
* Custom SVG paths (`icons.tsx`) instead of heavy icon libraries.

### 19. Current Technical Debt
* **Test Architecture:** Relies on a globally running `docker-compose` stack (`infra/docker-compose.yml`) instead of isolated testcontainers. MinIO collisions occur if tests don't use random bucket names (`apps/api/test/helpers/containers.ts`).
* **Dispatcher Mocking:** The dispatcher and ComfyUI integration are largely scaffolded/spec'd but not fully fleshed out in the provided files.
* **Auth Race Conditions:** A `tryRefresh()` lock exists in frontend `api.ts` alongside a `BroadcastChannel` to sync tokens across tabs, but rapid parallel 401s in Edge scenarios can still cause forced logouts.
* **BFF Redundancy:** Proxying every request through Next.js API routes adds a network hop and serialization overhead.

### 20. Top 20 Architectural Risks
1. **Flaky Integration Tests:** Lack of testcontainers means tests fail if developer forgets `pnpm docker:up`. Tests cannot run in parallel safely due to shared DB state collisions.
2. **Redis Single Point of Failure:** Redis handles both Job Queues (Streams) and SSE PubSub. A Redis crash halts all background processing and real-time updates.
3. **Queue Backpressure:** Unbounded Redis Stream growth if GPU workers stall; requires strict `XACK` and `XDEL` lifecycle management.
4. **Credit Race Conditions:** High concurrency could result in credit overdrafts if Postgres transactions don't use strict `FOR UPDATE` locks during the deduction step.
5. **Orphaned Jobs/Refunds:** Network failure between Dispatcher and ComfyUI could leave jobs permanently in `PROCESSING`, robbing merchants of credits without refunds.
6. **R2 Eventual Consistency:** Dispatcher marks job complete and frontend requests image before R2 edge nodes have fully propagated it, causing 404s.
7. **S3 Presigned URL Abuse:** Malicious actors could harvest presigned URLs and upload massive files, incurring massive R2 costs if `content-length-range` policies aren't strictly enforced.
8. **BFF Proxy Bottlenecks:** Vercel serverless limits on Next.js API routes could bottleneck high-throughput widget traffic.
9. **Origin Spoofing:** Widget CORS/Origin validation can be bypassed outside browsers (e.g., curl scripts draining API keys).
10. **Third-Party Cookie Blocking:** Modern browsers block 3rd-party cookies; if the widget requires authenticated sessions via iframe cookies instead of strict API keys, it will break in Safari/Chrome Incognito.
11. **Monorepo Boundary Leaks:** Without strict ESLint boundaries, Next.js might accidentally import `packages/db` server-side code into client bundles.
12. **SSE Connection Limits:** Fastify nodes holding thousands of open SSE connections could hit OS file descriptor limits (`ulimit`).
13. **GPU Worker Autoscaling:** Without an orchestration layer (like Kubernetes/KEDA), queue times will spike during traffic bursts.
14. **Silent Next.js Rendering Errors:** `error.tsx` catches exceptions but might swallow them if Sentry integration (`instrumentation.ts`) fails to initialize properly on Edge runtimes.
15. **Unbounded Database Growth:** Job logs and SSE event histories need a TTL or archiving strategy to prevent Postgres bloat.
16. **Missing Rate Limiting:** No explicit Redis-based rate limiting on `/v1/widget/jobs` means a distributed attack could drain a merchant's credits instantly.
17. **ComfyUI Arbitrary Execution:** If user inputs aren't sanitized, malicious payload injections to ComfyUI could crash the worker nodes.
18. **Next.js Middleware Cold Starts:** Heavy regex or token parsing in `middleware.ts` will slow down every request due to Edge cold starts.
19. **Hardcoded Ports:** Fastify binds to `4000`. Port collisions on dev machines will break local workflows.
20. **BroadcastChannel Limitations:** Multi-tab token sync fails across different subdomains or browsers that don't fully support the API, leading to out-of-sync sessions.
