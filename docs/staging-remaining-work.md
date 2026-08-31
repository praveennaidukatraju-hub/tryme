# Staging — Remaining Work

Staging is live and functional (real synced data, working images, Google auth, Grafana observability, Shopify integration, correct nginx/SSL) as of 2026-08-07. What's left, to fix later.

## 1. Unfilled env vars in `.env.staging`

Still `change_me` on the VPS — features below silently no-op or fail closed until set, nothing is broken by leaving them:

| Var | Feature gated | Behavior while unset |
|---|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Credit top-up payments | Payment endpoints fail; must be `rzp_test_*` — guardrail rejects a live key |
| `RESEND_API_KEY` | Transactional email (verify, reset password) | Email sending fails |
| `OPENAI_API_KEY` | Chatbot embeddings (`CHATBOT_EMBED_MODEL`) | RAG ingestion fails |
| `ANTHROPIC_API_KEY`, `CHATBOT_GEN_API_KEY`, `CHATBOT_TOOL_API_KEY` | Chatbot generation/tool-calling (Claude) | Chatbot replies fail |
| `GOOGLE_API_KEY` | Chatbot (if routed through Google models) | Only matters if `CHATBOT_GEN_PROVIDER`/`CHATBOT_TOOL_PROVIDER` ever point at Google |
| `CHATBOT_SERVICE_TOKEN` | api ↔ chatbot internal auth | `/ingest`/`/health` calls between api and chatbot fail |

Fill via the same pattern used so far: generate/obtain the value, edit `.env.staging` on the VPS, `--force-recreate` the affected service(s) (`api`, `chatbot`, or both depending on the var).

## 2. Deferred security follow-ups (flagged in the final branch review, never filed as tracked tickets)

- **Sync script uses full-privilege prod credentials.** `scripts/staging/sync-from-prod.sh` reads prod's Postgres/MinIO root credentials from `.env.production` to dump/mirror. Should be scoped to a read-only service account instead.
- **Staging deploys reuse prod's SSH key.** `VPS_SSH_KEY`/`VPS_USER`/`VPS_HOST` GitHub secrets are shared between the `main`→prod and `dev`→staging deploy jobs — push access to `dev` is currently equivalent to shell access to the production host as the deploy user. Should provision a separate, less-privileged key/user for staging.

## 3. SEC-H3 — object storage bucket is world-readable (real, pre-existing, not staging-specific)

Corrected in `docs/audits/open-findings.md` this session: prod's live MinIO bucket is still world-readable today (`mc anonymous set download`), grandfathered from before a later fix removed the line from the compose file — removing the line only stops a *new* bucket from getting the policy, it doesn't revoke an existing one. A real fix means either migrating the remaining `publicUrl()` call sites (models, catalog thumbnails, merchant logos — full list in the doc) to presigned URLs, or a deliberate, documented decision to keep those specific non-sensitive prefixes public and scope the bucket policy accordingly instead of bucket-wide.

## 4. Theme extension lint (found during `make shopify-deploy-staging`, pre-existing in prod too)

`apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid` — theme check found on deploy, didn't block release:
- 3× missing `width`/`height` on `<img>` tags (lines ~80, ~103, ~165)
- 1× hardcoded `/cart` href instead of `{{ routes.cart_url }}` (line ~190)

## Explicitly not in scope / already decided

- Staging GPU worker — deferred by design, jobs enqueue and stay `QUEUED` (see runbook §7).
- PixVerse catalog-video — deliberately fails closed (`PIXVERSE_API_KEY` empty), not a gap.
- Admin mobile — paused project-wide, not staging-specific.
