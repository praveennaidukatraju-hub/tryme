'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function VerifyEmailPage(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const stored = sessionStorage.getItem('pending_verify_email') ?? '';
    setEmail(stored);
  }, []);

  async function handleResend() {
    setSending(true);
    setError('');
    setSent(false);
    try {
      await fetch(`${BASE}/api/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

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
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(245,92,122,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
            fontSize: 24,
          }}
        >
          ✉️
        </div>
        <h1 style={{ fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>
          Check your inbox
        </h1>
        <p style={{ fontSize: 14, color: C.mid, lineHeight: 1.6, marginBottom: 8 }}>
          We sent a verification link to
        </p>
        {email && (
          <p style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 16 }}>{email}</p>
        )}
        <p style={{ fontSize: 13, color: C.light, lineHeight: 1.6, marginBottom: 32 }}>
          Click the link in the email to activate your account. The link expires in 24 hours.
        </p>

        {sent && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: 'rgba(0,180,100,0.08)',
              border: '1px solid rgba(0,180,100,0.3)',
              fontSize: 13,
              color: '#00a860',
              marginBottom: 16,
            }}
          >
            Verification email resent!
          </div>
        )}
        {error && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: `1px solid ${C.pink}`,
              background: 'rgba(245,92,122,0.06)',
              fontSize: 13,
              color: C.pink,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleResend}
          disabled={sending || !email}
          style={{
            width: '100%',
            height: 44,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            cursor: sending || !email ? 'not-allowed' : 'pointer',
            background: C.white,
            color: C.text,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            opacity: sending || !email ? 0.5 : 1,
            marginBottom: 12,
          }}
        >
          {sending ? 'Sending…' : 'Resend email'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/login')}
          style={{
            width: '100%',
            height: 44,
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: C.mid,
            fontFamily: 'inherit',
            fontSize: 14,
          }}
        >
          Back to login
        </button>
      </div>
    </div>
  );
}
