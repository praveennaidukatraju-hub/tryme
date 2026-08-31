export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NODE_ENV === 'development') {
      process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNRESET') return;
        throw err;
      });
    }
    const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      const Sentry = await import('@sentry/nextjs');
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
      });
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (dsn) {
      const Sentry = await import('@sentry/nextjs');
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV,
        tracesSampleRate: 0,
      });
    }
  }
}

export { captureRequestError as onRequestError } from '@sentry/nextjs';
