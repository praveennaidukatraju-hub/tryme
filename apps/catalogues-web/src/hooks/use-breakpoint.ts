import { BREAKPOINTS } from '@/lib/breakpoints';
import { useMediaQuery } from './use-media-query';

export type Tier = 'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop';

const QUERIES: Record<Tier, string> = {
  mobile: `(max-width: ${BREAKPOINTS.sm - 1}px)`,
  tablet: `(min-width: ${BREAKPOINTS.sm}px) and (max-width: ${BREAKPOINTS.lg - 1}px)`,
  'small-laptop': `(min-width: ${BREAKPOINTS.lg}px) and (max-width: ${BREAKPOINTS.xl - 1}px)`,
  laptop: `(min-width: ${BREAKPOINTS.xl}px) and (max-width: ${BREAKPOINTS['2xl'] - 1}px)`,
  desktop: `(min-width: ${BREAKPOINTS['2xl']}px)`,
};

/**
 * Resolves the current viewport tier. Internally five independent
 * useMediaQuery() calls — one per tier — since exactly one of these five
 * ranges is ever true at a time (they're contiguous and non-overlapping).
 * Returns null until the first one resolves (see useMediaQuery's SSR/
 * hydration note).
 */
export function useBreakpoint(): Tier | null {
  const isMobile = useMediaQuery(QUERIES.mobile);
  const isTablet = useMediaQuery(QUERIES.tablet);
  const isSmallLaptop = useMediaQuery(QUERIES['small-laptop']);
  const isLaptop = useMediaQuery(QUERIES.laptop);
  const isDesktop = useMediaQuery(QUERIES.desktop);

  if (
    isMobile === null ||
    isTablet === null ||
    isSmallLaptop === null ||
    isLaptop === null ||
    isDesktop === null
  ) {
    return null;
  }
  if (isMobile) return 'mobile';
  if (isTablet) return 'tablet';
  if (isSmallLaptop) return 'small-laptop';
  if (isLaptop) return 'laptop';
  if (isDesktop) return 'desktop';
  return 'desktop';
}
