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
      .filter(
        ([name, range]) => name.startsWith('@tryme/') && String(range).startsWith('workspace:'),
      )
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
