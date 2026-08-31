'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginBody } from '@tryme/types';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Eye, EyeOff, GiftIcon, LockIcon, MailIcon } from '@/components/icons';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';
import { Divider } from '@/components/ui/divider';
import { GoogleBtn } from '@/components/ui/google-btn';
import { initToken } from '@/lib/api';

type LoginForm = z.infer<typeof LoginBody>;

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 14,
  color: C.text,
  paddingLeft: 36,
  paddingRight: 12,
};

function ImagePanel() {
  return (
    <div
      className="auth-image-panel"
      style={{
        width: '58.2%',
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* biome-ignore lint/performance/noImgElement: auth background image */}
      <img
        src={`${BASE}/assets/auth-bg.png`}
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'top center',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0) 60%, rgba(0,0,0,0.72) 100%)',
        }}
      />
      <div style={{ position: 'absolute', bottom: 40, left: 40, right: 40 }}>
        <h2
          style={{
            fontWeight: 700,
            fontSize: 20,
            color: '#fff',
            marginBottom: 8,
            lineHeight: 1.4,
          }}
        >
          Turn Flat Lay Images Into Premium Model Shoots
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6, margin: 0 }}>
          Generate realistic AI catalogue photos with premium models, luxury backgrounds, and
          ecommerce-ready poses.
        </p>
      </div>
    </div>
  );
}

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/studio';
  const resetSuccess = searchParams.get('reset') === '1';
  const googleErrorCode = searchParams.get('error');
  const googleErrorMessage = googleErrorCode
    ? "Google sign-in didn't go through — please try again."
    : '';
  const [error, setError] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [freeCredits, setFreeCredits] = useState(100);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/v1/config/free-plan`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { credits?: number }) => {
        if (typeof data.credits === 'number' && data.credits > 0) setFreeCredits(data.credits);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(LoginBody),
  });

  async function onSubmit(data: LoginForm) {
    setError('');
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code === 'EMAIL_NOT_VERIFIED') {
        sessionStorage.setItem('pending_verify_email', data.email);
        router.push('/verify-email');
        return;
      }
      setError(body.error?.message ?? 'Login failed');
      return;
    }
    const { accessToken } = (await res.json().catch(() => ({}))) as { accessToken?: string };
    if (accessToken) initToken(accessToken);
    router.push(nextPath);
    router.refresh();
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `#000 url('${BASE}/assets/auth-screen-bg.png') center center / cover no-repeat`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        boxSizing: 'border-box',
      }}
    >
      <div
        className="auth-card"
        style={{
          width: '100%',
          maxWidth: 1143,
          height: 'min(772px, 88vh)',
          background: C.card,
          borderRadius: 20,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        {/* Form side */}
        <div
          style={{
            flex: 1,
            paddingLeft: 48,
            paddingRight: 40,
            paddingTop: 48,
            paddingBottom: 48,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 20,
            overflowY: 'auto',
          }}
        >
          <LogoAuth />

          {resetSuccess && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(0,180,100,0.08)',
                border: '1px solid rgba(0,180,100,0.3)',
                fontSize: 13,
                color: '#00a860',
              }}
            >
              Password reset successfully. Please log in.
            </div>
          )}

          {googleErrorMessage && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(220,38,38,0.06)',
                border: '1px solid rgba(220,38,38,0.25)',
                fontSize: 13,
                color: C.pink,
              }}
            >
              {googleErrorMessage}
            </div>
          )}

          <div>
            <h1 style={{ fontWeight: 700, fontSize: 22, color: C.text, marginBottom: 4 }}>
              Welcome Back
            </h1>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: C.mid }}
            >
              <GiftIcon /> <span>Get {freeCredits} Free credits to start.</span>
            </div>
          </div>

          <GoogleBtn label="Continue with Google" next={nextPath} />
          <Divider label="Or Continue With" />

          <form
            onSubmit={handleSubmit(onSubmit)}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="email" style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
                Email or Username*
              </label>
              <div style={fieldWrap}>
                <span style={{ position: 'absolute', left: 12, color: C.mid, display: 'flex' }}>
                  <MailIcon />
                </span>
                <input
                  id="email"
                  type="text"
                  placeholder="Enter your email or username"
                  autoComplete="username"
                  style={inputStyle}
                  suppressHydrationWarning
                  {...register('email')}
                />
              </div>
              {errors.email && (
                <p style={{ fontSize: 12, color: C.pink, margin: 0 }}>{errors.email.message}</p>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <label htmlFor="password" style={{ fontWeight: 700, fontSize: 14, color: C.text }}>
                  Password*
                </label>
                <button
                  type="button"
                  onClick={() => router.push('/forgot-password')}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: C.text,
                    fontWeight: 500,
                  }}
                >
                  Forgot Password?
                </button>
              </div>
              <div style={fieldWrap}>
                <span style={{ position: 'absolute', left: 12, color: C.mid, display: 'flex' }}>
                  <LockIcon />
                </span>
                <input
                  id="password"
                  type={showPwd ? 'text' : 'password'}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  style={{ ...inputStyle, paddingRight: 36 }}
                  suppressHydrationWarning
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
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
                  {showPwd ? <EyeOff /> : <Eye />}
                </button>
              </div>
              {errors.password && (
                <p style={{ fontSize: 12, color: C.pink, margin: 0 }}>{errors.password.message}</p>
              )}
            </div>

            {error && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: `1px solid ${C.pink}`,
                  background: 'rgba(245,92,122,0.06)',
                  fontSize: 14,
                  color: C.pink,
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
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
                opacity: isSubmitting ? 0.6 : 1,
              }}
            >
              {isSubmitting ? 'Signing in…' : 'Continue'}
            </button>
          </form>

          <p style={{ textAlign: 'center', fontSize: 12, color: C.light, margin: 0 }}>
            Don&apos;t have an account?{' '}
            <Link
              href="/register"
              style={{ fontWeight: 700, fontSize: 12, color: C.pink, textDecoration: 'none' }}
            >
              Sign Up
            </Link>
          </p>
        </div>

        <ImagePanel />
      </div>
    </div>
  );
}

export default function LoginPage(): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            background: `#000 url('${BASE}/assets/auth-screen-bg.png') center center / cover no-repeat`,
          }}
        />
      }
    >
      <LoginFormInner />
    </Suspense>
  );
}
