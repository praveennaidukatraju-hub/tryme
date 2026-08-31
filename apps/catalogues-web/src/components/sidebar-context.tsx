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
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname trigger
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
            <Sidebar onNavigate={close} fillWidth />
          </div>
        </>
      ) : (
        <Sidebar />
      )}
      {children}
    </SidebarContext.Provider>
  );
}
