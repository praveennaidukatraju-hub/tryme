# Design — Skill: `surface-admin-errors`

Date: 2026-07-13

## Problem

`apps/admin-web` has many places where an operation fails silently or shows a
generic toast ("Failed to save") that **discards the real backend error**. The
operator then has to search Grafana logs to learn what actually went wrong, even
for small errors. We want the real error text to reach the UI so Grafana is not
needed for routine failures.

## Goal

A repeatable, Skill-tool-invocable procedure that walks `apps/admin-web/src`
exhaustively, finds **every** error-handling site, and either:

- **auto-fixes** sites that already show a toast but throw away the real error, or
- **reports** fully-silent sites (which may be intentionally best-effort) for
  human review.

The enumeration must be deterministic — the agent may make **no assumptions** and
must not silently skip any site.

## Scope

- **In scope:** `apps/admin-web/src` only (React SPA).
- **Out of scope:** `apps/api`, `apps/dispatcher`, `apps/catalogues-web`. If a
  reported site's root cause is a backend generic message, note it in the report;
  do not edit backend code.

## Existing infrastructure (reused — no new infra)

Everything needed already exists in `apps/admin-web/src/lib/data.ts`:

- `class ApiError extends Error` — its `.message` is
  `apiErrorBodyMessage(body) ?? httpStatusMessage(status)`, i.e. **the real
  backend message when present**, else a friendly status fallback. It also
  carries `.body` and `.code`.
- `apiErrorMessage(err, fallback)` — returns `err.message` if non-empty, else
  `fallback`.
- `apiFetch<T>()` throws `ApiError` on non-2xx and a network `Error` on fetch
  failure.
- `toast({ kind, title, body })` (`components/ToastStack.tsx`) — `title` is the
  bold line, `body` is an optional secondary line.

**Canonical fix shape:** keep the friendly `title`, put the real error in `body`:

```ts
} catch (e) {
  toast({ kind: 'error', title: 'Failed to update face', body: apiErrorMessage(e, 'Please try again.') });
}
```

Backend text wins; the fallback is only used when the error has no message. The
skill never invents an error string.

## The "no-miss" enumeration (core guarantee)

The skill runs a **fixed grep pattern set** first to produce a complete worklist.
Every match MUST end in exactly one of three states — nothing is silently
skipped:

| Pattern (ripgrep) | Finds |
|---|---|
| `\} catch \{` | catch with no error binding — real error unreachable |
| `\} catch \(` | bound catch — verify `e` is actually surfaced |
| `\.catch\(` | promise-chain handlers (fire-and-forget swallows) |
| `if \(!res\.ok\)` / `!response\.ok` | manual fetch checks that may `return` silently |
| `console\.(error\|warn)` | logged-only, no UI |
| `setError\(` | state set but possibly never rendered |

End states per site:

- **FIXED** — code changed.
- **REPORTED** — flagged for human review, code untouched.
- **OK** — already surfaces the error, no change.

The skill must print a coverage line proving the total is fully partitioned:

```
N matches = X fixed + Y reported + Z ok
```

The skill is not "done" until every match is in one bucket and the tally
balances.

## Decision table

| Site class | Detected by | Action |
|---|---|---|
| Toasts but drops error — `catch { toast({title:'Failed to X'}) }` | catch has **no** binding **and** body contains `toast(` | **AUTO-FIX**: rebind `catch (e)`, add `body: apiErrorMessage(e, '<friendly fallback>')` |
| Bound but ignores `e` — `catch (e) { toast({title:'...'}) }` with `e` unused | binding exists, `toast` call lacks `e` / `apiErrorMessage` | **AUTO-FIX**: add `body: apiErrorMessage(e, ...)` |
| Logged-only — `catch (e) { console.error(e) }`, no toast | `console.*` present, no `toast(` in the catch | **AUTO-FIX**: add an error toast surfacing `e` |
| Fully silent — `catch { /* comment */ }`, no toast, no log | catch body has no `toast(` and no `console.*` | **REPORT** — may be intentional best-effort; human decides |
| Silent non-throw — `if (!res.ok) return` with no surface | manual ok-check that returns/continues without toast/throw | **REPORT** |
| Already surfaces `e` | `apiErrorMessage` / `e.message` already reaches a `toast` body | **OK**, no change |

Rules:

- Auto-fix is mechanical and message-preserving: the friendly `title` is kept; the
  real message goes in `body` via `apiErrorMessage(e, fallback)`.
- Reported sites are **never** guessed or edited — the agent does not decide
  whether a best-effort swallow is intentional.
- Known intentional swallows already exist (e.g. `AuthContext.tsx` initial-auth
  probe `catch { // not logged in }` and logout `catch { // best-effort }`).
  These belong in the REPORT, untouched.

## Outputs

1. **Fixes** applied in place to `apps/admin-web/src`.
2. **Report** at `docs/audits/<YYYY-MM-DD>-admin-error-surfacing.md` containing:
   - the coverage tally,
   - every REPORTED site: `file:line`, current code, why flagged, suggested fix,
   - a short summary of what was auto-fixed (counts by file).
3. **Skill** at `.claude/skills/surface-admin-errors/SKILL.md`.

## Verification

After auto-fixes, run:

```
pnpm --filter @tryme/admin typecheck
```

Must pass before the skill claims done. (Typecheck only — not a full build.)

## Non-goals

- No backend edits.
- No refactor of the error infra (`apiErrorMessage`, `ApiError`) — it is already
  sufficient.
- No change to toast styling/UX.
- No attempt to auto-classify intentional vs. accidental silent swallows —
  that judgment stays with the human via the report.
