# Web UI Restyle (vastra3.0 design) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `apps/web` to match the new vastra3.0 design — new sidebar nav, two-column auth pages, new Assets page, updated Pricing layout, and visual polish across all app pages. All existing API wiring preserved.

**Architecture:** Pure UI restyle — no API changes, no routing changes (except root redirect). New CSS classes added to `globals.css`. Existing `react-hook-form` / `react-query` logic kept intact in every page. New Assets page is UI-only with mock data.

**Tech Stack:** Next.js 15 App Router, Tailwind + custom CSS vars (`globals.css`), react-hook-form, react-query, Poppins font (already loaded).

**Design reference:** `vastra3.0/vastra.html` — all colors, layout, component shapes come from there.

**Design tokens already in globals.css:**
- `--peach: #F55C7A` (pink)
- `--amber: #F6B553`
- `--grad: linear-gradient(135deg, #F55C7A 0%, #F6B553 100%)`
- `--grad-soft: linear-gradient(135deg, rgba(245,92,122,0.10), rgba(246,181,83,0.10))`
- `--sidebar: #141414`, `--sidebar-2: #1B1B1B`, `--sidebar-line: rgba(255,255,255,0.07)`
- `--ink: #141414`, `--mute: #6E6A63`, `--surface: #FFFFFF`, `--bg: #FBF8F3`
- `--line: #ECE7DD`, `--mint: #209E46`

---

## File Map

| Action | File |
|--------|------|
| Delete | `apps/web/src/app/home/page.tsx` |
| Modify | `apps/web/src/app/page.tsx` — replace 500-line landing with redirect |
| Modify | `apps/web/src/app/globals.css` — add new utility classes |
| Modify | `apps/web/src/components/sidebar.tsx` — new nav items + logo |
| Modify | `apps/web/src/app/(auth)/login/page.tsx` — two-column layout |
| Modify | `apps/web/src/app/(auth)/register/page.tsx` — two-column layout |
| Create | `apps/web/src/app/(app)/assets/page.tsx` — new page, UI only |
| Modify | `apps/web/src/app/(app)/credits/page.tsx` — add pricing table section |
| Modify | `apps/web/src/app/(app)/account/page.tsx` — tab + layout updates |
| Modify | `apps/web/src/app/(app)/dashboard/page.tsx` — date grouping + new header |
| Modify | `apps/web/src/app/(app)/catalogues/[id]/page.tsx` — new header style |
| Modify | `apps/web/src/app/(app)/tryon/page.tsx` — step labels + TopBar |

---

## Task 1: Logo assets + root redirect + delete home page

**Files:**
- Delete: `apps/web/src/app/home/page.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Copy: `vastra3.0/assets/*.png` → `apps/web/public/assets/`

- [ ] **Step 1: Copy logo assets**

```bash
mkdir -p apps/web/public/assets
cp vastra3.0/assets/logo-icon.png apps/web/public/assets/
cp vastra3.0/assets/logo-icon-large.png apps/web/public/assets/
cp vastra3.0/assets/logo-wordmark.png apps/web/public/assets/
cp vastra3.0/assets/logo-wordmark-large.png apps/web/public/assets/
cp vastra3.0/assets/auth-bg.png apps/web/public/assets/
```

- [ ] **Step 2: Delete home page**

```bash
rm apps/web/src/app/home/page.tsx
```

- [ ] **Step 3: Replace page.tsx with redirect**

Replace entire `apps/web/src/app/page.tsx` with:

```typescript
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default async function RootPage() {
  const cookieStore = await cookies();
  const isLoggedIn = !!cookieStore.get('access_token');
  redirect(isLoggedIn ? '/tryon' : '/login');
}
```

- [ ] **Step 4: Verify build**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/public/assets/
git rm apps/web/src/app/home/page.tsx
git commit -m "feat(web): replace landing page with redirect, add logo assets"
```

---

## Task 2: Add CSS utility classes to globals.css

**Files:**
- Modify: `apps/web/src/app/globals.css`

The new design needs a few CSS patterns not in globals.css. Add them after the existing `.av-sidebar` block.

- [ ] **Step 1: Add topbar, auth-layout, and gradient-border classes**

Append to the end of `apps/web/src/app/globals.css`:

```css
/* ── vastra3.0 layout helpers ──────────────────────────────────── */

/* Two-column auth shell */
.av-auth-shell {
  display: flex;
  height: 100vh;
  background: var(--surface);
}
.av-auth-form-col {
  width: 600px;
  min-width: 600px;
  padding: 0 96px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 24px;
  overflow-y: auto;
}
.av-auth-image-col {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.av-auth-image-col img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.av-auth-image-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0,0,0,0) 60%, rgba(0,0,0,0.70) 100%);
}
.av-auth-image-caption {
  position: absolute;
  bottom: 40px;
  left: 44px;
  right: 44px;
}
@media (max-width: 900px) {
  .av-auth-form-col { width: 100%; min-width: 0; padding: 0 32px; }
  .av-auth-image-col { display: none; }
}

/* Dark submit button (used on auth pages) */
.av-btn-dark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 20px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-family: var(--font-poppins, inherit);
  font-weight: 600;
  font-size: 14px;
  background: var(--ink);
  color: #FEFEFE;
  transition: opacity .15s;
  width: 100%;
}
.av-btn-dark:hover { opacity: .85; }
.av-btn-dark:disabled { opacity: .55; cursor: not-allowed; }

/* Gradient button */
.av-btn-grad {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 20px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-family: var(--font-poppins, inherit);
  font-weight: 600;
  font-size: 14px;
  background: var(--grad);
  color: #FEFEFE;
  transition: opacity .15s;
}
.av-btn-grad:hover { opacity: .85; }

/* Auth divider */
.av-auth-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--mute);
}
.av-auth-divider::before,
.av-auth-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* Top bar (app pages) */
.av-topbar {
  height: 76px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  padding: 0 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.av-topbar-title { font-weight: 700; font-size: 20px; color: var(--ink); }
.av-topbar-sub { font-size: 13px; color: var(--mute); margin-top: 2px; }

/* Pricing table */
.av-pricing-table {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}
.av-pricing-table-head {
  display: flex;
  border-bottom: 1px solid var(--line);
}
.av-pricing-feat-col {
  width: 240px;
  flex-shrink: 0;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
}
.av-pricing-plan-col {
  flex: 1;
  padding: 16px;
  border-left: 1px solid var(--line);
  position: relative;
}
.av-pricing-plan-col.highlight {
  background: var(--grad);
  color: #FEFEFE;
}
.av-pricing-row {
  display: flex;
  border-bottom: 1px solid var(--line);
}
.av-pricing-row:last-child { border-bottom: none; }
.av-pricing-row:hover { background: #FAFAFA; }
.av-pricing-row-feat {
  width: 240px;
  flex-shrink: 0;
  padding: 14px 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.av-pricing-row-val {
  flex: 1;
  padding: 14px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--mute);
  border-left: 1px solid var(--line);
}
.av-pricing-section-head {
  display: flex;
  background: #FAFAFA;
  border-bottom: 1px solid var(--line);
}
.av-pricing-section-label {
  width: 240px;
  flex-shrink: 0;
  padding: 10px 20px;
  font-size: 11px;
  font-weight: 700;
  color: var(--mute);
  letter-spacing: .5px;
}

/* Catalogue date group header */
.av-cat-date-group { margin-bottom: 28px; }
.av-cat-date-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--mute);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

/* Assets page grid */
.av-assets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.av-asset-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow .15s;
}
.av-asset-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
.av-asset-thumb {
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
}
.av-asset-meta { padding: 10px 14px; }
.av-asset-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.av-asset-info { font-size: 11px; color: var(--mute); }
.av-asset-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(245,92,122,0.10);
  color: var(--peach);
  font-size: 11px;
  font-weight: 500;
}
```

- [ ] **Step 2: Verify CSS added correctly (no syntax errors)**

```bash
pnpm --filter @tryme/web build 2>&1 | head -20
```

Expected: build starts (CSS parsed), no parse errors before compilation.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "feat(web): add vastra3.0 CSS utility classes"
```

---

## Task 3: Sidebar restyle

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

New nav: Studio → `/tryon`, Catalogues → `/dashboard`, Assets → `/assets`, Pricing → `/credits`, Settings → `/account`. Remove Home. Remove dark mode toggle. New logo uses `/assets/logo-icon.png` + `/assets/logo-wordmark.png`.

**Keep:** `useQuery` for credits and me, `handleSignOut`, collapsed state.

- [ ] **Step 1: Replace sidebar.tsx**

```typescript
'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface CreditsResponse { balance: number }
interface MeResponse { email: string; displayName: string | null }

const StudioIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
  </svg>
);
const CatalogueIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
  </svg>
);
const AssetsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>
  </svg>
);
const PricingIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm0 0v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
  </svg>
);
const SettingsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14"/>
  </svg>
);
const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z"/>
  </svg>
);
const LogOutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <path d="M16 17l5-5-5-5M21 12H9"/>
  </svg>
);

const NAV_ITEMS = [
  { id: 'studio',     href: '/tryon',     label: 'Studio',     icon: <StudioIcon /> },
  { id: 'catalogues', href: '/dashboard', label: 'Catalogues', icon: <CatalogueIcon /> },
  { id: 'assets',     href: '/assets',    label: 'Assets',     icon: <AssetsIcon /> },
  { id: 'pricing',    href: '/credits',   label: 'Pricing',    icon: <PricingIcon /> },
  { id: 'settings',   href: '/account',   label: 'Settings',   icon: <SettingsIcon /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const { data: credits } = useQuery<CreditsResponse>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });

  const { data: me } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const balance = credits?.balance ?? 0;
  const maxBalance = 2500;

  const email = me?.email ?? '';
  const displayName = me?.displayName ?? email.split('@')[0] ?? 'User';
  const initials = displayName.slice(0, 2).toUpperCase() || 'U';

  const activeId = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + '/')
  )?.id;

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <aside style={{
      width: 260, minWidth: 260, height: '100vh',
      background: '#141414',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      borderRight: '1px solid #282828',
      position: 'sticky', top: 0, flexShrink: 0,
    }}>
      {/* Top */}
      <div>
        {/* Logo row */}
        <div style={{
          padding: '24px 20px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <Link href="/tryon" style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${BASE}/assets/logo-icon.png`} alt="" style={{ height: 24, width: 'auto' }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${BASE}/assets/logo-wordmark.png`} alt="Ai Vastra" style={{ height: 20, width: 'auto', filter: 'brightness(0) invert(1)' }} />
          </Link>
        </div>

        {/* Nav */}
        <nav style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeId === item.id;
            return (
              <Link
                key={item.id}
                href={item.href}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 16px', borderRadius: 8,
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(245,92,122,0.15), rgba(246,181,83,0.15))'
                    : 'transparent',
                  color: '#FEFEFE',
                  fontFamily: 'var(--font-poppins, inherit)',
                  fontWeight: 500, fontSize: 14,
                  textDecoration: 'none',
                  transition: 'background .15s',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ opacity: isActive ? 1 : 0.6 }}>{item.icon}</span>
                <span style={{ opacity: isActive ? 1 : 0.8 }}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Bottom */}
      <div style={{ padding: '0 20px 20px' }}>
        {/* Credits widget */}
        <div style={{
          borderRadius: 12,
          background: 'rgba(249,249,249,0.05)',
          border: '1px solid rgba(227,227,227,0.10)',
          padding: '14px 16px',
          marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14 }}>🔗</span>
              <span style={{ color: '#FEFEFE', fontSize: 13, fontWeight: 500 }}>Credits Left:</span>
            </div>
            <span style={{ color: '#FEFEFE', fontSize: 13, fontWeight: 500 }}>
              {balance}<span style={{ color: '#888', fontSize: 11 }}>/{maxBalance}</span>
            </span>
          </div>
          <Link href="/credits" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '7px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: 'rgba(255,255,255,0.08)', color: '#FEFEFE',
            fontFamily: 'var(--font-poppins, inherit)', fontSize: 13, fontWeight: 500,
            textDecoration: 'none',
          }}>
            <PlusIcon /> Credit Top-up
          </Link>
        </div>

        {/* User row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link href="/account" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', flex: 1, minWidth: 0 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 8, background: '#FCE8CA',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 600, color: '#141414', flexShrink: 0,
            }}>{initials}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#FEFEFE', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
              {email && <div style={{ color: '#EEEEEE', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>}
            </div>
          </Link>
          <button onClick={handleSignOut} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', flexShrink: 0, padding: 4 }} title="Sign out">
            <LogOutIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "feat(web): restyle sidebar — new nav items + vastra3.0 logo"
```

---

## Task 4: Auth pages restyle (Login + Register)

**Files:**
- Modify: `apps/web/src/app/(auth)/login/page.tsx`
- Modify: `apps/web/src/app/(auth)/register/page.tsx`

Two-column layout: left = form (600px), right = `auth-bg.png` + overlay caption. Keep all `useForm` / fetch / Zod logic. No Google OAuth wiring (button is UI only).

- [ ] **Step 1: Replace login page.tsx**

```typescript
'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginBody } from '@tryme/types';
import type { z } from 'zod';

type LoginForm = z.infer<typeof LoginBody>;

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <path d="M22 6l-10 7L2 6"/>
  </svg>
);
const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0110 0v4"/>
  </svg>
);
const GiftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 12v10H4V12"/><path d="M22 7H2v5h20V7z"/><path d="M12 22V7"/>
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/>
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
  </svg>
);

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', height: 44,
  padding: '0 16px 0 36px',
  background: '#F9F9F9', border: '1px solid #EEEEEE', borderRadius: 8,
  fontSize: 14, color: '#141414', fontFamily: 'inherit', outline: 'none',
};

function FieldWithIcon({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span style={{ position: 'absolute', left: 12, color: '#626262', display: 'flex', pointerEvents: 'none' }}>{icon}</span>
      {children}
    </div>
  );
}

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/tryon';
  const [error, setError] = useState('');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({
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
      const body = await res.json() as { error?: { message?: string } };
      setError(body.error?.message ?? 'Login failed');
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  return (
    <div className="av-auth-shell">
      {/* Left — form */}
      <div className="av-auth-form-col">
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/assets/logo-icon-large.png`} alt="" style={{ height: 36, width: 'auto' }} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/assets/logo-wordmark-large.png`} alt="Ai Vastra" style={{ height: 30, width: 'auto' }} />
        </div>

        <div>
          <h1 style={{ fontWeight: 700, fontSize: 22, color: '#141414', marginBottom: 4 }}>Welcome Back</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#626262' }}>
            <GiftIcon /> <span>Get 100 Free credits to start.</span>
          </div>
        </div>

        {/* Google button (UI only) */}
        <button style={{
          width: '100%', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: '#FEFEFE', border: '1px solid #E8E8E8', borderRadius: 8, cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 500, fontSize: 14, color: '#141414',
        }}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.3 1.2 8.4 3.2l6.3-6.3C34.9 2.7 29.8.5 24 .5 14.8.5 7 6.1 3.3 14l7.4 5.7C12.5 13.4 17.8 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.4-4.8 7.1l7.4 5.7c4.3-4 6.8-9.8 7.2-16.8z"/>
            <path fill="#FBBC05" d="M10.7 28.3A14.9 14.9 0 019.5 24c0-1.5.3-3 .7-4.3L2.8 14C1 17.1 0 20.4 0 24s1 6.9 2.8 10l7.9-5.7z"/>
            <path fill="#34A853" d="M24 47.5c5.8 0 10.7-1.9 14.3-5.1l-7.4-5.7c-2 1.3-4.4 2.1-6.9 2.1-6.2 0-11.5-4-13.3-9.5l-7.4 5.7C7 41.9 14.8 47.5 24 47.5z"/>
          </svg>
          Continue with Google
        </button>

        <div className="av-auth-divider">Or Continue With</div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="av-field">
            <label className="av-field-label" htmlFor="email">Email*</label>
            <FieldWithIcon icon={<MailIcon />}>
              <input id="email" type="email" placeholder="Enter your email" autoComplete="email" style={inputStyle} {...register('email')} />
            </FieldWithIcon>
            {errors.email && <p style={{ fontSize: 12, color: 'var(--peach)', margin: '4px 0 0' }}>{errors.email.message}</p>}
          </div>
          <div className="av-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="av-field-label" htmlFor="password" style={{ marginBottom: 0 }}>Password*</label>
              <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#141414', fontWeight: 500 }}>Reset Password</button>
            </div>
            <FieldWithIcon icon={<LockIcon />}>
              <input id="password" type="password" placeholder="Enter password" autoComplete="current-password" style={inputStyle} {...register('password')} />
            </FieldWithIcon>
            {errors.password && <p style={{ fontSize: 12, color: 'var(--peach)', margin: '4px 0 0' }}>{errors.password.message}</p>}
          </div>
          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--peach)', background: 'rgba(245,92,122,0.06)', fontSize: 14, color: 'var(--peach)' }}>{error}</div>
          )}
          <button type="submit" disabled={isSubmitting} className="av-btn-dark" style={{ marginTop: 4 }}>
            {isSubmitting ? 'Signing in…' : 'Continue'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: '#939393' }}>
          Don&apos;t have an account?{' '}
          <Link href="/register" style={{ fontWeight: 700, fontSize: 12, color: 'var(--peach)', textDecoration: 'none' }}>Sign Up</Link>
        </p>
      </div>

      {/* Right — image */}
      <div className="av-auth-image-col">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE}/assets/auth-bg.png`} alt="" />
        <div className="av-auth-image-overlay" />
        <div className="av-auth-image-caption">
          <h2 style={{ fontWeight: 700, fontSize: 20, color: '#FEFEFE', marginBottom: 8, lineHeight: 1.4 }}>
            Turn Flat Lay Images Into Premium Model Shoots
          </h2>
          <p style={{ fontSize: 13, color: '#EEEEEE', lineHeight: 1.6, margin: 0 }}>
            Generate realistic AI catalogue photos with premium models, luxury backgrounds, and ecommerce-ready poses.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#FEFEFE' }} />}>
      <LoginFormInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Replace register page.tsx**

```typescript
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { RegisterBody } from '@tryme/types';
import type { z } from 'zod';

type RegisterForm = z.infer<typeof RegisterBody>;

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <path d="M22 6l-10 7L2 6"/>
  </svg>
);
const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0110 0v4"/>
  </svg>
);
const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);
const GiftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 12v10H4V12"/><path d="M22 7H2v5h20V7z"/><path d="M12 22V7"/>
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/>
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
  </svg>
);

const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', height: 44,
  padding: '0 16px 0 36px',
  background: '#F9F9F9', border: '1px solid #EEEEEE', borderRadius: 8,
  fontSize: 14, color: '#141414', fontFamily: 'inherit', outline: 'none',
};

function FieldWithIcon({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span style={{ position: 'absolute', left: 12, color: '#626262', display: 'flex', pointerEvents: 'none' }}>{icon}</span>
      {children}
    </div>
  );
}

export default function RegisterPage(): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState('');

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RegisterForm>({
    resolver: zodResolver(RegisterBody),
  });

  async function onSubmit(data: RegisterForm) {
    setError('');
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json() as { error?: { message?: string } };
      setError(body.error?.message ?? 'Registration failed');
      return;
    }
    router.push('/tryon');
    router.refresh();
  }

  return (
    <div className="av-auth-shell">
      {/* Left — form */}
      <div className="av-auth-form-col" style={{ paddingTop: 40, paddingBottom: 40 }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/assets/logo-icon-large.png`} alt="" style={{ height: 36, width: 'auto' }} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE}/assets/logo-wordmark-large.png`} alt="Ai Vastra" style={{ height: 30, width: 'auto' }} />
        </div>

        <div>
          <h1 style={{ fontWeight: 700, fontSize: 22, color: '#141414', marginBottom: 4 }}>Create Your Account</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#626262' }}>
            <GiftIcon /> <span>Get 100 Free credits to start.</span>
          </div>
        </div>

        {/* Google button (UI only) */}
        <button style={{
          width: '100%', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          background: '#FEFEFE', border: '1px solid #E8E8E8', borderRadius: 8, cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 500, fontSize: 14, color: '#141414',
        }}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.3 1.2 8.4 3.2l6.3-6.3C34.9 2.7 29.8.5 24 .5 14.8.5 7 6.1 3.3 14l7.4 5.7C12.5 13.4 17.8 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.4-4.8 7.1l7.4 5.7c4.3-4 6.8-9.8 7.2-16.8z"/>
            <path fill="#FBBC05" d="M10.7 28.3A14.9 14.9 0 019.5 24c0-1.5.3-3 .7-4.3L2.8 14C1 17.1 0 20.4 0 24s1 6.9 2.8 10l7.9-5.7z"/>
            <path fill="#34A853" d="M24 47.5c5.8 0 10.7-1.9 14.3-5.1l-7.4-5.7c-2 1.3-4.4 2.1-6.9 2.1-6.2 0-11.5-4-13.3-9.5l-7.4 5.7C7 41.9 14.8 47.5 24 47.5z"/>
          </svg>
          Sign Up with Google
        </button>

        <div className="av-auth-divider">Or Create Account With Email</div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="av-field">
            <label className="av-field-label" htmlFor="displayName">Full Name</label>
            <FieldWithIcon icon={<UserIcon />}>
              <input id="displayName" type="text" placeholder="Enter your full name" autoComplete="name" style={inputStyle} {...register('displayName')} />
            </FieldWithIcon>
            {errors.displayName && <p style={{ fontSize: 12, color: 'var(--peach)', margin: '4px 0 0' }}>{errors.displayName.message}</p>}
          </div>
          <div className="av-field">
            <label className="av-field-label" htmlFor="email">Email*</label>
            <FieldWithIcon icon={<MailIcon />}>
              <input id="email" type="email" placeholder="Enter your email" autoComplete="email" style={inputStyle} {...register('email')} />
            </FieldWithIcon>
            {errors.email && <p style={{ fontSize: 12, color: 'var(--peach)', margin: '4px 0 0' }}>{errors.email.message}</p>}
          </div>
          <div className="av-field">
            <label className="av-field-label" htmlFor="password">Password*</label>
            <FieldWithIcon icon={<LockIcon />}>
              <input id="password" type="password" placeholder="Enter password" autoComplete="new-password" style={inputStyle} {...register('password')} />
            </FieldWithIcon>
            {errors.password && <p style={{ fontSize: 12, color: 'var(--peach)', margin: '4px 0 0' }}>{errors.password.message}</p>}
          </div>
          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid var(--peach)', background: 'rgba(245,92,122,0.06)', fontSize: 14, color: 'var(--peach)' }}>{error}</div>
          )}
          <button type="submit" disabled={isSubmitting} className="av-btn-dark" style={{ marginTop: 4 }}>
            {isSubmitting ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: '#939393', paddingBottom: 20 }}>
          Already have an account?{' '}
          <Link href="/login" style={{ fontWeight: 700, fontSize: 12, color: 'var(--peach)', textDecoration: 'none' }}>Sign In</Link>
        </p>
      </div>

      {/* Right — image */}
      <div className="av-auth-image-col">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE}/assets/auth-bg.png`} alt="" />
        <div className="av-auth-image-overlay" />
        <div className="av-auth-image-caption">
          <h2 style={{ fontWeight: 700, fontSize: 20, color: '#FEFEFE', marginBottom: 8, lineHeight: 1.4 }}>
            Turn Flat Lay Images Into Premium Model Shoots
          </h2>
          <p style={{ fontSize: 13, color: '#EEEEEE', lineHeight: 1.6, margin: 0 }}>
            Generate realistic AI catalogue photos with premium models, luxury backgrounds, and ecommerce-ready poses.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/'(auth)'/login/page.tsx apps/web/src/app/'(auth)'/register/page.tsx
git commit -m "feat(web): restyle auth pages — two-column layout with image panel"
```

---

## Task 5: New Assets page

**Files:**
- Create: `apps/web/src/app/(app)/assets/page.tsx`

UI only. Mock garment cards. No API calls. Grid layout matching vastra3.0 `AssetsPage`.

- [ ] **Step 1: Create the assets page**

```typescript
'use client';

const MOCK_ASSETS = [
  { name: 'blue_kurta_flatlay.jpg', size: '2.4 MB', date: 'May 25, 2026', type: 'Top' },
  { name: 'floral_saree_clean.png', size: '3.1 MB', date: 'May 25, 2026', type: 'Saree' },
  { name: 'mens_white_shirt.jpg', size: '1.8 MB', date: 'May 24, 2026', type: 'Shirt' },
  { name: 'black_trousers_flat.jpg', size: '2.0 MB', date: 'May 24, 2026', type: 'Trouser' },
  { name: 'red_top_plain.png', size: '1.5 MB', date: 'May 23, 2026', type: 'Top' },
  { name: 'denim_jeans_blue.jpg', size: '2.8 MB', date: 'May 23, 2026', type: 'Jeans' },
  { name: 'green_kurta_set.jpg', size: '3.4 MB', date: 'May 22, 2026', type: 'Kurta' },
  { name: 'pink_skirt_cotton.png', size: '1.9 MB', date: 'May 22, 2026', type: 'Skirt' },
];

const BG_COLORS = ['#f5f0e8','#e8f0f5','#f0e8f5','#e8f5ee','#f5e8e8','#eef5e8','#f5f5e8','#e8e8f5'];

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);
const FilterIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
  </svg>
);
const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <path d="M17 8l-5-5-5 5M12 3v12"/>
  </svg>
);

export default function AssetsPage(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar */}
      <div className="av-topbar">
        <div>
          <div className="av-topbar-title">Your Assets</div>
          <div className="av-topbar-sub">Manage your uploaded garment images used for catalogue generation.</div>
        </div>
        <button className="av-btn-grad" style={{ gap: 8 }}>
          <UploadIcon /> Upload Asset
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {/* Filters */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--mute)', display: 'flex' }}>
              <SearchIcon />
            </span>
            <input
              placeholder="Search assets..."
              style={{
                width: '100%', paddingLeft: 34, height: 38, borderRadius: 8,
                border: '1px solid var(--line)', fontFamily: 'inherit', fontSize: 13,
                outline: 'none', background: 'var(--surface)',
              }}
            />
          </div>
          <button style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
            borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)',
            fontFamily: 'inherit', fontSize: 13, cursor: 'pointer', color: 'var(--ink)',
          }}>
            <FilterIcon /> Filter
          </button>
        </div>

        {/* Grid */}
        <div className="av-assets-grid">
          {MOCK_ASSETS.map((asset, i) => (
            <div key={i} className="av-asset-card">
              <div className="av-asset-thumb" style={{ background: BG_COLORS[i % BG_COLORS.length] }}>
                <span style={{ opacity: .4 }}>👗</span>
              </div>
              <div className="av-asset-meta">
                <div className="av-asset-name">{asset.name}</div>
                <div className="av-asset-info">{asset.size} · {asset.date}</div>
                <span className="av-asset-badge">{asset.type}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/assets/page.tsx
git commit -m "feat(web): add Assets page (UI only with mock data)"
```

---

## Task 6: Pricing page — add plan table

**Files:**
- Modify: `apps/web/src/app/(app)/credits/page.tsx`

Keep existing credit balance query, packages, request form, and past-requests section. Add a full pricing comparison table at the top (from new design). The table is UI-only — buttons show plans but don't trigger payment flow.

- [ ] **Step 1: Replace credits/page.tsx**

Take the existing `credits/page.tsx` and prepend a `PricingTable` component above the existing content. Full file:

```typescript
'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface CreditsResponse { balance: number; recent: { id: string; delta: number; reason: string; createdAt: string }[] }
interface CreditRequest { id: string; creditsRequested: number; note: string | null; status: string; createdAt: string; creditsApproved: number | null }

const SpinnerIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="av-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12l5 5L20 7"/>
  </svg>
);
const XIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12"/>
  </svg>
);

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--amber)',
  approved: 'var(--mint)',
  rejected: 'var(--peach)',
};

const PLANS = [
  { name: 'Starter Pack', sub: 'Individual sellers & small stores', credits: '2,500', price: '₹2,500', highlight: false },
  { name: 'Growth Pack', sub: 'Brands & growing businesses', credits: '5,000', price: '₹5,000', highlight: true, badge: 'Best Value' },
  { name: 'Pro Pack', sub: 'Large teams & agencies', credits: '10,000', price: '₹10,000', highlight: false },
];

const PRICING_SECTIONS = [
  {
    title: '1. ESSENTIAL FEATURES',
    rows: [
      { feature: 'Brand-safe Outputs', vals: ['Yes', 'Yes', 'Yes'] },
      { feature: 'No Watermark', vals: ['Yes', 'Yes', 'Yes'] },
      { feature: 'AI-powered Photoshoot', vals: ['Yes', 'Yes', 'Yes'] },
      { feature: 'Model Library Access', vals: ['Yes', 'Yes', 'Yes'] },
      { feature: 'Background Library', vals: ['Yes', 'Yes', 'Yes'] },
      { feature: 'Premium Models Access', vals: ['No', 'Limited', 'Full'] },
      { feature: 'Premium Backgrounds', vals: ['No', 'Limited', 'Full'] },
    ],
  },
  {
    title: '2. IMAGE OUTPUT & USAGE',
    rows: [
      { feature: 'HD (25 credits)', vals: ['100 Images', '200 Images', '400 Images'] },
      { feature: '2K (35 credits)', vals: ['71 Images', '142 Images', '285 Images'] },
    ],
  },
  {
    title: '3. SCALING FEATURES',
    rows: [
      { feature: 'Bulk Upload', vals: ['No', 'Yes', 'Yes'] },
      { feature: 'Rendering Priority', vals: ['Standard', 'Faster', 'Fastest'] },
    ],
  },
  {
    title: '4. CUSTOMER SUPPORT',
    rows: [
      { feature: 'Support', vals: ['Email', 'Email & Chat', 'Email, Chat & Priority'] },
      { feature: 'Dedicated Account Manager', vals: ['No', 'No', 'Yes'] },
    ],
  },
];

function renderVal(v: string) {
  if (v === 'Yes') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#e8f5e9' }}>
      <span style={{ color: '#209E46' }}><CheckIcon /></span>
    </span>
  );
  if (v === 'No') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#fce4ec' }}>
      <span style={{ color: 'var(--peach)' }}><XIcon /></span>
    </span>
  );
  const color = v === 'Full' ? 'var(--peach)' : v === 'Limited' ? 'var(--amber)' : 'var(--mute)';
  return <span style={{ color, fontWeight: 500 }}>{v}</span>;
}

function PricingTable() {
  return (
    <div className="av-pricing-table" style={{ marginBottom: 36 }}>
      {/* Plan headers */}
      <div className="av-pricing-table-head">
        <div className="av-pricing-feat-col">
          <span style={{ fontSize: 18 }}>✦</span> Features
        </div>
        {PLANS.map((plan, pi) => (
          <div
            key={pi}
            className={`av-pricing-plan-col${plan.highlight ? ' highlight' : ''}`}
            style={!plan.highlight ? { background: pi === 0 ? 'rgba(254,239,242,0.4)' : 'rgba(254,239,242,0.2)' } : {}}
          >
            {plan.badge && (
              <div style={{
                position: 'absolute', top: 10, right: 10,
                padding: '3px 10px', borderRadius: 4,
                background: plan.highlight ? 'rgba(255,255,255,0.22)' : 'rgba(245,92,122,0.1)',
                fontSize: 11, fontWeight: 700,
                color: plan.highlight ? '#FEFEFE' : 'var(--peach)',
              }}>
                ⭐ {plan.badge}
              </div>
            )}
            <div style={{ fontWeight: 700, fontSize: 15, color: plan.highlight ? '#FEFEFE' : 'var(--ink)', marginBottom: 4 }}>{plan.name}</div>
            <div style={{ fontSize: 13, color: plan.highlight ? '#f9f9f9' : 'var(--mute)', marginBottom: 10 }}>{plan.sub}</div>
            <div style={{ fontWeight: 700, fontSize: 22, color: plan.highlight ? '#FEFEFE' : 'var(--ink)', marginBottom: 14 }}>{plan.credits} Credits</div>
            <button style={{
              width: '100%', padding: '9px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: plan.highlight ? '#FEFEFE' : 'var(--grad)',
              color: plan.highlight ? 'var(--ink)' : '#FEFEFE',
            }}>Buy @ {plan.price}</button>
          </div>
        ))}
      </div>

      {/* Feature rows */}
      {PRICING_SECTIONS.map((sec, si) => (
        <div key={si}>
          <div className="av-pricing-section-head">
            <div className="av-pricing-section-label">{sec.title}</div>
            {PLANS.map((_, pi) => (
              <div key={pi} style={{ flex: 1, borderLeft: '1px solid var(--line)', background: pi === 1 ? 'rgba(245,92,122,0.03)' : 'transparent' }} />
            ))}
          </div>
          {sec.rows.map((row, ri) => (
            <div key={ri} className="av-pricing-row">
              <div className="av-pricing-row-feat">{row.feature}</div>
              {row.vals.map((v, vi) => (
                <div key={vi} className="av-pricing-row-val" style={{ background: vi === 1 ? 'rgba(245,92,122,0.03)' : 'transparent' }}>
                  {renderVal(v)}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const PACKAGES = [
  { credits: 10, label: '10 credits', desc: '10 try-ons' },
  { credits: 50, label: '50 credits', desc: '50 try-ons · best value' },
  { credits: 100, label: '100 credits', desc: '100 try-ons' },
];

export default function CreditsPage(): React.ReactElement {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const { data: credits } = useQuery<CreditsResponse>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });

  const { data: requests } = useQuery<{ items: CreditRequest[] }>({
    queryKey: ['credit-requests'],
    queryFn: () => api.get('/v1/credits/requests'),
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseInt(amount, 10);
    if (!amt || amt < 1) { setError('Enter a valid amount'); return; }
    setSubmitting(true); setError(''); setSuccess(false);
    try {
      await api.post('/v1/credits/request', { creditsRequested: amt, note: note || undefined });
      setSuccess(true); setAmount(''); setNote('');
      void qc.invalidateQueries({ queryKey: ['credit-requests'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar */}
      <div className="av-topbar">
        <div>
          <div className="av-topbar-title">Pricing</div>
          <div className="av-topbar-sub">Simple pricing for catalogue-ready visuals.</div>
        </div>
      </div>

      <div className="av-main-inner" style={{ overflowY: 'auto' }}>
        {/* Pricing table */}
        <PricingTable />

        {/* Balance card */}
        <div className="av-card" style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 13, color: 'var(--mute)', margin: '0 0 8px' }}>Current balance</p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 56, letterSpacing: '-0.03em', background: 'var(--grad)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              {credits?.balance ?? '—'}
            </span>
            <span style={{ fontSize: 18, color: 'var(--mute)', fontWeight: 500 }}>credits</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--mute)', margin: '8px 0 0' }}>1 credit = 1 virtual try-on generation</p>
        </div>

        {/* Packages */}
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em', margin: '0 0 16px' }}>Quick Request</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
            {PACKAGES.map((p) => (
              <button key={p.credits} type="button"
                onClick={() => setAmount(String(p.credits))}
                className="av-card"
                style={{ textAlign: 'left', cursor: 'pointer', border: amount === String(p.credits) ? '1.5px solid var(--peach)' : undefined, boxShadow: amount === String(p.credits) ? '0 0 0 3px rgba(245,92,122,0.12)' : undefined, transition: 'all .15s', fontFamily: 'inherit' }}
              >
                <span style={{ fontWeight: 700, fontSize: 32, letterSpacing: '-0.03em', background: 'var(--grad)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'block' }}>{p.credits}</span>
                <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginTop: 4 }}>{p.label}</span>
                <span style={{ fontSize: 12, color: 'var(--mute)', display: 'block', marginTop: 2 }}>{p.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Request form */}
        <div className="av-card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em', margin: '0 0 8px' }}>Request Credits</h2>
          <p style={{ fontSize: 14, color: 'var(--mute)', margin: '0 0 20px' }}>Submit a request to the admin. They will review and add credits to your account.</p>

          {success && (
            <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--mint)', background: 'var(--mint-soft)', fontSize: 14, color: 'var(--mint)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckIcon /> Request submitted — admin will review shortly.
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="av-field">
              <label className="av-field-label">Credits requested</label>
              <input type="number" min={1} max={1000} placeholder="e.g. 50" value={amount} onChange={(e) => setAmount(e.target.value)}
                style={{ height: 46, padding: '0 16px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 14, color: 'var(--ink)', fontFamily: 'inherit', outline: 'none' }} />
            </div>
            <div className="av-field">
              <label className="av-field-label">Note <span className="av-field-hint">(optional)</span></label>
              <input type="text" placeholder="Tell us what you're working on…" value={note} onChange={(e) => setNote(e.target.value)}
                style={{ height: 46, padding: '0 16px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 14, color: 'var(--ink)', fontFamily: 'inherit', outline: 'none' }} />
            </div>
            {error && (
              <div style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid var(--peach)', background: 'rgba(245,92,122,0.06)', fontSize: 14, color: 'var(--peach)' }}>{error}</div>
            )}
            <button type="submit" disabled={submitting || !amount} className="av-btn av-btn-primary" style={{ alignSelf: 'flex-start' }}>
              {submitting ? <><SpinnerIcon /> Submitting…</> : 'Submit request →'}
            </button>
          </form>
        </div>

        {/* Past requests */}
        {requests && requests.items.length > 0 && (
          <div>
            <h2 style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em', margin: '0 0 16px' }}>Your Requests</h2>
            <div className="av-card" style={{ padding: 0 }}>
              {requests.items.map((r, i) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: i < requests.items.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[r.status] ?? 'var(--mute)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: 600, fontSize: 14, margin: 0, color: 'var(--ink)' }}>{r.creditsRequested} credits requested</p>
                    {r.note && <p style={{ fontSize: 12, color: 'var(--mute)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</p>}
                    <p style={{ fontSize: 12, color: 'var(--mute)', margin: '2px 0 0' }}>{new Date(r.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: r.status === 'approved' ? 'var(--mint-soft)' : r.status === 'rejected' ? 'rgba(245,92,122,0.10)' : 'rgba(246,181,83,0.10)', color: STATUS_COLOR[r.status] ?? 'var(--mute)' }}>
                      {r.status}
                    </span>
                    {r.creditsApproved != null && r.status === 'approved' && (
                      <span style={{ fontSize: 12, color: 'var(--mint)' }}>+{r.creditsApproved} added</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/credits/page.tsx
git commit -m "feat(web): restyle pricing page — add plan comparison table"
```

---

## Task 7: Catalogues page restyle (dashboard)

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`

Keep ALL existing API queries. Add date-grouping, new TopBar with "Create Catalogue" button, search bar (UI only — no filter logic needed now).

- [ ] **Step 1: Replace dashboard/page.tsx**

```typescript
'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface JobSummary {
  id: string;
  status: string;
  createdAt: string;
  creditsCharged: number;
}

interface Catalogue {
  catalogueId: string;
  jobs: JobSummary[];
  createdAt: string;
}

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

const SpinnerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="av-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);
const WandIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/>
    <path d="M17.8 11.8L19 13"/><path d="M15 9h0"/><path d="M17.8 6.2L19 5"/>
    <path d="M3 21l9-9"/><path d="M12.2 6.2L11 5"/>
  </svg>
);
const FailIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);
const SparkleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
  </svg>
);
const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
  </svg>
);

const BG_COLORS = ['#f5f0e8','#e8f0f5','#f0e8f5','#e8f5ee','#f5e8e8','#eef5e8'];

function CoverImage({ catalogueId, jobs }: { catalogueId: string; jobs: JobSummary[] }) {
  const completedJob = jobs.find((j) => j.status === 'COMPLETED');
  const hasActive = jobs.some((j) => !TERMINAL.includes(j.status));
  const allFailed = jobs.every((j) => j.status === 'FAILED');

  const { data: result } = useQuery<{ url: string }>({
    queryKey: ['job-result', completedJob?.id],
    queryFn: () => api.get(`/v1/jobs/${completedJob!.id}/result`),
    enabled: !!completedJob,
    staleTime: 4 * 60 * 1000,
  });

  if (completedJob && result?.url) {
    return <img src={result.url} alt={`Catalogue ${catalogueId.slice(0, 8)}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
  }
  if (allFailed) {
    return (
      <div className="av-cat-placeholder av-cat-failed">
        <FailIcon /><span>Failed</span>
      </div>
    );
  }
  return (
    <div className="av-cat-placeholder av-cat-generating">
      <SpinnerIcon />
      <span>{hasActive ? 'Generating…' : jobs[0]?.status?.toLowerCase().replace('_', ' ')}</span>
    </div>
  );
}

function CatalogueCard({ catalogue, idx }: { catalogue: Catalogue; idx: number }) {
  const { catalogueId, jobs } = catalogue;
  const hasActive = jobs.some((j) => !TERMINAL.includes(j.status));
  const completedCount = jobs.filter((j) => j.status === 'COMPLETED').length;
  const dateStr = new Date(catalogue.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <Link href={`/catalogues/${catalogueId}`} style={{ textDecoration: 'none' }}>
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow .15s' }}
        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 20px rgba(0,0,0,0.08)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
      >
        <div style={{ height: 180, background: BG_COLORS[idx % BG_COLORS.length], position: 'relative', overflow: 'hidden' }}>
          <CoverImage catalogueId={catalogueId} jobs={jobs} />
          {hasActive && <div className="av-cat-pulse" />}
          {jobs.length > 1 && (
            <div className="av-cat-count">{completedCount}/{jobs.length}</div>
          )}
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--mute)', display: 'flex' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          </span>
          <span style={{ fontSize: 13, color: 'var(--mute)' }}>{jobs.length}</span>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)' }}>#{catalogueId.slice(0, 8)}</span>
          <span style={{ fontSize: 12, color: 'var(--mute)', marginLeft: 'auto' }}>{dateStr}</span>
        </div>
      </div>
    </Link>
  );
}

function groupByDate(catalogues: Catalogue[]): Record<string, Catalogue[]> {
  return catalogues.reduce<Record<string, Catalogue[]>>((acc, cat) => {
    const d = new Date(cat.createdAt);
    const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    (acc[label] = acc[label] || []).push(cat);
    return acc;
  }, {});
}

export default function DashboardPage(): React.ReactElement {
  const { data: catalogues, isLoading } = useQuery<Catalogue[]>({
    queryKey: ['catalogues'],
    queryFn: () => api.get('/v1/catalogues'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasActive = data.some((c) => c.jobs.some((j) => !TERMINAL.includes(j.status)));
      return hasActive ? 3000 : false;
    },
  });

  const groups = catalogues ? groupByDate(catalogues) : {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar */}
      <div className="av-topbar">
        <div>
          <div className="av-topbar-title">Your Catalogues</div>
          <div className="av-topbar-sub">View, manage, and download your previously generated catalogue images.</div>
        </div>
        <Link href="/tryon" className="av-btn-grad" style={{ gap: 8, textDecoration: 'none' }}>
          <SparkleIcon /> Create Catalogue
        </Link>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {/* Search bar */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ position: 'relative', maxWidth: 320 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--mute)', display: 'flex' }}>
              <SearchIcon />
            </span>
            <input
              placeholder="Search Catalogues"
              style={{
                width: '100%', paddingLeft: 34, height: 38, borderRadius: 8,
                border: '1px solid var(--line)', fontFamily: 'inherit', fontSize: 13,
                outline: 'none', background: 'var(--surface)',
              }}
            />
          </div>
        </div>

        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
            <SpinnerIcon />
          </div>
        )}

        {!isLoading && (!catalogues || catalogues.length === 0) && (
          <div className="av-card" style={{ textAlign: 'center', padding: '64px 24px' }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', margin: '0 auto 16px', color: 'var(--mute)' }}>
              <WandIcon />
            </div>
            <p style={{ fontWeight: 700, fontSize: 18, margin: '0 0 8px' }}>No catalogues yet</p>
            <p style={{ fontSize: 14, color: 'var(--mute)', margin: '0 0 24px' }}>Generate your first AI catalogue to get started.</p>
            <Link href="/tryon" className="av-btn av-btn-primary" style={{ textDecoration: 'none', display: 'inline-flex' }}>
              Get started →
            </Link>
          </div>
        )}

        {/* Date-grouped grid */}
        {Object.entries(groups).map(([date, items]) => (
          <div key={date} className="av-cat-date-group">
            <div className="av-cat-date-label">{date}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {items.map((cat, i) => <CatalogueCard key={cat.catalogueId} catalogue={cat} idx={i} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/dashboard/page.tsx
git commit -m "feat(web): restyle catalogues page — date groups + new header"
```

---

## Task 8: View Catalogue restyle

**Files:**
- Modify: `apps/web/src/app/(app)/catalogues/[id]/page.tsx`

Keep all query/delete logic. Add new header style matching vastra3.0 `ViewCatalogue` — back arrow, title, "Download All" button (placeholder).

- [ ] **Step 1: Replace the header section in catalogues/[id]/page.tsx**

Only change the `return` JSX. Keep all imports, interfaces, and `ImageCard` component unchanged. Replace only the `CataloguePage` return:

```typescript
// Replace ONLY the return statement in CataloguePage (keep all other code unchanged):
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar */}
      <div className="av-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/dashboard" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mute)', display: 'flex', textDecoration: 'none' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </Link>
          <div>
            <div className="av-topbar-title">
              Catalogue <span style={{ color: 'var(--mute)', fontWeight: 500, fontSize: 14 }}>#{id.slice(0, 8)}</span>
            </div>
            <div className="av-topbar-sub">
              {isLoading ? 'Loading…' : `${completedCount} of ${total} image${total !== 1 ? 's' : ''} ready`}
            </div>
          </div>
        </div>
        <button className="av-btn av-btn-ghost" style={{ gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download All
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
            <SpinnerIcon />
          </div>
        )}
        {data && (
          <div className="av-cdet-grid">
            {data.jobs.map((job) => (
              <ImageCard key={job.id} job={job} catalogueId={id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/catalogues/'[id]'/page.tsx
git commit -m "feat(web): restyle view catalogue page — new topbar"
```

---

## Task 9: Studio page TopBar update

**Files:**
- Modify: `apps/web/src/app/(app)/tryon/page.tsx`

Keep 100% of existing logic. Only change:
1. Wrap in a flex column with `av-topbar` + scrollable content area + footer (same footer logic)
2. Update `STEPS` labels to match new design: `['Setup', 'AI Models', 'Backgrounds', 'Generate']` (still 5 internal steps but stepper shows 4 — step 4 & 5 both show step 4 "Generate")

- [ ] **Step 1: Update STEPS array and add TopBar wrapper**

In `tryon/page.tsx`, change:

```typescript
// OLD:
const STEPS = [
  'Setup Your Catalogue',
  'Select AI Models',
  'Select Backgrounds',
  'Choose Templates',
  'Lower & Shoes',
];
```

to:

```typescript
// NEW — 4 visible steps; internal step 4 (Lower & Shoes) still renders under "Generate"
const STEPS = ['Setup', 'AI Models', 'Backgrounds', 'Generate'];
// Map internal step index to visible stepper index
function visibleStep(s: number) { return Math.min(s, 3); }
```

Then in the return, wrap the existing content in a new shell:

```typescript
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar with stepper */}
      <div className="av-topbar">
        <div>
          <div className="av-topbar-title">Create Catalogue</div>
          <div className="av-topbar-sub">Create premium AI catalogue shoots from flat lay garments in minutes.</div>
        </div>
        {/* Stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {STEPS.map((s, i) => {
            const vs = visibleStep(step);
            const done = i < vs;
            const active = i === vs;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: active ? '#141414' : done ? 'var(--grad)' : 'var(--line)',
                    fontSize: 10, fontWeight: 600, color: (active || done) ? '#FEFEFE' : 'var(--mute)', flexShrink: 0,
                  }}>
                    {done ? <CheckIcon /> : i + 1}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 500, color: active ? 'var(--ink)' : 'var(--mute)', whiteSpace: 'nowrap' }}>{s}</span>
                </div>
                {i < STEPS.length - 1 && <div style={{ width: 32, height: 1, background: 'var(--line)', margin: '0 8px' }} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div className="av-main-inner">
          {/* Content grid */}
          <div className="av-work">
            <div className="av-card">
              {/* ... all existing step JSX unchanged ... */}
            </div>
            <aside><Guide /></aside>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="av-footer">
        {/* ... existing footer buttons unchanged ... */}
      </div>

      {/* Toast */}
      <div className={`av-toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  );
```

Note: keep the existing `av-page-head` section removed (TopBar replaces it). Keep the `av-stepper` section removed (new stepper is in TopBar). Keep all the card content (steps 0-4) identical.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/tryon/page.tsx
git commit -m "feat(web): restyle studio page — new TopBar with 4-step stepper"
```

---

## Task 10: Account/Settings page — tab rename

**Files:**
- Modify: `apps/web/src/app/(app)/account/page.tsx`

Rename tabs to match new design: `Profile Details | Billing | Credit History | Invoices`. Add TopBar. Rename `activity` tab key to `creditHistory`. Map tab labels: `profile → Profile Details`, `billing → Billing`, `invoices → Invoices`, `activity → Credit History`.

- [ ] **Step 1: Update tab definitions in account/page.tsx**

Change:

```typescript
// OLD
type Tab = 'profile' | 'billing' | 'invoices' | 'activity';
const TABS: { k: Tab; label: string }[] = [
  { k: 'profile', label: 'Profile' },
  { k: 'billing', label: 'Billing' },
  { k: 'invoices', label: 'Invoices' },
  { k: 'activity', label: 'Credit Activity' },
];
```

to:

```typescript
// NEW
type Tab = 'profile' | 'billing' | 'invoices' | 'creditHistory';
const TABS: { k: Tab; label: string }[] = [
  { k: 'profile', label: 'Profile Details' },
  { k: 'billing', label: 'Billing' },
  { k: 'creditHistory', label: 'Credit History' },
  { k: 'invoices', label: 'Invoices' },
];
```

Change all `tab === 'activity'` checks to `tab === 'creditHistory'`.
Change `useState<Tab>('profile')` stays same.

Then wrap the return in the new shell with TopBar:

```typescript
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* TopBar */}
      <div className="av-topbar">
        <div>
          <div className="av-topbar-title">Account Settings</div>
          <div className="av-topbar-sub">Manage your profile, billing, credits, and account activity.</div>
        </div>
        <button onClick={handleSignOut} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px',
          borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--ink)',
        }}>
          <LogOutIcon /> Log Out
        </button>
      </div>

      <div className="av-main-inner" style={{ overflowY: 'auto', maxWidth: 760 }}>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--line)' }}>
          {TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                padding: '10px 20px', fontSize: 14, fontWeight: 600,
                color: tab === t.k ? 'var(--ink)' : 'var(--mute)',
                borderBottom: tab === t.k ? '2px solid var(--ink)' : '2px solid transparent',
                marginBottom: -1, transition: 'color .15s', whiteSpace: 'nowrap',
              }}
            >{t.label}</button>
          ))}
        </div>

        {/* ... all existing tab content unchanged, just replace tab === 'activity' with tab === 'creditHistory' ... */}
      </div>
    </div>
  );
```

Add `handleSignOut` function (use same pattern as sidebar):

```typescript
  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }
```

Add `useRouter` import.

Add `LogOutIcon`:

```typescript
const LogOutIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <path d="M16 17l5-5-5-5M21 12H9"/>
  </svg>
);
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @tryme/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Full build check**

```bash
pnpm --filter @tryme/web build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully` or similar.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/'(app)'/account/page.tsx
git commit -m "feat(web): restyle settings page — tab rename + TopBar + logout button"
```

---

## Final: Update progress.md

- [ ] **Step 1: Add entry to docs/progress.md**

```markdown
## 2026-05-26 — Web UI restyle (vastra3.0 design)

### Done
- Root redirect (landing page → login/tryon)
- Deleted home/page.tsx
- Logo assets copied to public/assets/
- New CSS utility classes in globals.css
- Sidebar: new nav (Studio/Catalogues/Assets/Pricing/Settings), new logo, credits widget, no dark mode toggle
- Auth pages: two-column layout with auth-bg.png image panel, Google button (UI only)
- Assets page: new page with mock data grid
- Pricing page: full plan comparison table added (UI only), kept credit request form
- Catalogues: date-grouped cards, new TopBar
- View Catalogue: new TopBar with back arrow
- Studio: new TopBar with 4-step stepper
- Settings/Account: renamed tabs, TopBar with logout

### Open Questions
- Google OAuth (button exists but no wiring)
- Assets page: needs real API for listing/uploading user garments
- Pricing: "Buy" buttons are UI-only, no payment integration
```

```bash
git add docs/progress.md
git commit -m "docs: update progress.md — web UI restyle complete"
```
