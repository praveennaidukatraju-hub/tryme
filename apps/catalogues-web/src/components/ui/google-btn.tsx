'use client';
import { C } from '../tokens';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function GoogleBtn({ label, next, src }: { label: string; next?: string; src?: string }) {
  const params = new URLSearchParams();
  if (next) params.set('next', next);
  if (src) params.set('src', src);
  const qs = params.toString();
  const href = qs ? `${API_URL}/v1/auth/google/init?${qs}` : `${API_URL}/v1/auth/google/init`;
  return (
    <a
      href={href}
      rel="opener"
      className="google-btn"
      style={{
        width: '100%',
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        background: C.white,
        border: `1px solid ${C.border2}`,
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: 500,
        fontSize: 14,
        color: C.text,
        textDecoration: 'none',
        transition: 'background .15s',
      }}
    >
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
        <path
          fill="#EA4335"
          d="M24 9.5c3.5 0 6.3 1.2 8.4 3.2l6.3-6.3C34.9 2.7 29.8.5 24 .5 14.8.5 7 6.1 3.3 14l7.4 5.7C12.5 13.4 17.8 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.4-4.8 7.1l7.4 5.7c4.3-4 6.8-9.8 7.2-16.8z"
        />
        <path
          fill="#FBBC05"
          d="M10.7 28.3A14.9 14.9 0 019.5 24c0-1.5.3-3 .7-4.3L2.8 14C1 17.1 0 20.4 0 24s1 6.9 2.8 10l7.9-5.7z"
        />
        <path
          fill="#34A853"
          d="M24 47.5c5.8 0 10.7-1.9 14.3-5.1l-7.4-5.7c-2 1.3-4.4 2.1-6.9 2.1-6.2 0-11.5-4-13.3-9.5l-7.4 5.7C7 41.9 14.8 47.5 24 47.5z"
        />
      </svg>
      {label}
    </a>
  );
}
