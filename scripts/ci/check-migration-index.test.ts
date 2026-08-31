import { describe, expect, it } from 'vitest';
import { findCollisions, parseJournal } from './check-migration-index.mts';

describe('findCollisions', () => {
  it('returns nothing when local and upstream agree on every shared idx', () => {
    const upstream = parseJournal(
      JSON.stringify({
        entries: [
          { idx: 0, tag: '0000_a' },
          { idx: 1, tag: '0001_b' },
        ],
      }),
    );
    const local = parseJournal(
      JSON.stringify({
        entries: [
          { idx: 0, tag: '0000_a' },
          { idx: 1, tag: '0001_b' },
          { idx: 2, tag: '0002_c' },
        ],
      }),
    );
    expect(findCollisions(local, upstream)).toEqual([]);
  });

  it('flags an idx reused for a different migration', () => {
    const upstream = parseJournal(JSON.stringify({ entries: [{ idx: 5, tag: '0005_theirs' }] }));
    const local = parseJournal(JSON.stringify({ entries: [{ idx: 5, tag: '0005_mine' }] }));
    expect(findCollisions(local, upstream)).toEqual([{ idx: 5, tag: '0005_mine' }]);
  });

  it('ignores idx values only present on one side', () => {
    const upstream = parseJournal(JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }] }));
    const local = parseJournal(JSON.stringify({ entries: [{ idx: 1, tag: '0001_new' }] }));
    expect(findCollisions(local, upstream)).toEqual([]);
  });
});
