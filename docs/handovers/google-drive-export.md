# Handover: Google Drive export for Studio results

**For:** antigravity CLI (implementer)
**From:** Claude review — architecture spec + implementation plan for a "Save to Drive" export on Studio results, produced after a multi-round design review (shared-OAuth-client tradeoff, `drive.file` scope verification, crypto reuse, GDPR-erasure hook). Demand for the feature has been confirmed by the user — cleared to implement, not speculative.
**Scope:** new `apps/api/src/modules/google-drive/` module (connect/callback/status/disconnect/export routes), one new table, one new env var, one Studio UI button. No other module changes beyond two small, precisely-located hooks (route registration, account-erasure).

---

## 1. Start here

Read in this order before writing anything:

1. `docs/superpowers/specs/2026-08-21-google-drive-export-design.md` — the *why*: shared-OAuth-client decision and its revocation caveat, why a separate module rather than extending login, why no new encryption code, why no batch export yet.
2. `docs/superpowers/plans/2026-08-21-google-drive-export.md` — the *how*: 8 tasks, each with exact file paths, find/replace blocks for existing files, and full content for new files. Execute it task-by-task with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

This handover doesn't repeat either doc's content — it's the checklist for what to confirm before you start and before you hand back.

## 2. What must NOT change

- `apps/api/src/modules/auth/google.routes.ts` — the login flow. Untouched by every task in the plan; if a diff touches this file, stop and re-read the design doc's "Why a separate module" section.
- No second Google OAuth client. Reuse `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — only a new redirect URI is registered in the Google Cloud Console (external, see §3).
- No new dependency. No `googleapis` or `google-auth-library` in any `package.json` — every Drive/Google call is plain `fetch`, matching how this codebase already does Shopify and Google OAuth. If a diff adds one of these packages, that's a deviation from the plan, not an improvement — revert it.
- No batch export, no proactive/background token refresh, no per-store/merchant Drive connections. Single-image, user-initiated export only — explicitly out of scope in the design doc's Non-goals.
- The comment required at the disconnect call site (`token.ts`'s `disconnect()` in the plan) explaining the shared-grant revocation caveat is not optional boilerplate — keep it. It's there so a future engineer doesn't "fix" this into a second OAuth client without understanding why one wasn't used.

## 3. Blocking external prerequisite

Task 8 in the plan (do this before Task 7's manual verification, not after):

- Add `https://<api-host>/v1/integrations/google-drive/callback` (prod and staging) as an authorized redirect URI on the **existing** OAuth client in Google Cloud Console.
- Confirm `drive.file` is added to the OAuth consent screen's scope list, and the app is in "Production" publishing status (or Drive export only works for allow-listed test users while in "Testing"). This only needs Google's basic verification tier — no CASA/restricted-scope review.
- Provision `GOOGLE_DRIVE_TOKEN_ENC_KEY` in each environment (`openssl rand -base64 32`), same as `SHOPIFY_TOKEN_ENC_KEY` was.

None of this is code — flag to the user if you don't have Google Cloud Console access to do it yourself, rather than stubbing around it.

## 4. Known gaps in the plan — resolve by reading the live file, not by guessing

The plan's self-review flags two spots where it deliberately left a placeholder rather than fabricate exact values:

- Task 7 Step 3: the new Drive button's pixel offset next to the existing per-tile download icon in `generation-panel.tsx` — read the file's current state at implementation time and position it so the two icons don't overlap.
- Task 7 Step 6: where a "disconnect Drive" control belongs in Settings — the plan points at `apps/catalogues-web/src/app/(app)/settings/page.tsx` as the likely home but hasn't designed that UI; use whatever section pattern that page already establishes for account-level toggles.

## 5. Verification before handing back

- `pnpm --filter @tryme/db exec tsc --noEmit -p .`, `pnpm --filter @tryme/types exec tsc --noEmit -p .`, `pnpm --filter @tryme/api run typecheck`, `pnpm --filter @tryme/web run typecheck`, `pnpm --filter @tryme/web run lint` — all clean.
- New integration test file (`apps/api/test/integration/google-drive.test.ts`) passes, run per the plan's temporary-vitest-config-edit steps (Task 6) — and confirm the config edit was reverted afterward (`git diff --stat vitest.config.ts` clean).
- Manual walkthrough per plan Task 7 Step 6: connect → export → confirm the file lands in an "AI Vastra" folder in a real test Google account → disconnect → confirm export then 409s → reconnect → confirm it works again.
- Confirm no diff touches `auth/google.routes.ts`, and no `googleapis`/`google-auth-library` entry appears in any `package.json` or lockfile.
