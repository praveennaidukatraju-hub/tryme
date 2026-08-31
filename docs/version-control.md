# Version Control Rules

## Branch Policy

- `main` — protected. PRs into `main` are only accepted from `dev`, or from a
  `hotfix/*` branch for true emergencies. **GitHub-enforced:** no direct push,
  force-push, or delete; the required `ci-gate` check must pass before merge,
  and `ci-gate` itself fails on any PR into `main` whose head isn't `dev` or
  `hotfix/*` (the `branch-source-gate` job in `ci.yml`).
- `dev` — feature/fix branches must raise a PR **into `dev`**. **GitHub-enforced:**
  no direct push, force-push, or delete; the required `ci-gate` check must pass
  before merge. No restriction on source branch — any `feature/*`/`fix/*`/`chore/*`
  branch can target it.
- Feature branches — branch off `dev`, raise PR back into `dev`.

```
feature/foo ─┐
fix/bar     ─┼─▶ PR ─▶ dev ─▶ PR ─▶ main
chore/baz   ─┘

hotfix/foo ───────────────▶ PR ─▶ main ─▶ PR ─▶ dev  (back-merge, same day)
```

## Hotfix Back-Merge

A `hotfix/*` branch that merges straight into `main` bypasses `dev`, so `dev`
is now missing that commit and will silently drop it on the next promotion PR
unless it's merged back.

**Immediately after a hotfix lands on `main`:** open a second PR, same branch
or a fresh one off `main`, merging `main` into `dev` (or cherry-pick the
hotfix commit onto a `chore/backmerge-*` branch off `dev` if `main` has
diverged further). Merge it before starting any other work on `dev` — a
promotion PR opened before the back-merge will look like it's reverting the
hotfix.

Verify with `git merge-base --is-ancestor <hotfix-sha> origin/dev` — should
print nothing and exit 0 once the back-merge is in.

## Secret Scanning (gitleaks)

CI's `gitleaks` job (`.github/workflows/ci.yml`) fails a PR if a new commit
introduces something that looks like a credential. It runs against `.gitleaks.toml`
(rule config + allowlist) and `.gitleaks-baseline.json` (every finding that
existed in history as of the commit the baseline was generated from — this repo's
680+ pre-existing commits are not re-litigated on every run; only genuinely new
matches fail the job).

**If gitleaks flags a real false positive going forward** (a new test fixture that
looks like a secret, a non-secret high-entropy string): add a regex to
`.gitleaks.toml`'s `[allowlist]` rather than touching the baseline — the baseline
should only change when history itself changes (a purge, a rewrite), regenerated
via:
```bash
gitleaks detect --config .gitleaks.toml --report-format json --report-path .gitleaks-baseline.json --redact --exit-code 0
```

`--redact` is load-bearing, not cosmetic: a baseline generated without it stores
the real secret value in `Secret`, and matching that against a `--redact`ed scan
(what CI always runs) never suppresses anything — every entry re-fires as a
"new" leak. This is also why the `workflow_dispatch`/`schedule` full-history scan
can drift out of sync with the baseline over time even with no real secret ever
added: `git log`-based fingerprints are commit-scoped, and squash-merging a
feature branch prunes its original commits from reachable history, so any
baseline entry pinned to one of those now-unreachable SHAs silently stops being
reachable too. A periodic re-run of the command above (full history, not a
range) is normal maintenance, not just a "history was rewritten" event.

**If it flags a real secret:** do not merge. Rotate the credential, then follow
SEC-C1's remediation pattern in `docs/audits/open-findings.md` (or its history —
redact, confirm rotation, then `git filter-repo` to purge if the repo is public).

## Commit & Push Policy

**Only commit and push when a meaningful unit of work is complete.**

Commit when: a full feature works end-to-end, a bug is fixed and verified, a migration + its API/UI changes are done together, or a multi-file refactor is complete.

Do NOT commit for: single CSS changes, label/copy tweaks, one-liners that are part of a larger in-progress task.

## Migration Index Conflicts (diverged branches)

When pulling from `origin/master` onto a feature branch that added migrations, index collisions can occur if both sides independently picked the same next index.

**Detection:** Before merging, run:
```bash
git diff --name-only HEAD..origin/master -- packages/db/src/migrations/
```
If `origin/master` has a `0063_*.sql` and so does your branch, you have a collision.

**Resolution order:**
1. Check the highest index on `origin/master`: `git show origin/master:packages/db/src/migrations/meta/_journal.json | python3 -m json.tool | grep '"idx"' | tail -3`
2. Rename your local migration files to start after that: `git mv 0063_foo.sql 0064_foo.sql`
3. Do the merge: `git merge origin/master`
4. In `_journal.json`, resolve the conflict so server entries come first, then yours at the bumped indices
5. `git add` renamed files + journal, then `git merge --continue`
6. Run `pnpm db:migrate` — NOTICE "already exists" is safe; it means local DB already has the table
7. **If `pnpm db:migrate` silently skips a migration** (Drizzle gap problem): happens when earlier-index hash is missing but later-index hashes are already recorded. Apply it manually:
   ```ts
   // packages/db/apply-one.ts (delete after use)
   import postgres from 'postgres';
   import { createHash } from 'crypto';
   import { readFileSync } from 'fs';
   const sql = postgres(process.env.DATABASE_URL!);
   const migSql = readFileSync('/abs/path/to/NNNN_migration.sql', 'utf8');
   const hash = createHash('sha256').update(migSql).digest('hex');
   await sql.begin(async tx => {
     await tx.unsafe(migSql);
     await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${Date.now()})`;
   });
   await sql.end();
   ```
   Then run it: `node_modules/.bin/tsx --env-file=.env packages/db/apply-one.ts`

**Rule:** Server's migration index is canonical. Your branch always yields and renumbers upward.
