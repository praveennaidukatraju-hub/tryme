import { PageSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <PageSkeleton withActions>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div>
          <Skeleton w={120} h={16} style={{ marginBottom: 14 }} />
          <div style={{ display: 'flex', gap: 20 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
              <Skeleton key={i} w={108.8} h={109} />
            ))}
          </div>
        </div>
        <div>
          <Skeleton w={140} h={16} style={{ marginBottom: 14 }} />
          <div style={{ display: 'flex', gap: 20 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
              <Skeleton key={i} w={108.8} h={109} />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 40 }}>
          <Skeleton w={280} h={120} />
          <Skeleton w={200} h={120} />
        </div>
        <Skeleton w="100%" h={238} r={12} />
      </div>
    </PageSkeleton>
  );
}
