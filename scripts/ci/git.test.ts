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
    const range = resolveRange({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: HEAD }, () => '');
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
