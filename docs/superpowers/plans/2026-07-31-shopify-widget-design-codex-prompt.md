# Task: implement the Shopify Widget Design plan, subagent-driven

## Context

Repo: `/mnt/vol1/PycharmProjects/tryme_v1`
Branch: `feat/shopify-app-refactor` (already checked out — do not create a new branch)

Read these three files in full before doing anything:

1. `CLAUDE.md` — authoritative project instructions. Its "Invariants (do not break)" section overrides your defaults.
2. `docs/superpowers/plans/2026-07-31-shopify-widget-design.md` — the plan you are implementing. 9 tasks.
3. `docs/superpowers/specs/2026-07-31-shopify-widget-design-design.md` — the design the plan implements. Read it for intent when a task's wording is ambiguous.

The plan's "Spec Corrections Applied In This Plan" section supersedes the spec on three points. Where they disagree, **the plan wins**.

## Execution model

Work task-by-task, 1 → 9, in order. For each task N:

1. **Read** the full text of Task N from the plan, including its `**Files:**` and `**Interfaces:**` blocks.
2. **Dispatch a fresh implementer subagent.** Give it: the repo path, the contents of `CLAUDE.md`, the plan's `## Global Constraints` section, and the verbatim text of Task N. Do **not** give it the whole plan — each task is self-contained by design, and the `Interfaces:` block tells it the exact signatures neighbouring tasks rely on.
3. The implementer follows the task's checkbox steps **in the order written**. The plan is TDD: write the failing test, run it and confirm it fails for the stated reason, implement, run it and confirm it passes. An implementer that writes the implementation first has not followed the task.
4. **Dispatch a fresh reviewer subagent** on the resulting diff (`git diff`). Give it Task N's text and the relevant spec section. It checks:
   - Every step in the task was actually done, not just the ones that were convenient.
   - The diff matches the spec's intent, not merely the task's letter.
   - Tests were genuinely run and genuinely passed — not asserted.
   - Correctness and quality problems the task text didn't anticipate.
5. If the reviewer raises findings: hand them to an implementer, fix, re-review. Loop until clean.
6. **Commit** using the exact message in that task's commit step. Then move to N+1.

After Task 9, run one final review over the whole branch diff since `819180e3`.

## Hard rules

- **Never `git push`. Never open a PR.** Commit locally only. If you think the work is ready to push, say so and stop.
- **Never run schema or migration work against production or `tryon_prod`.** This plan adds no migration (the `settings` column already exists as `jsonb`), so you should not be running `pnpm db:generate` or `pnpm db:migrate` at all. If you believe you need to, stop and ask.
- `pnpm docker:up` must be running before any integration test. Integration tests use the docker-compose Postgres/Redis/MinIO on localhost.
- **Do not run the full API integration suite.** It has a known pre-existing Redis rate-limiter 429 cascade when every file runs together, unrelated to this work. Run only the three files the plan names: `metafields`, `onboarding`, `shopify-widget-config`.
- Every merchant-authored string rendered in Liquid must pass through `| escape`. Liquid does not auto-escape.
- Absent config must always mean "behave exactly as today". No existing store may change appearance until a merchant opts in. If a change would alter the storefront for a store with no `widget_config` metafield, it is wrong.
- No `console.log` in committed code.
- pnpm workspaces. Never create an npm or yarn lockfile.
- `apps/admin-mobile` is out of scope. Do not touch, test, or typecheck it.

## Blocking dependency — read before starting Task 3

Another agent is concurrently implementing `docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md`. As of `139d858b` it has finished its Tasks 1-4 and has 5-12 outstanding.

- **Tasks 1 and 2 of your plan are safe to run now.** They touch `packages/db/src/schema/shopify.ts`, `packages/types/src/widget.ts`, and three files under `apps/api/src/modules/shopify/`. The only overlap is `routes.ts`, where both plans add a registration line — a trivial merge.
- **Tasks 3 through 9 must wait** until the shopper-limits plan is fully landed. They collide on `tryon-block.liquid`, `tryon-widget.js`, `tryon-widget.css`, `App.tsx`, `AppNavMenu.tsx`, and `DashboardPage.tsx`.

Before starting Task 3, verify shopper-limits is done:

```bash
git log --oneline -20 | grep -i "shopify"
ls apps/api/src/modules/shopify/limits.ts apps/api/src/modules/shopify/gdpr.ts
```

If `limits.ts` or `gdpr.ts` is missing, shopper-limits is still in flight — **stop and report**, do not proceed to Task 3.

Task 3 deletes `tryon-block.liquid`, which shopper-limits Task 6 edits to add an email-gate step. Before deleting it, run:

```bash
git show HEAD:apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid | grep -i email
```

If that prints anything, **that markup must be carried into `tryon-button.liquid` verbatim**. Missing this silently removes a shipped feature with no test to catch it.

## Tasks with no automated test

Tasks 4 and 5 modify the theme extension, which has no test runner. Their verification is the dev-store checklist written into the task. Do **not** invent automated tests to fill the gap, and do **not** mark these tasks complete on the strength of "it should work". If you cannot run the dev-store checks, say so explicitly in your report and mark those steps as unverified rather than done.

## Reporting

After each task, report in three lines: what landed, what the reviewer flagged and how it was resolved, and the exact test command output line showing pass counts.

At the end, report: tasks completed, tasks blocked and why, any step you marked unverified, and anything in the plan that turned out to be wrong when it met the real code.
