'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LogoAuth } from '@/components/logo';
import { C } from '@/components/tokens';
import { Divider } from '@/components/ui/divider';
import { GoogleBtn } from '@/components/ui/google-btn';
import { catalogAppLogin, initCatalogAppToken } from './catalog-app-api';
import { LoggedOutProvider } from './logged-out-context';

type AuthState = 'checking' | 'authed' | 'unauthed';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: 'Google sign-in failed. Please try again.',
  not_a_merchant: "This Google account isn't enabled for virtual try-on yet. Contact support.",
};

function LoginFormInner({ onLoggedIn }: { onLoggedIn: () => void }) {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await catalogAppLogin(identifier, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        padding: 20,
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 360,
          maxWidth: '100%',
          background: C.white,
          borderRadius: 14,
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.12)',
        }}
      >
        <LogoAuth />
        <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Try On Library</h1>

        <GoogleBtn label="Continue with Google" next="/tryon-library-app" />
        <Divider label="Or Continue With" />

        {oauthError && ERROR_MESSAGES[oauthError] && (
          <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{ERROR_MESSAGES[oauthError]}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="identifier" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Email or Username
          </label>
          <input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            suppressHydrationWarning
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="password" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            suppressHydrationWarning
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        {error && <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{
            height: 44,
            borderRadius: 8,
            border: 'none',
            background: C.dark,
            color: C.onDark,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: C.white }} />}>
      <LoginFormInner onLoggedIn={onLoggedIn} />
    </Suspense>
  );
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    if ('serviceWorker' in navigator) {
      const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
      navigator.serviceWorker
        .register(`${BASE}/tryon-library-app-sw.js`, { scope: `${BASE}/tryon-library-app` })
        .catch(() => {});
    }
    (async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/catalog-app/refresh`,
          {
            method: 'POST',
          },
        );
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { accessToken?: string };
          if (data.accessToken) {
            initCatalogAppToken(data.accessToken);
            setAuthState('authed');
            return;
          }
        }
        setAuthState('unauthed');
      } catch {
        if (!cancelled) setAuthState('unauthed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLoggedOut() {
    setAuthState('unauthed');
  }

  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh', background: C.white }} />;
  }
  if (authState === 'unauthed') {
    return <LoginForm onLoggedIn={() => setAuthState('authed')} />;
  }
  return <LoggedOutProvider onLoggedOut={handleLoggedOut}>{children}</LoggedOutProvider>;
}
