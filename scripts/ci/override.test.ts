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
    expect(applyManualOverride(docsOnlyResult, { FORCE_ALL: '' }, config)).toEqual(docsOnlyResult);
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
    const result = applyManualOverride(docsOnlyResult, { SERVICES_OVERRIDE: 'api,web' }, config);
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
    expect(() => applyManualOverride(docsOnlyResult, { SERVICES_OVERRIDE: ' , ' }, config)).toThrow(
      /no valid service names/,
    );
  });

  it('refuses to guess when both overrides are supplied', () => {
    expect(() =>
      applyManualOverride(docsOnlyResult, { FORCE_ALL: 'true', SERVICES_OVERRIDE: 'api' }, config),
    ).toThrow(/both FORCE_ALL and SERVICES_OVERRIDE/);
  });
});
