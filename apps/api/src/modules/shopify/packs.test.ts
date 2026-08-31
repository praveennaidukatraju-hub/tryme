import { SIMPLE_TRYON_COST } from '@tryme/types';
import { describe, expect, it } from 'vitest';
import { CREDIT_PACK_IDS, CREDIT_PACKS, getPack } from './packs.js';

describe('credit packs', () => {
  it('resolves every known pack id', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(getPack(id)?.id).toBe(id);
    }
  });

  it('returns null for an unknown pack id', () => {
    expect(getPack('pack_999')).toBeNull();
    expect(getPack('')).toBeNull();
  });

  it("prices every pack above Shopify's $0.50 application-charge floor", () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].priceUsd).toBeGreaterThanOrEqual(0.5);
    }
  });

  // A pack whose credits are not a whole number of try-ons leaves a remainder
  // the merchant paid for and can never spend.
  it('sizes every pack to a whole number of try-ons, on both purchase paths', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].credits % SIMPLE_TRYON_COST).toBe(0);
      expect(CREDIT_PACKS[id].autorefillCredits % SIMPLE_TRYON_COST).toBe(0);
    }
  });

  it('gives auto-refill strictly more credits than manual, at the same price', () => {
    for (const id of CREDIT_PACK_IDS) {
      expect(CREDIT_PACKS[id].autorefillCredits).toBeGreaterThan(CREDIT_PACKS[id].credits);
    }
  });

  // Pricing-intent regression test: this is what catches someone later editing
  // a default into a value where a smaller pack is a better deal per credit
  // than a larger one, which would make the ladder meaningless.
  it('improves cents-per-credit monotonically as pack size grows', () => {
    const rates = CREDIT_PACK_IDS.map(
      (id) => (CREDIT_PACKS[id].priceUsd * 100) / CREDIT_PACKS[id].credits,
    );
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThan(rates[i - 1]);
    }
  });
});
