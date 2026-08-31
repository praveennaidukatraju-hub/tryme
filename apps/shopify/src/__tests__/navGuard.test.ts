import { afterEach, describe, expect, it } from 'vitest';
import { runNavGuard, setNavGuard } from '../lib/navGuard';

describe('in-app navigation guard', () => {
  afterEach(() => setNavGuard(null));

  it('allows navigation when no page has registered a guard', () => {
    expect(runNavGuard()).toBe(true);
  });

  it('returns the registered page guard decision', () => {
    setNavGuard(() => false);

    expect(runNavGuard()).toBe(false);
  });

  it('allows navigation again after the page clears its guard', () => {
    setNavGuard(() => false);
    setNavGuard(null);

    expect(runNavGuard()).toBe(true);
  });
});
