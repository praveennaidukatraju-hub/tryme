'use client';
import type { ReactNode } from 'react';
import { XIcon } from '@/components/icons';
import { C } from '@/components/tokens';

/**
 * Generic full-viewport modal chrome for the batch "Configure" popup —
 * backdrop, panel, header with close button, scrollable body, and an optional
 * non-scrolling footer (the summary bar + submit stays visible while rows
 * scroll). Mirrors select-modal.tsx's shell so the two modals feel like one
 * system.
 */
export function ConfigureModalShell({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside-to-dismiss backdrop; keyboard users have the visible Close button below
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only, not itself interactive */}
      <div
        role="presentation"
        style={{
          background: C.white,
          borderRadius: 12,
          padding: 24,
          width: 1180,
          maxWidth: '95vw',
          maxHeight: '90vh',
          boxSizing: 'border-box',
          boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
            flexShrink: 0,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.mid,
            }}
          >
            <XIcon size={20} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
        {footer && (
          <div
            style={{
              flexShrink: 0,
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
