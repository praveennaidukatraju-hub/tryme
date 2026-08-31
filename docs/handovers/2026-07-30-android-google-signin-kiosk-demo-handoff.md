# Handover: Android Google sign-in + kiosk demo catalog data

**For:** Codex CLI (implementer)
**From:** Claude — plans already written and committed on `feat/android-kiosk-backend` (commit `13ac6ae3`, "docs: add plans for Android Google sign-in and kiosk demo catalog data"). No implementation code has been written yet; this is a pure handoff.
**Branch:** `feat/android-kiosk-backend` — already checked out locally, tracking `origin/feat/android-kiosk-backend`. Implement here, do not create a new branch.
**Mode:** Both plans declare it themselves — `> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.` Use `superpowers:subagent-driven-development`: dispatch each numbered Task to a subagent following the plan's own TDD steps (write failing test → run it, confirm it fails → implement → run it, confirm it passes → commit). Track progress with the plans' `- [ ]` checkboxes — check each one off as its task lands.

## Scope

Two plans, fully spec'd with TDD steps, exact file paths/line numbers, and literal code to write:

1. `docs/superpowers/plans/2026-07-30-android-google-signin-onboarding.md` — 7 tasks
2. `docs/superpowers/plans/2026-07-30-kiosk-demo-catalog-data.md` — 9 tasks

They are independent — either order, or two subagents in parallel. Doing plan 1 first is a minor nicety only (plan 2's admin merchant picker can then show the `signupSource` badge plan 1 adds) — not a hard dependency, per the "Companion plan" note at the top of each file.

## Plan 1 — Google sign-in + merchant onboarding

**Goal:** Google Sign-In becomes the Android app's signup path: verify a native Google ID token → find/link/create the user via the same ladder the existing web OAuth callback uses → if no `merchants` row exists yet, require an onboarding form that creates one (active on submit).

**New surface:**
- `POST /v1/auth/device-login/google` — verifies the ID token via `jose` against Google's JWKS, upserts the user, returns a normal device session plus a derived `merchantStatus`.
- `GET` / `POST /v1/merchant/onboarding` — creates the `merchants` row.
- `merchants.signup_source` column (`admin` | `android_google`), surfaced on admin `UsersPage.tsx`.
- Android: Credential Manager Google button + new onboarding screen.

**Tasks:** (1) Google ID token verifier — pure unit test, no containers. (2) Extract the shared Google user upsert out of `google.routes.ts` so the web callback and the new device route can't drift apart. (3) `merchantStatus` on the two existing device-login responses. (4) The new Google device-login route itself. (5) Onboarding route + `signup_source` migration (`0133_merchant_signup_source.sql`). (6) Surface `signupSource` in admin. (7) Android client work (Credential Manager wiring, onboarding activity).

**Flagged risk — carry forward, do not silently fix:** merchant try-ons cost 0 credits (`apps/api/src/modules/merchant/create-tryon-job.ts:13`). Self-serve Google signup with active-on-submit onboarding means anyone with a Google account can create a merchant and run unbounded free GPU try-ons. The plan proceeds anyway per a prior product decision, and only adds the `signup_source` breadcrumb so these accounts are findable in admin. The next step — a per-merchant daily try-on cap for admin-untouched accounts — is explicitly out of scope for this plan; don't add it, but flag it back if it's not already tracked somewhere.

## Plan 2 — Kiosk demo catalog data

**Goal:** Admins author demo products in the same shape as merchant products and choose which merchant accounts see them on the Android app; merchants can view but never edit or delete demo rows.

**New surface:**
- Four tables: `demo_catalog_sets` → `demo_catalog_subcategories` → `demo_catalog_items`, plus `demo_catalog_assignments`. Content rows carry **no** `merchantId` — visibility is only ever through an assignment row (one demo object serves every assigned merchant, not N copies).
- Merchant read routes get an `includeDemo` query param, default **true**, appending assigned demo rows tagged `isDemo:true, readOnly:true`. Must be parsed as a string enum, not `z.coerce.boolean()` (which turns `"false"` into `true`).
- Try-on garment resolution extracted into one shared resolver (merchant item, falling back to an assigned demo item), used by both the merchant and kiosk job routes.
- New admin page: Kiosk Demo Data.

**Tasks:** (1) schema, migration (`0134_demo_catalog.sql`), storage keys. (2) Admin CRUD for sets + subcategories. (3) Admin upload + CRUD for items (real presigned PUT in tests, not mocked). (4) Demo set assignments. (5) Merchant read path — assigned demo rows appended. (6) Try-on on demo products via the shared resolver. (7) Keep demo rows out of the merchant-facing library UIs (`catalogue-manager`, `tryon-library-app`). (8) Admin panel Kiosk Demo Data page. (9) End-to-end verification on the Android app.

**Note on the kiosk module:** this plan touches `apps/api/src/modules/kiosk/*` (kiosk catalog/jobs routes) and `apps/api/src/modules/merchant/tryon.routes.ts`. That module is live and in scope on `feat/android-kiosk-backend`. It was separately and fully deleted on a sibling branch (`srinivasgunnam-nicedigitals-changes`, commit `ba64715c`) as an unrelated cleanup — don't port that deletion here.

## Global constraints (both plans, repeated from `CLAUDE.md`)

- ESM only; every relative import inside `apps/api/src` ends `.js`.
- No `console.log` — use `app.log` / `@tryme/logger`.
- Zod request schemas only; response shapes are plain objects.
- Integration tests need `pnpm docker:up` running first. No testcontainers.
- Never run migrations against production. Local/staging → CI/CD → `db:migrate:prod`.
- Every admin mutation logs `adminUserId` + entity id + changed field keys (audit-trail precedent already in `CLAUDE.md`, following the 2026-07-27 incident).
- Do not touch `apps/admin-mobile` (paused per `CLAUDE.md`).
- If `pnpm db:generate` picks a migration index that collides with what's since landed on `origin/main`, the server's index is canonical — renumber your local migration upward, never below (see `CLAUDE.md`'s "Migration Index Conflicts" section).

## Definition of done

- Every `- [ ]` checkbox in both plan files checked off.
- `pnpm --filter @tryme/api test`, `pnpm typecheck`, and `pnpm lint` all clean.
- `docs/progress.md` updated per `CLAUDE.md`'s Progress Tracking section — dated entry at the top with Done / Failed-Not-Done / Open Questions.
- Report back per task: which commits landed, and anything that deviated from the plan's literal code and why (the plan's schema/route snippets are a strong default, not gospel — if the live schema or an existing helper's signature disagrees with what the plan assumed, the live code wins and the deviation should be called out).
