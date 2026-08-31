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
      'admin',
      'api',
      'chatbot',
      'dispatcher',
      'shopify-admin',
      'web',
    ]);
    expect(consumersAsTargets('@tryme/db')).toEqual(['api', 'chatbot', 'dispatcher']);
    expect(consumersAsTargets('@tryme/storage')).toEqual(['api', 'dispatcher']);
    expect(consumersAsTargets('@tryme/logger')).toEqual(['api', 'chatbot', 'dispatcher']);
    expect(consumersAsTargets('@tryme/observability')).toEqual(['api', 'chatbot', 'dispatcher']);
  });
});
