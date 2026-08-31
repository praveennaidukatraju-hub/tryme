import { CardGridSkeleton, PageSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <PageSkeleton>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Skeleton w={300} h={38} />
        <Skeleton w={120} h={38} />
        <Skeleton w={120} h={38} />
        <Skeleton w={140} h={38} style={{ marginLeft: 'auto' }} />
      </div>
      <CardGridSkeleton count={9} fluid />
    </PageSkeleton>
  );
}
