import { describe, expect, it } from 'vitest';
import { computeEffectiveEnabled } from '../src/modules/shopify/activation.js';

const base = {
  mode: 'selective' as const,
  individuallyEnabled: false,
  individuallyExcluded: false,
  inEnabledCollection: false,
  inExcludedCollection: false,
};

describe('computeEffectiveEnabled', () => {
  it('is false by default (selective mode, nothing set)', () => {
    expect(computeEffectiveEnabled(base)).toBe(false);
  });

  it('is true when individually enabled', () => {
    expect(computeEffectiveEnabled({ ...base, individuallyEnabled: true })).toBe(true);
  });

  it('is true when in an enabled collection', () => {
    expect(computeEffectiveEnabled({ ...base, inEnabledCollection: true })).toBe(true);
  });

  it('is true for every product when mode is global', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global' })).toBe(true);
  });

  it('individual exclusion wins over individual enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, individuallyEnabled: true, individuallyExcluded: true }),
    ).toBe(false);
  });

  it('individual exclusion wins over collection enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, inEnabledCollection: true, individuallyExcluded: true }),
    ).toBe(false);
  });

  it('collection exclusion wins over individual enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, individuallyEnabled: true, inExcludedCollection: true }),
    ).toBe(false);
  });

  it('collection exclusion wins over collection enablement', () => {
    expect(
      computeEffectiveEnabled({ ...base, inEnabledCollection: true, inExcludedCollection: true }),
    ).toBe(false);
  });

  it('individual exclusion wins even under global mode', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global', individuallyExcluded: true })).toBe(
      false,
    );
  });

  it('collection exclusion wins even under global mode', () => {
    expect(computeEffectiveEnabled({ ...base, mode: 'global', inExcludedCollection: true })).toBe(
      false,
    );
  });

  it('both exclusion signals set still resolves to false, not a crash', () => {
    expect(
      computeEffectiveEnabled({
        ...base,
        mode: 'global',
        individuallyExcluded: true,
        inExcludedCollection: true,
      }),
    ).toBe(false);
  });
});
