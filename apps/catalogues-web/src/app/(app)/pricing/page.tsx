'use client';

import { useBreakpoint } from '@/hooks/use-breakpoint';
import { Desktop } from './layouts/Desktop';
import { Mobile } from './layouts/Mobile';
import { Tablet } from './layouts/Tablet';
import Loading from './loading';
import { usePricingData } from './use-pricing-data';

export default function PricingPage(): React.ReactElement {
  const data = usePricingData();
  const tier = useBreakpoint();

  if (tier === null) return <Loading />;
  if (tier === 'mobile') return <Mobile {...data} />;
  if (tier === 'tablet') return <Tablet {...data} />;
  return <Desktop {...data} />;
}
