import { describe, expect, it } from 'vitest';
import { GSTIN_REGEX } from './credits.js';

describe('GSTIN_REGEX', () => {
  it('matches a valid GSTIN', () => {
    expect(GSTIN_REGEX.test('27AAPFU0939F1ZV')).toBe(true);
  });

  it('rejects a malformed GSTIN', () => {
    expect(GSTIN_REGEX.test('not-a-gstin')).toBe(false);
    expect(GSTIN_REGEX.test('27AAPFU0939F1Z')).toBe(false); // too short
    expect(GSTIN_REGEX.test('27aapfu0939f1zv')).toBe(false); // lowercase
  });
});
