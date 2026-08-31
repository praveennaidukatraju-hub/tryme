'use client';
import Link from 'next/link';
import { C, grad } from '@/components/tokens';

function AlertGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Branded full-section error / empty fallback used by route error boundaries,
 * the 404 page, and any inline failure state. Keep presentational only.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
  homeHref,
  homeLabel = 'Go home',
  compact,
}: {
  title: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  homeHref?: string;
  homeLabel?: string;
  compact?: boolean;
}): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        minHeight: compact ? undefined : 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 16,
        padding: compact ? '40px 24px' : '64px 24px',
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
        <AlertGlyph />
      </div>
      <div style={{ maxWidth: 380 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 6px' }}>{title}</h2>
        {message && (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: C.mid, margin: 0 }}>{message}</p>
        )}
      </div>
      {(onRetry || homeHref) && (
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                height: 40,
                padding: '0 20px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: C.dark,
                color: C.white,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {retryLabel}
            </button>
          )}
          {homeHref && (
            <Link
              href={homeHref}
              style={{
                height: 40,
                padding: '0 20px',
                borderRadius: 8,
                border: `1px solid ${C.border2}`,
                background: C.white,
                color: C.text,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {homeLabel}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
