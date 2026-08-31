# Handover: Merchant Catalog Saree Two-Input (Body & Pallu)

**For:** antigravity CLI (implementer)
**From:** Claude — architect/reviewer only on this initiative. Nothing in this plan is
implemented yet; this handoff covers all 4 tasks from scratch.
**Branch:** `feat/merchant-catalog-saree-two-input` — already checked out locally at
`D:\tryme\webtool`, tracking `origin/dev` (no matching remote branch yet — this is a new
branch, push with `-u` on first push). **Branched off latest `origin/dev` (`e5b00dca`), not
off the admin-identity-authz-audit branch** — this work has no dependency on that branch's
permission system, so it belongs on its own branch per this repo's normal branch policy
(`docs/version-control.md`: feature branches branch off `dev`, PR back into `dev`).

**Before Task 1 — commit the pending uncommitted diff first, as its own commit:**
`apps/catalogues-web/src/app/(app)/studio/page.tsx` has an uncommitted change already sitting
in the working tree (from an earlier, separate session) — it removes the "Full Saree" /
"Body & Pallu" dropdown from Studio's saree upload step and defaults `sareeUploadMode` to
`'two_input'` unconditionally, since Full Saree was being retired as an option. It's
unrelated to this plan's own scope but was carried onto this branch because it's the same
general feature area (saree upload UX) and was sitting uncommitted when this branch was cut.
It has already been through `biome check` and `tsc` clean in the session that wrote it.
Commit it as:
```
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "fix(catalogues-web): remove Full Saree upload option from Studio, default to Body & Pallu"
```
Then start Task 1 on a clean tree.

**Plan file:** `docs/superpowers/plans/2026-08-20-merchant-catalog-saree-two-input.md` — read
Tasks 1-4 directly from this file. Each has a literal TDD script (test code, implementation
code, exact commands) with `- [ ] **Step N**` checkboxes — check each one off (`- [x]`) as it
lands.

## Scope (all 4 tasks pending)

| Task | What | Depends on |
|---|---|---|
| 1 | Expose `supportsTwoInputMannequin` on `GET /v1/merchant/catalog/subcategories` responses (computed from `garment_subcategories.requires_mannequin_step` + `mannequin_two_input_workflow_template_id`) | Nothing new |
| 2 | Teach `createMerchantCatalogJob` (`apps/api/src/modules/merchant/create-job.ts`) to build a two-phase job pair (standalone mannequin job + a `PENDING_MANNEQUIN` step-2 job pointing at it via `params.mannequinJobId`) when `secondFlatImageKey` is supplied, instead of the existing single-image inline mannequin path | Task 1 for the capability flag to make sense end-to-end, but is independently testable via the API directly |
| 3 | One-line wiring: forward `secondFlatImageKey` from the `/v1/merchant/catalog/generate` route handler into the now-extended `createMerchantCatalogJob` call (it's already accepted by the request schema and already forwarded to the *other* branch, `createMerchantSareeMannequinJob` — just never to this one) | Task 2 |
| 4 | `ProductModal.tsx` — add a second "Pallu" upload box in Flat Image mode, gated on Task 1's `supportsTwoInputMannequin`, wired to send `secondFlatImageKey` | Tasks 1-3 |

**The key architectural point, worth internalizing before touching code:** Task 2 does
**not** add dispatcher code. The dispatcher already has a fully generic sweep
(`apps/dispatcher/src/job/saree-step2-promoter.ts`, `promoteSareeStep2Jobs`, already running
on a 5s interval) that promotes any `PENDING_MANNEQUIN` job to `QUEUED` once its
`params.mannequinJobId` job completes — it does not check `jobs.source` anywhere. Studio's
own two-input saree flow (`apps/api/src/modules/jobs/createSareeMannequin.ts`) already
produces exactly this two-row shape and this sweep already promotes it correctly in
production (verified: 88% success rate on Studio's two-input jobs, no distinct failure mode).
Task 2 is "make `createMerchantCatalogJob` produce the same shape Studio's function already
produces," not "invent a new completion mechanism."

**Explicitly out of scope — do not implement, even if it looks like a natural extension:**
- A `sareeStyleId` picker in `ProductModal.tsx`. No existing UI for it in this modal or in
  Studio's own two-input flow; the garment type's default two-input workflow is used
  unconditionally whenever both images are present.
- Bulk "Add Product" two-input support (`/v1/merchant/catalog/generate-bulk`,
  `BulkUploadModal.tsx`). Bulk generate is one-flat-image-per-row by construction; pairing N
  body images with N pallu images is a different UI problem, not part of this plan.
- Touching `createMerchantSareeMannequinJob` or the `mannequinOnly` request branch at all.
  That is a separate, already-shipped, heavily-used-in-production feature (99 production
  jobs as of 2026-08-20, real merchants, session-authed) serving a different product surface
  (confirmed to be a terminal, full-credit-cost job with no step 2 — not what "Add Product"
  needs). Do not repurpose it, do not "clean it up," do not merge it with this plan's new
  code path.
- Touching `runMannequinPhase` (`apps/dispatcher/src/job/mannequin-phase.ts`) — the shared
  inline single-image mannequin path every *other* merchant catalog job (non-saree, or saree
  without a second image) still uses. This plan adds a parallel path for the two-input case
  specifically to avoid touching code shared by every merchant catalog job in existence.

## Gotchas worth knowing before you start

1. **Two visually-similar-sounding job "kinds" exist — do not confuse them.**
   `JOB_SOURCE.SAREE_MANNEQUIN` (`'saree_mannequin'`) is the internal, 0-credit, "step 1 of
   2" helper this plan's Task 2 creates. `JOB_SOURCE.MERCHANT_CATALOG_SAREE_MANNEQUIN`
   (`'merchant_catalog_saree_mannequin'`) is the pre-existing, full-credit, terminal job type
   behind `mannequinOnly: true` — a completely different thing this plan does not touch. Both
   share `job_inputs.params.kind === 'saree_mannequin'` as their dispatcher-routing
   discriminator (`apps/dispatcher/src/job/processor.ts` routes on `params.kind`, not
   `jobs.source` — verified), which is exactly why Task 2's new mannequin job doesn't need any
   dispatcher change: it's dispatched by the same routing condition Studio's mannequin jobs
   already use.
2. **`keys.output(jobId)` vs `keys.mannequinIntermediate(jobId)` — do not mix these up.**
   `runMannequinPhase` (the *inline*, single-image path, untouched by this plan) writes its
   intermediate result to `keys.mannequinIntermediate(jobId)`. The *standalone* mannequin job
   processor (`processSareeMannequinJob`, what Task 2's new job type uses) writes via the
   shared `finalizeOutput` helper to `keys.output(jobId)` — and the promoter
   (`saree-step2-promoter.ts`) reads `keys.output(mannequinJobId)` when it promotes a step-2
   job. This was verified end-to-end while writing the plan (traced `finalizeOutput`'s actual
   `PutObjectCommand` call), not assumed — Task 2's new job must go through the standalone
   processor path (which it does automatically, by having no `backgroundId`/`poseId` and
   `params.kind === 'saree_mannequin'`), not the inline one.
3. **Credits are still deducted at job-creation time, not at mannequin-completion time.** The
   step-2 job's `atomicDeduct` call happens in the same transaction as its own insert, exactly
   like the existing single-input path — this must not change. A merchant should not be able
   to get a free mannequin-step render and abandon the flow before paying for step 2.
4. **The plan's Task 2 flags one genuine implementation-time unknown**, called out explicitly
   in the plan file itself (search for "requiring verification at implementation time"): the
   third integration test imports `promoteSareeStep2Jobs` directly from
   `apps/dispatcher/src/job/saree-step2-promoter.ts` into an `apps/api` test file — these are
   separate workspace packages and this cross-package import may not resolve cleanly. The plan
   describes the fallback (skip that one test, or add dispatcher-side coverage instead) — read
   that note before attempting the third test in Task 2, don't just fight the import error
   blindly.
5. **Plan line-number references drift** (recurring issue on this repo's other handoffs too)
   — always grep/read the actual current file before editing against a snippet's line
   reference; the plan's line numbers were accurate as of `e5b00dca` but may have moved,
   especially since Task 2's edits are large and reshape the tail of
   `createMerchantCatalogJob`.
6. **Docker infra must be running** (`pnpm docker:up` — postgres/redis/minio) before any
   integration test.
7. **No admin-web-style unit test harness exists for `apps/catalogues-web` pages** — Task 4's
   verification step is a manual browser walk (`pnpm --filter @tryme/web dev`), not an
   automated test. Don't invent a testing harness to cover this.

## Definition of done

- Every `- [ ]` checkbox for Tasks 1-4 in
  `docs/superpowers/plans/2026-08-20-merchant-catalog-saree-two-input.md` checked to `- [x]`.
- `pnpm --filter @tryme/api test:integration` green — the new/modified tests in
  `merchant-catalog-subcategories.test.ts` and `merchant-catalog-generate.test.ts`, plus no
  regressions anywhere else (this touches a function, `createMerchantCatalogJob`, called by
  both the single-generate and bulk-generate routes — re-run the full suite, not just the
  files this plan lists, to catch any bulk-path regression).
- `pnpm typecheck` and `pnpm lint` clean repo-wide.
- `pnpm --filter @tryme/web typecheck` and a successful `pnpm --filter @tryme/web dev`
  manual walk of Task 4's UI (both the two-input-capable and non-capable subcategory cases,
  per the plan's own Task 4 Step 7).
- `docs/progress.md` updated with a new dated entry at the top (`## YYYY-MM-DD — <title>`,
  `**Done**` bullets), matching the existing entries' style.
- Final commit(s) per task, matching the plan's own commit-message suggestions unless the
  live code disagrees enough to warrant a different message.
- Report back: which commits landed for each task, and call out any place where the live
  codebase disagreed with the plan's literal snippets and what you did instead — the plan is
  a strong default, not gospel; when it's wrong, say so and explain the deviation rather than
  silently following or silently ignoring it. In particular, report what you found/did for
  gotcha #4 above (the cross-package test import).
