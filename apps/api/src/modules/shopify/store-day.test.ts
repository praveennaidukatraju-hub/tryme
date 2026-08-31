import { describe, expect, it } from 'vitest';
import { storeDayKey, windowStart } from './store-day.js';

describe('storeDayKey', () => {
  it('uses the store local day, not the UTC day', () => {
    // 2026-03-01T20:00:00Z is already 2026-03-02 in Asia/Kolkata (UTC+5:30).
    const at = new Date('2026-03-01T20:00:00Z');
    expect(storeDayKey('Asia/Kolkata', at)).toBe('20260302');
    expect(storeDayKey(null, at)).toBe('20260301');
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    const at = new Date('2026-03-01T20:00:00Z');
    expect(storeDayKey('Not/AZone', at)).toBe('20260301');
  });
});

describe('windowStart', () => {
  it('starts the day window at local midnight', () => {
    const at = new Date('2026-03-01T20:00:00Z'); // 2026-03-02 01:30 IST
    // Local midnight of 2026-03-02 IST is 2026-03-01T18:30:00Z.
    expect(windowStart('Asia/Kolkata', 'day', at).toISOString()).toBe('2026-03-01T18:30:00.000Z');
  });

  it('uses the offset at local midnight across a DST transition', () => {
    // 2026-03-08 noon in New York is UTC-4, but local midnight was still UTC-5.
    const at = new Date('2026-03-08T16:00:00Z');
    expect(windowStart('America/New_York', 'day', at).toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('uses the first midnight when a DST rollback repeats it', () => {
    // Amman repeated 00:00 on 2020-10-30: first at UTC+3, then at UTC+2.
    const at = new Date('2020-10-30T10:00:00Z');
    expect(windowStart('Asia/Amman', 'day', at).toISOString()).toBe('2020-10-29T21:00:00.000Z');
  });

  it('uses the first day crossing when a rollback regresses the local date', () => {
    // St. John's first entered Oct 25 at UTC-2:30, then rolled into Oct 24
    // before entering Oct 25 again at UTC-3:30.
    const at = new Date('1987-10-25T12:00:00Z');
    expect(windowStart('America/St_Johns', 'day', at).toISOString()).toBe(
      '1987-10-25T02:30:00.000Z',
    );
  });

  it('handles a multi-hour rollback that regresses the local date', () => {
    // Casey first entered Mar 5 at UTC+11, then rolled back three hours and
    // entered Mar 5 again at UTC+8.
    const at = new Date('2010-03-05T10:00:00Z');
    expect(windowStart('Antarctica/Casey', 'day', at).toISOString()).toBe(
      '2010-03-04T13:00:00.000Z',
    );
  });

  it('starts the week window on Monday', () => {
    const at = new Date('2026-03-05T12:00:00Z'); // a Thursday
    expect(windowStart('UTC', 'week', at).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('starts the month window on the first', () => {
    const at = new Date('2026-03-05T12:00:00Z');
    expect(windowStart('UTC', 'month', at).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});
