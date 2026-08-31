import { PageSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <PageSkeleton withActions>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <Skeleton key={i} w={110} h={20} />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          border: '1px solid var(--c-border)',
          borderRadius: 12,
          padding: 24,
        }}
      >
        <Skeleton w={180} h={16} />
        <div style={{ display: 'flex', gap: 20 }}>
          <Skeleton w="100%" h={44} />
          <Skeleton w="100%" h={44} />
          <Skeleton w="100%" h={44} />
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <Skeleton w="100%" h={44} />
          <Skeleton w="100%" h={44} />
          <Skeleton w="100%" h={44} />
        </div>
      </div>
    </PageSkeleton>
  );
}
