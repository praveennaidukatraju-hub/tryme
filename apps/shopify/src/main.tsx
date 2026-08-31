import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';

const basename = import.meta.env.PROD ? '/shopify-admin' : '/';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found in index.html');

// A promise rejection with no .catch() anywhere in its chain would otherwise
// vanish silently — every page in this app is expected to catch its own API
// calls, so this is a floor to catch what slips through, not a substitute
// for handling errors at the call site.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection in Shopify admin SPA', event.reason);
});

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
