import { CardGridSkeleton, PageSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <PageSkeleton>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <Skeleton w={300} h={38} />
        <Skeleton w={100} h={38} />
        <Skeleton w={100} h={38} />
      </div>
      <CardGridSkeleton count={6} w={370} h={376} />
    </PageSkeleton>
  );
}
