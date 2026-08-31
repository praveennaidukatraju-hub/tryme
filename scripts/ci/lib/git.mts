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
