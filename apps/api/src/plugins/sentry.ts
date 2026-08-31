import * as Sentry from '@sentry/node';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

export const sentryPlugin = fp(async (app: FastifyInstance) => {
  const dsn = app.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: app.env.NODE_ENV,
    tracesSampleRate: app.env.NODE_ENV === 'production' ? 0.1 : 0,
  });

  app.addHook('onClose', async () => {
    await Sentry.close(2000);
  });
});
