import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outputLines, renderSummary } from './detect-affected.mts';
import type { DetectResult } from './lib/classify.mts';

// node_modules/.bin/tsx is a POSIX shell shim (`#!/bin/sh`) with no Windows
// entry point of its own — spawning it directly via execFileSync (no shell)
// throws ENOENT on Windows. tsx's actual CLI is a plain Node ESM script, so
// running it through `node <cli.mjs>` works identically on every platform.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

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

    execFileSync(process.execPath, [tsxCli, 'scripts/ci/detect-affected.mts', '--out', outJson], {
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
