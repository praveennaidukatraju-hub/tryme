import fp from 'fastify-plugin';
import { bumpCatalogOptionsVersion } from '../lib/catalog-options-cache.js';

/** Route prefixes whose mutations can change what the catalog options payload
 *  contains: admin asset CRUD (faces, backgrounds, poses, garment types) and the
 *  lower/shoe catalog. */
const INVALIDATING_PREFIXES = ['/admin/assets', '/admin/catalog'];
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Invalidates the catalog options cache after any successful admin asset mutation.
 *
 * WHY A HOOK AND NOT PER-ROUTE CALLS: modules/admin/models.routes.ts alone declares
 * 28 mutating routes, with more in catalog.routes.ts and subcategories.routes.ts.
 * Wiring an explicit bump into each one means route #29 silently ships without it,
 * and the failure is invisible — stale reads, no error. One hook keyed on the URL
 * prefix cannot be forgotten.
 *
 * Registered with fastify-plugin so the hook applies app-wide; admin routes are
 * registered as sibling plugins in server.ts, not under a shared parent scope, so an
 * encapsulated hook would never see them.
 *
 * onResponse (not onSend): only bump once the response is actually out and its status
 * is known, so a rejected or failed mutation does not churn the cache generation.
 */
export const catalogCacheInvalidationPlugin = fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    if (!INVALIDATING_PREFIXES.some((p) => req.url.startsWith(p))) return;
    await bumpCatalogOptionsVersion(app);
  });
});
