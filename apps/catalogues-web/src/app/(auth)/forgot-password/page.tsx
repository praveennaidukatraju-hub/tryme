'use client';
import Link from 'next/link';
import { useState } from 'react';
import { MailIcon } from '@/components/icons';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const fieldWrap: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  background: C.field,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  height: 44,
};
const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 14,
  color: C.text,
  paddingLeft: 36,
  paddingRight: 12,
};

export default function ForgotPasswordPage(): React.ReactElement {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    try {
      await fetch(`${BASE}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } finally {
      setLoading(false);
      setSubmitted(true);
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
        padding: '24px 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 'clamp(24px, 8vw, 40px)',
          background: C.card,
          borderRadius: 16,
          border: `1px solid ${C.border}`,
        }}
      >
        <div style={{ marginBottom: 28 }}>
          <LogoAuth />
        </div>
        <h1 style={{ fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>
          Forgot password?
        </h1>
        <p style={{ fontSize: 14, color: C.mid, lineHeight: 1.6, marginBottom: 28 }}>
          Enter your email and we&apos;ll send you a reset link.
        </p>

        {submitted ? (
          <div>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'rgba(0,180,100,0.08)',
                border: '1px solid rgba(0,180,100,0.3)',
                fontSize: 14,
                color: '#00a860',
                marginBottom: 24,
                lineHeight: 1.6,
                overflowWrap: 'anywhere',
              }}
            >
              If an account exists for{' '}
              <strong style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{email}</strong>
              , you&apos;ll receive a reset link shortly.
            </div>
            <Link
              href="/login"
              style={{
                display: 'block',
                textAlign: 'center',
                fontSize: 14,
                color: C.pink,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Back to login
            </Link>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="email" style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
                Email*
              </label>
              <div style={fieldWrap}>
                <span style={{ position: 'absolute', left: 12, color: C.mid, display: 'flex' }}>
                  <MailIcon />
                </span>
                <input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                  suppressHydrationWarning
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || !email}
              style={{
                width: '100%',
                height: 44,
                borderRadius: 8,
                border: 'none',
                cursor: loading || !email ? 'not-allowed' : 'pointer',
                background: C.dark,
                color: C.onDark,
                fontFamily: 'inherit',
                fontWeight: 600,
                fontSize: 14,
                opacity: loading || !email ? 0.6 : 1,
              }}
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
            <Link
              href="/login"
              style={{
                textAlign: 'center',
                fontSize: 13,
                color: C.mid,
                textDecoration: 'none',
              }}
            >
              Back to login
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
