'use client';

import { useState } from 'react';
import { C, grad } from '@/components/tokens';

function ClockGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="2" />
      <path d="M12 7v5l3 2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Branded, intentional "coming soon" panel for features that are scaffolded
 * but not yet wired. Replaces half-built disabled forms / empty tables.
 */
export function ComingSoon({
  title,
  message,
  icon,
}: {
  title: string;
  message?: string;
  icon?: React.ReactNode;
}): React.ReactElement {
  const [notified, setNotified] = useState(false);

  return (
    <div
      style={{
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: '56px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: grad,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon ?? <ClockGlyph />}
      </div>
      <div style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: 0 }}>{title}</h3>
          <span
            style={{
              padding: '2px 10px',
              borderRadius: 99,
              fontSize: 11,
              fontWeight: 600,
              background: 'rgba(246,181,83,0.15)',
              color: C.amber,
            }}
          >
            Coming soon
          </span>
        </div>
        {message && (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.mid, margin: '8px 0 0' }}>
            {message}
          </p>
        )}
        <button
          type="button"
          disabled={notified}
          onClick={() => setNotified(true)}
          className="btn-hover-opacity"
          style={{
            marginTop: 24,
            background: notified ? C.lighter : C.text,
            color: notified ? C.mid : C.card,
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            cursor: notified ? 'default' : 'pointer',
            fontWeight: 600,
            transition: 'opacity 0.15s, background 0.15s, color 0.15s',
          }}
        >
          {notified ? 'Added to waitlist ✓' : 'Notify me when ready'}
        </button>
      </div>
    </div>
  );
}
