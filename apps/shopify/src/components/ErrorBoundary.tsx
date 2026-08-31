import { AppProvider, Banner, Box } from '@shopify/polaris';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// React only supports catching render-time exceptions via a class
// component's static/lifecycle methods — there's no hook equivalent. This is
// the last line of defense: every page in this app already handles its own
// API errors, so landing here means a bug slipped through, not a normal
// backend failure — hence the generic message rather than a classified one.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error in Shopify admin SPA', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <AppProvider i18n={{}}>
          <Box padding="800">
            <Banner
              title="Something went wrong"
              tone="critical"
              action={{ content: 'Reload', onAction: () => window.location.reload() }}
            >
              An unexpected error occurred. Reloading usually fixes it — if it keeps happening,
              contact support.
            </Banner>
          </Box>
        </AppProvider>
      );
    }
    return this.props.children;
  }
}
