'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Eye, EyeOff, LockIcon } from '@/components/icons';
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

function ResetPasswordInner(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'Reset failed. The link may have expired.');
        return;
      }
      setSuccess(true);
      setTimeout(() => router.push('/login?reset=1'), 1500);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
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
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 14, color: C.mid, marginBottom: 20 }}>Invalid reset link.</p>
          <Link href="/forgot-password" style={{ color: C.pink, fontWeight: 600, fontSize: 14 }}>
            Request a new link
          </Link>
        </div>
      </div>
    );
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
          Reset your password
        </h1>
        <p style={{ fontSize: 14, color: C.mid, marginBottom: 28 }}>
          Enter a new password for your account.
        </p>

        {success ? (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(0,180,100,0.08)',
              border: '1px solid rgba(0,180,100,0.3)',
              fontSize: 14,
              color: '#00a860',
              textAlign: 'center',
            }}
          >
            Password reset! Redirecting to login…
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="newPassword" style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
                New Password*
              </label>
              <div style={fieldWrap}>
                <span style={{ position: 'absolute', left: 12, color: C.mid, display: 'flex' }}>
                  <LockIcon />
                </span>
                <input
                  id="newPassword"
                  type={showNewPassword ? 'text' : 'password'}
                  placeholder="Min. 8 characters"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={{ ...inputStyle, paddingRight: 40 }}
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((visible) => !visible)}
                  aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                  aria-pressed={showNewPassword}
                  title={showNewPassword ? 'Hide new password' : 'Show new password'}
                  style={{
                    position: 'absolute',
                    right: 10,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: C.mid,
                    display: 'flex',
                    padding: 0,
                  }}
                >
                  {showNewPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label
                htmlFor="confirmPassword"
                style={{ fontWeight: 700, fontSize: 14, color: C.text }}
              >
                Confirm Password*
              </label>
              <div style={fieldWrap}>
                <span style={{ position: 'absolute', left: 12, color: C.mid, display: 'flex' }}>
                  <LockIcon />
                </span>
                <input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={{ ...inputStyle, paddingRight: 40 }}
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((visible) => !visible)}
                  aria-label={
                    showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
                  }
                  aria-pressed={showConfirmPassword}
                  title={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                  style={{
                    position: 'absolute',
                    right: 10,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: C.mid,
                    display: 'flex',
                    padding: 0,
                  }}
                >
                  {showConfirmPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </div>
            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: `1px solid ${C.pink}`,
                  background: 'rgba(245,92,122,0.06)',
                  fontSize: 13,
                  color: C.pink,
                }}
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                height: 44,
                borderRadius: 8,
                border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                background: C.dark,
                color: C.onDark,
                fontFamily: 'inherit',
                fontWeight: 600,
                fontSize: 14,
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? 'Resetting…' : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.bg }} />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
