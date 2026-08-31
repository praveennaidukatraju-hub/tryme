'use client';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          fontFamily: 'system-ui, sans-serif',
          background: '#fff',
          color: '#141414',
          textAlign: 'center',
          padding: 24,
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Something went wrong</h2>
        <p style={{ fontSize: 14, color: '#626262', margin: 0, maxWidth: 360 }}>
          An unexpected error occurred. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            height: 40,
            padding: '0 20px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: '#141414',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
