# Handover: Kiosk demo catalog data — Tasks 6-9

**For:** antigravity CLI (implementer)
**From:** Claude — Tasks 1-5 of this plan are implemented, reviewed, and committed. This handoff covers the 4 remaining tasks.
**Branch:** `feat/android-kiosk-backend` — already checked out locally at `D:\tryme\webtool`, tracking `origin/feat/android-kiosk-backend`. Implement here, do not create a new branch. Current HEAD: `73d253d1`.
**Plan file:** `docs/superpowers/plans/2026-07-30-kiosk-demo-catalog-data.md` — read Tasks 6, 7, 8, 9 directly from this file (starting at the `### Task 6` heading, roughly line 2224 onward). Each task has a literal TDD script (test code, implementation code, exact commands) with `- [ ] **Step N**` checkboxes — check each one off (`- [x]`) as it lands, matching the style already used for Tasks 1-5 in the same file.

## What's already done (Tasks 1-5)

| Task | What | Commits |
|---|---|---|
| 1 | Demo catalog schema (4 tables), migration, storage keys | `0ab94c78` |
| 2 | Admin CRUD for demo sets/subcategories | `da9c5ec1`, `b573d5eb` |
| 3 | Admin upload + CRUD for demo items | `edbf5ab8`, `b76e9d03` |
| 4 | Demo set → merchant assignments | `b2e24fd2` |
| 5 | Merchant catalog reads surface assigned demo rows (`includeDemo` param) | `de39d2f4`, `8419c135` |

Every task above went through two review passes (spec-compliance, then code-quality) before being marked done, and each found and fixed at least one real gap the first implementation pass missed. Follow that same discipline for Tasks 6-9: implement, test, self-review against the plan's literal requirements, then treat "it compiles and the happy path works" as insufficient — check edge cases (unassigned merchant, inactive rows, wrong-owner attempts) explicitly.

## Remaining scope

### Task 6: Try-on on demo products

**Goal:** Let a merchant run an actual try-on job using a demo item's image as the garment input, but only if the demo set is assigned to them.

**New file:** `apps/api/src/modules/merchant/resolve-tryon-garment.ts` — `resolveTryonGarment(app, merchantId, itemId): Promise<{ r2Key: string; workflowTemplateId: string; isDemo: boolean }>`. This resolver tries the merchant's own `merchantCatalogItems` first, falls back to an assigned+active demo item, and throws `404` if neither matches (or the id belongs to an unassigned demo set) and `403` if the matched demo item exists but is `isActive: false`.

**Modify:**
- `apps/api/src/modules/merchant/tryon.routes.ts` (around lines 116-216 per the plan — **verify actual current line numbers before editing, they will have drifted** like they did in Task 5) — use the resolver instead of a direct `merchantCatalogItems` lookup.
- `apps/api/src/modules/kiosk/jobs.routes.ts` (~150-190) — same resolver, for kiosk-device job creation.
- `apps/api/src/modules/kiosk/catalog.routes.ts` (~41-72) — append demo items to what a kiosk device's catalog read returns (reuse `loadDemoItems` from Task 5's `apps/api/src/modules/merchant/demo-catalog-read.ts`).

**Test:** `apps/api/test/demo-catalog-tryon.test.ts` — the plan has the full test file written out. It uses `createTestTryonCategory` from `apps/api/test/helpers/merchant.ts` (confirmed this helper exists on disk, no adaptation needed there) to seed a real workflow template so the job-creation path is exercised for real, not mocked. Covers: demo item + assigned set → 201 with the demo r2Key and workflow template landing in `job_inputs`, unassigned demo set → 404, inactive demo item → 403, garbage id → 404, and confirms the merchant's own item path still works unchanged (credits still 0, still free — this task must not touch the credit-charging logic at all).

**Watch for:** the kiosk module (`apps/api/src/modules/kiosk/*`) is live and in-scope on this branch. (It was separately and fully deleted on a different branch, `srinivasgunnam-nicedigitals-changes`, as an unrelated cleanup — don't let that confuse you; on `feat/android-kiosk-backend` it's real and this task explicitly extends it.)

### Task 7: Keep demo rows out of the merchant-facing library UIs

**Goal:** The Android app should see demo rows (that's the whole point), but the *web* merchant catalogue-manager UIs should not — those are for a merchant to manage their own products, and a demo row appearing there would look editable when it isn't (Task 5 already guarantees demo items 404 on mutation, but that's a bad UX surprise, not a fix).

**Modify:** every merchant-facing web read of `/v1/merchant/catalog` or `/v1/merchant/catalog/subcategories`, adding `includeDemo=false` explicitly:
- `apps/catalogues-web/src/app/(app)/catalogue-manager/CatalogueManagerContent.tsx` (and any sibling files in that directory reading the same endpoints)
- The equivalent reads under `apps/catalogues-web/src/app/tryon-library-app/` (the installable mini-app has its own duplicated catalog-read logic — check `catalog-app-api.ts` / `catalog-app-helpers.ts` in that directory)

Read the plan's Task 7 section for the exact file/caller list — find every call site by searching for the fetch calls to these two endpoints, not just the two directories named above; the plan calls out that some call sites may not be obvious from the file names alone. Verify the web app builds and typechecks after the change (`pnpm --filter @tryme/web typecheck`, `pnpm --filter @tryme/web build` or equivalent — check `package.json` for the exact filter name, it may be `@tryme/catalogues-web`).

### Task 8: Admin panel — Kiosk Demo Data page

**Goal:** Give admins a UI to do everything Tasks 2-4's API already supports (create/edit demo sets, subcategories, items with image upload, and assign sets to merchants) without needing raw `curl`/Postman.

**New file:** `apps/admin-web/src/pages/DemoCatalogPage.tsx` — the plan has substantial UI code written out (a Vite+React page following this admin panel's existing component patterns).

**Modify:** `apps/admin-web/src/App.tsx` (register the route), `apps/admin-web/src/components/Sidebar.tsx` (nav entry). Verify the admin app builds (`pnpm --filter @tryme/admin build` or check the exact package filter name in `apps/admin-web/package.json`).

Follow the existing admin-web page conventions rather than the plan's literal JSX verbatim if the two disagree — e.g. Task 3's implementer found and correctly used the already-established `deleteDemoObjects`/`serializeStorageError` pattern instead of a plan snippet that predated it. Same principle here: check how the most recently added, most similar admin page (likely something touching upload/CRUD, e.g. `SampleVideoUploadModal.tsx` or the merchants/users pages) actually structures forms, modals, and API calls, and match that rather than introducing a new one-off style.

### Task 9: End-to-end verification

**Goal:** Prove the whole feature works together, not just task-by-task in isolation.

- Bring up the full stack (`pnpm docker:up`, `pnpm dev` or per-service dev commands) and manually walk: admin creates a demo set with a subcategory and an item (real image upload) → assigns it to a test merchant account → confirm it appears via `/v1/merchant/catalog` for that merchant and NOT for an unassigned one → confirm a try-on job can be created against it.
- Run the full API suite (`pnpm --filter @tryme/api test`) and confirm it's fully green — by the end of Task 5 it was 395/395 across 48 files; expect that number to grow with Tasks 6-8's new tests.
- Run `pnpm typecheck` and `pnpm lint` repo-wide.
- Update `docs/progress.md` with a new dated entry at the top (Done / Failed-Not-Done / Open Questions), per this repo's `CLAUDE.md` Progress Tracking convention — every prior task in this plan's implementation also did this.
- Final commit.

## Hard-won gotchas from Tasks 1-5 — read before starting, they will very likely recur

1. **The plan's line-number references drift.** Every task so far had at least one stale line reference (e.g. Task 5's plan said `widget.ts:96,154`, actual was `112-134` and `170-181`). Always grep/read the actual current file before editing against a plan snippet's line numbers — never trust them blindly.

2. **The plan's literal test-helper names are sometimes stale.** Task 3 and 4's plan snippets both called a helper `createAdminToken` that doesn't exist — the real one is `adminAuthHeader(app, role)` from `apps/api/test/helpers/admin.js`, which returns the full `{ authorization: 'Bearer ...' }` header object directly (not a bare token). If a plan snippet references a helper you can't find, check `apps/api/test/helpers/*.ts` for the real name before assuming it needs to be written from scratch.

3. **`apps/api/test/demo-catalog-admin.test.ts` has a shared `/admin/auth/login` rate limit problem** (5 requests/min, and that file now has many `describe` blocks each calling `adminAuthHeader` in their own `beforeAll`). If you touch that file again in Task 6-9 (unlikely, but Task 8's admin UI work might add admin-side API tests elsewhere) and see unexpected `429`s instead of the response you expect, add `await app.redis.del('fastify-rate-limit-POST/admin/auth/login-127.0.0.1');` at the top of your new `beforeAll`, matching the pattern already used elsewhere in that file.

4. **Storage-delete failures should surface, not swallow.** Task 3 established (and Task 2 originated) a pattern: any route that deletes both a DB row and its R2 object(s) should use the `deleteDemoObjects`/`serializeStorageError` helpers in `apps/api/src/modules/admin/demo-catalog.routes.ts` (or write an equivalent for a new module) so a partial storage failure returns `502 STORAGE_DELETE_FAILED` with an audit log, rather than a bare `Promise.allSettled` that silently drops the failure. If Task 8's admin UI needs any new delete endpoint, or if Task 6/7 touch any delete path, follow this pattern.

5. **Biome/lint via `pnpm --filter @tryme/api lint <path>` from the repo root can mis-resolve the path** (doubles the `apps/api` segment). If you hit that, `cd apps/api && npx biome check <relative-path>` works reliably.

6. **`demo-catalog.routes.ts` is ~670 lines across 4 CRUD surfaces** (items, sets, subcategories, assignments) — a code-quality review flagged this as a split candidate, but confirmed no task after Task 4 touches this file again per the plan's own File Structure section, so it was correctly left alone. Task 6's new file (`resolve-tryon-garment.ts`) is separate and doesn't touch this file — don't let file-size concerns bleed into scope you weren't asked to touch.

7. **Docker infra must be running** (`pnpm docker:up` — postgres/redis/minio) before any integration test. It was running throughout Tasks 1-5; if it's down, start it first.

8. **Real MinIO, not mocks.** Every test added in Tasks 1-5 that touches storage does a real presigned PUT + real `headObject`/`putObject` against the test MinIO bucket rather than mocking the storage layer — keep that discipline for any new upload-adjacent tests in Task 6/8.

## Definition of done

- Every `- [ ]` checkbox for Tasks 6-9 in `docs/superpowers/plans/2026-07-30-kiosk-demo-catalog-data.md` checked to `- [x]`.
- `pnpm --filter @tryme/api test`, `pnpm typecheck`, `pnpm lint` all clean.
- Web and admin apps build successfully.
- `docs/progress.md` updated with a dated entry per `CLAUDE.md`'s Progress Tracking section.
- Report back: which commits landed for each task, and call out any place where the live codebase disagreed with the plan's literal snippets and what you did instead (the plan is a strong default, not gospel — when it's wrong, say so and explain the deviation, don't silently follow it or silently ignore it).
