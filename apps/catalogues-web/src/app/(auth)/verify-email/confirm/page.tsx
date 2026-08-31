'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function ConfirmInner(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    const token = searchParams.get('token') ?? '';
    if (!token) {
      setErrorMsg('Invalid verification link.');
      setStatus('error');
      return;
    }

    fetch(`${BASE}/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json()) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? 'Verification failed');
        }
        setStatus('success');
        setTimeout(() => router.push('/studio'), 1200);
      })
      .catch((err: Error) => {
        setErrorMsg(err.message);
        setStatus('error');
      });
  }, [searchParams, router]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 420,
          padding: 40,
          background: C.card,
          borderRadius: 16,
          border: `1px solid ${C.border}`,
          textAlign: 'center',
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <LogoAuth />
        </div>

        {status === 'loading' && (
          <>
            <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
            <h1 style={{ fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>
              Verifying your email…
            </h1>
            <p style={{ fontSize: 14, color: C.mid }}>Please wait a moment.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{ fontSize: 32, marginBottom: 16 }}>✅</div>
            <h1 style={{ fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>
              Email verified!
            </h1>
            <p style={{ fontSize: 14, color: C.mid }}>Redirecting you to the studio…</p>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ fontSize: 32, marginBottom: 16 }}>❌</div>
            <h1 style={{ fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>
              Verification failed
            </h1>
            <p style={{ fontSize: 14, color: C.mid, marginBottom: 24 }}>
              {errorMsg || 'This link may have expired or already been used.'}
            </p>
            <button
              type="button"
              onClick={() => router.push('/verify-email')}
              style={{
                width: '100%',
                height: 44,
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: C.dark,
                color: C.onDark,
                fontFamily: 'inherit',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              Resend verification email
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailConfirmPage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.bg }} />}>
      <ConfirmInner />
    </Suspense>
  );
}
