import '@shopify/polaris/build/esm/styles.css';
import { AppProvider, Banner, Box, Frame, Navigation, Spinner } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppNavMenu, NAV_ITEMS } from './components/AppNavMenu';
import { apiFetch, setShopDomain } from './lib/api';
import {
  AppBridgeTimeoutError,
  clearRecoveryReloadMarker,
  shouldAttemptRecoveryReload,
} from './lib/appBridge';
import { type ClassifiedError, classifyError } from './lib/errors';
import { runNavGuard } from './lib/navGuard';
import AnalyticsPage from './pages/AnalyticsPage';
import AutorefillCallbackPage from './pages/AutorefillCallbackPage';
import BillingCallbackPage from './pages/BillingCallbackPage';
import DashboardPage from './pages/DashboardPage';
import ManagePage from './pages/ManagePage';
import PricingPage from './pages/PricingPage';
import SettingsPage from './pages/SettingsPage';
import SupportPage from './pages/SupportPage';
import type { ShopifyMe } from './types';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then((res) => {
        clearRecoveryReloadMarker();
        setShopDomain(res.store.shopDomain);
        setLoading(false);
      })
      .catch((err) => {
        // A wedged App Bridge instance can't be recovered by retrying the call
        // in place — only a fresh document gets a fresh instance. Do that once
        // automatically so the merchant never sees an error for what is a
        // transient Shopify-side hang.
        if (err instanceof AppBridgeTimeoutError && shouldAttemptRecoveryReload()) {
          window.location.reload();
          return; // Keep the spinner up; this document is being replaced.
        }
        const classified = classifyError(err);
        if (classified.code === 'SHOPIFY_REAUTH_REQUIRED') {
          return; // Keep the spinner up; apiFetch's top-level redirect is in flight.
        }
        // No FORBIDDEN -> OAuth redirect here any more. Under managed
        // installation the server provisions the store from this request's own
        // session token (see requireShopifySession), so a fresh install no
        // longer surfaces as 403 at all. A 403 that survives that means
        // provisioning genuinely failed, and redirecting to OAuth would only
        // bounce back through Shopify's install entry — the loop that got
        // shops throttled with 429. Show the error and let Retry reload.
        setError(classified);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <AppProvider i18n={{}}>
        <Spinner accessibilityLabel="Loading" size="large" />
      </AppProvider>
    );
  }

  if (error) {
    return (
      <AppProvider i18n={{}}>
        <Box padding="800">
          <Banner
            title="Couldn't load TryMe"
            tone={error.tone}
            // A full reload, not load(): if App Bridge is the thing that's
            // wedged, re-running the same call in place hangs again.
            action={{ content: 'Retry', onAction: () => window.location.reload() }}
          >
            {error.message}
          </Banner>
        </Box>
      </AppProvider>
    );
  }

  // window.shopify is only defined inside the Shopify admin iframe (see
  // lib/appBridge.ts). Outside it, <ui-nav-menu> renders nothing, so Frame's
  // own `navigation` prop supplies a usable dev nav instead — Polaris's
  // <Navigation> requires a <Frame> ancestor providing frame context, which
  // it only gets by being passed in here rather than rendered as a sibling.
  // When App Bridge IS present, <ui-nav-menu> (real Shopify nav) handles
  // navigation natively, so no `navigation` prop is passed at all.
  const devNavigation = !window.shopify ? (
    <Navigation location={location.pathname}>
      <Navigation.Section
        title="TryMe (dev)"
        items={NAV_ITEMS.map((item) => ({
          label: item.label,
          icon: item.icon,
          // Deliberately omit `url`: Polaris renders URL items as anchors and
          // navigates after onClick, even when the guard rejects the attempt.
          selected: location.pathname === item.path,
          onClick: () => {
            if (runNavGuard()) navigate(item.path);
          },
        }))}
      />
    </Navigation>
  ) : undefined;

  return (
    <AppProvider i18n={{}}>
      <AppNavMenu />
      <Frame navigation={devNavigation}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/manage" element={<ManagePage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/billing/callback" element={<BillingCallbackPage />} />
          <Route path="/billing/autorefill-callback" element={<AutorefillCallbackPage />} />
          {/* Merchants may have bookmarked the old path while it was the only
              product surface. */}
          <Route path="/products" element={<Navigate to="/manage" replace />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
          {/* Widget Design page removed — merchants may have it bookmarked or
              pinned in Shopify admin's nav history. */}
          <Route path="/widget-design" element={<Navigate to="/" replace />} />
        </Routes>
      </Frame>
    </AppProvider>
  );
}
