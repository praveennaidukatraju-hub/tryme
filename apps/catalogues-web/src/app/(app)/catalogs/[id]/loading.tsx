import { C } from '@/components/tokens';
import { CardGridSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <>
      <div
        style={{
          height: 76,
          background: C.white,
          borderBottom: `1px solid ${C.border}`,
          padding: '0 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Skeleton w={20} h={20} r={4} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton w={180} h={18} />
            <Skeleton w={120} h={12} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Skeleton w={133} h={44} />
          <Skeleton w={177} h={44} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        <CardGridSkeleton count={8} w={369.33} h={316} />
      </div>
    </>
  );
}
