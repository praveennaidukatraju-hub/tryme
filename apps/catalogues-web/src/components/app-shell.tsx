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
import { BREAKPOINTS } from '@/lib/breakpoints';

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
  const isMobileLayout = useMediaQuery(`(max-width: ${BREAKPOINTS.lg - 1}px)`);
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
