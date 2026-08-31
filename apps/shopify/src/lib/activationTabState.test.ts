import { describe, expect, it } from 'vitest';
import { isTabEditable } from './activationTabState';

describe('isTabEditable', () => {
  it('collections and individual tabs are editable in selective mode', () => {
    expect(isTabEditable('selective', 'collections')).toBe(true);
    expect(isTabEditable('selective', 'individual')).toBe(true);
  });

  it('collections and individual tabs are read-only in global mode', () => {
    expect(isTabEditable('global', 'collections')).toBe(false);
    expect(isTabEditable('global', 'individual')).toBe(false);
  });

  it('exclusion tab is always editable, in either mode', () => {
    expect(isTabEditable('selective', 'exclusion')).toBe(true);
    expect(isTabEditable('global', 'exclusion')).toBe(true);
  });
});
