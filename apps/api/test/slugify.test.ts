import { describe, expect, it } from 'vitest';
import { makeUniqueSlug, slugify } from '../src/lib/slugify.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Full Sleeve Shirt')).toBe('full-sleeve-shirt');
  });

  it('strips diacritics', () => {
    expect(slugify('Café Négro')).toBe('cafe-negro');
  });

  it('collapses runs of non-alphanumeric characters', () => {
    expect(slugify('  a---b__c!!d  ')).toBe('a-b-c-d');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('a UUID-shaped label slugifies to something still regex-valid', () => {
    expect(slugify('7d0b286f-e4de-4c8a-991d-0ce0a4b25b2e')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('makeUniqueSlug', () => {
  it('uses the bare slugified label when unused', () => {
    const used = new Set<string>();
    expect(makeUniqueSlug('Blazer', ['men'], 'id-1', used)).toBe('blazer');
    expect(used.has('blazer')).toBe(true);
  });

  it('widens with a discriminator on collision', () => {
    const used = new Set<string>(['pose13']);
    const s = makeUniqueSlug('pose13', ['men'], 'id-2', used);
    expect(s).toBe('pose13-men');
  });

  it('falls back to an id suffix when even the discriminator collides', () => {
    const used = new Set<string>(['pose13', 'pose13-men']);
    const s = makeUniqueSlug('pose13', ['men'], 'abcdef12-3456-7890-abcd-ef1234567890', used);
    expect(s).toBe('pose13-men-abcdef');
    expect(used.has(s)).toBe(true);
  });

  it('never returns the same slug twice across a batch', () => {
    const used = new Set<string>();
    const slugs = ['pose13', 'pose13', 'pose13', 'pose13'].map((label, i) =>
      makeUniqueSlug(label, ['women'], `id-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, used),
    );
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('falls back to the fallback word when label slugifies to empty', () => {
    const used = new Set<string>();
    const s = makeUniqueSlug('!!!', [], 'id-5', used, 'background');
    expect(s).toBe('background');
  });

  it('every produced slug matches the PUBLIC_SLUG shape', () => {
    const used = new Set<string>();
    const labels = ['Café', 'pose13', 'pose13', '', '7d0b286f-e4de-4c8a-991d-0ce0a4b25b2e'];
    for (const [i, label] of labels.entries()) {
      const s = makeUniqueSlug(label, ['women', 'lower'], `row-${i}-uuid`, used, 'item');
      expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.length).toBeLessThanOrEqual(64);
    }
  });
});
