import { httpRequestDuration, metricsContentType, metricsText } from '@tryme/observability';
import fp from 'fastify-plugin';

/**
 * Records `http_request_duration_seconds` for every response and exposes the
 * Prometheus exposition at `GET /metrics`.
 *
 * The route label uses Fastify's matched route template (e.g. `/jobs/:id`), not the
 * raw URL, to keep label cardinality bounded. Unmatched requests (404s) fall back to
 * a single `__unmatched__` bucket for the same reason.
 *
 * NOTE: `/metrics` is intentionally unauthenticated — it must be kept off the public
 * internet at the ingress (Cloudflare Tunnel) and scraped only over the private
 * Docker network. See docs/observability.md.
 */
export const metricsPlugin = fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? '__unmatched__';
    if (route === '/metrics') return;
    httpRequestDuration.observe(
      {
        method: req.method,
        route,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', metricsContentType);
    return metricsText();
  });
});
