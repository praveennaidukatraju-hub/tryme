# Handover: Merchant Catalog Two-Input (Body + Pallu) Direct Try-On

**For:** antigravity CLI (implementer)
**From:** Claude — architect/reviewer only on this initiative. Nothing in this plan is
implemented yet; this handoff covers all 8 tasks from scratch.
**Branch:** `feat/merchant-catalog-saree-two-input` — already checked out locally at
`D:\tryme\webtool`, already tracking `origin/dev` with 5 prior commits on it
(`5d74d580`..`4d012b9c`, the earlier "merchant catalog saree two-input" plan — already
merged/shipped work, not part of this handoff's scope). This new plan continues on the same
branch rather than a fresh one because it depends directly on that prior work (the
`supportsTwoInputMannequin` flag, the Pallu upload UI pattern, the `garment_subcategories`
mannequin columns) and touches overlapping files.

## Before Task 1 — three pending items sitting in the working tree, handle each correctly

1. **`docs/progress.md`** has an uncommitted 24-line deletion — a duplicate dated entry from
   the prior plan's completion writeup that a previous session found and removed. Commit it
   standalone first:
   ```
   git add docs/progress.md
   git commit -m "docs: remove duplicated progress.md entry"
   ```
2. **`docs/handovers/2026-08-20-merchant-catalog-saree-two-input-handoff.md`** is untracked —
   the handoff doc for the *prior*, already-completed plan. Commit it for the repo's record:
   ```
   git add docs/handovers/2026-08-20-merchant-catalog-saree-two-input-handoff.md
   git commit -m "docs: add handoff doc for the completed merchant catalog saree two-input plan"
   ```
3. **`apps/catalogues-web/.../tryon/ProductModal.tsx`** has an uncommitted diff — this is
   covered by the new plan's own Task 8, Step 0 (hides "Flat Image" mode and defaults to
   "Catalogue Image" for two-input-capable subcategories). Do **not** commit it here; commit
   it exactly where Task 8 Step 0 says to, so it lands as its own clearly-scoped commit
   separate from Task 8's actual new work (the Pallu box).

**Do NOT commit** `flat-body-and-pallu-saree-tryon-api (1).json` at the repo root — it's a
reference-only ComfyUI export the user supplied to confirm the workflow shape. The graph it
describes already exists as a `workflow_templates` row in the DB (see below); the JSON file
itself isn't app code and doesn't belong in the repo. Leave it alone or delete it — either is
fine, just don't `git add` it.

**Plan file:** `docs/superpowers/plans/2026-08-20-merchant-catalog-two-input-direct-tryon.md`
— read Tasks 1-8 directly from this file. Each has a literal TDD script (test code,
implementation code, exact commands) with `- [ ] **Step N**` checkboxes — check each one off
(`- [x]`) as it lands.

## Scope (all 8 tasks pending)

| Task | What | Depends on |
|---|---|---|
| 1 | DB migration: `merchant_catalog_items.second_r2_key`/`second_thumbnail_key`, `garment_subcategories.two_input_tryon_workflow_template_id` | Nothing new |
| 2 | Types: second-image fields on `MerchantCatalogItem`/`CreateBody`, `supportsTwoInputDirectTryon` on `MerchantCatalogSubcategory`, admin patch field | Task 1 |
| 3 | API: `serializeCatalogItem`/`serializeSubcategory` presign+expose the second image; create route stores it; delete route cleans it up | Tasks 1-2 |
| 4 | Admin UI: new field on `EditGarmentTypeModal.tsx` to wire `twoInputTryonWorkflowTemplateId` onto a garment type | Task 2 |
| 5 | `resolveTryonGarment.ts`: when a catalog item has a second image, resolve the two-input template instead of the (empty, unconfigured) `tryon_categories` lookup | Tasks 1-2 |
| 6 | Job creation: carry the second garment key through `createMerchantTryonJob` as `job_inputs.third_garment_key` (existing column, existing body+pallu convention) | Task 5 |
| 7 | Dispatcher `processWidgetJob`: patch the second garment image into the ComfyUI workflow when the template has a second garment node | Task 6 |
| 8 | `ProductModal.tsx`: Pallu upload box in "Catalogue Image" (direct-upload) mode, gated on Task 2's `supportsTwoInputDirectTryon` | Tasks 2-3 |

**The key architectural point, worth internalizing before touching code:** this is a
**one-shot** try-on, not a two-phase job pair. The prior plan on this branch (mannequin
generation) builds a standalone 0-credit mannequin job + a `PENDING_MANNEQUIN` step-2 job
that a dispatcher sweep promotes once the mannequin completes. **This plan does none of
that.** The ComfyUI workflow the user supplied
(`flat-body-and-pallu-saree-tryon-api (1).json`, already uploaded to the local dev DB as
workflow_templates id `3042bd53-3714-4d38-9642-6b46a995781c`, slug
`flat_body_and_pallu_saree_tryon_api_1_`) does person + body + pallu → final result in a
**single KSampler pass** (node 26 = person, node 30 = body, node 27 = pallu, node 25 =
SaveImage). Feed the customer's own photo into node 26 (instead of an admin-curated face)
and it produces that customer wearing the saree directly — confirmed by the user directly:
"we are able to do the tryon with the person image and the body and pallu directly without
the catalogue image." Task 7's dispatcher change is a small, single-pass extension of the
*existing* `processWidgetJob` (already does person + one garment in one pass for every other
merchant/kiosk tryon job) — not new job-orchestration machinery.

**Why a *new* `garment_subcategories` column instead of reusing
`mannequin_two_input_workflow_template_id`, which already points at this exact template
row?** That column is actively consumed today by `createSareeMannequin.ts` and
`create-job.ts` with a **model-gallery face** patched into node 26 — a different job
semantically (0-credit, step 1 of 2, feeds a further per-pose composite). This plan's
consumer patches the **real customer's photo** into the same node role — full-credit,
one-shot, terminal. Same template row, two independently-toggleable capabilities, two
columns. Verify this yourself before assuming otherwise:
```
docker exec tryme-postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> -t -c \
  "select id, slug, workflow_type, tryon_person_node_id, tryon_garment_node_id, \
   tryon_garment_node_id_2, tryon_output_node_id from workflow_templates \
   where tryon_garment_node_id_2 is not null;"
```
(get `POSTGRES_USER`/`POSTGRES_DB` from `.env` — never print their values, just use them)

## Explicitly out of scope — do not implement, even if it looks like a natural extension

- Touching `mannequinTwoInputWorkflowTemplateId` or its consumers (`createSareeMannequin.ts`,
  `create-job.ts`'s mannequin-drape branch, the Studio wizard). Separate, already-shipped
  capability.
- `demoCatalogItems` / the demo-catalog branch of `resolveTryonGarment.ts`. Demo items are
  admin-authored; this plan is the merchant's own catalog items only.
- Seeding or fixing `tryon_categories` for the single-image tryon path. It's empty in the
  local DB today and that's a separate, pre-existing gap — this plan's two-input path
  bypasses it entirely by design (see Task 5), it does not fix it.
- Studio's own saree upload flow — already fixed and committed (`6fd7dc85`, defaults to
  Body & Pallu, Full Saree option removed).
- "Flat Image" mode's existing Pallu box (prior plan's Task 4, already shipped). Task 8 here
  only touches "Catalogue Image" mode.

## Gotchas worth knowing before you start

1. **The two-input template id is environment-specific.** `3042bd53-3714-4d38-9642-6b46a995781c`
   is what it is in the *local dev* DB verified during planning. Don't hardcode it anywhere
   in application code — it only appears as a value you type into the admin UI (Task 4's
   manual verification step) or a one-off ops SQL statement, never in a migration or a
   TypeScript literal. Confirm the id fresh in whatever DB you're testing against.
2. **`tryon_categories` is empty locally and `garment_subcategories.tryon_category_id` is
   null for saree** — verified directly during planning. This means the *existing*
   single-image merchant-tryon path (`resolveTryonGarment`'s `assertWorkflow` branch) already
   fails validation for saree today, unrelated to this plan. Task 5's two-input branch must
   run *before* (not after) the existing `assertWorkflow(own)` call, so it never falls
   through to a check that's guaranteed to fail for saree specifically. The plan's Task 5
   snippet already orders it this way — preserve that order if you restructure anything.
3. **`job_inputs.third_garment_key` already exists and already means "pallu" by established
   convention** (`upperGarmentKey` = body, `thirdGarmentKey` = pallu) — used identically by
   `createSareeMannequin.ts`, `create-job.ts`, and `shopify/catalog-job.ts`. Task 6 follows
   this exact precedent. No new `job_inputs` column, no migration for that table.
4. **`pnpm -r typecheck` silently skips `admin-web`** (recurring, documented gap on this
   repo) — its `package.json` has no `typecheck` script, so it's filtered out without error.
   For Task 4, run `npx tsc -b --force` directly inside `apps/admin-web` instead of trusting
   a root-level typecheck run.
5. **Docker infra must be running** (`pnpm docker:up` — postgres/redis/minio) before any
   integration test or migration.
6. **Plan line-number references drift** (recurring issue on this repo's other handoffs) —
   always grep/read the actual current file before editing against a snippet's line
   reference; the plan's line numbers were accurate as of this branch's tip when written but
   may have moved by the time you implement, especially in `ProductModal.tsx` (Task 8) and
   `processor.ts` (Task 7), both of which the plan itself flags as needing a fresh read
   before editing.
7. **No admin-web-style unit test harness exists for `apps/catalogues-web` pages** — Task 8's
   verification step is a manual browser walk, not an automated test. Don't invent a testing
   harness to cover this.

## Definition of done

- Every `- [ ]` checkbox for Tasks 1-8 in
  `docs/superpowers/plans/2026-08-20-merchant-catalog-two-input-direct-tryon.md` checked to
  `- [x]`.
- `pnpm --filter @tryme/api test:integration` green — the new/modified tests from Tasks 3
  and 5, plus no regressions in the existing merchant-catalog and merchant-tryon-jobs test
  files (Task 5 touches `resolveTryonGarment`, already covered by an existing test file for
  the single-image path — re-run the full suite, not just new files).
- `pnpm typecheck` and `pnpm lint` clean repo-wide (remember the `admin-web` gotcha above).
- `pnpm --filter @tryme/web typecheck` clean and Task 8's manual browser walk done for
  both the two-input-capable and non-capable subcategory cases.
- `docs/progress.md` updated with a new dated entry at the top, matching the existing
  entries' style — added *above* the prior plan's completion entry, not merged into it.
- Final commit(s) per task, matching the plan's own commit-message suggestions unless the
  live code disagrees enough to warrant a different message.
- Report back: which commits landed for each task; whether the local admin UI walk (Task 4
  Step 4) actually found and successfully used the two-input template id in your
  environment; and call out any place where the live codebase disagreed with the plan's
  literal snippets and what you did instead — the plan is a strong default, not gospel; when
  it's wrong, say so and explain the deviation rather than silently following or silently
  ignoring it.
