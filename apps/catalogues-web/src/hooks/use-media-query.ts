import { useLayoutEffect, useState } from 'react';

/**
 * Reactive single-query matchMedia hook. Returns null on the server and on
 * the client's first render (so SSR and initial hydration match exactly),
 * then resolves synchronously in useLayoutEffect before paint. The
 * MediaQueryList is created once per distinct `query` string (inside the
 * effect, gated by the [query] dependency array) — not recreated on every
 * render.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = () => setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
