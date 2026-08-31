# Admin Dashboard Login System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real JWT-based authentication into the admin SPA so only users in `admin_users` can access the dashboard.

**Architecture:** The API already has `/v1/auth/login`, `/v1/auth/refresh`, and `/v1/auth/logout` plus a `requireAdmin` guard. We add one new endpoint (`GET /admin/me`) so the SPA can verify admin role post-login. On the SPA side, an `AuthContext` tries a silent refresh on mount (using the httpOnly refresh cookie) and holds the access token in memory. If not authed, `App.tsx` renders `LoginPage` instead of the dashboard.

**Tech Stack:** Fastify (api), Vitest + testcontainers (api tests), React 18 + TypeScript + Vite (admin SPA), jose (JWT verify), `@tryme/db` Drizzle ORM

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `apps/api/src/modules/admin/me.routes.ts` | `GET /admin/me` — return `{ userId, email, role }` for admin users |
| Modify | `apps/api/src/server.ts` | Register `adminMeRoutes` |
| Create | `apps/api/test/integration/admin-me.test.ts` | Integration tests for `GET /admin/me` |
| Create | `apps/admin/src/lib/api.ts` | Module-level token store + `apiFetch` with auto-refresh on 401 |
| Create | `apps/admin/src/context/AuthContext.tsx` | Login/logout/auto-refresh, exposes token + role |
| Create | `apps/admin/src/pages/LoginPage.tsx` | Email+password form; calls `login()` from context |
| Modify | `apps/admin/src/main.tsx` | Wrap with `<AuthProvider>` |
| Modify | `apps/admin/src/App.tsx` | Remove hardcoded role; gate on auth; render `<LoginPage>` when not authed |

---

## Task 1: API — `GET /admin/me` endpoint

**Files:**
- Create: `apps/api/src/modules/admin/me.routes.ts`
- Modify: `apps/api/src/server.ts` (add import + register)
- Create: `apps/api/test/integration/admin-me.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/integration/admin-me.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startContainers, type Containers } from '../helpers/containers';
import { buildTestApp, type TestApp } from '../helpers/api';
import { schema } from '@tryme/db';

describe('GET /admin/me', () => {
  let c: Containers; let app: TestApp;
  beforeAll(async () => { c = await startContainers(); app = await buildTestApp(c); }, 60000);
  afterAll(async () => { await app?.close(); await c?.stop(); });

  async function registerUser(email: string) {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    const { accessToken } = res.json();
    const userId = JSON.parse(atob(accessToken.split('.')[1])).sub as string;
    return { token: accessToken, userId };
  }

  it('returns 401 with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    const { token } = await registerUser('plain@x.com');
    const res = await app.inject({
      method: 'GET', url: '/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns userId, email, and role for admin user', async () => {
    const { token, userId } = await registerUser('admin@x.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'SUPER_ADMIN' });
    const res = await app.inject({
      method: 'GET', url: '/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: expect.any(String),
      email: 'admin@x.com',
      role: 'SUPER_ADMIN',
    });
  });

  it('returns 403 for MODERATOR when only SUPER_ADMIN allowed', async () => {
    const { token, userId } = await registerUser('mod@x.com');
    await app.db.insert(schema.adminUsers).values({ userId, role: 'MODERATOR' });
    const res = await app.inject({
      method: 'GET', url: '/admin/me',
      headers: { authorization: `Bearer ${token}` },
    });
    // /admin/me accepts any admin role — MODERATOR is valid
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'MODERATOR' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @tryme/api test -- admin-me
```

Expected: FAIL — `GET /admin/me` route not found (404 or route missing).

- [ ] **Step 3: Write the endpoint**

```typescript
// apps/api/src/modules/admin/me.routes.ts
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@tryme/db';
import { requireAdmin } from './guard';

export async function adminMeRoutes(app: FastifyInstance) {
  app.get('/admin/me', { preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT']) }, async (req) => {
    const [user] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    return { userId: req.userId, email: user.email, role: req.adminRole };
  });
}
```

- [ ] **Step 4: Register the route in server.ts**

In `apps/api/src/server.ts`, add after the existing admin imports:
```typescript
import { adminMeRoutes } from './modules/admin/me.routes';
```

And inside `buildServer`, after `adminConfigRoutes` registration:
```typescript
await app.register(adminMeRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @tryme/api test -- admin-me
```

Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/me.routes.ts apps/api/src/server.ts apps/api/test/integration/admin-me.test.ts
git commit -m "feat(api): add GET /admin/me endpoint for admin identity verification"
```

---

## Task 2: Admin SPA — API client

**Files:**
- Modify: `apps/admin/src/lib/api.ts` (currently has only mock data helpers — add real fetch logic in a new section; mock exports stay untouched)

**Note:** `api.ts` currently exports only mock data and helpers (`TONES`, `STATUS_ORDER`, `statusBadge`, `MOCK_STATS`, etc.). We add the API fetch client in this same file — no new file needed.

- [ ] **Step 1: Add the API client to `apps/admin/src/lib/api.ts`**

Append at the end of `apps/admin/src/lib/api.ts` (after existing exports):

```typescript
// ── API client ──────────────────────────────────────────────────────────────

let _token: string | null = null;
let _onAuthFailure: (() => void) | null = null;

export function setToken(t: string | null) { _token = t; }
export function getToken() { return _token; }
export function initAuthFailureHandler(cb: () => void) { _onAuthFailure = cb; }

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const makeHeaders = (token: string | null): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  });

  const res = await fetch(path, { ...init, headers: makeHeaders(_token), credentials: 'include' });

  if (res.status === 401 && _token) {
    // Attempt silent refresh
    const refreshRes = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refreshRes.ok) {
      const { accessToken } = await refreshRes.json() as { accessToken: string };
      setToken(accessToken);
      const retry = await fetch(path, { ...init, headers: makeHeaders(accessToken), credentials: 'include' });
      if (!retry.ok) throw new ApiError(retry.status, await retry.json());
      return retry.json() as Promise<T>;
    }
    setToken(null);
    _onAuthFailure?.();
    throw new ApiError(401, { error: { code: 'SESSION_EXPIRED', message: 'session expired' } });
  }

  if (!res.ok) throw new ApiError(res.status, await res.json());
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @tryme/admin build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/lib/api.ts
git commit -m "feat(admin): add apiFetch client with auto-refresh on 401"
```

---

## Task 3: Admin SPA — AuthContext

**Files:**
- Create: `apps/admin/src/context/AuthContext.tsx`

- [ ] **Step 1: Create AuthContext**

```typescript
// apps/admin/src/context/AuthContext.tsx
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { setToken, getToken, initAuthFailureHandler, apiFetch, ApiError } from '../lib/api';

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT';

interface AuthState {
  token: string | null;
  role: AdminRole | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const handleAuthFailure = useCallback(() => {
    setTokenState(null);
    setRole(null);
  }, []);

  useEffect(() => {
    initAuthFailureHandler(handleAuthFailure);
  }, [handleAuthFailure]);

  const fetchRole = useCallback(async () => {
    const me = await apiFetch<{ userId: string; email: string; role: AdminRole }>('/admin/me');
    setRole(me.role);
  }, []);

  // On mount: try silent refresh
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const { accessToken } = await res.json() as { accessToken: string };
          setToken(accessToken);
          setTokenState(accessToken);
          await fetchRole();
        }
      } catch {
        // Not logged in — stay on login page
      } finally {
        setIsLoading(false);
      }
    })();
  }, [fetchRole]);

  const login = useCallback(async (email: string, password: string) => {
    const { accessToken } = await apiFetch<{ accessToken: string }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(accessToken);
    setTokenState(accessToken);
    await fetchRole();
  }, [fetchRole]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/v1/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort
    }
    setToken(null);
    setTokenState(null);
    setRole(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, role, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @tryme/admin build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/context/AuthContext.tsx
git commit -m "feat(admin): add AuthContext with login/logout/silent-refresh"
```

---

## Task 4: Admin SPA — Login Page

**Files:**
- Create: `apps/admin/src/pages/LoginPage.tsx`

- [ ] **Step 1: Create LoginPage**

```tsx
// apps/admin/src/pages/LoginPage.tsx
import { useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { ApiError } from '../lib/api';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Your account does not have admin access.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Invalid email or password.');
      } else {
        setError('Login failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 380,
        padding: '2rem',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{ marginBottom: '1.75rem', textAlign: 'center' }}>
          <div style={{
            fontFamily: 'var(--sans)',
            fontSize: '1.25rem',
            fontWeight: 700,
            color: 'var(--ink)',
            letterSpacing: '-0.02em',
          }}>
            Tryme Admin
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
            Sign in to continue
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--ink-2)' }}>
              Email
            </label>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r)',
                background: 'var(--surface-2)',
                color: 'var(--ink)',
                fontSize: '0.875rem',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--ink-2)' }}>
              Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r)',
                background: 'var(--surface-2)',
                color: 'var(--ink)',
                fontSize: '0.875rem',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: '0.5rem 0.75rem',
              background: 'var(--danger-soft)',
              border: '1px solid var(--danger-border)',
              borderRadius: 'var(--r)',
              color: 'var(--danger-ink)',
              fontSize: '0.8125rem',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: '0.25rem',
              padding: '0.5625rem',
              background: loading ? 'var(--muted-2)' : 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--r)',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: loading ? 'default' : 'pointer',
              transition: 'background 0.15s',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @tryme/admin build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/pages/LoginPage.tsx
git commit -m "feat(admin): add LoginPage with email/password form"
```

---

## Task 5: Admin SPA — Wire everything into App.tsx and main.tsx

**Files:**
- Modify: `apps/admin/src/main.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: Wrap app with AuthProvider in main.tsx**

Replace contents of `apps/admin/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import App from './App.tsx';
import { AuthProvider } from './context/AuthContext.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
```

- [ ] **Step 2: Update App.tsx to gate on auth**

Replace the entire contents of `apps/admin/src/App.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { ToastStack } from './components/ToastStack';
import DashboardPage from './pages/DashboardPage';
import CatalogPage from './pages/CatalogPage';
import UsersPage from './pages/UsersPage';
import JobsPage from './pages/JobsPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import { useAuth } from './context/AuthContext';
import type { ToastItem } from './types';

type Page = 'dashboard' | 'catalog' | 'users' | 'jobs' | 'settings';
type Theme = 'light' | 'dark';

const PAGE_LABELS: Record<Page, string> = {
  dashboard: 'Dashboard',
  catalog: 'Catalog',
  users: 'Users',
  jobs: 'Jobs',
  settings: 'Settings',
};

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return (localStorage.getItem('tryme-theme') as Theme) || 'dark';
}

export default function App() {
  const { token, role, isLoading } = useAuth();
  const [page, setPage] = useState<Page>('dashboard');
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tryme-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const toast = useCallback((t: { kind?: 'error'; title: string; body?: string }) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, kind: t.kind, title: t.title, body: t.body }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const handleNav = useCallback((p: string) => {
    setPage(p as Page);
  }, []);

  const handleNavWithFilter = useCallback((_page: string, _filter?: { page: string; filter?: string }) => {
    setPage(_page as Page);
  }, []);

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        color: 'var(--muted)',
        fontFamily: 'var(--sans)',
        fontSize: '0.875rem',
      }}>
        Loading…
      </div>
    );
  }

  if (!token) {
    return <LoginPage />;
  }

  const trail = ['Tryme', PAGE_LABELS[page]];
  const pageProps = { onNav: handleNavWithFilter, toast };
  const settingsProps = { onNav: handleNavWithFilter, toast, theme, onToggleTheme: toggleTheme };

  return (
    <div className="app">
      <Sidebar page={page} onNav={handleNav} role={role ?? ''} />
      <div className="main">
        <Topbar trail={trail} onNavTrail={(i) => i === 0 && setPage('dashboard')} />
        <main className="content">
          {page === 'dashboard' && <DashboardPage {...pageProps} />}
          {page === 'catalog' && <CatalogPage {...pageProps} />}
          {page === 'users' && <UsersPage {...pageProps} />}
          {page === 'jobs' && <JobsPage {...pageProps} />}
          {page === 'settings' && <SettingsPage {...settingsProps} />}
        </main>
      </div>
      <ToastStack items={toasts} onDismiss={dismissToast} />
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm --filter @tryme/admin build 2>&1 | grep -E "error|warning" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Start dev server and manually verify login flow**

```bash
pnpm --filter @tryme/admin dev
```

Open `http://localhost:5173` in browser. Verify:
1. Login page appears (not dashboard)
2. Wrong credentials → error message shown
3. Non-admin credentials → "account does not have admin access" error
4. Valid admin credentials → dashboard loads with correct role in sidebar
5. Page refresh → stays logged in (silent refresh via cookie)
6. Logout (via Settings page or sidebar) → returns to login page

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/main.tsx apps/admin/src/App.tsx
git commit -m "feat(admin): gate dashboard behind auth — show LoginPage when not authenticated"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Admin login with email/password | Task 4 (LoginPage) + Task 3 (AuthContext.login) |
| JWT issued only to `admin_users` rows | Task 1 (`/admin/me` returns 403 for non-admins; login returns 403 because `/admin/me` fails) |
| Token stored securely (not localStorage) | Task 2/3 — access token in memory only |
| Auto-refresh on page reload | Task 3 — silent refresh in `useEffect` on mount |
| Protected dashboard | Task 5 — `App.tsx` renders `<LoginPage>` when `!token` |
| Role exposed to sidebar/UI | Task 5 — `role` from `useAuth()` passed to `<Sidebar>` |
| Logout | Task 3 — `logout()` calls `/v1/auth/logout`, clears token |
| 401 auto-refresh mid-session | Task 2 — `apiFetch` retry logic |
| CLAUDE.md invariant: double-check admin (JWT + DB) | Preserved — `requireAdmin` guard in `/admin/me` does both checks |

### Placeholder scan

No TBDs, no "implement later", no "handle edge cases" without code. All steps have actual code.

### Type consistency

- `AdminRole` type defined in `AuthContext.tsx`, matches `guard.ts` union `'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT'`
- `apiFetch<T>` used consistently with typed generics throughout
- `role ?? ''` in App.tsx handles `null` role safely for `<Sidebar role>` prop (string expected)
- `setToken` / `getToken` from `api.ts` used consistently in `AuthContext.tsx`
