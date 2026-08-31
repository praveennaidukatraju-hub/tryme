# App Shell — Responsive Sidebar (Off-Canvas Drawer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below 1024px viewport width (or on the existing `/sellio` route), the permanent 200px `Sidebar` rail becomes a hamburger-triggered off-canvas drawer, so every page under `(app)` gets its full viewport width back on mobile/tablet — unblocking the pricing page's `Mobile`/`Tablet` layouts (built earlier this session) from actually being visible/testable.

**Architecture:** A new `useMediaQuery(query)` primitive (extracted from `useBreakpoint()`'s existing matchMedia logic) gives `AppShell` an independent, reactive `isMobileLayout` boolean with no threshold coupling to pricing's tiers. A new `SidebarProvider` owns all drawer state (open/closed, route-change auto-close, ESC, body-scroll-lock, focus) and renders either the existing permanent rail or a `position: fixed` drawer + backdrop. `TopBar` grows one optional hamburger button, shown only in drawer mode, that toggles the same shared state via context — no other page-level code changes anywhere.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript 5.6. No test runner in `apps/catalogues-web` — verification is `pnpm --filter @tryme/web typecheck`/`lint`/`build` plus manual browser checks, per this repo's established convention for frontend-only work.

**Reference spec:** `docs/superpowers/specs/2026-07-28-app-shell-sidebar-responsive-design.md`

---

## Before you start

Four existing files are touched: `apps/catalogues-web/src/hooks/use-breakpoint.ts`, `apps/catalogues-web/src/components/app-shell.tsx`, `apps/catalogues-web/src/components/sidebar.tsx`, `apps/catalogues-web/src/components/topbar.tsx`. Every task below quotes the exact current content it's replacing — read as it exists right now, before any task in this plan touches it. Tasks 1–4 only add new files or make additive, backward-compatible changes (an optional prop nothing calls yet); nothing observable changes until Task 5.

**Explicit regression requirement carried over from the spec:** at ≥1024px viewport, and on every non-`/sellio` route, behavior after this plan must be byte-for-byte identical to today — same permanent rail, same layout. If any manual check in Task 5 or Task 7 shows a difference at desktop width, that's a bug in this plan's execution, not an acceptable trade-off.

**Known, accepted trade-off (not something this plan fixes):** Next.js prerenders every `(app)` page's initial HTML at build time, when `isMobileLayout` can't be known (no `window` on the server). That statically-served HTML always renders the permanent rail — so on a real phone, there's a brief flash of the full 200px sidebar before client-side hydration resolves `isMobileLayout` and collapses it into the drawer. This mirrors the exact same category of trade-off already accepted in the pricing viewport-tier spec ("theoretically visible... not worth a server-side user-agent-sniffing fallback for a first rollout") — not fixed here for the same reason: a third `isMobileLayout === null` rendering state would add real complexity to chase a sub-second, one-time-per-page-load flash. This is separate from the resize-transition flash (Task 4's `useLayoutEffect` fix), which happens within an already-hydrated, already-running page and is fully fixable.

---

### Task 1: `useMediaQuery` primitive

**Files:**
- Create: `apps/catalogues-web/src/hooks/use-media-query.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useLayoutEffect, useState } from 'react';

/**
 * Reactive single-query matchMedia hook. Returns null on the server and on
 * the client's first render (so SSR and initial hydration match exactly),
 * then resolves synchronously in useLayoutEffect before paint. The
 * MediaQueryList is created once per distinct `query` string (inside the
 * effect, gated by the [query] dependency array) — not recreated on every
 * render.
 */
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = () => setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/hooks/use-media-query.ts
git commit -m "feat(web): add reusable useMediaQuery primitive"
```

---

### Task 2: Refactor `useBreakpoint()` to use `useMediaQuery()` internally

**Files:**
- Modify: `apps/catalogues-web/src/hooks/use-breakpoint.ts` (full replacement)

Pure internal refactor — same public API (`Tier | null`, same five tier names, same five thresholds), so every existing consumer (the pricing page's `page.tsx`) is unaffected.

- [ ] **Step 1: Replace the entire file contents**

Current content (for reference — being replaced):

```ts
import { useLayoutEffect, useState } from 'react';

export type Tier = 'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop';

const QUERIES: Record<Tier, string> = {
  mobile: '(max-width: 639px)',
  tablet: '(min-width: 640px) and (max-width: 1023px)',
  'small-laptop': '(min-width: 1024px) and (max-width: 1279px)',
  laptop: '(min-width: 1280px) and (max-width: 1535px)',
  desktop: '(min-width: 1536px)',
};

export function useBreakpoint(): Tier | null {
  const [tier, setTier] = useState<Tier | null>(null);

  useLayoutEffect(() => {
    const entries = (Object.entries(QUERIES) as [Tier, string][]).map(
      ([t, q]) => [t, window.matchMedia(q)] as const,
    );
    const resolve = () => {
      const match = entries.find(([, mql]) => mql.matches);
      setTier(match ? match[0] : 'desktop');
    };
    resolve();
    for (const [, mql] of entries) mql.addEventListener('change', resolve);
    return () => {
      for (const [, mql] of entries) mql.removeEventListener('change', resolve);
    };
  }, []);

  return tier;
}
```

New content:

```ts
import { useMediaQuery } from './use-media-query';

export type Tier = 'mobile' | 'tablet' | 'small-laptop' | 'laptop' | 'desktop';

const QUERIES: Record<Tier, string> = {
  mobile: '(max-width: 639px)',
  tablet: '(min-width: 640px) and (max-width: 1023px)',
  'small-laptop': '(min-width: 1024px) and (max-width: 1279px)',
  laptop: '(min-width: 1280px) and (max-width: 1535px)',
  desktop: '(min-width: 1536px)',
};

/**
 * Resolves the current viewport tier. Internally five independent
 * useMediaQuery() calls — one per tier — since exactly one of these five
 * ranges is ever true at a time (they're contiguous and non-overlapping).
 * Returns null until the first one resolves (see useMediaQuery's SSR/
 * hydration note).
 */
export function useBreakpoint(): Tier | null {
  const isMobile = useMediaQuery(QUERIES.mobile);
  const isTablet = useMediaQuery(QUERIES.tablet);
  const isSmallLaptop = useMediaQuery(QUERIES['small-laptop']);
  const isLaptop = useMediaQuery(QUERIES.laptop);
  const isDesktop = useMediaQuery(QUERIES.desktop);

  if (
    isMobile === null ||
    isTablet === null ||
    isSmallLaptop === null ||
    isLaptop === null ||
    isDesktop === null
  ) {
    return null;
  }
  if (isMobile) return 'mobile';
  if (isTablet) return 'tablet';
  if (isSmallLaptop) return 'small-laptop';
  if (isLaptop) return 'laptop';
  if (isDesktop) return 'desktop';
  return 'desktop';
}
```

All five `useMediaQuery` calls do resolve together today (same synchronous `useLayoutEffect` pass, before first paint), so checking just `isMobile` would work right now — but that relies on an implicit, unstated timing guarantee. Checking all five explicitly costs nothing and doesn't silently break if `useBreakpoint()`'s hooks are ever reordered, made conditional, or React's effect batching changes. The final `return 'desktop'` fallback mirrors the original's `match ? match[0] : 'desktop'` behavior for the same (practically unreachable, since the five ranges are contiguous and exhaustive) edge case.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Manual regression check**

Run: `pnpm --filter @tryme/web dev`, open `/pricing` at 375px, 800px, and 1728px widths. Confirm the `Mobile`/`Tablet`/`Desktop` layouts still dispatch correctly exactly as before this refactor — this task must not change pricing's behavior at all, only `use-breakpoint.ts`'s internals.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/hooks/use-breakpoint.ts
git commit -m "refactor(web): rebuild useBreakpoint on top of useMediaQuery"
```

---

### Task 3: `Sidebar` gains an optional `onNavigate` callback

**Files:**
- Modify: `apps/catalogues-web/src/components/sidebar.tsx`

Additive and backward-compatible — the existing call site (`<Sidebar />` in `app-shell.tsx`) is untouched until Task 5, and passing no `onNavigate` is valid (it's optional).

- [ ] **Step 1: Change the function signature**

Find:
```tsx
export function Sidebar() {
```

Replace with:
```tsx
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
```

- [ ] **Step 2: Call `onNavigate` from the logo link**

Find (in the "Logo row" section):
```tsx
        <Link href="/studio" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
```

Replace with:
```tsx
        <Link
          href="/studio"
          onClick={() => onNavigate?.()}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
```

- [ ] **Step 3: Call `onNavigate` from the active nav item link**

Find (in the nav-item rendering, the `isActive` branch):
```tsx
                      <Link
                        key={item.id}
                        href={item.href}
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 16px',
                          borderRadius: 8,
                          textDecoration: 'none',
                          border: 'none',
                          boxShadow: 'inset 3px 0 0 0 #BD2587',
                          background:
                            'linear-gradient(90deg, rgba(189, 37, 135, 0.15) 0%, rgba(189, 37, 135, 0) 100%)',
                          boxSizing: 'border-box',
                          width: '100%',
                        }}
                        onMouseEnter={() => prefetchRoute(item.id)}
                        onFocus={() => prefetchRoute(item.id)}
                      >
```

Replace with (only the last two lines change — one line added):
```tsx
                      <Link
                        key={item.id}
                        href={item.href}
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 16px',
                          borderRadius: 8,
                          textDecoration: 'none',
                          border: 'none',
                          boxShadow: 'inset 3px 0 0 0 #BD2587',
                          background:
                            'linear-gradient(90deg, rgba(189, 37, 135, 0.15) 0%, rgba(189, 37, 135, 0) 100%)',
                          boxSizing: 'border-box',
                          width: '100%',
                        }}
                        onMouseEnter={() => prefetchRoute(item.id)}
                        onFocus={() => prefetchRoute(item.id)}
                        onClick={() => onNavigate?.()}
                      >
```

- [ ] **Step 4: Call `onNavigate` from the inactive nav item link**

Find (the non-active branch, immediately after):
```tsx
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="sidebar-link-hover"
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 16px',
                        borderRadius: 8,
                        textDecoration: 'none',
                        background: 'transparent',
                        border: 'none',
                        boxShadow: 'none',
                        width: '100%',
                        boxSizing: 'border-box',
                        transition: 'box-shadow 0.2s, background-color 0.2s',
                      }}
                      onMouseEnter={() => prefetchRoute(item.id)}
                      onFocus={() => prefetchRoute(item.id)}
                    >
```

Replace with (one line added):
```tsx
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="sidebar-link-hover"
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 16px',
                        borderRadius: 8,
                        textDecoration: 'none',
                        background: 'transparent',
                        border: 'none',
                        boxShadow: 'none',
                        width: '100%',
                        boxSizing: 'border-box',
                        transition: 'box-shadow 0.2s, background-color 0.2s',
                      }}
                      onMouseEnter={() => prefetchRoute(item.id)}
                      onFocus={() => prefetchRoute(item.id)}
                      onClick={() => onNavigate?.()}
                    >
```

- [ ] **Step 5: Call `onNavigate` from the credits-card link**

Find (in the "Credits Card Linked to Pricing" section):
```tsx
        <Link
          href="/pricing"
          style={{
            textDecoration: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            borderRadius: 12,
            border: '1px solid rgba(57, 61, 70, 0.7)',
            background: '#0d1222',
            boxSizing: 'border-box',
            width: '100%',
            transition: 'all 0.2s',
          }}
          className="sidebar-credits-card"
        >
```

Replace with (one line added):
```tsx
        <Link
          href="/pricing"
          onClick={() => onNavigate?.()}
          style={{
            textDecoration: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            borderRadius: 12,
            border: '1px solid rgba(57, 61, 70, 0.7)',
            background: '#0d1222',
            boxSizing: 'border-box',
            width: '100%',
            transition: 'all 0.2s',
          }}
          className="sidebar-credits-card"
        >
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS. (`app-shell.tsx` still calls `<Sidebar />` with zero props — valid, since `onNavigate` is optional.)

- [ ] **Step 7: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/catalogues-web/src/components/sidebar.tsx
git commit -m "feat(web): add optional onNavigate callback to Sidebar nav links"
```

---

### Task 4: `SidebarProvider` + `SidebarContext`

**Files:**
- Create: `apps/catalogues-web/src/components/sidebar-context.tsx`

`SidebarProvider` owns only state, effects, and context — no application-specific UI. It renders the rail/drawer/backdrop, but the `/sellio` floating toggle button is a separate small consumer component (`SellioSidebarToggle`, added in Task 5 inside `app-shell.tsx`, since that's where the existing `/sellio` business logic already lives) that reads `useSidebarContext()` like any other consumer would. Not wired into `AppShell` yet (that's Task 5); this task only creates the file and verifies it type-checks standalone.

- [ ] **Step 1: Write the file**

```tsx
'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { Sidebar } from './sidebar';

interface SidebarContextValue {
  isDrawerMode: boolean;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebarContext(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (!value) {
    throw new Error('useSidebarContext must be used within a SidebarProvider');
  }
  return value;
}

const DRAWER_WIDTH = 'min(85vw, 320px)';
export const SIDEBAR_DRAWER_ID = 'app-sidebar-drawer';

export function SidebarProvider({
  isDrawerMode,
  children,
}: {
  isDrawerMode: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(!isDrawerMode);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Reset to closed every time drawer mode turns on — initial mount already
  // below 1024px, narrowing an existing desktop session, or navigating to
  // /sellio. Without this, resizing down could inherit an open/closed state
  // that has nothing to do with the new context. This must be
  // useLayoutEffect, not useEffect: useMediaQuery's own resolution (in
  // AppShell) is a useLayoutEffect, so on a live resize (not first load —
  // see the note below), matching that timing means this reset resolves in
  // the same synchronous pre-paint pass instead of one frame later, which
  // would otherwise show a one-frame flash of an incorrectly-open drawer
  // before it snaps shut.
  useLayoutEffect(() => {
    if (isDrawerMode) close();
  }, [isDrawerMode, close]);

  // Close on any navigation — clicked link, browser back/forward,
  // router.push(), a redirect, a deep link. Sidebar's own onNavigate (below)
  // is a snappier optimization on top of this, not a replacement for it.
  useEffect(() => {
    close();
  }, [pathname, close]);

  // ESC closes, only while actually open in drawer mode. Gating on both
  // (not isOpen alone) means leaving drawer mode via resize automatically
  // tears this listener down through React's effect-dependency mechanism.
  // document (not window) matches the existing click-outside-handler
  // convention already used elsewhere in this app (the pricing country
  // selector) — keydown bubbles to both identically, so this is purely a
  // consistency choice, not a functional one.
  useEffect(() => {
    if (!(isOpen && isDrawerMode)) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, isDrawerMode, close]);

  // Body scroll lock, only while actually open in drawer mode. Captures the
  // pre-existing overflow value inside this effect's own closure (not in
  // provider state) and restores exactly that value — composes correctly
  // with React's cleanup lifecycle and with anything else that might touch
  // body overflow.
  useEffect(() => {
    if (!(isOpen && isDrawerMode)) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen, isDrawerMode]);

  const value = useMemo<SidebarContextValue>(
    () => ({ isDrawerMode, isOpen, open, close, toggle }),
    [isDrawerMode, isOpen, open, close, toggle],
  );

  return (
    <SidebarContext.Provider value={value}>
      {isDrawerMode ? (
        <>
          {/* Always mounted once in drawer mode — opacity/pointer-events
              toggle instead of conditional mount, so both the backdrop and
              the drawer actually animate (not just pop in/out), and a
              closed drawer can never intercept stray clicks regardless of
              its transform. */}
          <div
            aria-hidden="true"
            onClick={close}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              zIndex: 1300,
              opacity: isOpen ? 1 : 0,
              pointerEvents: isOpen ? 'auto' : 'none',
              transition: 'opacity 180ms ease',
            }}
          />
          <div
            id={SIDEBAR_DRAWER_ID}
            className="sidebar-drawer-panel"
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              height: '100vh',
              width: DRAWER_WIDTH,
              zIndex: 1301,
              transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
              opacity: isOpen ? 1 : 0,
              pointerEvents: isOpen ? 'auto' : 'none',
              transition: 'transform 180ms ease, opacity 180ms ease',
            }}
          >
            <Sidebar onNavigate={close} />
          </div>
        </>
      ) : (
        <Sidebar />
      )}
      {children}
    </SidebarContext.Provider>
  );
}
```

Note the `@media (prefers-reduced-motion: reduce)` override for the drawer's `transition` isn't expressible in an inline `style` object — that's handled in Task 5 via a small global CSS rule added alongside the drawer, not here.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/components/sidebar-context.tsx
git commit -m "feat(web): add SidebarProvider owning drawer state, rail/drawer/backdrop rendering"
```

---

### Task 5: Wire `SidebarProvider` into `AppShell`

**Files:**
- Modify: `apps/catalogues-web/src/components/app-shell.tsx` (full replacement)
- Modify: `apps/catalogues-web/src/app/globals.css` (add the reduced-motion override)

This is the task where behavior actually changes. Current content (being replaced):

```tsx
'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChatWidget } from '@/components/chat-widget';
import { ProfileGate } from '@/components/profile-gate';
import { Sidebar } from '@/components/sidebar';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// The /sellio mock page renders its own full Shopify admin chrome,
// including its own left nav rail — showing the real Ai Vastra Sidebar at
// the same time makes two sidebars collide visually. Hide it on that route
// by default, with a floating toggle so the merchant (or a demo presenter)
// can still get back to the rest of the app without navigating away.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const path = BASE && pathname?.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const isSellio = path === '/sellio' || path?.startsWith('/sellio/');
  const [sidebarVisible, setSidebarVisible] = useState(!isSellio);

  useEffect(() => {
    setSidebarVisible(!isSellio);
  }, [isSellio]);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      {sidebarVisible && <Sidebar />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProfileGate>{children}</ProfileGate>
      </div>
      {process.env.NODE_ENV === 'development' && <ChatWidget />}
      {isSellio && (
        <button
          type="button"
          onClick={() => setSidebarVisible((v) => !v)}
          style={{
            position: 'fixed',
            bottom: 16,
            left: 16,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 36,
            padding: '0 16px',
            borderRadius: 999,
            border: 'none',
            background: 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {sidebarVisible ? 'Hide Ai Vastra Sidebar' : 'Show Ai Vastra Sidebar'}
        </button>
      )}
    </div>
  );
}
```

`SellioSidebarToggle` is a small new consumer component defined right in `app-shell.tsx` — it's `/sellio`-specific business logic (the button's copy, its always-bottom-left positioning), so it belongs next to `isSellio`'s existing computation, not inside the generic `SidebarProvider`. It has to render as a *child* of `SidebarProvider` (passed inside `children`) rather than a sibling in `AppShell`, since context is only readable by a provider's descendants — `AppShell` itself, sitting above `SidebarProvider` in the tree, can't call `useSidebarContext()` directly.

- [ ] **Step 1: Replace the entire file contents**

```tsx
'use client';
import { usePathname } from 'next/navigation';
import { ChatWidget } from '@/components/chat-widget';
import { ProfileGate } from '@/components/profile-gate';
import {
  SIDEBAR_DRAWER_ID,
  SidebarProvider,
  useSidebarContext,
} from '@/components/sidebar-context';
import { useMediaQuery } from '@/hooks/use-media-query';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function SellioSidebarToggle(): React.ReactElement {
  const { isOpen, toggle } = useSidebarContext();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={isOpen}
      aria-controls={SIDEBAR_DRAWER_ID}
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        padding: '0 16px',
        borderRadius: 999,
        border: 'none',
        background: 'linear-gradient(135deg, #7c3aed 0%, #BD2587 100%)',
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      }}
    >
      {isOpen ? 'Hide Ai Vastra Sidebar' : 'Show Ai Vastra Sidebar'}
    </button>
  );
}

// The /sellio mock page renders its own full Shopify admin chrome,
// including its own left nav rail — showing the real Ai Vastra Sidebar at
// the same time makes two sidebars collide visually. Below 1024px, every
// route uses the same drawer mechanism for the same reason a permanent
// 200px rail doesn't fit a narrow viewport.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const path = BASE && pathname?.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const isSellio = path === '/sellio' || path?.startsWith('/sellio/');
  const isMobileLayout = useMediaQuery('(max-width: 1023px)');
  const isDrawerMode = isSellio || !!isMobileLayout;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', position: 'relative' }}>
      <SidebarProvider isDrawerMode={isDrawerMode}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ProfileGate>{children}</ProfileGate>
        </div>
        {isSellio && <SellioSidebarToggle />}
      </SidebarProvider>
      {process.env.NODE_ENV === 'development' && <ChatWidget />}
    </div>
  );
}
```

- [ ] **Step 2: Add the reduced-motion override for the drawer**

Add to the end of `apps/catalogues-web/src/app/globals.css`:

```css

/* Sidebar drawer — respect reduced-motion preference (Task 5, App Shell responsive sidebar) */
@media (prefers-reduced-motion: reduce) {
  .sidebar-drawer-panel {
    transition: none !important;
  }
}
```

`className="sidebar-drawer-panel"` and `transition: 'transform 180ms ease, opacity 180ms ease'` on the drawer panel are already part of Task 4's code — nothing further to change in `sidebar-context.tsx` for this step.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `pnpm --filter @tryme/web build`
Expected: PASS.

- [ ] **Step 6: Manual regression check — desktop unchanged**

Run: `pnpm --filter @tryme/web dev`, open any `(app)` page (e.g. `/studio`) at ≥1024px. Confirm: permanent sidebar rail, identical to before this task — no hamburger visible anywhere (TopBar doesn't have one yet — that's Task 6, so there's nothing to check there yet), no drawer/backdrop markup present.

- [ ] **Step 7: Manual check — drawer mechanics without a toggle button yet**

At this point there's no way to *open* the drawer through the UI yet (Task 6 adds the hamburger). Confirm instead: at <1024px, the permanent rail is gone and the page content occupies the full viewport width (open React DevTools or just visually confirm no 200px gap on the left). This is the direct fix for the original bug report — re-check `/pricing`'s `Mobile`/`Tablet` layouts now render correctly with the full width.

- [ ] **Step 8: Manual check — `/sellio` regression**

Navigate to `/sellio` at a desktop width. Confirm the floating "Show/Hide Ai Vastra Sidebar" button still appears bottom-left and toggles the sidebar exactly as before.

- [ ] **Step 9: Commit**

```bash
git add apps/catalogues-web/src/components/app-shell.tsx apps/catalogues-web/src/components/sidebar-context.tsx apps/catalogues-web/src/app/globals.css
git commit -m "feat(web): wire SidebarProvider into AppShell, sidebar collapses below 1024px"
```

---

### Task 6: Hamburger button in `TopBar`

**Files:**
- Modify: `apps/catalogues-web/src/components/topbar.tsx` (full replacement)

Current content (being replaced):

```tsx
import { PhoneCall } from 'lucide-react';
import { SupportButton } from './SupportModal';
import { C } from './tokens';
import { UserMenu } from './user-menu';

export function TopBar({
  title,
  subtitle,
  right,
  lead,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  lead?: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: 76,
        background: C.white,
        borderBottom: `1px solid ${C.border}`,
        padding: '0 28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {lead ?? (
        <div>
          {title && (
            <div style={{ fontWeight: 600, fontSize: 20, lineHeight: '32px', color: C.text }}>
              {title}
            </div>
          )}
          {subtitle && (
            <div
              style={{
                fontWeight: 500,
                fontSize: 14,
                lineHeight: '20px',
                color: C.mid,
                marginTop: 2,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {right}

        <a
          href="tel:+917729883692"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: C.text,
            fontSize: 14,
            fontWeight: 500,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <PhoneCall size={18} />
          +91 77298 83692
        </a>

        {/* Support button */}
        <SupportButton />

        <UserMenu />
      </div>
    </div>
  );
}
```

- [ ] **Step 1: Replace the entire file contents**

```tsx
import { Menu, PhoneCall } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { SIDEBAR_DRAWER_ID, useSidebarContext } from './sidebar-context';
import { SupportButton } from './SupportModal';
import { C } from './tokens';
import { UserMenu } from './user-menu';

export function TopBar({
  title,
  subtitle,
  right,
  lead,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  lead?: React.ReactNode;
}) {
  const { isDrawerMode, isOpen, toggle } = useSidebarContext();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(isOpen);

  // Restore focus to the hamburger after the drawer closes — regardless of
  // how it was opened (WAI-ARIA dialog/menu pattern: DOM focus returns to
  // the trigger unconditionally; :focus-visible already keeps this
  // invisible to mouse users, so there's no "unexpected jump").
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      menuButtonRef.current?.focus();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  return (
    <div
      style={{
        height: 76,
        background: C.white,
        borderBottom: `1px solid ${C.border}`,
        padding: '0 28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {isDrawerMode && (
          <button
            type="button"
            ref={menuButtonRef}
            onClick={toggle}
            aria-label="Toggle navigation menu"
            aria-expanded={isOpen}
            aria-controls={SIDEBAR_DRAWER_ID}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.white,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Menu size={18} color={C.text} />
          </button>
        )}
        {lead ?? (
          <div>
            {title && (
              <div style={{ fontWeight: 600, fontSize: 20, lineHeight: '32px', color: C.text }}>
                {title}
              </div>
            )}
            {subtitle && (
              <div
                style={{
                  fontWeight: 500,
                  fontSize: 14,
                  lineHeight: '20px',
                  color: C.mid,
                  marginTop: 2,
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {right}

        <a
          href="tel:+917729883692"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: C.text,
            fontSize: 14,
            fontWeight: 500,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <PhoneCall size={18} />
          +91 77298 83692
        </a>

        {/* Support button */}
        <SupportButton />

        <UserMenu />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @tryme/web lint`
Expected: PASS.

- [ ] **Step 4: Manual check**

`TopBar` is shared by every page in the app, so this task's regression surface is wider than Tasks 1-4 — check all three below rather than only the new mobile behavior, so a subtle regression here doesn't hide until Task 7's final sweep:

Run: `pnpm --filter @tryme/web dev`.
- **Mobile, 375px:** open `/pricing` (or any page using `TopBar`). Confirm: hamburger button appears to the left of the title; tapping it opens the drawer with a visible backdrop; tapping the backdrop closes it; tapping a nav link inside the drawer both closes it and navigates; ESC closes it; while open, the page behind can't be scrolled; after closing, pressing Tab shows focus is back on the hamburger button (not lost to `<body>`).
- **Desktop, ≥1024px:** open the same page. Confirm no hamburger button renders, and `TopBar`'s title/subtitle spacing and the right-side phone/support/user-menu row look exactly as before this task — the new wrapping `<div>` around the hamburger-and-title group must not visibly shift anything at desktop width.
- **`/sellio`:** confirm the page still renders correctly (it uses its own chrome, not `TopBar`, so this is a quick sanity check that nothing here leaked into it, not a deep check).

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/components/topbar.tsx
git commit -m "feat(web): add hamburger drawer toggle to TopBar"
```

---

### Task 7: Final verification sweep and progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Full verification pass**

Run: `pnpm --filter @tryme/web typecheck` — expect PASS.
Run: `pnpm --filter @tryme/web lint` — expect PASS.
Run: `pnpm --filter @tryme/web build` — expect PASS.

- [ ] **Step 2: Manual sweep per the spec's testing plan**

With `pnpm --filter @tryme/web dev` running:
- **Regression, ≥1024px:** every `(app)` page still shows the permanent rail, no hamburger, no drawer markup interactable.
- **Drawer mechanics, <1024px:** hamburger opens/closes the drawer; backdrop click closes; nav-link click closes and navigates; browser back/forward after opening the drawer on one page and navigating leaves the drawer closed on the destination page; ESC closes it; body doesn't scroll while open; focus returns to the hamburger after close.
- **Boundary resize, 1023↔1024:** open the drawer at 1023px, resize to 1024px — rail appears, drawer/backdrop disappear, body scroll unlocks, page is fully usable with no leftover overlay. Resize back to 1023px — drawer starts closed, not inheriting the prior open state.
- **`/sellio` regression:** floating toggle button still works at any viewport width.
- **Original bug re-check:** `/pricing`'s `Mobile` and `Tablet` layouts (from the earlier viewport-tier rebuild) now render correctly with the full restored viewport width — no more sidebar-induced squeeze.

- [ ] **Step 3: Add a dated entry to `docs/progress.md`**

Add this entry at the top of the log (above the most recent existing entry):

```markdown
## 2026-07-28 — App Shell: responsive sidebar (off-canvas drawer)

### Done
- Extracted a reusable `useMediaQuery(query)` primitive (`apps/catalogues-web/src/hooks/use-media-query.ts`) from `useBreakpoint()`'s existing matchMedia logic; `useBreakpoint()` refactored to build on it internally with zero external API change.
- Added `SidebarProvider`/`SidebarContext` (`apps/catalogues-web/src/components/sidebar-context.tsx`) owning all drawer state: open/closed, route-change auto-close, `onNavigate` optimization, ESC-to-close, body-scroll-lock (exact-value preserve/restore), and rendering the rail/drawer/backdrop/`/sellio`-toggle markup.
- `AppShell` now collapses the sidebar into a `min(320px, 85vw)` off-canvas drawer below 1024px (independently of pricing's own viewport tiers — no threshold coupling) or on `/sellio`, instead of a permanent 200px rail.
- `TopBar` gained an optional hamburger button (shown only in drawer mode) with accessible unconditional focus-restore on close, matching the WAI-ARIA dialog/menu pattern.
- Root cause of the original bug report ("pricing page's mobile/tablet layouts don't look responsive") confirmed and fixed: `AppShell`'s permanent 200px sidebar was squeezing every page's content area regardless of what that page's own layout did — this was never a bug in the pricing rebuild itself.

### Failed / Not Done
- (none)

### Open Questions / Decisions
- `TopBar`'s own right-side content (Support button, phone link, `UserMenu`) collapsing into a mobile overflow menu, and renaming/expanding `useBreakpoint()` into a richer `useViewport()` API, were both explicitly deferred to their own future specs — not bundled into this change.
- Next step in the sequence: continue rolling the `useBreakpoint()` + tier-layout pattern (established on the pricing page) out to other pages, now that the shell gives them the full viewport width to work with instead of fighting it.
```

- [ ] **Step 4: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record app shell responsive sidebar work"
```

---

## Self-review notes

- **Spec coverage:** every behavior in the spec's "Behavior" section maps to a line in Task 4's `SidebarProvider` (reset-on-entering-drawer-mode, two-mechanism closing, ESC, body-scroll-lock with exact-value restore, backdrop/drawer sibling structure, drawer width formula) or Task 6 (unconditional focus restore). The `useMediaQuery` decoupling requirement is Task 1+2. The explicit ≥1024px regression requirement has a dedicated manual-check step in Tasks 5 and 7. `prefers-reduced-motion` is Task 5 Step 2.
- **Type consistency:** `SidebarContextValue`'s shape (`{ isDrawerMode, isOpen, open, close, toggle }`) is defined once in Task 4 and consumed with the exact same field names in Task 6's `TopBar` and Task 5's `SellioSidebarToggle`. `Sidebar`'s `onNavigate?: () => void` prop (Task 3) is called identically from Task 4's `SidebarProvider` (`<Sidebar onNavigate={close} />`) and left unset at the rail call site (`<Sidebar />`). `SIDEBAR_DRAWER_ID`, exported once from Task 4's `sidebar-context.tsx`, is imported by both Task 6's `TopBar` (`aria-controls`) and Task 5's `SellioSidebarToggle` (`aria-controls`) rather than being redeclared as a duplicate string literal in either.
- **No placeholders:** every step gives complete code or an exact find-and-replace against content quoted from the actual current file.
- **Post-review revisions incorporated:** `SidebarProvider` no longer takes an `isSellio` prop or renders `/sellio`-specific UI — that moved to a separate `SellioSidebarToggle` consumer component in Task 5's `app-shell.tsx`, keeping the provider limited to state/effects/context. `useBreakpoint()`'s null-check (Task 2) now checks all five `useMediaQuery` results explicitly rather than relying on an implicit "they all resolve together" timing guarantee. The backdrop and drawer panel (Task 4) are now always mounted once in drawer mode, animating both `opacity` and `transform` and gating `pointerEvents` on `isOpen`, instead of the backdrop popping in/out via conditional mount with no transition — this also means a closed drawer can never intercept stray clicks. Both toggle buttons (`TopBar`'s hamburger, `SellioSidebarToggle`) now set `aria-expanded`/`aria-controls`, and the drawer panel has a stable `id`. The backdrop has `aria-hidden="true"`.
