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

const REQUIRED_TARGET_KEYS = [
  'name',
  'dir',
  'packageName',
  'dockerfile',
  'composeService',
] as const;

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
