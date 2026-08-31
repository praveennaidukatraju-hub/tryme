import { describe, expect, it } from 'vitest';
import { resolvePreset } from './analyticsRange';

const today = new Date('2026-07-31T00:00:00Z');
const installedAt = new Date('2026-06-15T00:00:00Z');

describe('resolvePreset', () => {
  it('7d covers today and the six days before it', () => {
    // Inclusive of both ends — seven days total, not eight.
    expect(resolvePreset('7d', installedAt, today)).toEqual({
      from: '2026-07-25',
      to: '2026-07-31',
    });
  });

  it('30d covers today and the twenty-nine days before it', () => {
    expect(resolvePreset('30d', installedAt, today)).toEqual({
      from: '2026-07-02',
      to: '2026-07-31',
    });
  });

  it('90d covers today and the eighty-nine days before it', () => {
    expect(resolvePreset('90d', installedAt, today)).toEqual({
      from: '2026-05-03',
      to: '2026-07-31',
    });
  });

  it('all starts at the install date', () => {
    expect(resolvePreset('all', installedAt, today)).toEqual({
      from: '2026-06-15',
      to: '2026-07-31',
    });
  });

  it('clamps all-time to 400 days so the API never rejects it', () => {
    // The events retention horizon is 400 days and the endpoint enforces it.
    // A store installed five years ago must still get a working "All time".
    const ancient = new Date('2021-01-01T00:00:00Z');
    const { from, to } = resolvePreset('all', ancient, today);
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(400);
  });
});
