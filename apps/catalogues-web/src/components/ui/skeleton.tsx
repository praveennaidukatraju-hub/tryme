import { C } from '@/components/tokens';

/** Shimmer placeholder primitive. Uses the global .av-shimmer keyframes. */
export function Skeleton({
  w,
  h,
  r = 8,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      className="av-shimmer"
      style={{ width: w ?? '100%', height: h ?? 12, borderRadius: r, ...style }}
    />
  );
}

/** Top bar skeleton matching the real TopBar (76px, border-bottom). */
export function TopBarSkeleton({ withActions }: { withActions?: boolean }): React.ReactElement {
  return (
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Skeleton w={220} h={18} />
        <Skeleton w={300} h={12} />
      </div>
      {withActions && (
        <div style={{ display: 'flex', gap: 10 }}>
          <Skeleton w={120} h={40} />
          <Skeleton w={140} h={40} />
        </div>
      )}
    </div>
  );
}

/** A responsive grid of card skeletons. */
export function CardGridSkeleton({
  count = 8,
  w = 215.2,
  h = 212.67,
  fluid = false,
}: {
  count?: number;
  w?: number;
  h?: number;
  fluid?: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: fluid
          ? 'repeat(auto-fill, minmax(240px, 1fr))'
          : `repeat(auto-fill, ${w}px)`,
        gap: 16,
        width: '100%',
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton
            w={fluid ? '100%' : w}
            h={fluid ? undefined : h}
            r={14}
            style={fluid ? { aspectRatio: '3/4', height: 'auto' } : undefined}
          />
          <Skeleton w={fluid ? '60%' : w * 0.6} h={12} />
        </div>
      ))}
    </div>
  );
}

/** Standard page shell: top bar skeleton + scrollable padded body. */
export function PageSkeleton({
  withActions,
  children,
}: {
  withActions?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <TopBarSkeleton withActions={withActions} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>{children}</div>
    </>
  );
}
