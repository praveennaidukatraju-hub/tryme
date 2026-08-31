# Tryme

AI-powered virtual try-on platform. Upload garment images, pick catalog items (model, pose, background), get AI-generated try-on results — powered by ComfyUI on GPU workers behind Cloudflare Tunnels.

## Architecture

```
User → Next.js (web) → Fastify API → Redis Streams → Dispatcher → ComfyUI Workers
                                                          │
                                              R2/MinIO (assets + outputs)
                                                          │
                                              PostgreSQL 16 (users, credits, catalog, jobs)
```

| Service | Path | Description |
|---------|------|-------------|
| API | `apps/api` | Fastify 5 REST API — auth, credits, catalog, jobs |
| Dispatcher | `apps/dispatcher` | Redis Stream consumer — routes jobs to GPU workers |
| Web | `apps/catalogues-web` | Next.js 15 user-facing frontend |
| Admin | `apps/admin-web` | Vite + React internal admin panel |

| Package | Path | Description |
|---------|------|-------------|
| db | `packages/db` | Drizzle ORM schema + migrations |
| types | `packages/types` | Shared Zod schemas |
| storage | `packages/storage` | R2/MinIO presigned URL provider |
| logger | `packages/logger` | pino wrapper |

## Stack

- **Runtime:** Node 20+, TypeScript 5.6, ESM
- **API:** Fastify 5, Zod type provider
- **DB:** PostgreSQL 16, Drizzle ORM
- **Queue:** Redis 7 Streams
- **Storage:** S3-compatible (Cloudflare R2 / MinIO for dev)
- **Tests:** Vitest with isolated DB + MinIO per test file
- **Monorepo:** pnpm workspaces

## Setup

```bash
cp .env.example .env
pnpm install
pnpm docker:up        # postgres + redis + minio on 127.0.0.1
pnpm db:generate      # generate Drizzle migrations
pnpm db:migrate       # apply to local DB
```

## Commands

| Command | What |
|---------|------|
| `pnpm dev` | Run all services in parallel |
| `pnpm test` | Run all tests |
| `pnpm --filter @tryme/api test` | API tests only |
| `pnpm --filter @tryme/dispatcher test` | Dispatcher tests only |
| `pnpm docker:up` / `docker:down` | Start/stop infra |
| `pnpm docker:reset` | Tear down + delete volumes |
| `pnpm build` | Typecheck + build all |

