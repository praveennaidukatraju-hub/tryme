import { describe, expect, it } from 'vitest';
import { ALERT_LEVEL_RANK, deriveLevel } from './runway.js';

describe('deriveLevel', () => {
  it('is empty at a zero balance regardless of burn', () => {
    expect(deriveLevel({ balance: 0, dailyBurnCredits: 100, lifetimeJobs: 50 }).level).toBe(
      'empty',
    );
    expect(deriveLevel({ balance: 0, dailyBurnCredits: 0, lifetimeJobs: 50 }).level).toBe('empty');
  });

  it('is ok with plenty of runway', () => {
    // 1000 credits at 50/day = 20 days
    const result = deriveLevel({ balance: 1000, dailyBurnCredits: 50, lifetimeJobs: 100 });
    expect(result.level).toBe('ok');
    expect(result.daysRemaining).toBe(20);
  });

  it('warns under seven days of runway', () => {
    // 300 credits at 50/day = 6 days
    expect(deriveLevel({ balance: 300, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe(
      'warning',
    );
  });

  it('is critical under two days of runway', () => {
    // 75 credits at 50/day = 1.5 days
    expect(deriveLevel({ balance: 75, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe(
      'critical',
    );
  });

  it('treats exactly seven days as ok, not warning', () => {
    // Boundary is strict: the merchant has a full week, which is the point.
    expect(deriveLevel({ balance: 350, dailyBurnCredits: 50, lifetimeJobs: 100 }).level).toBe('ok');
  });

  // A store that has never generated anything is onboarding, not running dry.
  // Alerting it would make the very first thing we email a merchant a warning
  // about a problem they don't have.
  it('never alerts a store with no lifetime jobs', () => {
    const result = deriveLevel({ balance: 25, dailyBurnCredits: 0, lifetimeJobs: 0 });
    expect(result.level).toBe('ok');
    expect(result.daysRemaining).toBeNull();
  });

  describe('cold start — has run jobs, but none in the trailing window', () => {
    it('reports no runway estimate rather than infinity', () => {
      expect(
        deriveLevel({ balance: 500, dailyBurnCredits: 0, lifetimeJobs: 10 }).daysRemaining,
      ).toBeNull();
    });

    it('falls back to absolute credits', () => {
      expect(deriveLevel({ balance: 500, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe('ok');
      expect(deriveLevel({ balance: 199, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe(
        'warning',
      );
      expect(deriveLevel({ balance: 49, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe(
        'critical',
      );
    });
  });

  it('ranks levels so escalation can be compared numerically', () => {
    expect(ALERT_LEVEL_RANK.ok).toBeLessThan(ALERT_LEVEL_RANK.warning);
    expect(ALERT_LEVEL_RANK.warning).toBeLessThan(ALERT_LEVEL_RANK.critical);
    expect(ALERT_LEVEL_RANK.critical).toBeLessThan(ALERT_LEVEL_RANK.empty);
  });

  // 'empty' tracks "can no longer afford a try-on" (matching the storefront's
  // own balance < jobCost gate), not "balance is exactly zero" — a store can
  // have a few leftover credits that are worth nothing once they're below the
  // live job cost.
  describe('tryonCost threshold', () => {
    it('defaults to SIMPLE_TRYON_COST when no tryonCost is given', () => {
      // 4 credits, no explicit tryonCost — falls back to the compile-time
      // SIMPLE_TRYON_COST (5), so 4 < 5 is empty.
      expect(deriveLevel({ balance: 4, dailyBurnCredits: 0, lifetimeJobs: 10 }).level).toBe(
        'empty',
      );
    });

    it('is empty once balance drops below the live job cost, even above zero', () => {
      // 8 credits against a retuned 10-credit job cost: can't afford one more
      // try-on, so this must read 'empty' — not 'critical' with a misleading
      // "about N days left".
      expect(
        deriveLevel({ balance: 8, dailyBurnCredits: 50, lifetimeJobs: 10, tryonCost: 10 }).level,
      ).toBe('empty');
    });

    it('is not empty once balance can afford at least one try-on at the live cost', () => {
      expect(
        deriveLevel({ balance: 10, dailyBurnCredits: 0, lifetimeJobs: 10, tryonCost: 10 }).level,
      ).not.toBe('empty');
    });
  });
});
