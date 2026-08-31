# tryme — forked from aivastra (2026-08-31)

This document records exactly how `tryme` was created from the `aivastra`
monorepo, and how it differs. Read this before assuming anything about this
project's history or config — it deliberately breaks from `aivastra` on every
axis (code, git history, secrets, infra) except the application architecture
itself.

## What this is

`tryme` is a full copy of the `aivastra` monorepo's structure and stack (same
apps: `api`, `dispatcher`, `chatbot`, `catalogues-web`, `admin-web`, `shopify`,
same shared packages, same tooling), rebranded and detached so it can become an
unrelated product. It is **not** a git fork/clone in the GitHub sense — it has
its own commit history from a single initial import, and shares no data,
secrets, or infrastructure with `aivastra`.

## Source

Copied from `C:\Users\prave\OneDrive\Documents\Projects\aivastra` (branch
`main`, commit `1950534d` at copy time) into
`C:\Users\prave\OneDrive\Documents\Projects\tryme` via `robocopy /E`, excluding
`.git`, `node_modules`, `dist`, `.next`, `.turbo`, and `.env`.

## Rebranding

Every occurrence of `aivastra` (and its case variants `Aivastra`, `AiVastra`,
`AIVASTRA`) was replaced with `tryme` / `Tryme` / `TryMe` / `TRYME` across all
text files (810 files changed) via a small Node script — package names,
container names, docs, comments, UI strings, everything. Binary assets (images,
fonts) were left untouched.

Package scope: `@aivastra/*` → `@tryme/*` in every `package.json`
(`@tryme/db`, `@tryme/logger`, `@tryme/storage`, `@tryme/types`,
`@tryme/observability`, `@tryme/api`, `@tryme/dispatcher`, `@tryme/chatbot`,
`@tryme/web`, `@tryme/admin`, `@tryme/shopify-admin`). Root package name is
`tryme`.

A few files with `aivastra` literally in the filename were renamed by hand:

| Old | New |
|---|---|
| `apps/api/postman/aivastra-dev-api.postman_collection.json` | `apps/api/postman/tryme-dev-api.postman_collection.json` |
| `infra/observability/dashboards/aivastra-overview.json` | `infra/observability/dashboards/tryme-overview.json` |
| `wordpress-plugin/aivastra-tryon.php` | `wordpress-plugin/tryme-tryon.php` |
| `wordpress-plugin/local-wp/themes/storefront-aivastra` | `wordpress-plugin/local-wp/themes/storefront-tryme` |

**Not renamed** (out of scope — deeper refactor, not part of "same processes,
same admin/web/api"): the Java/Kotlin package directories
(`apps/saree_catalogue_android/.../java/aivastra/...`,
`apps/virtual_tryon_android/.../java/aivastra/...`). Renaming an Android
package ID touches `AndroidManifest.xml`, `build.gradle` `applicationId`, and
every import statement — flag if these apps are actually needed for `tryme`.

`pnpm-lock.yaml` was deleted and regenerated fresh (`pnpm install`) rather than
text-replaced, so it isn't just a find/replace over hashes.

`.gitleaks-baseline.json` (a secret-scanner allowlist keyed to commit history)
was reset to `[]` — the old baseline referenced `aivastra`'s history, which no
longer exists here.

## Git

- Fresh `git init`, default branch renamed `master` → `main`.
- Remote `origin` = `https://github.com/praveennaidukatraju-hub/tryme.git`
  (added, **not pushed** — the GitHub repo may not exist yet; push manually
  once it does).
- 16 commits, all made in this session, batched by directory rather than one
  giant commit — `lefthook`'s `biome-staged` pre-commit hook expands
  `{staged_files}` onto the command line, and Windows' command-line length
  limit made a single ~1,800-file commit fail with "The command line is too
  long." No commit skips hooks.
- Along the way, `pnpm biome check --write .` fixed formatting drift the
  rebrand's find/replace introduced (renamed strings shifted line lengths past
  biome's print width). Six pre-existing lint **errors** (unrelated to the
  rebrand — unsafe optional chaining in three test files, two SVG assets
  missing a `<title>`/using a deprecated property) were fixed by hand so the
  hook would pass; these were latent issues in `aivastra` too, just never
  triggered because `aivastra`'s history never staged all files at once.

## What is NOT shared with aivastra

| Layer | tryme | aivastra | Shared? |
|---|---|---|---|
| Git history | fresh, 16 commits | its own history | No |
| Git remote | `praveennaidukatraju-hub/tryme` | (separate) | No |
| Docker network | `tryme_tryme-net` | `aivastra_aivastra-net` | No |
| Postgres | `tryme-postgres`, volume `tryme_pgdata`, db `tryme_dev`, port `5433` | `aivastra-postgres`, port `5432` | No |
| Redis | `tryme-redis`, volume `tryme_redisdata`, port `6380` | `aivastra-redis`, port `6379` | No |
| MinIO | `tryme-minio`, volume `tryme_miniodata`, port `9010`/`9011` | `aivastra-minio`, port `9000`/`9001` | No |
| JWT/cookie secrets | freshly generated random values | its own | No |
| Postgres/MinIO credentials | freshly generated random values | its own | No |
| Third-party keys (Google OAuth, Resend, Grafana Cloud, Shopify app, chatbot LLM providers) | left **blank** — fill in with tryme's own accounts | its own real keys | No |
| Deployment target | a different VPS (per your instruction) | its current VPS | No |

Nothing reads or writes across the two projects at any layer.

## Local dev ports

| Service | aivastra | tryme |
|---|---|---|
| api | 4000 | **4001** |
| catalogues-web | 3000 | **3001** |
| dispatcher health | 4100 | **4101** |
| chatbot | 4200 | **4201** |
| admin-web (vite) | 5173 (auto-picks next free) | 5173 (auto-picks next free) |
| shopify (vite) | 5174 (auto-picks next free) | 5174 (auto-picks next free) |
| postgres | 5432 | **5433** |
| redis | 6379 | **6380** |
| minio api/console | 9000/9001 | **9010/9011** |

`admin-web` and `shopify` both use Vite, which auto-increments to the next free
port if its default is taken — so if both projects run at once, whichever
started second will land on 5175/5176 etc. Their proxy config
(`apps/admin-web/vite.config.ts`, `apps/shopify/vite.config.ts`) was repointed
from the hardcoded `127.0.0.1:4000` to `127.0.0.1:4001` so they talk to
**tryme's** api regardless of which port they land on.
`apps/catalogues-web/package.json`'s `dev`/`start` scripts had their hardcoded
`--port 3000` changed to `--port 3001` (the `WEB_PORT` env var isn't actually
read by the Next.js CLI, so this had to be a script edit, not an env change).

## Environment (`tryme/.env`, gitignored)

Built from `aivastra/.env`'s structure, not its values:

- **Freshly generated locally** (not reused from aivastra): `JWT_SECRET`,
  `COOKIE_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
  `ADMIN_BOOTSTRAP_PASSWORD`, `CHATBOT_SERVICE_TOKEN`, `SHOPIFY_TOKEN_ENC_KEY`.
- **Left blank on purpose** (aivastra's values are tied to its own accounts —
  copying them would make tryme dependent on aivastra's infrastructure, the
  opposite of what was asked): `GOOGLE_CLIENT_ID`/`_SECRET`, `RESEND_API_KEY`
  (see exception below), Grafana Cloud vars, chatbot LLM provider keys
  (`CHATBOT_GEN_API_KEY` etc.), `SHOPIFY_API_KEY`/`_SECRET`/`_APP_URL`/etc.
- **Exception**: `RESEND_API_KEY` is required non-empty by
  `apps/api/src/env.ts` (`z.string().min(1)`), so it's set to the literal
  placeholder `dev_placeholder_replace_me` — the api will boot but real emails
  (verification, password reset) will fail until you swap in a real Resend key.
- `ADMIN_BOOTSTRAP_EMAIL` stayed `admin@example.com`; the api auto-created that
  bootstrap admin on first boot against the fresh `tryme_dev` database.
- One env-schema gotcha hit and fixed: `CHATBOT_TOOL_PROVIDER` (and its
  siblings `_MODEL`/`_API_KEY`/`_BASE_URL`) are `z.enum(...).optional()` in
  `apps/chatbot/src/env.ts` — an **empty string** still fails enum validation
  (`.optional()` only tolerates the key being *absent*, not blank). The `.env`
  lines were removed entirely rather than left blank, so the chatbot correctly
  falls back to the generation-model config for tool routing.

## Database

182 Drizzle migrations applied to a brand-new, empty `tryme_dev` database —
no data carried over from `aivastra`.

## Shared-package build step

`apps/api`, `apps/dispatcher`, `apps/chatbot` import `@tryme/db`,
`@tryme/logger`, `@tryme/storage`, `@tryme/observability` as compiled
`dist/` output, not source — same as in `aivastra`. After `pnpm install`,
each package needs `pnpm --filter @tryme/<pkg> build` once before `pnpm dev`
will work (this bit both projects during this session — it's a general
monorepo gotcha, not tryme-specific, worth remembering).

## How to run it

```bash
cd C:\Users\prave\OneDrive\Documents\Projects\tryme
pnpm install                                    # first time only
pnpm --filter @tryme/db build                   # first time only
pnpm --filter @tryme/logger build               # first time only
pnpm --filter @tryme/storage build              # first time only
pnpm --filter @tryme/types build                # first time only
pnpm --filter @tryme/observability build        # first time only
pnpm docker:up                                  # postgres, redis, minio
pnpm db:migrate                                 # first time only / after schema changes
pnpm dev                                         # all services
```

Open:

- Catalogues web (customer-facing): http://localhost:3001
- Admin panel: http://localhost:5173 (or next free port — check terminal output)
- Shopify embedded admin: http://localhost:5174 (or next free port)
- Admin bootstrap login: `admin@example.com` / `ADMIN_BOOTSTRAP_PASSWORD` in `.env`

## Still open / follow-ups

- `origin` remote is set but the GitHub repo `praveennaidukatraju-hub/tryme`
  was not verified to exist and nothing has been pushed.
- Third-party integrations (Google OAuth, Resend, Grafana Cloud, Shopify
  Partner Dashboard app, chatbot LLM provider) all need tryme's own
  credentials before those features work — see the blank vars above.
- Android apps (`saree_catalogue_android`, `virtual_tryon_android`) still use
  the `aivastra` Java/Kotlin package ID — rename if/when those apps are needed.
- `SHOPIFY_TOKEN_ENC_KEY` was generated fresh even though Shopify isn't
  configured yet — rotate it if this project's Shopify integration is
  ever seeded with test data under a different key later.
