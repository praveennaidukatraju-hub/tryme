import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildCatalogOptions, type CatalogOptions } from '../modules/catalog-options/build.js';

/**
 * Redis cache for the admin-curated asset picker payload.
 *
 * WHY: buildCatalogOptions() issues 8-9 sequential Postgres queries and returns the
 * SAME result for every caller with the same (gender, garmentTypeId) — there is no
 * per-tenant data in it at all. The API pool is `max: 10` per process
 * (packages/db/src/index.ts), so leaving this uncached puts the public developer API
 * one traffic spike away from starving every other route.
 *
 * Invalidation is version-based, not delete-based. A counter is INCR'd whenever an
 * admin mutates an asset (see plugins/catalog-cache-invalidation.ts);
 * the version is part of every cache key, so a bump orphans the entire previous
 * generation at once — no key enumeration, no SCAN, and no risk of missing a variant.
 * Orphans are reclaimed by TTL.
 *
 * Follows the same read-with-fallback shape as lib/resolution-config.ts.
 */

/**
 * Cache keys are namespaced by the database they were built from.
 *
 * Redis is not partitioned per deployment here: the API test harness points every
 * test file at redis://127.0.0.1:6379/15 while giving each one its own Postgres
 * database (test/helpers/containers.ts, which already flags cross-file key races),
 * and the same hazard exists any time two deployments on different databases share a
 * Redis. Without this, one database's asset list gets served to another's callers.
 *
 * Derived rather than configured so it needs no new env var, and stable across
 * restarts of the same deployment so a redeploy does not cold-start the cache.
 */
const namespaces = new WeakMap<FastifyInstance, string>();

function namespaceOf(app: FastifyInstance): string {
  let ns = namespaces.get(app);
  if (!ns) {
    // app.env, not process.env — buildServer takes its config as an argument and the
    // test harness never populates process.env, so reading the latter would give every
    // test file the same namespace and defeat the point.
    ns = createHash('sha256').update(app.env.DATABASE_URL).digest('hex').slice(0, 12);
    namespaces.set(app, ns);
  }
  return ns;
}

const TTL_SECONDS = 3600;

/** Reads the current cache generation. Returns 0 when Redis is unavailable, which
 *  makes every key fall into a single generation — harmless, because the read path
 *  degrades to a direct DB build in that case anyway. */
export async function getCatalogOptionsVersion(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(`catalog:options:${namespaceOf(app)}:ver`);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Invalidates every cached variant by moving to a new generation. INCR is atomic,
 *  so concurrent admin writes across multiple API processes cannot lose a bump. */
export async function bumpCatalogOptionsVersion(app: FastifyInstance): Promise<void> {
  try {
    await app.redis.incr(`catalog:options:${namespaceOf(app)}:ver`);
  } catch (err) {
    // Non-fatal: the admin's write itself already succeeded, and the stale entry
    // expires within TTL_SECONDS. Log loudly — a persistent failure here means
    // admins see up to an hour of staleness on both the dev API and Shopify.
    app.log.error(
      { err },
      'failed to bump catalog options cache version — entries will be stale until TTL',
    );
  }
}

function cacheKey(
  app: FastifyInstance,
  version: number,
  scope: 'public' | 'internal',
  gender: string,
  garmentTypeId?: string,
): string {
  return `catalog:options:${namespaceOf(app)}:v${version}:${scope}:${gender}:${garmentTypeId ?? 'all'}`;
}

export interface CachedCatalogOptions {
  options: CatalogOptions;
  /** Cache generation the payload was built in — used as the ETag. */
  version: number;
}

/**
 * Returns the options payload, from Redis when warm and from Postgres otherwise.
 *
 * Every Redis failure mode (unreachable, malformed JSON, write rejected) falls
 * through to a direct build rather than surfacing an error: a cache outage must
 * degrade throughput, never availability.
 */
export async function getCatalogOptions(
  app: FastifyInstance,
  opts: { gender: string; garmentTypeId?: string; publicOnly: boolean },
): Promise<CachedCatalogOptions> {
  const scope = opts.publicOnly ? 'public' : 'internal';
  const version = await getCatalogOptionsVersion(app);
  const key = cacheKey(app, version, scope, opts.gender, opts.garmentTypeId);

  try {
    const raw = await app.redis.get(key);
    if (raw) return { options: JSON.parse(raw) as CatalogOptions, version };
  } catch {
    // fall through to a direct build
  }

  const options = await buildCatalogOptions(app, opts);

  try {
    await app.redis.setex(key, TTL_SECONDS, JSON.stringify(options));
  } catch {
    // serving the freshly built payload uncached is still correct
  }

  return { options, version };
}
