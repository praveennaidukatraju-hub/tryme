import { describe, expect, it } from 'vitest';
import { defaultTriggerCredits, shouldRefill } from './autorefill.js';

describe('shouldRefill', () => {
  it('refills at or below the trigger', () => {
    expect(shouldRefill({ balance: 160, triggerCredits: 160, status: 'ACTIVE' })).toBe(true);
    expect(shouldRefill({ balance: 40, triggerCredits: 160, status: 'ACTIVE' })).toBe(true);
  });

  it('does not refill above the trigger', () => {
    expect(shouldRefill({ balance: 161, triggerCredits: 160, status: 'ACTIVE' })).toBe(false);
  });

  it('does not refill when auto-refill is off', () => {
    expect(shouldRefill({ balance: 0, triggerCredits: null, status: null })).toBe(false);
  });

  // PENDING means the merchant was shown the approval page and has not accepted
  // it. Charging against an unapproved authorization is exactly the "granting
  // against a PENDING charge" mistake the prepaid path already guards against.
  it('does not refill unless the subscription is ACTIVE', () => {
    for (const status of ['PENDING', 'DECLINED', 'CANCELLED', 'CAP_REACHED', 'FROZEN']) {
      expect(shouldRefill({ balance: 0, triggerCredits: 160, status })).toBe(false);
    }
  });
});

describe('defaultTriggerCredits', () => {
  it('is 20% of the pack the merchant chose', () => {
    expect(defaultTriggerCredits('pack_10')).toBe(160);
    expect(defaultTriggerCredits('pack_25')).toBe(450);
    expect(defaultTriggerCredits('pack_50')).toBe(960);
    expect(defaultTriggerCredits('pack_100')).toBe(2000);
  });

  it('is null for a pack we do not sell', () => {
    expect(defaultTriggerCredits('pack_999')).toBeNull();
  });
});
