# Phase 1 — CI Affected-Target Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every push to `main` from testing, building, and force-recreating all six production services; make a docs-only push touch zero containers.

**Architecture:** A version-controlled target manifest (`config/ci-targets.json`) plus a deterministic TypeScript detector (`scripts/ci/`) computes which deployment targets a Git diff affects, using recursive pnpm workspace dependency edges read from `package.json` files. The detector emits a JSON artifact and `$GITHUB_OUTPUT` values. `.github/workflows/ci.yml` gates its expensive jobs on those outputs behind a stable `ci-gate` aggregate check, and the SSH deploy step builds and recreates only the affected Compose services instead of the whole stack.

**Tech Stack:** Node 20+ (repo `engines`), TypeScript 5.6, ESM (`.mts`), `tsx` 4.19 (already a root devDependency), Vitest 2.1.3, Biome 2.4.16, GitHub Actions, Docker Compose.

## Global Constraints

- Package manager is pnpm 9.12.0. Never introduce npm/yarn lockfiles.
- ESM only. Detector source files use the `.mts` extension; test files use `.test.ts`.
- No `console.log` in committed application code. The detector is a CI script, not an application service — it writes to stdout deliberately and does not use `@tryme/logger`.
- The detector derives its file universe from **Git**, never a filesystem walk (`docs/production-cicd-plan.md` §4.4). Untracked directories `apps/web`, `apps/admin`, `apps/merchant-web`, and the Git-ignored `apps/admin-mobile` must not change its output.
- Deployment target names are **never** inferred from a directory path segment (§4.1). Three of six differ: `apps/catalogues-web` → `web`, `apps/admin-web` → `admin`, `apps/shopify` → `shopify-admin`.
- Failure is safe: any uncertainty sets `fallbackToAll` and selects every service. Uncertainty causes more building, never less (§5.2).
- Do not put `paths-ignore` on the whole workflow; branch protection requires the stable `ci-gate` check to always report (§5.5).
- Do not commit or push without explicit instruction from the repository owner.
- Scope is Phase 1 only. GHCR, blue/green slots, the NGINX gateway, `/ready` endpoints, and drain contracts are Phases 2+ and are out of scope here.

## File Structure

| Path | Responsibility |
|---|---|
| `config/ci-targets.json` | Declarative target manifest: targets with explicit `dir` + `packageName`, separate release surfaces, docs/infra/CI/global path rules, testable packages |
| `scripts/ci/lib/targets.mts` | Load and validate the manifest; assert it agrees with the real workspace |
| `scripts/ci/lib/workspace.mts` | Read tracked workspace manifests from Git; build the reverse dependency graph; compute recursive consumers |
| `scripts/ci/lib/classify.mts` | Pure function: changed paths + manifest + graph → `DetectResult`. No I/O |
| `scripts/ci/lib/git.mts` | Resolve the diff range for push/PR events; run and parse `git diff --name-status -z` |
| `scripts/ci/detect-affected.mts` | CLI entry: wire the above, write the JSON artifact, `$GITHUB_OUTPUT`, and `$GITHUB_STEP_SUMMARY` |
| `scripts/ci/detect-affected.test.ts` | Fixture tests for classification and the diff parser (§17.1) |
| `scripts/ci/workspace.test.ts` | Tests for the dependency graph and manifest/workspace agreement (§4.2) |
| `vitest.config.ts` (root, new) | Vitest config scoped to `scripts/ci/**` so detector tests do not collide with per-app suites |
| `.github/workflows/ci.yml` | Rewritten: `detect` job, conditional jobs, `ci-gate`, job-level deploy concurrency, scoped deploy |

Library files are split by responsibility so `classify.mts` stays pure and exhaustively testable without Git or the filesystem. That purity is what makes the ~20 fixture cases in §17.1 cheap to write.

---

### Task 1: Root Vitest harness for CI scripts

Detector tests need a runner. The repo has no root Vitest config; every suite lives under an app or package. This task adds a root config scoped to `scripts/ci/**` and proves the existing suites still pass afterward.

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (root — add `vitest` devDependency and a `test:ci-scripts` script)
- Test: `scripts/ci/harness.test.ts` (temporary; deleted in Step 7)

**Interfaces:**
- Consumes: nothing.
- Produces: the command `pnpm test:ci-scripts`, which runs every `scripts/ci/**/*.test.ts` file. All later tasks use it.

- [ ] **Step 1: Write a failing placeholder test that proves the harness runs**

Create `scripts/ci/harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('ci script harness', () => {
  it('runs TypeScript tests from scripts/ci', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails because no runner is configured**

Run: `pnpm test:ci-scripts`

Expected: FAIL. npm reports the script is missing, e.g. `Command "test:ci-scripts" not found`.

- [ ] **Step 3: Add the root Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/ci/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
});
```

- [ ] **Step 4: Add the devDependency and script to the root `package.json`**

In `package.json`, add to `scripts` (after the existing `"test"` entry):

```json
    "test:ci-scripts": "vitest run --config vitest.config.ts",
```

And add to `devDependencies`, keeping the block alphabetically ordered — it belongs after `"typescript-eslint"`:

```json
    "vitest": "^2.1.3"
```

`^2.1.3` matches `@tryme/api` and `@tryme/storage`. `packages/db` already pins `^4.1.7`, so mixed majors already coexist in this hoisted workspace; Step 6 verifies nothing regressed.

- [ ] **Step 5: Install and run the test to verify it passes**

Run:

```bash
pnpm install
pnpm test:ci-scripts
```

Expected: install completes and updates `pnpm-lock.yaml`; the test run reports `1 passed`.

- [ ] **Step 6: Verify existing suites still pass after the root install**

Run:

```bash
pnpm docker:up
pnpm --filter @tryme/api test:unit
pnpm --filter @tryme/dispatcher test:unit
```

Expected: both suites pass, same as before this task. If either fails with a Vitest resolution error, revert the root `vitest` version to match that package's own pin and re-run.

- [ ] **Step 7: Delete the placeholder and commit**

```bash
rm scripts/ci/harness.test.ts
git add vitest.config.ts package.json pnpm-lock.yaml
git commit -m "chore(ci): add root vitest harness scoped to scripts/ci"
```

---

### Task 2: Target manifest and loader

`config/ci-targets.json` is the single source of truth for the directory→package→target mapping. The loader validates it and — critically — asserts it still agrees with the real workspace, so a future directory rename cannot silently produce a wrong deploy.

**Files:**
- Create: `config/ci-targets.json`
- Create: `scripts/ci/lib/targets.mts`
- Test: `scripts/ci/targets.test.ts`

**Interfaces:**
- Consumes: `pnpm test:ci-scripts` from Task 1.
- Produces:
  - `interface TargetDef { name: string; dir: string; packageName: string; dockerfile: string; composeService: string }`
  - `interface SeparateSurface { dir: string; reason: string }`
  - `interface TargetsConfig { schemaVersion: number; targets: TargetDef[]; separateSurfaces: SeparateSurface[]; testablePackages: string[]; docsPaths: string[]; ciPaths: string[]; infraPaths: string[]; deploymentBundlePaths: string[]; globalRebuildPaths: string[] }`
  - `function loadTargets(path?: string): TargetsConfig`
  - `function matchAny(file: string, patterns: string[]): boolean`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/targets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTargets, matchAny } from './lib/targets.mts';

describe('loadTargets', () => {
  it('loads the six deployable targets', () => {
    const config = loadTargets('config/ci-targets.json');
    expect(config.schemaVersion).toBe(1);
    expect(config.targets.map((t) => t.name).sort()).toEqual([
      'admin',
      'api',
      'chatbot',
      'dispatcher',
      'shopify-admin',
      'web',
    ]);
  });

  it('maps directories that differ from their target name', () => {
    const config = loadTargets('config/ci-targets.json');
    const byName = new Map(config.targets.map((t) => [t.name, t]));
    expect(byName.get('web')?.dir).toBe('apps/catalogues-web');
    expect(byName.get('web')?.packageName).toBe('@tryme/web');
    expect(byName.get('admin')?.dir).toBe('apps/admin-web');
    expect(byName.get('admin')?.packageName).toBe('@tryme/admin');
    expect(byName.get('shopify-admin')?.dir).toBe('apps/shopify');
    expect(byName.get('shopify-admin')?.packageName).toBe('@tryme/shopify-admin');
  });

  it('declares the separate release surfaces', () => {
    const config = loadTargets('config/ci-targets.json');
    expect(config.separateSurfaces.map((s) => s.dir).sort()).toEqual([
      'apps/saree_catalogue_android',
      'apps/shopify-extension',
      'apps/virtual-tryon-mobile&kiosk_latest',
    ]);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => loadTargets('scripts/ci/__fixtures__/bad-schema.json')).toThrow(
      /schemaVersion must be 1/,
    );
  });

  it('rejects duplicate target directories', () => {
    expect(() => loadTargets('scripts/ci/__fixtures__/duplicate-dir.json')).toThrow(
      /duplicate target dir/,
    );
  });
});

describe('matchAny', () => {
  it('matches a directory glob', () => {
    expect(matchAny('docs/a/b.md', ['docs/**'])).toBe(true);
    expect(matchAny('docsy/a.md', ['docs/**'])).toBe(false);
  });

  it('matches a root-only extension glob', () => {
    expect(matchAny('README.md', ['*.md'])).toBe(true);
    expect(matchAny('apps/api/README.md', ['*.md'])).toBe(false);
  });

  it('matches an exact path', () => {
    expect(matchAny('pnpm-lock.yaml', ['pnpm-lock.yaml'])).toBe(true);
    expect(matchAny('pnpm-lock.yaml.bak', ['pnpm-lock.yaml'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `Failed to resolve import "./lib/targets.mts"`.

- [ ] **Step 3: Create the target manifest**

Create `config/ci-targets.json`:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "name": "web",
      "dir": "apps/catalogues-web",
      "packageName": "@tryme/web",
      "dockerfile": "apps/catalogues-web/Dockerfile",
      "composeService": "web"
    },
    {
      "name": "admin",
      "dir": "apps/admin-web",
      "packageName": "@tryme/admin",
      "dockerfile": "apps/admin-web/Dockerfile",
      "composeService": "admin"
    },
    {
      "name": "shopify-admin",
      "dir": "apps/shopify",
      "packageName": "@tryme/shopify-admin",
      "dockerfile": "apps/shopify/Dockerfile",
      "composeService": "shopify-admin"
    },
    {
      "name": "api",
      "dir": "apps/api",
      "packageName": "@tryme/api",
      "dockerfile": "apps/api/Dockerfile",
      "composeService": "api"
    },
    {
      "name": "chatbot",
      "dir": "apps/chatbot",
      "packageName": "@tryme/chatbot",
      "dockerfile": "apps/chatbot/Dockerfile",
      "composeService": "chatbot"
    },
    {
      "name": "dispatcher",
      "dir": "apps/dispatcher",
      "packageName": "@tryme/dispatcher",
      "dockerfile": "apps/dispatcher/Dockerfile",
      "composeService": "dispatcher"
    }
  ],
  "separateSurfaces": [
    {
      "dir": "apps/shopify-extension",
      "reason": "Shopify theme extension; published through the Shopify CLI, not a container image"
    },
    {
      "dir": "apps/virtual-tryon-mobile&kiosk_latest",
      "reason": "mobile/kiosk client; separate release surface"
    },
    {
      "dir": "apps/saree_catalogue_android",
      "reason": "native Gradle/Kotlin Android app; no package.json, not a pnpm workspace member, published through its own Android build"
    }
  ],
  "testablePackages": ["@tryme/api", "@tryme/dispatcher"],
  "docsPaths": ["docs/**", "*.md", "LICENSE"],
  "ciPaths": [".github/**", "config/ci-targets.json", "scripts/ci/**", "vitest.config.ts"],
  "infraPaths": ["infra/**"],
  "deploymentBundlePaths": ["Makefile", ".env.production.example", ".env.example"],
  "globalRebuildPaths": [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ".npmrc",
    "biome.json",
    "tsconfig.base.json",
    ".dockerignore",
    "lefthook.yml"
  ]
}
```

- [ ] **Step 4: Create the invalid fixtures the tests require**

Create `scripts/ci/__fixtures__/bad-schema.json`:

```json
{
  "schemaVersion": 2,
  "targets": [],
  "separateSurfaces": [],
  "testablePackages": [],
  "docsPaths": [],
  "ciPaths": [],
  "infraPaths": [],
  "deploymentBundlePaths": [],
  "globalRebuildPaths": []
}
```

Create `scripts/ci/__fixtures__/duplicate-dir.json`:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "name": "api",
      "dir": "apps/api",
      "packageName": "@tryme/api",
      "dockerfile": "apps/api/Dockerfile",
      "composeService": "api"
    },
    {
      "name": "api-clone",
      "dir": "apps/api",
      "packageName": "@tryme/api-clone",
      "dockerfile": "apps/api/Dockerfile",
      "composeService": "api-clone"
    }
  ],
  "separateSurfaces": [],
  "testablePackages": [],
  "docsPaths": [],
  "ciPaths": [],
  "infraPaths": [],
  "deploymentBundlePaths": [],
  "globalRebuildPaths": []
}
```

- [ ] **Step 5: Implement the loader**

Create `scripts/ci/lib/targets.mts`:

```ts
import { readFileSync } from 'node:fs';

export interface TargetDef {
  name: string;
  dir: string;
  packageName: string;
  dockerfile: string;
  composeService: string;
}

export interface SeparateSurface {
  dir: string;
  reason: string;
}

export interface TargetsConfig {
  schemaVersion: number;
  targets: TargetDef[];
  separateSurfaces: SeparateSurface[];
  testablePackages: string[];
  docsPaths: string[];
  ciPaths: string[];
  infraPaths: string[];
  deploymentBundlePaths: string[];
  globalRebuildPaths: string[];
}

const REQUIRED_TARGET_KEYS = ['name', 'dir', 'packageName', 'dockerfile', 'composeService'] as const;

export function loadTargets(path = 'config/ci-targets.json'): TargetsConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as TargetsConfig;

  if (config.schemaVersion !== 1) {
    throw new Error(`${path}: schemaVersion must be 1, got ${String(config.schemaVersion)}`);
  }
  if (!Array.isArray(config.targets)) {
    throw new Error(`${path}: targets must be an array`);
  }

  const names = new Set<string>();
  const dirs = new Set<string>();
  for (const target of config.targets) {
    for (const key of REQUIRED_TARGET_KEYS) {
      if (!target[key]) {
        throw new Error(`${path}: target missing "${key}": ${JSON.stringify(target)}`);
      }
    }
    if (names.has(target.name)) {
      throw new Error(`${path}: duplicate target name "${target.name}"`);
    }
    if (dirs.has(target.dir)) {
      throw new Error(`${path}: duplicate target dir "${target.dir}"`);
    }
    names.add(target.name);
    dirs.add(target.dir);
  }

  return config;
}

/**
 * Pattern forms, in the order they are tested:
 *   "docs/**"        directory prefix
 *   "*.md"           extension, repository root only
 *   "pnpm-lock.yaml" exact path
 */
export function matchAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      return file.startsWith(pattern.slice(0, -2));
    }
    if (pattern.startsWith('*.')) {
      return file.endsWith(pattern.slice(1)) && !file.includes('/');
    }
    return file === pattern;
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 8 tests.

- [ ] **Step 7: Format and commit**

```bash
pnpm biome check --write config/ci-targets.json scripts/ci
git add config/ci-targets.json scripts/ci/lib/targets.mts scripts/ci/targets.test.ts scripts/ci/__fixtures__
git commit -m "feat(ci): add deployable target manifest and validating loader"
```

---

### Task 3: Workspace dependency graph

Computes recursive workspace consumers from `package.json` files so a `@tryme/types` change selects exactly `web`, `api`, `chatbot`, `dispatcher` (§4.2) — derived from real edges, never a hardcoded table.

**Files:**
- Create: `scripts/ci/lib/workspace.mts`
- Test: `scripts/ci/workspace.test.ts`

**Interfaces:**
- Consumes: `TargetsConfig` and `loadTargets` from Task 2.
- Produces:
  - `interface WorkspaceMember { name: string; dir: string; workspaceDeps: string[] }`
  - `function listWorkspaceManifests(cwd?: string): string[]`
  - `function readWorkspaceMembers(manifestPaths: string[], read?: (p: string) => string): WorkspaceMember[]`
  - `function buildDependentsGraph(members: WorkspaceMember[]): Map<string, string[]>`
  - `function recursiveConsumers(graph: Map<string, string[]>, pkg: string): string[]`
  - `function assertTargetsMatchWorkspace(config: TargetsConfig, members: WorkspaceMember[]): void`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTargets } from './lib/targets.mts';
import {
  assertTargetsMatchWorkspace,
  buildDependentsGraph,
  listWorkspaceManifests,
  readWorkspaceMembers,
  recursiveConsumers,
} from './lib/workspace.mts';

const FAKE_MANIFESTS: Record<string, string> = {
  'packages/types/package.json': JSON.stringify({ name: '@tryme/types' }),
  'packages/db/package.json': JSON.stringify({
    name: '@tryme/db',
    dependencies: { '@tryme/types': 'workspace:*', drizzle: '^1.0.0' },
  }),
  'apps/api/package.json': JSON.stringify({
    name: '@tryme/api',
    dependencies: { '@tryme/db': 'workspace:*' },
    devDependencies: { vitest: '^2.1.3' },
  }),
  'apps/catalogues-web/package.json': JSON.stringify({
    name: '@tryme/web',
    dependencies: { '@tryme/types': 'workspace:*' },
  }),
  'apps/merchant-web/package.json': JSON.stringify({ private: true }),
};

const fakeRead = (p: string): string => FAKE_MANIFESTS[p];

describe('readWorkspaceMembers', () => {
  it('records the directory and workspace-protocol dependencies', () => {
    const members = readWorkspaceMembers(Object.keys(FAKE_MANIFESTS), fakeRead);
    const api = members.find((m) => m.name === '@tryme/api');
    expect(api?.dir).toBe('apps/api');
    expect(api?.workspaceDeps).toEqual(['@tryme/db']);
  });

  it('skips manifests without a name field', () => {
    const members = readWorkspaceMembers(Object.keys(FAKE_MANIFESTS), fakeRead);
    expect(members.map((m) => m.dir)).not.toContain('apps/merchant-web');
  });

  it('ignores non-workspace dependencies', () => {
    const members = readWorkspaceMembers(Object.keys(FAKE_MANIFESTS), fakeRead);
    const db = members.find((m) => m.name === '@tryme/db');
    expect(db?.workspaceDeps).toEqual(['@tryme/types']);
  });
});

describe('recursiveConsumers', () => {
  const graph = buildDependentsGraph(readWorkspaceMembers(Object.keys(FAKE_MANIFESTS), fakeRead));

  it('walks transitively', () => {
    expect(recursiveConsumers(graph, '@tryme/types')).toEqual([
      '@tryme/api',
      '@tryme/db',
      '@tryme/web',
    ]);
  });

  it('returns direct consumers for a leaf-adjacent package', () => {
    expect(recursiveConsumers(graph, '@tryme/db')).toEqual(['@tryme/api']);
  });

  it('returns nothing for a package nobody depends on', () => {
    expect(recursiveConsumers(graph, '@tryme/api')).toEqual([]);
  });
});

describe('real repository workspace', () => {
  const members = readWorkspaceMembers(listWorkspaceManifests());
  const graph = buildDependentsGraph(members);
  const config = loadTargets('config/ci-targets.json');
  const targetPackages = new Set(config.targets.map((t) => t.packageName));
  const consumersAsTargets = (pkg: string): string[] =>
    recursiveConsumers(graph, pkg)
      .filter((p) => targetPackages.has(p))
      .map((p) => config.targets.find((t) => t.packageName === p)?.name ?? p)
      .sort();

  it('every manifest target directory exists in the workspace with the declared name', () => {
    expect(() => assertTargetsMatchWorkspace(config, members)).not.toThrow();
  });

  it('excludes git-ignored and untracked directories', () => {
    const dirs = members.map((m) => m.dir);
    expect(dirs).not.toContain('apps/admin-mobile');
    expect(dirs).not.toContain('apps/web');
    expect(dirs).not.toContain('apps/admin');
    expect(dirs).not.toContain('apps/merchant-web');
  });

  it('reproduces the documented shared-package impact table', () => {
    expect(consumersAsTargets('@tryme/types')).toEqual([
      'api',
      'chatbot',
      'dispatcher',
      'web',
    ]);
    expect(consumersAsTargets('@tryme/db')).toEqual(['api', 'chatbot', 'dispatcher']);
    expect(consumersAsTargets('@tryme/storage')).toEqual(['api', 'dispatcher']);
    expect(consumersAsTargets('@tryme/logger')).toEqual(['api', 'chatbot', 'dispatcher']);
    expect(consumersAsTargets('@tryme/observability')).toEqual([
      'api',
      'chatbot',
      'dispatcher',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `Failed to resolve import "./lib/workspace.mts"`.

- [ ] **Step 3: Implement the workspace module**

Create `scripts/ci/lib/workspace.mts`:

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { TargetsConfig } from './targets.mts';

export interface WorkspaceMember {
  name: string;
  dir: string;
  workspaceDeps: string[];
}

interface RawManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Tracked manifests only. Untracked and git-ignored directories must not influence CI. */
export function listWorkspaceManifests(cwd = process.cwd()): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', 'apps/*/package.json', 'packages/*/package.json'],
    { cwd, encoding: 'utf8' },
  );
  return out.split('\0').filter((p) => p.length > 0);
}

export function readWorkspaceMembers(
  manifestPaths: string[],
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): WorkspaceMember[] {
  const members: WorkspaceMember[] = [];

  for (const path of manifestPaths) {
    const manifest = JSON.parse(read(path)) as RawManifest;
    if (!manifest.name) continue;

    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const workspaceDeps = Object.entries(deps)
      .filter(([name, range]) => name.startsWith('@tryme/') && String(range).startsWith('workspace:'))
      .map(([name]) => name)
      .sort();

    members.push({ name: manifest.name, dir: path.slice(0, path.lastIndexOf('/')), workspaceDeps });
  }

  return members.sort((a, b) => a.name.localeCompare(b.name));
}

/** package name -> packages that depend on it directly. */
export function buildDependentsGraph(members: WorkspaceMember[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const member of members) graph.set(member.name, []);

  for (const member of members) {
    for (const dep of member.workspaceDeps) {
      const existing = graph.get(dep);
      if (existing) existing.push(member.name);
      else graph.set(dep, [member.name]);
    }
  }

  for (const [key, value] of graph) {
    graph.set(key, [...new Set(value)].sort());
  }
  return graph;
}

export function recursiveConsumers(graph: Map<string, string[]>, pkg: string): string[] {
  const seen = new Set<string>();
  const stack = [pkg];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const dependent of graph.get(current) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      stack.push(dependent);
    }
  }

  return [...seen].sort();
}

/**
 * Guards the class of bug that motivates the explicit `dir` field: a directory rename
 * or a package rename that silently detaches a target from its source.
 */
export function assertTargetsMatchWorkspace(
  config: TargetsConfig,
  members: WorkspaceMember[],
): void {
  const byDir = new Map(members.map((m) => [m.dir, m.name]));

  for (const target of config.targets) {
    const actual = byDir.get(target.dir);
    if (!actual) {
      throw new Error(
        `ci-targets.json target "${target.name}" points at "${target.dir}", which is not a tracked workspace member`,
      );
    }
    if (actual !== target.packageName) {
      throw new Error(
        `ci-targets.json target "${target.name}" declares packageName "${target.packageName}" but "${target.dir}" is "${actual}"`,
      );
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 18 tests total. The `reproduces the documented shared-package impact table` case is the important one — it proves the graph matches `docs/production-cicd-plan.md` §4.2 without hardcoding it.

- [ ] **Step 5: Format and commit**

```bash
pnpm biome check --write scripts/ci
git add scripts/ci/lib/workspace.mts scripts/ci/workspace.test.ts
git commit -m "feat(ci): derive recursive workspace consumers from package manifests"
```

---

### Task 4: Path classifier

The pure core. Takes changed paths and produces the full `DetectResult`, covering every row of §5.3 and every fail-safe case in §5.2.

**Files:**
- Create: `scripts/ci/lib/classify.mts`
- Test: `scripts/ci/classify.test.ts`

**Interfaces:**
- Consumes: `TargetsConfig`, `matchAny` (Task 2); `WorkspaceMember`, `recursiveConsumers` (Task 3).
- Produces:
  - `interface DetectResult { schemaVersion: 1; baseSha: string; headSha: string; changedFiles: string[]; changedPackages: string[]; affectedPackages: string[]; services: string[]; testTargets: string[]; migrationChanged: boolean; deploymentBundleChanged: boolean; infrastructureChanged: boolean; ciChanged: boolean; docsOnly: boolean; fallbackToAll: boolean; reasons: Record<string, string[]> }`
  - `interface ClassifyInput { baseSha: string; headSha: string; changedFiles: string[]; config: TargetsConfig; members: WorkspaceMember[]; graph: Map<string, string[]>; fallbackReason?: string }`
  - `function classify(input: ClassifyInput): DetectResult`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classify } from './lib/classify.mts';
import { loadTargets } from './lib/targets.mts';
import {
  buildDependentsGraph,
  listWorkspaceManifests,
  readWorkspaceMembers,
} from './lib/workspace.mts';

const config = loadTargets('config/ci-targets.json');
const members = readWorkspaceMembers(listWorkspaceManifests());
const graph = buildDependentsGraph(members);

const run = (changedFiles: string[], fallbackReason?: string) =>
  classify({
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    changedFiles,
    config,
    members,
    graph,
    fallbackReason,
  });

const ALL_SERVICES = ['admin', 'api', 'chatbot', 'dispatcher', 'shopify-admin', 'web'];

describe('documentation changes', () => {
  it('classifies a docs-only change as docsOnly with no services', () => {
    const result = run(['docs/readme.md']);
    expect(result.docsOnly).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });

  it('treats root markdown as documentation', () => {
    expect(run(['README.md']).docsOnly).toBe(true);
  });

  it('does not treat markdown inside a service as documentation', () => {
    const result = run(['apps/api/README.md']);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(['api']);
  });

  it('is not docsOnly when a deleted service file accompanies a docs change', () => {
    const result = run(['docs/readme.md', 'apps/api/src/server.ts']);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(['api']);
  });
});

describe('per-service directories that differ from the target name', () => {
  it('maps apps/catalogues-web to web', () => {
    expect(run(['apps/catalogues-web/src/app/page.tsx']).services).toEqual(['web']);
  });

  it('maps apps/admin-web to admin', () => {
    expect(run(['apps/admin-web/src/App.tsx']).services).toEqual(['admin']);
  });

  it('maps apps/shopify to shopify-admin', () => {
    expect(run(['apps/shopify/src/main.tsx']).services).toEqual(['shopify-admin']);
  });

  it('maps a service Dockerfile to its own service', () => {
    expect(run(['apps/dispatcher/Dockerfile']).services).toEqual(['dispatcher']);
  });
});

describe('shared packages', () => {
  it('selects all recursive consumers of types', () => {
    const result = run(['packages/types/src/jobs.ts']);
    expect(result.services).toEqual(['api', 'chatbot', 'dispatcher', 'web']);
    expect(result.changedPackages).toEqual(['@tryme/types']);
  });

  it('selects db consumers and flags migrations', () => {
    const result = run(['packages/db/src/migrations/0117_add_column.sql']);
    expect(result.migrationChanged).toBe(true);
    expect(result.services).toEqual(['api', 'chatbot', 'dispatcher']);
  });

  it('flags the migration journal', () => {
    expect(run(['packages/db/src/migrations/meta/_journal.json']).migrationChanged).toBe(true);
  });

  it('does not flag migrations for an ordinary db source change', () => {
    const result = run(['packages/db/src/schema/jobs.ts']);
    expect(result.migrationChanged).toBe(false);
    expect(result.services).toEqual(['api', 'chatbot', 'dispatcher']);
  });
});

describe('global and infrastructure paths', () => {
  it('falls back to all services on a lockfile change', () => {
    const result = run(['pnpm-lock.yaml']);
    expect(result.fallbackToAll).toBe(true);
    expect(result.services).toEqual(ALL_SERVICES);
  });

  it('falls back to all services on a .dockerignore change', () => {
    expect(run(['.dockerignore']).services).toEqual(ALL_SERVICES);
  });

  it('flags infrastructure without selecting services', () => {
    const result = run(['infra/docker-compose.prod.yml']);
    expect(result.infrastructureChanged).toBe(true);
    expect(result.services).toEqual([]);
    expect(result.docsOnly).toBe(false);
  });

  it('flags a CI change without selecting services', () => {
    const result = run(['.github/workflows/ci.yml']);
    expect(result.ciChanged).toBe(true);
    expect(result.services).toEqual([]);
  });

  it('flags a deployment bundle change without selecting services', () => {
    const result = run(['.env.production.example']);
    expect(result.deploymentBundleChanged).toBe(true);
    expect(result.services).toEqual([]);
  });
});

describe('separate release surfaces', () => {
  it('does not deploy for the Shopify theme extension', () => {
    const result = run(['apps/shopify-extension/blocks/widget.liquid']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
    expect(result.docsOnly).toBe(false);
  });

  it('handles a directory name containing an ampersand', () => {
    const result = run(['apps/virtual-tryon-mobile&kiosk_latest/app/index.tsx']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });

  it('does not deploy for the native Android app, which has no package.json', () => {
    const result = run(['apps/saree_catalogue_android/app/build.gradle.kts']);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
    expect(result.docsOnly).toBe(false);
  });
});

describe('fail-safe behaviour', () => {
  it('falls back to all services for an unmapped path under apps/', () => {
    const result = run(['apps/brand-new-thing/src/index.ts']);
    expect(result.fallbackToAll).toBe(true);
    expect(result.services).toEqual(ALL_SERVICES);
    expect(result.reasons.ALL.join(' ')).toMatch(/unmapped production path/);
  });

  it('falls back to all services for an unmapped top-level path', () => {
    expect(run(['deploy.sh']).fallbackToAll).toBe(true);
  });

  it('falls back to all services when the caller reports an unusable diff range', () => {
    const result = run(['docs/readme.md'], 'force-push: no usable merge base');
    expect(result.fallbackToAll).toBe(true);
    expect(result.docsOnly).toBe(false);
    expect(result.services).toEqual(ALL_SERVICES);
  });

  it('treats an empty diff as docs-only-equivalent and deploys nothing', () => {
    const result = run([]);
    expect(result.services).toEqual([]);
    expect(result.fallbackToAll).toBe(false);
  });
});

describe('test targets', () => {
  it('selects only packages with unit tests wired into CI', () => {
    expect(run(['packages/types/src/jobs.ts']).testTargets).toEqual([
      '@tryme/api',
      '@tryme/dispatcher',
    ]);
  });

  it('selects no test targets for a frontend-only change', () => {
    expect(run(['apps/admin-web/src/App.tsx']).testTargets).toEqual([]);
  });
});

describe('reasons', () => {
  it('records why each service was selected', () => {
    const result = run(['apps/api/src/server.ts', 'packages/types/src/jobs.ts']);
    expect(result.reasons['@tryme/types']).toEqual(['packages/types/src/jobs.ts']);
    expect(result.reasons.api).toEqual(['apps/api/src/server.ts']);
  });

  it('is deterministic for the same input in any order', () => {
    const a = run(['packages/types/src/jobs.ts', 'apps/api/src/server.ts']);
    const b = run(['apps/api/src/server.ts', 'packages/types/src/jobs.ts']);
    expect(a.services).toEqual(b.services);
    expect(a.affectedPackages).toEqual(b.affectedPackages);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `Failed to resolve import "./lib/classify.mts"`.

- [ ] **Step 3: Implement the classifier**

Create `scripts/ci/lib/classify.mts`:

```ts
import { matchAny, type TargetsConfig } from './targets.mts';
import { recursiveConsumers, type WorkspaceMember } from './workspace.mts';

export interface DetectResult {
  schemaVersion: 1;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  changedPackages: string[];
  affectedPackages: string[];
  services: string[];
  testTargets: string[];
  migrationChanged: boolean;
  deploymentBundleChanged: boolean;
  infrastructureChanged: boolean;
  ciChanged: boolean;
  docsOnly: boolean;
  fallbackToAll: boolean;
  reasons: Record<string, string[]>;
}

export interface ClassifyInput {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  config: TargetsConfig;
  members: WorkspaceMember[];
  graph: Map<string, string[]>;
  fallbackReason?: string;
}

const MIGRATION_PREFIX = 'packages/db/src/migrations/';

export function classify(input: ClassifyInput): DetectResult {
  const { config, members, graph } = input;

  const result: DetectResult = {
    schemaVersion: 1,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles: [...input.changedFiles].sort(),
    changedPackages: [],
    affectedPackages: [],
    services: [],
    testTargets: [],
    migrationChanged: false,
    deploymentBundleChanged: false,
    infrastructureChanged: false,
    ciChanged: false,
    docsOnly: false,
    fallbackToAll: false,
    reasons: {},
  };

  const addReason = (key: string, why: string): void => {
    const list = (result.reasons[key] ??= []);
    if (!list.includes(why)) list.push(why);
  };

  if (input.fallbackReason) {
    result.fallbackToAll = true;
    addReason('ALL', input.fallbackReason);
  }

  const changedPackages = new Set<string>();
  let sawNonDocsPath = false;

  for (const file of result.changedFiles) {
    if (matchAny(file, config.docsPaths)) {
      addReason('docs', file);
      continue;
    }

    sawNonDocsPath = true;

    if (matchAny(file, config.globalRebuildPaths)) {
      result.fallbackToAll = true;
      addReason('ALL', file);
      continue;
    }

    const surface = config.separateSurfaces.find((s) => file.startsWith(`${s.dir}/`));
    if (surface) {
      addReason('separate-surface', file);
      continue;
    }

    if (file.startsWith(MIGRATION_PREFIX)) {
      result.migrationChanged = true;
    }

    if (matchAny(file, config.ciPaths)) {
      result.ciChanged = true;
      addReason('ci', file);
      continue;
    }

    if (matchAny(file, config.infraPaths)) {
      result.infrastructureChanged = true;
      addReason('infra', file);
      continue;
    }

    if (matchAny(file, config.deploymentBundlePaths)) {
      result.deploymentBundleChanged = true;
      addReason('deployment-bundle', file);
      continue;
    }

    // Targets are checked before generic workspace members: a target directory
    // is also a workspace member, and the target mapping is the specific one.
    const target = config.targets.find((t) => file.startsWith(`${t.dir}/`));
    if (target) {
      changedPackages.add(target.packageName);
      addReason(target.name, file);
      continue;
    }

    const member = members.find((m) => file.startsWith(`${m.dir}/`));
    if (member) {
      changedPackages.add(member.name);
      addReason(member.name, file);
      continue;
    }

    result.fallbackToAll = true;
    addReason('ALL', `unmapped production path: ${file}`);
  }

  result.docsOnly =
    !sawNonDocsPath && !result.fallbackToAll && result.changedFiles.length > 0;

  const affected = new Set<string>(changedPackages);
  for (const pkg of changedPackages) {
    for (const consumer of recursiveConsumers(graph, pkg)) affected.add(consumer);
  }

  const targetByPackage = new Map(config.targets.map((t) => [t.packageName, t.name]));

  if (result.fallbackToAll) {
    result.affectedPackages = members.map((m) => m.name).sort();
    result.services = config.targets.map((t) => t.name).sort();
  } else {
    result.affectedPackages = [...affected].sort();
    result.services = [...affected]
      .map((pkg) => targetByPackage.get(pkg))
      .filter((name): name is string => Boolean(name))
      .sort();
  }

  result.changedPackages = [...changedPackages].sort();

  const testable = new Set(config.testablePackages);
  result.testTargets = result.affectedPackages.filter((pkg) => testable.has(pkg));

  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 46 tests total (18 from Tasks 2–3 plus 28 in this file — count the `it(...)` blocks above if the exact figure ever drifts; the file's own test list is authoritative, not this number).

- [ ] **Step 5: Format and commit**

```bash
pnpm biome check --write scripts/ci
git add scripts/ci/lib/classify.mts scripts/ci/classify.test.ts
git commit -m "feat(ci): classify changed paths into affected deployment targets"
```

---

### Task 5: Diff range resolution and `--name-status -z` parsing

Turns a GitHub event into a concrete SHA range, failing safe whenever the range cannot be established (§5.2), and parses `git diff --name-status -z` including renames, copies, and deletions.

**Files:**
- Create: `scripts/ci/lib/git.mts`
- Test: `scripts/ci/git.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface DiffRange { baseSha: string; headSha: string; fallbackReason?: string }`
  - `type GitRunner = (args: string[]) => string`
  - `function resolveRange(env: NodeJS.ProcessEnv, git?: GitRunner): DiffRange`
  - `function parseNameStatusZ(raw: string): string[]`
  - `function changedFilesBetween(range: DiffRange, git?: GitRunner): string[]`

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/git.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { changedFilesBetween, parseNameStatusZ, resolveRange } from './lib/git.mts';

const ZERO = '0'.repeat(40);
const BEFORE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);

describe('parseNameStatusZ', () => {
  it('parses added and modified entries', () => {
    const raw = ['M', 'apps/api/src/server.ts', 'A', 'docs/new.md', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual(['apps/api/src/server.ts', 'docs/new.md']);
  });

  it('keeps deleted paths so historical classification still applies', () => {
    const raw = ['D', 'apps/api/src/old.ts', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual(['apps/api/src/old.ts']);
  });

  it('returns both sides of a rename', () => {
    const raw = ['R100', 'apps/api/src/a.ts', 'apps/chatbot/src/b.ts', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual(['apps/api/src/a.ts', 'apps/chatbot/src/b.ts']);
  });

  it('returns both sides of a copy', () => {
    const raw = ['C075', 'packages/types/src/a.ts', 'packages/db/src/b.ts', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual(['packages/db/src/b.ts', 'packages/types/src/a.ts']);
  });

  it('handles paths containing spaces and ampersands', () => {
    const raw = ['M', 'apps/virtual-tryon-mobile&kiosk_latest/a b.tsx', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual(['apps/virtual-tryon-mobile&kiosk_latest/a b.tsx']);
  });

  it('returns an empty list for an empty diff', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('resolveRange for push events', () => {
  const okGit = (): string => '';

  it('uses BEFORE_SHA when it is present locally', () => {
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD, BEFORE_SHA: BEFORE },
      okGit,
    );
    expect(range).toEqual({ baseSha: BEFORE, headSha: HEAD });
  });

  it('falls back on the all-zero initial-push SHA', () => {
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD, BEFORE_SHA: ZERO },
      okGit,
    );
    expect(range.fallbackReason).toMatch(/initial push or force-push/);
  });

  it('falls back when BEFORE_SHA is missing', () => {
    const range = resolveRange({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD }, okGit);
    expect(range.fallbackReason).toMatch(/initial push or force-push/);
  });

  it('falls back when BEFORE_SHA is not present in the local object store', () => {
    const failingGit = (): string => {
      throw new Error('fatal: Not a valid object name');
    };
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: HEAD, BEFORE_SHA: BEFORE },
      failingGit,
    );
    expect(range.fallbackReason).toMatch(/not present locally/);
  });
});

describe('resolveRange for pull requests', () => {
  it('uses the merge base with the target branch', () => {
    const git = (args: string[]): string => {
      expect(args).toEqual(['merge-base', 'origin/main', HEAD]);
      return `${MERGE_BASE}\n`;
    };
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: HEAD, GITHUB_BASE_REF: 'main' },
      git,
    );
    expect(range).toEqual({ baseSha: MERGE_BASE, headSha: HEAD });
  });

  it('falls back when the merge base cannot be computed', () => {
    const git = (): string => {
      throw new Error('fatal: Not a valid object name origin/main');
    };
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: HEAD, GITHUB_BASE_REF: 'main' },
      git,
    );
    expect(range.fallbackReason).toMatch(/merge-base/);
  });

  it('falls back when GITHUB_BASE_REF is absent', () => {
    const range = resolveRange(
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: HEAD },
      () => '',
    );
    expect(range.fallbackReason).toMatch(/GITHUB_BASE_REF/);
  });
});

describe('changedFilesBetween', () => {
  it('returns an empty list without running git when the range is a fallback', () => {
    const git = (): string => {
      throw new Error('git should not run for a fallback range');
    };
    expect(changedFilesBetween({ baseSha: '', headSha: HEAD, fallbackReason: 'x' }, git)).toEqual(
      [],
    );
  });

  it('invokes git diff with -z and parses the output', () => {
    const git = (args: string[]): string => {
      expect(args).toEqual(['diff', '--name-status', '-z', `${BEFORE}..${HEAD}`]);
      return ['M', 'apps/api/src/server.ts', ''].join('\0');
    };
    expect(changedFilesBetween({ baseSha: BEFORE, headSha: HEAD }, git)).toEqual([
      'apps/api/src/server.ts',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `Failed to resolve import "./lib/git.mts"`.

- [ ] **Step 3: Implement the git module**

Create `scripts/ci/lib/git.mts`:

```ts
import { execFileSync } from 'node:child_process';

export interface DiffRange {
  baseSha: string;
  headSha: string;
  fallbackReason?: string;
}

export type GitRunner = (args: string[]) => string;

const ZERO_SHA = '0'.repeat(40);

export const runGit: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function resolveRange(env: NodeJS.ProcessEnv, git: GitRunner = runGit): DiffRange {
  const eventName = env.GITHUB_EVENT_NAME ?? 'push';
  const headSha = env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']).trim();

  if (eventName === 'pull_request') {
    const baseRef = env.GITHUB_BASE_REF;
    if (!baseRef) {
      return {
        baseSha: '',
        headSha,
        fallbackReason: 'pull_request event without GITHUB_BASE_REF',
      };
    }
    try {
      return { baseSha: git(['merge-base', `origin/${baseRef}`, headSha]).trim(), headSha };
    } catch {
      return {
        baseSha: '',
        headSha,
        fallbackReason: `merge-base with origin/${baseRef} could not be computed`,
      };
    }
  }

  const before = env.BEFORE_SHA ?? '';
  if (!before || before === ZERO_SHA) {
    return {
      baseSha: '',
      headSha,
      fallbackReason: 'no usable base SHA (initial push or force-push)',
    };
  }

  try {
    git(['cat-file', '-e', `${before}^{commit}`]);
  } catch {
    return {
      baseSha: '',
      headSha,
      fallbackReason: `base SHA ${before} is not present locally`,
    };
  }

  return { baseSha: before, headSha };
}

/**
 * Records are NUL-separated: a status token, then one path, except for R/C
 * statuses which carry two paths. Both sides of a rename or copy are treated
 * as changed. Deleted paths are retained so historical classification applies.
 */
export function parseNameStatusZ(raw: string): string[] {
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const files: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      if (tokens[i + 1]) files.push(tokens[i + 1]);
      if (tokens[i + 2]) files.push(tokens[i + 2]);
      i += 2;
    } else {
      if (tokens[i + 1]) files.push(tokens[i + 1]);
      i += 1;
    }
  }

  return [...new Set(files)].sort();
}

export function changedFilesBetween(range: DiffRange, git: GitRunner = runGit): string[] {
  if (range.fallbackReason || !range.baseSha) return [];
  return parseNameStatusZ(
    git(['diff', '--name-status', '-z', `${range.baseSha}..${range.headSha}`]),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 61 tests total (46 from Tasks 2–4 plus 15 in this file — the file's own test list is authoritative if this number ever drifts).

- [ ] **Step 5: Format and commit**

```bash
pnpm biome check --write scripts/ci
git add scripts/ci/lib/git.mts scripts/ci/git.test.ts
git commit -m "feat(ci): resolve diff ranges and parse name-status output safely"
```

---

### Task 6: Detector CLI

Wires the libraries together and emits the three outputs CI consumes: a JSON artifact, `$GITHUB_OUTPUT` values, and a human-readable job summary.

**Files:**
- Create: `scripts/ci/detect-affected.mts`
- Modify: `package.json` (root — add `ci:detect` script)
- Test: `scripts/ci/detect-affected.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `function renderSummary(result: DetectResult): string`
  - `function outputLines(result: DetectResult): string[]` — the `key=value` lines appended to `$GITHUB_OUTPUT`
  - CLI: `pnpm ci:detect --out <path>`, exit code 0 on success and 1 on any internal error after writing a fail-safe result

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/detect-affected.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetectResult } from './lib/classify.mts';
import { outputLines, renderSummary } from './detect-affected.mts';

const baseResult: DetectResult = {
  schemaVersion: 1,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  changedFiles: ['apps/api/src/server.ts'],
  changedPackages: ['@tryme/api'],
  affectedPackages: ['@tryme/api'],
  services: ['api'],
  testTargets: ['@tryme/api'],
  migrationChanged: false,
  deploymentBundleChanged: false,
  infrastructureChanged: false,
  ciChanged: false,
  docsOnly: false,
  fallbackToAll: false,
  reasons: { api: ['apps/api/src/server.ts'] },
};

describe('outputLines', () => {
  it('emits JSON arrays for matrix inputs and booleans as strings', () => {
    const lines = outputLines(baseResult);
    expect(lines).toContain('services=["api"]');
    expect(lines).toContain('test_targets=["@tryme/api"]');
    expect(lines).toContain('docs_only=false');
    expect(lines).toContain('migration_changed=false');
    expect(lines).toContain('has_deployable=true');
  });

  it('reports has_deployable=false for a docs-only result', () => {
    const lines = outputLines({ ...baseResult, services: [], docsOnly: true });
    expect(lines).toContain('has_deployable=false');
    expect(lines).toContain('docs_only=true');
  });

  it('emits a space-separated compose service list for the deploy step', () => {
    const lines = outputLines({ ...baseResult, services: ['api', 'web'] });
    expect(lines).toContain('compose_services=api web');
  });
});

describe('renderSummary', () => {
  it('lists every selected service with its reasons', () => {
    const summary = renderSummary(baseResult);
    expect(summary).toContain('| `api` |');
    expect(summary).toContain('apps/api/src/server.ts');
  });

  it('states plainly when nothing deploys', () => {
    const summary = renderSummary({ ...baseResult, services: [], docsOnly: true });
    expect(summary).toContain('Documentation-only change');
  });

  it('surfaces the fallback reason', () => {
    const summary = renderSummary({
      ...baseResult,
      fallbackToAll: true,
      reasons: { ALL: ['pnpm-lock.yaml'] },
    });
    expect(summary).toContain('Fell back to all services');
    expect(summary).toContain('pnpm-lock.yaml');
  });
});

describe('CLI end to end', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes the JSON artifact and GITHUB_OUTPUT for a real range', () => {
    dir = mkdtempSync(join(tmpdir(), 'detect-'));
    const outJson = join(dir, 'affected.json');
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');

    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const beforeSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();

    execFileSync('node_modules/.bin/tsx', ['scripts/ci/detect-affected.mts', '--out', outJson], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_SHA: headSha,
        BEFORE_SHA: beforeSha,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      },
      encoding: 'utf8',
    });

    const result = JSON.parse(readFileSync(outJson, 'utf8')) as DetectResult;
    expect(result.schemaVersion).toBe(1);
    expect(result.headSha).toBe(headSha);
    expect(Array.isArray(result.services)).toBe(true);

    const output = readFileSync(outputFile, 'utf8');
    expect(output).toMatch(/^services=/m);
    expect(output).toMatch(/^docs_only=/m);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `Failed to resolve import "./detect-affected.mts"`.

- [ ] **Step 3: Implement the CLI**

Create `scripts/ci/detect-affected.mts`:

```ts
import { appendFileSync, writeFileSync } from 'node:fs';
import { classify, type DetectResult } from './lib/classify.mts';
import { changedFilesBetween, resolveRange } from './lib/git.mts';
import { loadTargets } from './lib/targets.mts';
import {
  assertTargetsMatchWorkspace,
  buildDependentsGraph,
  listWorkspaceManifests,
  readWorkspaceMembers,
} from './lib/workspace.mts';

export function outputLines(result: DetectResult): string[] {
  return [
    `services=${JSON.stringify(result.services)}`,
    `compose_services=${result.services.join(' ')}`,
    `affected_packages=${JSON.stringify(result.affectedPackages)}`,
    `test_targets=${JSON.stringify(result.testTargets)}`,
    `docs_only=${String(result.docsOnly)}`,
    `fallback_to_all=${String(result.fallbackToAll)}`,
    `migration_changed=${String(result.migrationChanged)}`,
    `infrastructure_changed=${String(result.infrastructureChanged)}`,
    `deployment_bundle_changed=${String(result.deploymentBundleChanged)}`,
    `ci_changed=${String(result.ciChanged)}`,
    `has_deployable=${String(result.services.length > 0)}`,
    `has_tests=${String(result.testTargets.length > 0)}`,
    `has_packages=${String(result.affectedPackages.length > 0)}`,
  ];
}

export function renderSummary(result: DetectResult): string {
  const lines: string[] = ['## Affected targets', ''];

  lines.push(`Range: \`${result.baseSha || '(none)'}\` → \`${result.headSha}\``);
  lines.push(`Changed files: ${result.changedFiles.length}`);
  lines.push('');

  if (result.fallbackToAll) {
    lines.push('> **Fell back to all services.** Reasons:');
    for (const reason of result.reasons.ALL ?? []) lines.push(`> - \`${reason}\``);
    lines.push('');
  }

  if (result.docsOnly) {
    lines.push('**Documentation-only change.** No images are built and no deployment runs.');
    lines.push('');
  }

  if (result.services.length === 0) {
    lines.push('No deployable service selected.');
  } else {
    lines.push('| Service | Reasons |');
    lines.push('|---|---|');
    for (const service of result.services) {
      const reasons = result.reasons[service] ?? ['selected through a workspace dependency'];
      lines.push(`| \`${service}\` | ${reasons.map((r) => `\`${r}\``).join('<br>')} |`);
    }
  }

  lines.push('');
  lines.push(`Affected packages: ${result.affectedPackages.length}`);
  lines.push(`Test targets: ${result.testTargets.join(', ') || '(none)'}`);
  lines.push(`Migration changed: ${String(result.migrationChanged)}`);

  return lines.join('\n');
}

function outPathFromArgv(argv: string[]): string {
  const index = argv.indexOf('--out');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : 'affected.json';
}

function main(): void {
  const outPath = outPathFromArgv(process.argv.slice(2));
  const config = loadTargets('config/ci-targets.json');
  const members = readWorkspaceMembers(listWorkspaceManifests());
  assertTargetsMatchWorkspace(config, members);

  const graph = buildDependentsGraph(members);
  const range = resolveRange(process.env);
  const changedFiles = changedFilesBetween(range);

  const result = classify({
    baseSha: range.baseSha,
    headSha: range.headSha,
    changedFiles,
    config,
    members,
    graph,
    fallbackReason: range.fallbackReason,
  });

  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputLines(result).join('\n')}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderSummary(result)}\n`);
  }

  process.stdout.write(`${renderSummary(result)}\n`);
}

// Only run when invoked as a script, so the test file can import the helpers.
if (process.argv[1]?.endsWith('detect-affected.mts')) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`detect-affected failed: ${message}\n`);
    if (process.env.GITHUB_OUTPUT) {
      // Fail safe: an unexpected detector error must select everything.
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        [
          'services=["admin","api","chatbot","dispatcher","shopify-admin","web"]',
          'compose_services=admin api chatbot dispatcher shopify-admin web',
          'docs_only=false',
          'fallback_to_all=true',
          'has_deployable=true',
          'has_tests=true',
          'has_packages=true',
          'migration_changed=true',
          '',
        ].join('\n'),
      );
    }
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Add the root script**

In `package.json`, add to `scripts` immediately after `"test:ci-scripts"`:

```json
    "ci:detect": "tsx scripts/ci/detect-affected.mts",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 68 tests total (61 from Tasks 2–5 plus 7 in this file — the file's own test list is authoritative if this number ever drifts).

- [ ] **Step 6: Run the detector against a real range and read the output**

Run:

```bash
GITHUB_EVENT_NAME=push \
GITHUB_SHA=$(git rev-parse HEAD) \
BEFORE_SHA=$(git rev-parse HEAD~3) \
pnpm ci:detect --out /tmp/affected.json
```

Expected: a Markdown summary on stdout naming the services affected by the last three commits, and `/tmp/affected.json` containing a `schemaVersion: 1` document. Sanity-check that the service list matches what those commits actually touched.

- [ ] **Step 7: Format, add the artifact to gitignore, and commit**

Append to `.gitignore`:

```text
affected.json
```

Then:

```bash
pnpm biome check --write scripts/ci package.json
git add scripts/ci/detect-affected.mts scripts/ci/detect-affected.test.ts package.json .gitignore
git commit -m "feat(ci): add detect-affected CLI with JSON, outputs, and summary"
```

---

### Task 7: Rewrite the CI workflow

Replaces the four unconditional jobs with a `detect` job, conditional work, and a stable `ci-gate` aggregate check. Also adds job-level deploy concurrency and scopes the SSH deploy to affected Compose services.

**Files:**
- Modify: `.github/workflows/ci.yml` (full rewrite)

**Interfaces:**
- Consumes: `pnpm ci:detect` and its `$GITHUB_OUTPUT` keys from Task 6 — `services`, `compose_services`, `test_targets`, `docs_only`, `fallback_to_all`, `migration_changed`, `has_deployable`, `has_tests`, `has_packages`.
- Produces: a required status check named `ci-gate`.

- [ ] **Step 1: Record the current baseline before changing anything**

Run:

```bash
gh run list --workflow=CI --branch=main --limit 5
```

Expected: recent `main` runs in the 7–11 minute range. Write the numbers into the PR description later; §16 Phase 0 wants this baseline.

- [ ] **Step 2: Rewrite the workflow**

Replace the entire contents of `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Pull requests supersede themselves; main pushes never cancel each other.
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  PNPM_VERSION: 9.12.0
  NODE_VERSION: 22

jobs:
  detect:
    name: Detect affected targets
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      services: ${{ steps.detect.outputs.services }}
      compose_services: ${{ steps.detect.outputs.compose_services }}
      test_targets: ${{ steps.detect.outputs.test_targets }}
      docs_only: ${{ steps.detect.outputs.docs_only }}
      fallback_to_all: ${{ steps.detect.outputs.fallback_to_all }}
      migration_changed: ${{ steps.detect.outputs.migration_changed }}
      has_deployable: ${{ steps.detect.outputs.has_deployable }}
      has_tests: ${{ steps.detect.outputs.has_tests }}
      has_packages: ${{ steps.detect.outputs.has_packages }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Detect affected targets
        id: detect
        env:
          BEFORE_SHA: ${{ github.event.before }}
        run: pnpm ci:detect --out affected.json

      - name: Upload detector result
        uses: actions/upload-artifact@v4
        with:
          name: affected-targets
          path: affected.json
          retention-days: 14

  lint:
    name: Lint & format
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [detect]
    if: needs.detect.outputs.docs_only != 'true'

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Biome check
        run: pnpm biome check .

  typecheck:
    name: Typecheck
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [detect]
    if: needs.detect.outputs.has_packages == 'true'

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared packages
        run: |
          pnpm --filter @tryme/db build
          pnpm --filter @tryme/types build
          pnpm --filter @tryme/logger build
          pnpm --filter @tryme/storage build
          pnpm --filter @tryme/observability build

      # Per-package typecheck filtering is Phase 2. Phase 1 keeps the whole-workspace
      # typecheck but now skips this job entirely for docs-only pushes, which is where
      # the time is actually saved.
      - name: Typecheck workspace
        run: pnpm -r --filter "!@tryme/admin-mobile" run typecheck

  test:
    name: Unit tests (${{ matrix.package }})
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [detect]
    if: needs.detect.outputs.has_tests == 'true'
    strategy:
      fail-fast: false
      matrix:
        package: ${{ fromJSON(needs.detect.outputs.test_targets) }}

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared packages
        run: |
          pnpm --filter @tryme/db build
          pnpm --filter @tryme/types build
          pnpm --filter @tryme/logger build
          pnpm --filter @tryme/storage build
          pnpm --filter @tryme/observability build

      # Both suites use apps/api/test/helpers/containers.ts, which provisions a
      # fresh database and bucket against these services on localhost.
      - name: Start test infra (Postgres, Redis, MinIO)
        run: docker compose -f infra/docker-compose.yml up -d --wait postgres redis minio

      - name: Run unit tests
        run: pnpm --filter ${{ matrix.package }} test:unit

  ci-scripts:
    name: Detector tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [detect]

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run detector tests
        run: pnpm test:ci-scripts

  ci-gate:
    name: ci-gate
    runs-on: ubuntu-latest
    timeout-minutes: 5
    if: always()
    needs: [detect, lint, typecheck, test, ci-scripts]

    steps:
      - name: Fail if any required job failed or was cancelled
        env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
        run: |
          set -euo pipefail
          echo "dependency results: ${RESULTS}"
          for result in ${RESULTS}; do
            case "${result}" in
              success|skipped) ;;
              *) echo "::error::a required job reported '${result}'"; exit 1 ;;
            esac
          done
          echo "all required jobs succeeded or were intentionally skipped"

  deploy:
    name: Deploy affected services
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [detect, ci-gate]
    if: >-
      github.ref == 'refs/heads/main' &&
      github.event_name == 'push' &&
      needs.detect.outputs.has_deployable == 'true'
    concurrency:
      group: tryme-production
      cancel-in-progress: false

    steps:
      - name: Deploy via SSH
        env:
          SSH_KEY: ${{ secrets.VPS_SSH_KEY }}
          VPS_HOST: ${{ secrets.VPS_HOST }}
          VPS_USER: ${{ secrets.VPS_USER }}
          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
          SERVICES: ${{ needs.detect.outputs.compose_services }}
          MIGRATION_CHANGED: ${{ needs.detect.outputs.migration_changed }}
        run: |
          set -euo pipefail
          trap 'rm -f /tmp/deploy_key' EXIT

          install -m 600 /dev/null /tmp/deploy_key
          echo "$SSH_KEY" > /tmp/deploy_key

          echo "deploying services: ${SERVICES}"

          ssh -i /tmp/deploy_key \
              -o StrictHostKeyChecking=no \
              -o ConnectTimeout=15 \
              "${VPS_USER}@${VPS_HOST}" \
              "set -euo pipefail
               SERVICES='${SERVICES}'
               MIGRATION_CHANGED='${MIGRATION_CHANGED}'
               COMPOSE=\"docker compose -f infra/docker-compose.prod.yml --env-file .env.production\"

               echo '→ pulling latest code'
               git config --global --add safe.directory ${DEPLOY_PATH}
               cd ${DEPLOY_PATH}
               git fetch https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git main
               git reset --hard FETCH_HEAD

               echo \"→ building images for: \${SERVICES}\"
               \${COMPOSE} build \${SERVICES}

               if [ \"\${MIGRATION_CHANGED}\" = 'true' ]; then
                 echo '→ applying DB migrations'
                 \${COMPOSE} run --rm api pnpm db:migrate:prod
               else
                 echo '→ no migration changes; skipping migrate'
               fi

               echo '→ verifying all migrations applied'
               \${COMPOSE} run --rm api pnpm db:verify:prod

               echo \"→ recreating: \${SERVICES}\"
               \${COMPOSE} up -d --no-deps --force-recreate \${SERVICES}

               echo '→ cleaning dangling images'
               docker image prune -f

               echo \"✓ deploy done: \${SERVICES}\""
```

Three deliberate changes to the deploy step, each traceable to `docs/production-cicd-plan.md` §16 Phase 1:

- `pull postgres redis` and `up -d --force-recreate postgres` are **removed**. Stateful services leave the ordinary application restart path. Base-image updates become a manual infrastructure operation.
- `build` and `up` are **scoped** to `${SERVICES}`, and `up` gains `--no-deps` so Compose cannot pull `postgres`/`redis` into the recreate set as dependencies.
- Migrations run only when `migration_changed=true`; `db:verify:prod` still runs on every deploy because it is read-only, fast, and catches drift.

- [ ] **Step 3: Validate the YAML parses**

Run:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
```

Expected: `yaml ok`. A parse error here means an indentation or quoting mistake in the heredoc-style SSH block.

- [ ] **Step 4: Commit and push a branch to exercise the pull-request path**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate jobs on affected-target detection and scope production deploy"
git checkout -b ci/phase1-affected-detection
git push -u origin ci/phase1-affected-detection
```

- [ ] **Step 5: Verify the pull-request run**

Run:

```bash
gh pr create --fill --base main
gh run watch
```

Expected: `detect`, `lint`, `typecheck`, `test`, `ci-scripts`, and `ci-gate` all run; `deploy` is skipped because the event is `pull_request`. Open the `detect` job summary and confirm the affected-services table names the services this branch actually touches.

- [ ] **Step 6: Verify the docs-only path on the same branch**

Run:

```bash
echo >> docs/production-cicd-plan.md
git commit -am "docs: whitespace touch to exercise docs-only detection"
git push
gh run watch
```

Expected: `detect` reports `docsOnly=true`; `lint`, `typecheck`, and `test` are **skipped**; `ci-gate` still reports **success**. This is the §5.5 required-check behaviour — confirm `ci-gate` is green while its dependencies are skipped, then revert the whitespace commit.

- [ ] **Step 7: Configure branch protection**

In the repository settings, set the required status check for `main` to `ci-gate` only. Remove `Lint & format`, `Typecheck`, and `Unit tests` from the required list — they are now conditional and will block merges permanently if left required.

This is a GitHub UI change, not a code change. Confirm it before merging, or a docs-only PR will be unmergeable.

- [ ] **Step 8: Verify the deploy path after merge**

After the PR merges to `main`, run:

```bash
gh run watch
```

Expected: the `deploy` job runs and its log shows `deploying services:` naming only the services this merge touched, `→ no migration changes; skipping migrate` (assuming no migration in the merge), and `✓ deploy done:` with the same list.

Then, on the VPS, confirm the §16 Phase 1 exit criteria:

```bash
docker ps --format '{{.Names}}\t{{.ID}}\t{{.CreatedAt}}'
```

Expected: `tryme-prod-postgres`, `tryme-prod-redis`, and `tryme-prod-minio` show their **pre-deploy** container IDs and creation times. Only the deployed services show new IDs. If any stateful container was recreated, the `--no-deps` flag or the service scoping is wrong — stop and fix before proceeding to Phase 2.

- [ ] **Step 9: Update the progress log and commit**

Add a dated entry at the top of `docs/progress.md`:

```markdown
## 2026-07-21 — Phase 1 CI affected-target detection

**Done**
- Added `config/ci-targets.json` and `scripts/ci/` detector with 68 tests.
- Rewrote `.github/workflows/ci.yml`: `detect` job, conditional lint/typecheck/test, stable `ci-gate`.
- Scoped the production deploy to affected Compose services; removed Postgres/Redis from the restart path; migrations now run only when `migration_changed=true`.
- Branch protection now requires `ci-gate` only.
- Added a 02:30 UTC nightly full-monorepo validation run and a `workflow_dispatch` override (`force_all`, `services`) as guards against detector misclassification.

**Failed / Not Done**
- Per-package typecheck filtering deferred to Phase 2; the workspace typecheck still runs whole.
- `docker image prune -f` still unconditional; retention policy is Phase 2 (§11.9).
- Nightly failures surface only in the Actions tab; alert routing is Phase 2 (§15).

**Open Questions / Decisions**
- Baseline CI duration before this change: <fill in from Step 1>. After: <fill in>.
```

Then:

```bash
git add docs/progress.md
git commit -m "docs(progress): log Phase 1 CI affected-target detection"
```

---

### Task 8: Nightly full run and manual override

Phase 1 introduces a new silent-failure mode: if the detector misclassifies, the affected service simply does not deploy — no error, no alert. This task adds the two guards that make that recoverable: a nightly run that validates the whole monorepo regardless of any diff, and a `workflow_dispatch` escape hatch to force a full or hand-picked deploy without pushing a dummy commit.

**Files:**
- Create: `scripts/ci/override.test.ts`
- Modify: `scripts/ci/detect-affected.mts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `DetectResult` (Task 4), `TargetsConfig` (Task 2), the CLI `main()` (Task 6).
- Produces: `function applyManualOverride(result: DetectResult, env: NodeJS.ProcessEnv, config: TargetsConfig): DetectResult`, honouring the `FORCE_ALL` and `SERVICES_OVERRIDE` environment variables.

- [ ] **Step 1: Write the failing tests**

Create `scripts/ci/override.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyManualOverride } from './detect-affected.mts';
import type { DetectResult } from './lib/classify.mts';
import { loadTargets } from './lib/targets.mts';

const config = loadTargets('config/ci-targets.json');

const docsOnlyResult: DetectResult = {
  schemaVersion: 1,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  changedFiles: ['docs/readme.md'],
  changedPackages: [],
  affectedPackages: [],
  services: [],
  testTargets: [],
  migrationChanged: false,
  deploymentBundleChanged: false,
  infrastructureChanged: false,
  ciChanged: false,
  docsOnly: true,
  fallbackToAll: false,
  reasons: { docs: ['docs/readme.md'] },
};

const ALL_SERVICES = ['admin', 'api', 'chatbot', 'dispatcher', 'shopify-admin', 'web'];

describe('applyManualOverride with no override set', () => {
  it('returns the result unchanged', () => {
    expect(applyManualOverride(docsOnlyResult, {}, config)).toEqual(docsOnlyResult);
  });

  it('ignores FORCE_ALL values other than "true"', () => {
    expect(applyManualOverride(docsOnlyResult, { FORCE_ALL: 'false' }, config)).toEqual(
      docsOnlyResult,
    );
    expect(applyManualOverride(docsOnlyResult, { FORCE_ALL: '' }, config)).toEqual(
      docsOnlyResult,
    );
  });
});

describe('applyManualOverride with FORCE_ALL', () => {
  const forced = () => applyManualOverride(docsOnlyResult, { FORCE_ALL: 'true' }, config);

  it('selects every service even for a docs-only diff', () => {
    expect(forced().services).toEqual(ALL_SERVICES);
  });

  it('clears docsOnly so downstream jobs do not skip', () => {
    expect(forced().docsOnly).toBe(false);
  });

  it('marks the result as a fallback and records why', () => {
    const result = forced();
    expect(result.fallbackToAll).toBe(true);
    expect(result.reasons.ALL).toContain('manual override: force_all');
  });

  it('selects every testable package', () => {
    expect(forced().testTargets).toEqual(['@tryme/api', '@tryme/dispatcher']);
  });

  it('forces migrations to be considered changed so verify still runs', () => {
    expect(forced().migrationChanged).toBe(true);
  });
});

describe('applyManualOverride with SERVICES_OVERRIDE', () => {
  it('selects exactly the named services', () => {
    const result = applyManualOverride(
      docsOnlyResult,
      { SERVICES_OVERRIDE: 'api,web' },
      config,
    );
    expect(result.services).toEqual(['api', 'web']);
    expect(result.docsOnly).toBe(false);
    expect(result.reasons.MANUAL).toContain('manual override: services=api,web');
  });

  it('tolerates surrounding whitespace', () => {
    const result = applyManualOverride(
      docsOnlyResult,
      { SERVICES_OVERRIDE: ' api , web ' },
      config,
    );
    expect(result.services).toEqual(['api', 'web']);
  });

  it('rejects an unknown service name rather than deploying nothing', () => {
    expect(() =>
      applyManualOverride(docsOnlyResult, { SERVICES_OVERRIDE: 'api,frontend' }, config),
    ).toThrow(/unknown service "frontend"/);
  });

  it('rejects an empty override string as a mistake', () => {
    expect(() =>
      applyManualOverride(docsOnlyResult, { SERVICES_OVERRIDE: ' , ' }, config),
    ).toThrow(/no valid service names/);
  });

  it('refuses to guess when both overrides are supplied', () => {
    expect(() =>
      applyManualOverride(
        docsOnlyResult,
        { FORCE_ALL: 'true', SERVICES_OVERRIDE: 'api' },
        config,
      ),
    ).toThrow(/both FORCE_ALL and SERVICES_OVERRIDE/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:ci-scripts`

Expected: FAIL with `applyManualOverride is not a function` or an export-not-found error.

- [ ] **Step 3: Implement the override helper**

In `scripts/ci/detect-affected.mts`, add this export immediately after `renderSummary`:

```ts
export function applyManualOverride(
  result: DetectResult,
  env: NodeJS.ProcessEnv,
  config: TargetsConfig,
): DetectResult {
  const forceAll = env.FORCE_ALL === 'true';
  const rawServices = (env.SERVICES_OVERRIDE ?? '').trim();

  if (forceAll && rawServices.length > 0) {
    throw new Error(
      'both FORCE_ALL and SERVICES_OVERRIDE were supplied; pick one so the intent is unambiguous',
    );
  }

  const allTestable = [...config.testablePackages].sort();

  if (rawServices.length > 0) {
    const known = new Set(config.targets.map((t) => t.name));
    const requested = rawServices
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (requested.length === 0) {
      throw new Error(`SERVICES_OVERRIDE "${rawServices}" contains no valid service names`);
    }
    for (const name of requested) {
      if (!known.has(name)) {
        throw new Error(
          `SERVICES_OVERRIDE: unknown service "${name}"; valid names are ${[...known].sort().join(', ')}`,
        );
      }
    }

    return {
      ...result,
      services: [...new Set(requested)].sort(),
      testTargets: allTestable,
      docsOnly: false,
      reasons: {
        ...result.reasons,
        MANUAL: [`manual override: services=${requested.join(',')}`],
      },
    };
  }

  if (forceAll) {
    return {
      ...result,
      services: config.targets.map((t) => t.name).sort(),
      affectedPackages: [...new Set([...result.affectedPackages, ...allTestable])].sort(),
      testTargets: allTestable,
      // A forced run cannot know whether schema is in sync, so it always verifies.
      migrationChanged: true,
      docsOnly: false,
      fallbackToAll: true,
      reasons: {
        ...result.reasons,
        ALL: [...(result.reasons.ALL ?? []), 'manual override: force_all'],
      },
    };
  }

  return result;
}
```

Add `TargetsConfig` to the existing `targets.mts` import at the top of the file:

```ts
import { loadTargets, type TargetsConfig } from './lib/targets.mts';
```

- [ ] **Step 4: Wire the override into the CLI**

In `main()`, replace the `writeFileSync(outPath, ...)` line and the `classify` call that precedes it so the override is applied before anything is written:

```ts
  const classified = classify({
    baseSha: range.baseSha,
    headSha: range.headSha,
    changedFiles,
    config,
    members,
    graph,
    fallbackReason: range.fallbackReason,
  });

  const result = applyManualOverride(classified, process.env, config);

  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:ci-scripts`

Expected: PASS, 80 tests total (68 from Tasks 2–6 plus 12 in this file — the file's own test list is authoritative if this number ever drifts).

- [ ] **Step 6: Verify the override from the command line**

Run:

```bash
FORCE_ALL=true \
GITHUB_EVENT_NAME=push \
GITHUB_SHA=$(git rev-parse HEAD) \
BEFORE_SHA=$(git rev-parse HEAD~1) \
pnpm ci:detect --out /tmp/forced.json

python3 -c "import json;d=json.load(open('/tmp/forced.json'));print(d['services'], d['fallbackToAll'], d['docsOnly'])"
```

Expected: `['admin', 'api', 'chatbot', 'dispatcher', 'shopify-admin', 'web'] True False`.

Then confirm the rejection path:

```bash
SERVICES_OVERRIDE=api,nope pnpm ci:detect --out /tmp/bad.json; echo "exit=$?"
```

Expected: stderr contains `unknown service "nope"` and `exit=1`.

- [ ] **Step 7: Add the schedule and dispatch triggers to the workflow**

In `.github/workflows/ci.yml`, replace the `on:` block:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    # 02:30 UTC daily — validates the whole monorepo regardless of any diff, so a
    # detector misclassification surfaces within a day instead of at the next incident.
    - cron: '30 2 * * *'
  workflow_dispatch:
    inputs:
      force_all:
        description: Build, test and deploy every service regardless of the diff
        type: boolean
        default: false
      services:
        description: 'Comma-separated service subset, e.g. "api,web". Leave empty unless overriding.'
        type: string
        default: ''
```

- [ ] **Step 8: Pass the override into the detect step**

Replace the `Detect affected targets` step in the `detect` job:

```yaml
      - name: Detect affected targets
        id: detect
        env:
          BEFORE_SHA: ${{ github.event.before }}
          # A scheduled run has no meaningful diff range, so it always forces all.
          FORCE_ALL: ${{ (github.event_name == 'schedule' || inputs.force_all) && 'true' || 'false' }}
          SERVICES_OVERRIDE: ${{ inputs.services }}
        run: pnpm ci:detect --out affected.json
```

- [ ] **Step 9: Allow manual dispatch to deploy, and keep the nightly from deploying**

Replace the `if:` block of the `deploy` job:

```yaml
    if: >-
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&
      needs.detect.outputs.has_deployable == 'true'
```

`schedule` is deliberately absent: the nightly validates, it never deploys. `workflow_dispatch` is present because forcing a deploy without pushing a dummy commit is the entire point of the escape hatch.

- [ ] **Step 10: Validate the YAML parses**

Run:

```bash
python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok', list(d['jobs'].keys()))"
```

Expected: `yaml ok ['detect', 'lint', 'typecheck', 'test', 'ci-scripts', 'ci-gate', 'deploy']`.

- [ ] **Step 11: Commit**

```bash
pnpm biome check --write scripts/ci
git add scripts/ci/detect-affected.mts scripts/ci/override.test.ts .github/workflows/ci.yml
git commit -m "feat(ci): add nightly full validation and manual deploy override"
```

- [ ] **Step 12: Exercise the dispatch path on the merged workflow**

`workflow_dispatch` only becomes available once the workflow file exists on `main`. After this branch merges, run:

```bash
gh workflow run CI --ref main -f force_all=true
gh run watch
```

Expected: `detect` reports all six services with reason `manual override: force_all`; every conditional job runs; `deploy` runs and its log lists all six Compose services.

Then verify the subset path — pick a low-risk service:

```bash
gh workflow run CI --ref main -f services=admin
gh run watch
```

Expected: the deploy log shows `deploying services: admin` and nothing else.

**Note on the nightly:** a scheduled failure only surfaces in the Actions tab. Routing it to an alert channel is Phase 2 observability work (§15) and is intentionally not in this task. Until then, check the nightly result as part of the post-Phase-1 soak described in `docs/production-cicd-plan.md` §16 Phase 1.1.

---

## Self-Review

**Spec coverage against `docs/production-cicd-plan.md` §16 Phase 1:**

| Phase 1 bullet | Task |
|---|---|
| Add affected detection and stable `ci-gate` | Tasks 2–7 |
| Docs-only pushes skip expensive work and deployment | Task 4 (classifier), Task 7 Steps 2, 6 |
| Serialize production deployments | Task 7 Step 2 (`concurrency: tryme-production`, job-level) |
| Scope legacy VPS builds/restarts to affected services | Task 7 Step 2 |
| Remove stateful services from `--force-recreate`; remove unconditional base-image pulls | Task 7 Step 2 |
| Keep the existing mechanism as rollback | Preserved — no GHCR, no slots, still `git reset --hard` + `compose build` |
| Exit: docs-only push touches no containers | Task 7 Step 6 |
| Exit: web-only push leaves backend and stateful container IDs unchanged | Task 7 Step 8 |
| Guard against detector misclassification | Task 8 (nightly full run) |
| Operator escape hatch when detection is wrong | Task 8 (`workflow_dispatch` force_all / services) |

Detector unit-test coverage against §17.1: docs-only add/modify/rename/delete, isolated change per app, every shared package and its recursive consumers, root lockfile/workspace/toolchain, service Dockerfile, migration SQL and journal, infrastructure, separate release surfaces, missing base SHA and force-push fallback, unmapped path fail-safe, deterministic reasons, and metacharacter paths — all present across Tasks 3–5. Multi-commit push coverage comes from `BEFORE_SHA` being `github.event.before` rather than `HEAD^`, exercised in Task 6 Step 6.

**Deliberately out of scope, flagged rather than silently dropped:** per-package typecheck filtering, Biome-on-changed-files (§6.4), and image-retention cleanup (§11.9). Each is a Phase 2 concern and is recorded in the Task 7 Step 9 progress entry. The nightly full-monorepo run (§6.6) was originally filed under Phase 2 but is pulled forward into Task 8, because it is the only automated guard against the silent-failure mode Phase 1 itself introduces.

**Known manual steps that cannot be automated in this phase:** branch protection reconfiguration (Task 7 Step 7), the VPS container-ID verification (Task 7 Step 8), and the post-merge dispatch exercise (Task 8 Step 12, which cannot run until the workflow exists on `main`). All three are gates, not optional.

**After this plan is executed:** follow `docs/production-cicd-plan.md` §16 Phase 1.1, the Phase 1 → Phase 2 gate. Do not begin Phase 2 implementation, or write the Phase 2 plan, until that gate's exit criteria are met.
