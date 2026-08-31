# Surface Admin Errors Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author a reusable, Skill-tool-invocable procedure that walks `apps/admin-web/src` exhaustively and makes every silent/generic error site surface the real backend error in the UI.

**Architecture:** The deliverable is a single skill document (`SKILL.md`) plus a validation pass. The skill drives a fixed grep enumeration → per-site classification (FIXED / REPORTED / OK) → mechanical auto-fix using the codebase's existing `apiErrorMessage(e, fallback)` + toast `body` → a written report for ambiguous sites → a coverage tally that must balance. No product code is written by this plan; the skill is what edits product code when later invoked.

**Tech Stack:** Markdown skill file with YAML frontmatter, ripgrep/grep enumeration, `pnpm --filter @tryme/admin typecheck` for verification.

## Global Constraints

- Skill operates on `apps/admin-web/src` **only**. Never edits `apps/api`, `apps/dispatcher`, `apps/catalogues-web`, or the error infra (`apiErrorMessage`, `ApiError`).
- Canonical fix shape (verbatim): keep friendly `title`, add `body: apiErrorMessage(e, '<fallback>')`. Backend text wins; fallback used only when the error has no message. Never invent an error string.
- Every enumeration match must end in exactly one of: **FIXED**, **REPORTED**, **OK**. The agent prints `N matches = X fixed + Y reported + Z ok` and is not done until it balances.
- Reported sites are never guessed or edited.
- Existing helpers live in `apps/admin-web/src/lib/data.ts`: `apiErrorMessage(err, fallback)`, `class ApiError` (`.message` = backend body message or friendly status fallback), `apiFetch<T>()`. Toast: `toast({ kind, title, body })` (`components/ToastStack.tsx`).
- Skill location: `.claude/skills/surface-admin-errors/SKILL.md`.
- Report location: `docs/audits/<YYYY-MM-DD>-admin-error-surfacing.md`.
- Verification after fixes: `pnpm --filter @tryme/admin typecheck` must pass.

---

## File Structure

- Create: `.claude/skills/surface-admin-errors/SKILL.md` — the entire procedure (frontmatter + enumeration + decision table + fix transform + report template + verification + coverage rule). One responsibility: tell an agent exactly how to run the error-surfacing pass.

No other files are created by this plan. The report and product-code edits are produced later, when the skill is invoked.

---

### Task 1: Author the `surface-admin-errors` skill

**Files:**
- Create: `.claude/skills/surface-admin-errors/SKILL.md`

**Interfaces:**
- Consumes: existing `apps/admin-web/src/lib/data.ts` exports (`apiErrorMessage`, `ApiError`, `apiFetch`) and `components/ToastStack.tsx` `toast({ kind, title, body })`.
- Produces: an invocable skill named `surface-admin-errors`. Later invocation produces product-code edits + a report at `docs/audits/<date>-admin-error-surfacing.md`.

- [ ] **Step 1: Create the skill file with frontmatter and full procedure**

Write `.claude/skills/surface-admin-errors/SKILL.md` with exactly this content:

````markdown
---
name: surface-admin-errors
description: Use when admin-panel operations fail silently or show generic toasts and you must search Grafana to learn the real error. Walks apps/admin-web/src exhaustively, auto-fixes sites that toast but discard the real backend error, and reports fully-silent sites for human review. Trigger words - silent error, generic toast, surface errors, admin error audit, error walkthrough.
---

# Surface Admin Errors

Make every error site in `apps/admin-web/src` show the real backend error, so
Grafana is not needed for routine failures. Deterministic and exhaustive: no
site is silently skipped, no error message is invented.

## Scope (hard boundary)

- Edit `apps/admin-web/src` ONLY.
- NEVER edit `apps/api`, `apps/dispatcher`, `apps/catalogues-web`, or the error
  infra (`apiErrorMessage`, `ApiError`) in `lib/data.ts`.
- If a site's root cause is a backend generic message, note it in the report;
  do not touch backend code.

## Existing infrastructure (reuse — do not reinvent)

In `apps/admin-web/src/lib/data.ts`:
- `apiErrorMessage(err, fallback)` → `err.message` if non-empty, else `fallback`.
- `class ApiError extends Error` → `.message` is the real backend body message
  when present, else a friendly status fallback. Also `.body`, `.code`, `.status`.
- `apiFetch<T>()` throws `ApiError` on non-2xx, network `Error` on fetch failure.

In `components/ToastStack.tsx`: `toast({ kind, title, body })` — `title` bold,
`body` optional second line.

**Canonical fix shape** — keep the friendly title, put the real error in `body`:

```ts
} catch (e) {
  toast({ kind: 'error', title: 'Failed to update face', body: apiErrorMessage(e, 'Please try again.') });
}
```

Backend text wins; the fallback shows only when the error has no message. NEVER
invent an error string.

## Step 1 — Enumerate (the no-miss guarantee)

Run each pattern from the repo root. Capture the full match list; you will
account for every line.

```bash
cd apps/admin-web/src
grep -rEn '[^a-z]catch \{'            --include=*.ts --include=*.tsx .   # catch, no binding
grep -rEn '\} catch \('              --include=*.ts --include=*.tsx .   # catch, bound
grep -rEn '\.catch\('                --include=*.ts --include=*.tsx .   # promise handlers
grep -rEn '!res\.ok|!response\.ok'   --include=*.ts --include=*.tsx .   # manual ok checks
grep -rEn 'console\.(error|warn)'    --include=*.ts --include=*.tsx .   # logged-only
grep -rEn 'setError\('               --include=*.ts --include=*.tsx .   # state, maybe unrendered
```

Build a worklist: one row per unique site (`file:line`). De-dupe overlaps (a
single catch can match more than one pattern — count the site once).

## Step 2 — Classify each site (open the file; read the whole handler)

For each site, read its enclosing handler and assign exactly one class:

| Class | Detected by | Action |
|---|---|---|
| Toasts but drops error | catch has NO binding AND its body contains `toast(` | **AUTO-FIX** |
| Bound but ignores `e` | binding exists, `toast(` call lacks `e`/`apiErrorMessage` | **AUTO-FIX** |
| Logged-only | `console.error/warn` present, no `toast(` in handler | **AUTO-FIX** (add error toast surfacing `e`) |
| Fully silent | catch/handler body has no `toast(` and no `console.*` | **REPORT** |
| Silent non-throw | `if (!res.ok) return` (or `.catch(()=>{})`) with no surface | **REPORT** |
| Already surfaces `e` | `apiErrorMessage`/`e.message`/`err.message` already in a `toast` body | **OK** |

Rules:
- A fully-silent swallow MAY be intentional best-effort (e.g. `AuthContext.tsx`
  initial-auth probe `catch { // not logged in }`, logout `catch { // best-effort }`).
  Do NOT decide — REPORT it, untouched.
- When unsure between AUTO-FIX and REPORT, choose REPORT. Never guess.

## Step 3 — Apply auto-fixes

For each AUTO-FIX site, apply the canonical fix shape:
- If the catch has no binding, add `(e)`.
- Preserve the existing friendly `title` verbatim.
- Add `body: apiErrorMessage(e, '<existing-title-as-sentence or "Please try again.">')`.
- If `apiErrorMessage` is not imported in the file, add it to the existing
  `lib/data.ts` import.
- Logged-only sites: keep the `console.*` line, add the error `toast(...)` after it.

Do NOT change control flow, `finally` blocks, or success paths. Message-surfacing
only.

## Step 4 — Write the report

Write `docs/audits/<YYYY-MM-DD>-admin-error-surfacing.md`:

```markdown
# Admin error-surfacing audit — <YYYY-MM-DD>

## Coverage
N matches = X fixed + Y reported + Z ok

## Auto-fixed (X)
- <file>: <count> site(s)   # one line per file

## Reported for review (Y)
### <file>:<line>
- Current: `<code>`
- Class: Fully silent | Silent non-throw
- Why flagged: <reason>
- Suggested fix: <one line, or "confirm intentional best-effort">
```

## Step 5 — Verify and report coverage

- Run: `pnpm --filter @tryme/admin typecheck` — must pass.
- Print the coverage line and confirm the partition balances:
  `N matches = X fixed + Y reported + Z ok`.
- You are NOT done until typecheck passes AND every enumerated site is in one
  bucket AND the tally balances.
````

- [ ] **Step 2: Verify the file exists and has valid frontmatter**

Run: `head -4 .claude/skills/surface-admin-errors/SKILL.md`
Expected: shows `---`, `name: surface-admin-errors`, a `description:` line, `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/surface-admin-errors/SKILL.md
git commit -m "feat(skill): add surface-admin-errors error-surfacing procedure"
```

---

### Task 2: Validate the skill's enumeration + classification against the live codebase (dry-run, no product edits)

This task proves the skill's greps actually surface the known real problem sites
and that the decision table classifies them correctly. It edits no product code.

**Files:**
- Modify: none (validation only). May append a `## Validation` note to the plan or scratch, but no product-code changes.

**Interfaces:**
- Consumes: the skill authored in Task 1.
- Produces: confirmation that patterns + decision table are correct (gate before the skill is trusted for real runs).

- [ ] **Step 1: Run the enumeration patterns and confirm non-empty worklists**

Run from repo root:
```bash
cd apps/admin-web/src
echo "no-bind:  $(grep -rEn '[^a-z]catch \{' --include=*.ts --include=*.tsx . | wc -l)"
echo "bound:    $(grep -rEn '\} catch \(' --include=*.ts --include=*.tsx . | wc -l)"
echo "promise:  $(grep -rEn '\.catch\(' --include=*.ts --include=*.tsx . | wc -l)"
echo "ok-check: $(grep -rEn '!res\.ok|!response\.ok' --include=*.ts --include=*.tsx . | wc -l)"
echo "logged:   $(grep -rEn 'console\.(error|warn)' --include=*.ts --include=*.tsx . | wc -l)"
echo "setError: $(grep -rEn 'setError\(' --include=*.ts --include=*.tsx . | wc -l)"
```
Expected (order-of-magnitude, exact numbers may drift as code changes):
```
no-bind:  91
bound:    51
promise:  25
ok-check: 6
logged:   1
setError: 25
```
Pass condition: `no-bind` and `bound` are both non-zero (the enumeration finds sites).

- [ ] **Step 2: Confirm a known AUTO-FIX site is surfaced and classified correctly**

Run: `sed -n '40,45p' components/EditFaceModal.tsx`
Expected: shows `} catch {` followed by `toast({ kind: 'error', title: 'Failed to update face' });` with no `body`/`apiErrorMessage`.
Classify by the table: catch has no binding AND body contains `toast(` → **Toasts but drops error → AUTO-FIX**. Confirm this matches.

- [ ] **Step 3: Confirm a known REPORT site is surfaced and classified correctly**

Run: `sed -n '62,64p' context/AuthContext.tsx`
Expected: shows `} catch {` / `// not logged in` — no `toast(`, no `console.*`.
Classify by the table: handler body has no `toast(` and no `console.*` → **Fully silent → REPORT**. Confirm the skill would REPORT (not edit) it.

- [ ] **Step 4: Confirm the verification command exists for the admin package**

Run: `pnpm --filter @tryme/admin typecheck 2>&1 | tail -5`
Expected: the command resolves (the `@tryme/admin` filter and a `typecheck` script exist) and completes. A clean tree should pass; record the result.

- [ ] **Step 5: Record validation outcome**

If Steps 1–4 pass, the skill is trusted for real runs. No commit needed (no files changed). If any step fails, fix the corresponding pattern or decision-table row in `.claude/skills/surface-admin-errors/SKILL.md`, then re-run this task and commit the skill fix:
```bash
git add .claude/skills/surface-admin-errors/SKILL.md
git commit -m "fix(skill): correct surface-admin-errors enumeration/classification"
```

---

## Self-Review

**Spec coverage:**
- Purpose/scope → Task 1 skill "Scope" section. ✓
- No-new-infra reuse → Task 1 "Existing infrastructure". ✓
- No-miss enumeration + coverage tally → Task 1 Step 1 & Step 5; Task 2 Step 1. ✓
- Decision table (6 classes) → Task 1 Step 2. ✓
- Canonical fix shape (title + `body: apiErrorMessage`) → Global Constraints + Task 1 Step 3. ✓
- Report at `docs/audits/<date>-...` → Task 1 Step 4. ✓
- Verification `pnpm --filter @tryme/admin typecheck` → Task 1 Step 5; Task 2 Step 4. ✓
- Reported-never-guessed, unsure→REPORT → Task 1 Step 2 rules. ✓
- Skill file location → Task 1 Files. ✓

**Placeholder scan:** No TBD/TODO. `<YYYY-MM-DD>` and `<fallback>` are intentional runtime substitutions inside the skill template, documented in Global Constraints. ✓

**Type consistency:** Helper names consistent throughout: `apiErrorMessage(err, fallback)`, `ApiError`, `toast({ kind, title, body })`, filter `@tryme/admin`. ✓
