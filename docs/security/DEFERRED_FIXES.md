# DEFERRED_FIXES.md

Security findings from `VULNERABILITY_REPORT.md` that are **not** fixed yet
because they need infra/ops action (not application-code changes). Tracked here
so they aren't lost. The 10 code-fixable findings are done — see
`REMEDIATION_LOG.md`.

Status as of 2026-06-18: **3 open** (M3, L2, L3).

---

## M3 — User images exposed via public bucket path  *(MEDIUM, UNCERTAIN)*

**Where:** `apps/api/src/modules/results/routes.ts` (and the admin results
monitor HTML) build image URLs with unsigned `app.storage.publicUrl(key)` over
prod `R2_PUBLIC_URL` (`https://app.tryme.com/minio/virtual-tryon-prod`).

**Risk:** if that path is world-readable, the only thing protecting a user's
garment/output image is the UUID in the key. Combined with key leakage (logs,
Referer) → unauthenticated read.

**Why deferred:** UNCERTAIN — nobody has confirmed the live MinIO/R2 ACL or the
`/minio/...` reverse-proxy rules actually allow anonymous read. And the fix is a
behavior change (signed URLs expire ~1h) that must land together with the infra
change.

**To fix (both halves, same PR):**
1. Confirm the live bucket/proxy ACL (is the public path actually anon-readable?).
2. Infra: make the bucket/proxy path private.
3. Code: swap `publicUrl()` → `presignGet()` in the results data route + admin
   monitor; ensure the monitor re-fetches before URLs expire.

**Codeable half:** yes (step 3 is localized). Blocked on steps 1–2.

---

## L2 — Plaintext secrets in working tree  *(LOW)*

**Where:** repo root — `.env`, `.env.production`, `client_secret_*.json`.

**Status:** verified **gitignored** and **absent from `git log --all`** — not in
history. But a live Google OAuth client secret sits in plaintext on disk.

**Why deferred:** no code change possible — pure ops.

**To fix (ops):**
1. Move secrets to a secret manager / out-of-tree path; inject at deploy.
2. **Rotate the Google client secret** if the dev machine or any backup was ever
   shared.

**Codeable:** no.

---

## L3 — API listens on `0.0.0.0`  *(LOW, expected)*

**Where:** `apps/api/src/main.ts:9` — `app.listen({ host: '0.0.0.0' })`.

**Status:** expected/correct behind the reverse proxy / Cloudflare tunnel
(containers need `0.0.0.0`). Not a defect on its own. Postgres/Redis already
bind `127.0.0.1`.

**Why deferred:** ops verification, not a bug.

**To fix (ops):**
1. Confirm the host firewall does not expose `:4000` directly to the internet.

**Optional code (low value):** add an `API_HOST` env (default `0.0.0.0`) so a
deployment could bind loopback-only. No-op by default — only worth it if a
specific deploy needs it.

**Codeable:** optional env knob only; no functional fix needed.
