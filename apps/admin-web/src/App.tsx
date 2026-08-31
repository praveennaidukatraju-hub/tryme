import { useCallback, useEffect, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { ToastStack } from './components/ToastStack';
import { Topbar } from './components/Topbar';
import { useAuth } from './context/AuthContext';
import { apiErrorMessage, apiFetch, patchAdminPreferences } from './lib/data';
import AssetsPage from './pages/AssetsPage';
import AuditLogsPage from './pages/AuditLogsPage';
import ChatbotQnaPage from './pages/ChatbotQnaPage';
import ChatInboxPage from './pages/ChatInboxPage';
import ContactRequestsPage from './pages/ContactRequestsPage';
import CreditAnalysisPage from './pages/CreditAnalysisPage';
import DashboardPage from './pages/DashboardPage';
import DemoCatalogPage from './pages/DemoCatalogPage';
import DevApiPage from './pages/DevApiPage';
import HeldBatchesPage from './pages/HeldBatchesPage';
import JobsPage from './pages/JobsPage';
import LoginPage from './pages/LoginPage';
import PaymentsPage from './pages/PaymentsPage';
import RecycleBinPage from './pages/RecycleBinPage';
import SareePage from './pages/SareePage';
import SettingsPage from './pages/SettingsPage';
import ShopifyFunnelsPage from './pages/ShopifyFunnelsPage';
import ShopifyStoresPage from './pages/ShopifyStoresPage';
import TelemetryPage from './pages/TelemetryPage';
import TryonPage from './pages/TryonPage';
import UsersPage from './pages/UsersPage';
import WorkersPage from './pages/WorkersPage';
import WorkflowsPage from './pages/WorkflowsPage';
import type { ToastItem } from './types';

type Theme = 'light' | 'dark' | 'system';

const PATH_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  assets: 'Assets',
  'demo-catalog': 'Kiosk Demo Data',
  users: 'Users',
  jobs: 'Jobs',
  'held-batches': 'Held Batches',
  workflows: 'Workflows',
  'dev-api': 'Dev API',
  'chat-inbox': 'Chat Inbox',
  'chatbot-qna': 'Chatbot Q&A',
  'recycle-bin': 'Recycle bin',
  contacts: 'Contact Requests',
  settings: 'Settings',
  workers: 'Workers',
  saree: 'Saree',
  'shopify-funnels': 'Shopify',
  'credit-analysis': 'Credit Analysis',
  payments: 'Payments',
  'shopify-stores': 'Shopify Stores',
  telemetry: 'Telemetry',
  'audit-logs': 'Activity Logs',
};

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const raw = localStorage.getItem('tryme-theme');
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t === 'system')
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return t;
}

export default function App() {
  const { token, role, isLoading } = useAuth();
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const idRef = useRef(0);
  const navigate = useNavigate();
  const location = useLocation();

  // Apply theme to DOM + persist locally
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
    localStorage.setItem('tryme-theme', theme);
  }, [theme]);

  // Track OS preference changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () =>
      document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Close the mobile drawer whenever the route changes
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Load server preference on login
  useEffect(() => {
    if (!token || isLoading) return;
    let cancelled = false;
    apiFetch<{ preferences?: { theme?: Theme } }>('/admin/me')
      .then((me) => {
        if (cancelled) return;
        const serverValue = me.preferences?.theme;
        if (serverValue) {
          setThemeState(serverValue);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, isLoading]);

  const toast = useCallback(
    (t: { kind?: 'error' | 'warning' | 'success'; title: string; body?: string }) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, kind: t.kind, title: t.title, body: t.body }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, 4000);
    },
    [],
  );

  const updateTheme = useCallback(
    (nextTheme: Theme) => {
      const previousTheme = theme;
      setThemeState(nextTheme);
      if (!token) return;
      patchAdminPreferences({ theme: nextTheme }).catch((e) => {
        setThemeState(previousTheme);
        toast({
          kind: 'error',
          title: 'Failed to sync theme preference',
          body: apiErrorMessage(e, 'Please try again.'),
        });
      });
    },
    [theme, token, toast],
  );

  function setTheme(next: Theme) {
    updateTheme(next);
  }

  const toggleTheme = useCallback(() => {
    const order: Theme[] = ['light', 'dark', 'system'];
    updateTheme(order[(order.indexOf(theme) + 1) % order.length]);
  }, [theme, updateTheme]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const handleNav = useCallback(
    (p: string) => {
      navigate(`/${p}`);
    },
    [navigate],
  );

  const handleNavWithFilter = useCallback(
    (
      _page: string,
      _filter?: {
        page: string;
        filter?: string;
        search?: string;
        date?: string;
        jobId?: string;
        fromUserId?: string;
        userId?: string;
      },
    ) => {
      navigate(`/${_page}`, { state: _filter });
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--muted)',
          fontFamily: 'var(--sans)',
          fontSize: '0.875rem',
        }}
      >
        Loading…
      </div>
    );
  }

  if (!token) {
    return <LoginPage />;
  }

  const segment = location.pathname.slice(1).split('/')[0] || 'dashboard';
  const pageLabel = PATH_LABELS[segment] ?? 'Dashboard';
  const trail = ['Tryme', pageLabel];
  const pageProps = { onNav: handleNavWithFilter, toast };
  const settingsProps = { onNav: handleNavWithFilter, toast, theme, setTheme };

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        page={segment}
        onNav={handleNav}
        role={role ?? ''}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      {mobileNavOpen && (
        <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />
      )}
      <div className="main">
        <Topbar
          trail={trail}
          onNavTrail={(i) => i === 0 && navigate('/dashboard')}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage {...pageProps} />} />
            <Route path="/dashboard" element={<DashboardPage {...pageProps} />} />
            <Route path="/assets" element={<AssetsPage {...pageProps} />} />
            <Route path="/users" element={<UsersPage {...pageProps} />} />
            <Route path="/jobs" element={<JobsPage {...pageProps} />} />
            <Route path="/held-batches" element={<HeldBatchesPage {...pageProps} />} />
            <Route path="/workflows" element={<WorkflowsPage {...pageProps} />} />
            <Route path="/shopify-funnels" element={<ShopifyFunnelsPage {...pageProps} />} />
            <Route path="/credit-analysis" element={<CreditAnalysisPage {...pageProps} />} />
            <Route path="/payments" element={<PaymentsPage {...pageProps} />} />
            <Route path="/shopify-stores" element={<ShopifyStoresPage {...pageProps} />} />
            <Route path="/telemetry" element={<TelemetryPage {...pageProps} />} />
            <Route path="/tryon" element={<TryonPage {...pageProps} />} />
            <Route path="/demo-catalog" element={<DemoCatalogPage {...pageProps} />} />
            <Route path="/dev-api" element={<DevApiPage {...pageProps} />} />
            <Route path="/saree" element={<SareePage {...pageProps} />} />
            <Route path="/chat-inbox" element={<ChatInboxPage {...pageProps} />} />
            <Route path="/chatbot-qna" element={<ChatbotQnaPage {...pageProps} />} />
            <Route path="/contacts" element={<ContactRequestsPage {...pageProps} />} />
            <Route path="/recycle-bin" element={<RecycleBinPage {...pageProps} />} />
            <Route path="/settings" element={<SettingsPage {...settingsProps} />} />
            <Route path="/workers" element={<WorkersPage {...pageProps} />} />
            <Route path="/audit-logs" element={<AuditLogsPage {...pageProps} />} />
            <Route path="*" element={<DashboardPage {...pageProps} />} />
          </Routes>
        </main>
      </div>
      <ToastStack items={toasts} onDismiss={dismissToast} />
    </div>
  );
}
