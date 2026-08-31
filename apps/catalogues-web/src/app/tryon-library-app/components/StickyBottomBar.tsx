'use client';
import { LIGHT } from '../theme';

export function StickyBottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        background: LIGHT.card,
        borderTop: `1px solid ${LIGHT.border}`,
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
        display: 'flex',
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}
