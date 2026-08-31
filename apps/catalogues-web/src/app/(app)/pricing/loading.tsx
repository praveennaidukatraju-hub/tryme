import { Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '40px 28px' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          marginBottom: 40,
        }}
      >
        <Skeleton w={420} h={28} />
        <Skeleton w={520} h={16} />
      </div>
      <div style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <Skeleton key={i} w={262} h={420} r={12} />
        ))}
      </div>
    </div>
  );
}
